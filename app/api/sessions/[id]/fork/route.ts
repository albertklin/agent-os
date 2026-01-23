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

// Worktree selection for fork (branch-based model)
interface WorktreeSelection {
  branch: string; // branch name (step 1: select which branch)
  mode: "direct" | "isolated"; // step 2: work directly in worktree or create new branch
  featureName?: string; // required if mode="isolated"
}

interface BranchWorktreeInfo {
  worktreePath: string | null;
  isMainWorktree: boolean;
}

/**
 * Find the worktree path for a given branch name
 */
async function findWorktreeForBranch(
  db: ReturnType<typeof getDb>,
  projectId: string,
  branchName: string,
  mainWorktreePath: string
): Promise<BranchWorktreeInfo> {
  // Check if the branch is checked out in the main worktree
  const mainBranch = await getCurrentBranch(mainWorktreePath);
  if (mainBranch === branchName) {
    return { worktreePath: mainWorktreePath, isMainWorktree: true };
  }

  // Check if there's an isolated worktree for this branch
  const existingSession = db
    .prepare(
      `SELECT worktree_path FROM sessions
       WHERE project_id = ? AND branch_name = ?
       AND worktree_path IS NOT NULL
       AND lifecycle_status NOT IN ('failed', 'deleting')
       LIMIT 1`
    )
    .get(projectId, branchName) as { worktree_path: string } | undefined;

  if (existingSession) {
    return {
      worktreePath: existingSession.worktree_path,
      isMainWorktree: false,
    };
  }

  return { worktreePath: null, isMainWorktree: false };
}

interface ForkRequest {
  name?: string;
  // NEW: Unified worktree selection
  worktreeSelection?: WorktreeSelection;
  // NEW: Auto-approve setting (independent, defaults to parent's value)
  autoApprove?: boolean;
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
    const {
      name,
      worktreeSelection,
      autoApprove,
      useWorktree,
      featureName,
      baseBranch,
    } = body;

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
      // New unified format (branch-based)
      effectiveWorktreeSelection = worktreeSelection;
    } else if (useWorktree && featureName) {
      // Legacy format with explicit worktree request
      const parentBranch =
        parent.branch_name ||
        (await getCurrentBranch(sourceProjectPath)) ||
        "main";
      effectiveWorktreeSelection = {
        branch: parentBranch,
        mode: "isolated",
        featureName,
      };
    } else {
      // Default: direct mode on parent's branch (or current branch if no worktree)
      const parentBranch =
        parent.branch_name ||
        (await getCurrentBranch(sourceProjectPath)) ||
        "main";
      effectiveWorktreeSelection = {
        branch: parentBranch,
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

    // Determine effective autoApprove: use request value, default to parent's
    const effectiveAutoApprove = autoApprove ?? Boolean(parent.auto_approve);
    const agentType = parent.agent_type || "claude";

    // Validate: auto_approve requires isolated worktree (not main + direct)
    if (effectiveAutoApprove && agentType === "claude") {
      // Check if this would be main + direct
      const mainBranch = await getCurrentBranch(sourceProjectPath);
      const isMainDirect =
        effectiveWorktreeSelection.mode === "direct" &&
        effectiveWorktreeSelection.branch === mainBranch;

      if (isMainDirect) {
        return NextResponse.json(
          {
            error:
              "Skip permissions requires an isolated worktree. " +
              "Please select 'Isolated' mode or choose a different branch.",
          },
          { status: 400 }
        );
      }
    }

    // For direct mode, resolve the branch to its worktree path
    let branchWorktreeInfo: BranchWorktreeInfo | null = null;
    let isExistingWorktreeDirect = false;

    if (effectiveWorktreeSelection.mode === "direct") {
      branchWorktreeInfo = await findWorktreeForBranch(
        db,
        parent.project_id || "uncategorized",
        effectiveWorktreeSelection.branch,
        sourceProjectPath
      );

      if (!branchWorktreeInfo.worktreePath) {
        return NextResponse.json(
          {
            error:
              "No worktree exists for this branch. Please select 'Isolated' mode to create a new worktree.",
          },
          { status: 400 }
        );
      }

      isExistingWorktreeDirect = !branchWorktreeInfo.isMainWorktree;
    }

    // For worktree sessions, use source project path initially - runSessionSetup will update it
    const actualWorkingDirectory = needsWorktreeSetup
      ? sourceProjectPath
      : branchWorktreeInfo?.worktreePath || sourceProjectPath;

    // Create new session
    const newId = randomUUID();
    const newName =
      name || effectiveWorktreeSelection.featureName || `${parent.name} (fork)`;
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
        effectiveAutoApprove ? 1 : 0,
        parent.project_id || "uncategorized",
        parent.extra_mounts,
        parent.allowed_domains
      );

    // Handle the different worktree scenarios
    if (needsWorktreeSetup) {
      // Use the selected branch as the base for the new worktree
      const baseBranchToUse = effectiveWorktreeSelection.branch;

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
    } else if (isExistingWorktreeDirect && branchWorktreeInfo?.worktreePath) {
      // Direct mode with an existing isolated worktree - make fork a tracked sibling.
      // This ensures the worktree won't be deleted while the fork is still using it.
      // Find an existing session with this worktree to copy the branch info from
      const existingWorktreeSession = db
        .prepare(
          `SELECT * FROM sessions WHERE worktree_path = ? AND lifecycle_status NOT IN ('failed', 'deleting') LIMIT 1`
        )
        .get(branchWorktreeInfo.worktreePath) as Session | undefined;

      if (!existingWorktreeSession) {
        // Race condition: worktree was deleted between findWorktreeForBranch and here
        queries.deleteSession(db).run(newId);
        return NextResponse.json(
          {
            error:
              "The worktree for this branch is no longer available. Please try again.",
          },
          { status: 409 }
        );
      }

      queries
        .updateSessionWorktree(db)
        .run(
          existingWorktreeSession.worktree_path,
          existingWorktreeSession.branch_name,
          existingWorktreeSession.base_branch,
          newId
        );

      // Create tmux session with fork command
      const agentCommand = buildAgentCommand(agentType, {
        parentSessionId: parent.claude_session_id,
        model: parent.model,
        autoApprove: effectiveAutoApprove,
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
        autoApprove: effectiveAutoApprove,
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
