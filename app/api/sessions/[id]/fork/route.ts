import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDb, queries, type Session, type Project } from "@/lib/db";
import { runSessionSetup } from "@/lib/session-setup";
import { statusBroadcaster } from "@/lib/status-broadcaster";
import { sessionManager } from "@/lib/session-manager";
import { buildAgentCommand } from "@/lib/sessions";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface ForkRequest {
  name?: string;
  useWorktree?: boolean;
  featureName?: string;
  baseBranch?: string;
}

// POST /api/sessions/[id]/fork - Fork a session
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: parentId } = await params;

    // Parse body if present, otherwise use empty object
    let body: ForkRequest = {};
    try {
      body = await request.json();
    } catch {
      // No body provided, use defaults
    }
    const { name, useWorktree, featureName, baseBranch } = body;

    // Validate worktree options
    if (useWorktree && !featureName) {
      return NextResponse.json(
        { error: "Feature name is required when using an isolated worktree" },
        { status: 400 }
      );
    }

    const db = getDb();

    // Get parent session
    const parent = queries.getSession(db).get(parentId) as Session | undefined;
    if (!parent) {
      return NextResponse.json(
        { error: "Parent session not found" },
        { status: 404 }
      );
    }

    // Lifecycle guard: can only fork from a ready session
    if (parent.lifecycle_status !== "ready") {
      return NextResponse.json(
        {
          error: "Cannot fork session that is not ready",
          lifecycle_status: parent.lifecycle_status,
        },
        { status: 409 }
      );
    }

    // Sandboxed (auto-approve) sessions require an isolated worktree for container mounting
    // This ensures the forked session gets its own container with proper isolation
    if (parent.auto_approve && parent.agent_type === "claude") {
      if (!useWorktree || !featureName) {
        return NextResponse.json(
          {
            error:
              "Forking a session with skipped permissions requires an isolated worktree. " +
              "Please enable 'Isolated worktree' and provide a feature name.",
          },
          { status: 400 }
        );
      }
    }

    // Determine source project path for worktree creation
    let sourceProjectPath = parent.working_directory;
    if (useWorktree && parent.project_id) {
      const project = queries.getProject(db).get(parent.project_id) as
        | Project
        | undefined;
      if (project && project.working_directory) {
        sourceProjectPath = project.working_directory;
      }
    }

    const actualBaseBranch = baseBranch || parent.base_branch || "main";
    // For worktree sessions, use source project path initially - runSessionSetup will update it
    const actualWorkingDirectory = useWorktree
      ? sourceProjectPath
      : parent.working_directory;

    // Create new session
    const newId = randomUUID();
    const newName = name || featureName || `${parent.name} (fork)`;
    const agentType = parent.agent_type || "claude";
    const tmuxName = `${agentType}-${newId}`;

    queries
      .createSession(db)
      .run(
        newId,
        newName,
        tmuxName,
        actualWorkingDirectory,
        parentId,
        parent.model,
        parent.system_prompt,
        parent.group_path || "sessions",
        agentType,
        parent.auto_approve ? 1 : 0,
        parent.project_id || "uncategorized"
      );

    // Set worktree info - either trigger setup for new worktree or inherit from parent
    if (useWorktree && featureName) {
      // New isolated worktree requested - use runSessionSetup for full setup
      // This handles: worktree creation, container init (for auto-approve), deps install
      queries.updateSessionLifecycleStatus(db).run("creating", newId);
      queries.updateSessionSetupStatus(db).run("pending", null, newId);

      // Broadcast initial status via SSE so UI shows creating state immediately
      statusBroadcaster.updateStatus({
        sessionId: newId,
        status: "idle",
        lifecycleStatus: "creating",
        setupStatus: "pending",
      });

      runSessionSetup({
        sessionId: newId,
        projectPath: sourceProjectPath,
        featureName: featureName,
        baseBranch: actualBaseBranch,
      }).catch((error) => {
        console.error(
          `[fork] Unhandled error during setup for session ${newId}:`,
          error
        );
      });
    } else if (parent.worktree_path) {
      // No new worktree requested, but parent has one - make fork a tracked sibling.
      // This ensures the worktree won't be deleted while the fork is still using it.
      queries
        .updateSessionWorktree(db)
        .run(
          parent.worktree_path,
          parent.branch_name,
          parent.base_branch,
          newId
        );

      // Create tmux session with fork command
      const agentCommand = buildAgentCommand(agentType, {
        parentSessionId: parent.claude_session_id,
        model: parent.model,
        autoApprove: Boolean(parent.auto_approve),
      });
      await sessionManager.startTmuxSession(newId, agentCommand);
    } else {
      // No worktree at all - create tmux session with fork command
      const agentCommand = buildAgentCommand(agentType, {
        parentSessionId: parent.claude_session_id,
        model: parent.model,
        autoApprove: Boolean(parent.auto_approve),
      });
      await sessionManager.startTmuxSession(newId, agentCommand);
    }

    // NOTE: We do NOT copy claude_session_id here.
    // When the forked session is first attached, it will use --fork-session flag
    // with the parent's claude_session_id to create a new branched conversation.
    // The new session ID will be captured automatically.

    // Copy any local messages from parent (for logging purposes)
    // Use batch copy query instead of N individual inserts
    const copyResult = queries.copySessionMessages(db).run(newId, parentId);
    const messagesCopied = copyResult.changes;

    const session = queries.getSession(db).get(newId) as Session;

    return NextResponse.json(
      {
        session,
        messagesCopied,
        worktreeCreated: !!(useWorktree && featureName),
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Error forking session:", error);
    return NextResponse.json(
      { error: "Failed to fork session" },
      { status: 500 }
    );
  }
}
