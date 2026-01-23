import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import { getDb, queries, type Session, type Project } from "@/lib/db";
import { runSessionSetup } from "@/lib/session-setup";
import { statusBroadcaster } from "@/lib/status-broadcaster";
import { sessionManager } from "@/lib/session-manager";
import { buildAgentCommand } from "@/lib/sessions";

const execAsync = promisify(exec);

/**
 * Get current branch name for a directory
 */
async function getCurrentBranch(dir: string): Promise<string | null> {
  try {
    const resolvedDir = dir.replace("~", process.env.HOME || "");
    const { stdout } = await execAsync(
      `git -C "${resolvedDir}" rev-parse --abbrev-ref HEAD`,
      { timeout: 5000 }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Worktree selection for fork
interface WorktreeSelection {
  base: string; // worktree path (project dir = main worktree)
  mode: "direct" | "isolated";
  featureName?: string; // required if mode="isolated"
}

interface ForkRequest {
  name?: string;
  // NEW: Unified worktree selection
  worktreeSelection?: WorktreeSelection;
  // LEGACY: Old worktree options (for backward compatibility)
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
    const { name, worktreeSelection, useWorktree, featureName, baseBranch } =
      body;

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

    // Determine source project path for worktree creation
    let sourceProjectPath = parent.working_directory;
    if (parent.project_id) {
      const project = queries.getProject(db).get(parent.project_id) as
        | Project
        | undefined;
      if (project && project.working_directory) {
        sourceProjectPath = project.working_directory;
      }
    }

    // Normalize worktree selection - support both new and legacy formats
    let effectiveWorktreeSelection: WorktreeSelection;

    if (worktreeSelection) {
      // New unified format
      effectiveWorktreeSelection = worktreeSelection;
    } else if (useWorktree && featureName) {
      // Legacy format with explicit worktree request
      effectiveWorktreeSelection = {
        base: parent.worktree_path || sourceProjectPath,
        mode: "isolated",
        featureName,
      };
    } else {
      // Default: direct mode on parent's worktree (or main if no worktree)
      effectiveWorktreeSelection = {
        base: parent.worktree_path || sourceProjectPath,
        mode: "direct",
      };
    }

    // Validate worktree options
    if (
      effectiveWorktreeSelection.mode === "isolated" &&
      !effectiveWorktreeSelection.featureName
    ) {
      return NextResponse.json(
        { error: "Feature name is required when using isolated mode" },
        { status: 400 }
      );
    }

    // Determine if this is creating a new worktree or sharing an existing one
    const needsWorktreeSetup =
      effectiveWorktreeSelection.mode === "isolated" &&
      effectiveWorktreeSelection.featureName;

    // For direct mode with an existing isolated worktree, check if it's the parent's worktree
    const isExistingWorktreeDirect =
      effectiveWorktreeSelection.mode === "direct" &&
      effectiveWorktreeSelection.base !== sourceProjectPath &&
      parent.worktree_path;

    // For worktree sessions, use source project path initially - runSessionSetup will update it
    const actualWorkingDirectory = needsWorktreeSetup
      ? sourceProjectPath
      : effectiveWorktreeSelection.base;

    // Create new session
    const newId = randomUUID();
    const newName =
      name || effectiveWorktreeSelection.featureName || `${parent.name} (fork)`;
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
        parent.project_id || "uncategorized",
        parent.extra_mounts,
        parent.allowed_domains
      );

    // Handle the different worktree scenarios
    if (needsWorktreeSetup) {
      // Get current branch from the selected base worktree
      // Step 1 (base selection) and step 2 (mode) are independent -
      // we always use the current branch of whatever worktree was selected
      const currentBranch = await getCurrentBranch(
        effectiveWorktreeSelection.base
      );
      if (!currentBranch) {
        // Clean up the session we just created
        queries.deleteSession(db).run(newId);
        return NextResponse.json(
          {
            error: "Could not determine current branch for worktree creation",
          },
          { status: 400 }
        );
      }
      const baseBranchToUse = currentBranch;

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
        featureName: effectiveWorktreeSelection.featureName!,
        baseBranch: baseBranchToUse,
      }).catch((error) => {
        console.error(
          `[fork] Unhandled error during setup for session ${newId}:`,
          error
        );
      });
    } else if (isExistingWorktreeDirect && parent.worktree_path) {
      // Direct mode with parent's existing worktree - make fork a tracked sibling.
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
      try {
        await sessionManager.startTmuxSession(newId, agentCommand);
      } catch (error) {
        console.error(
          `[fork] Failed to start tmux session for ${newId}:`,
          error
        );
        queries.updateSessionLifecycleStatus(db).run("failed", newId);
        statusBroadcaster.updateStatus({
          sessionId: newId,
          status: "idle",
          lifecycleStatus: "failed",
        });
        return NextResponse.json(
          { error: "Failed to start terminal session" },
          { status: 500 }
        );
      }
    } else {
      // Direct mode with main worktree - create tmux session with fork command
      const agentCommand = buildAgentCommand(agentType, {
        parentSessionId: parent.claude_session_id,
        model: parent.model,
        autoApprove: Boolean(parent.auto_approve),
      });
      try {
        await sessionManager.startTmuxSession(newId, agentCommand);
      } catch (error) {
        console.error(
          `[fork] Failed to start tmux session for ${newId}:`,
          error
        );
        queries.updateSessionLifecycleStatus(db).run("failed", newId);
        statusBroadcaster.updateStatus({
          sessionId: newId,
          status: "idle",
          lifecycleStatus: "failed",
        });
        return NextResponse.json(
          { error: "Failed to start terminal session" },
          { status: 500 }
        );
      }
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
        worktreeCreated: needsWorktreeSetup,
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
