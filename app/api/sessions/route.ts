import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import { getDb, queries, type Session, type Group } from "@/lib/db";
import { isValidAgentType, type AgentType } from "@/lib/providers";
import { runSessionSetup } from "@/lib/session-setup";
import { validateMounts, serializeMounts } from "@/lib/mounts";
import {
  validateDomains,
  serializeDomains,
  normalizeDomains,
} from "@/lib/domains";
import type { MountConfig } from "@/lib/db/types";
// Note: Global Claude hooks are configured at server startup (see server.ts)
import { isGitRepo } from "@/lib/git";
import { statusBroadcaster } from "@/lib/status-broadcaster";
import { sessionManager } from "@/lib/session-manager";
import { buildAgentCommand } from "@/lib/sessions";

const execAsync = promisify(exec);

// Worktree selection for new session creation (branch-based model)
interface WorktreeSelection {
  branch: string; // branch name (step 1: select which branch)
  mode: "direct" | "isolated"; // step 2: work directly in worktree or create new branch
  featureName?: string; // required if mode="isolated"
}

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

interface BranchWorktreeInfo {
  worktreePath: string | null;
  isMainWorktree: boolean;
}

/**
 * Find the worktree path for a given branch name
 * Returns the worktree path if one exists, or null if no worktree for this branch
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

// GET /api/sessions - List all sessions and groups
export async function GET() {
  try {
    const db = getDb();
    const sessions = queries.getAllSessions(db).all() as Session[];
    const groups = queries.getAllGroups(db).all() as Group[];

    // Convert expanded from 0/1 to boolean
    const formattedGroups = groups.map((g) => ({
      ...g,
      expanded: Boolean(g.expanded),
    }));

    return NextResponse.json({ sessions, groups: formattedGroups });
  } catch (error) {
    console.error("Error fetching sessions:", error);
    return NextResponse.json(
      { error: "Failed to fetch sessions" },
      { status: 500 }
    );
  }
}

// Generate a unique session name
// Uses getActiveSessions to exclude failed/deleted sessions from numbering
function generateSessionName(db: ReturnType<typeof getDb>): string {
  const sessions = queries.getActiveSessions(db).all() as Session[];
  const existingNumbers = sessions
    .map((s) => {
      const match = s.name.match(/^Session (\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((n) => n > 0);

  const nextNumber =
    existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
  return `Session ${nextNumber}`;
}

// POST /api/sessions - Create new session
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const db = getDb();

    const {
      name: providedName,
      workingDirectory = "~",
      parentSessionId = null,
      model = "opus",
      systemPrompt = null,
      groupPath = "sessions",
      claudeSessionId = null,
      agentType: rawAgentType = "claude",
      autoApprove = false,
      projectId = "uncategorized",
      // NEW: Unified worktree selection (preferred)
      worktreeSelection = null as WorktreeSelection | null,
      // LEGACY: Worktree options (for backward compatibility)
      useWorktree = false,
      featureName = null,
      // Initial prompt to send when session starts
      initialPrompt = null,
      // Extra mounts for sandboxed sessions
      extraMounts = [],
      // Extra allowed network domains for sandboxed sessions
      allowedDomains = [],
    } = body;

    // Validate agent type
    const agentType: AgentType = isValidAgentType(rawAgentType)
      ? rawAgentType
      : "claude";

    // Normalize worktree selection - support both new and legacy formats
    let effectiveWorktreeSelection: WorktreeSelection | null = null;

    if (worktreeSelection) {
      // New unified format (branch-based)
      effectiveWorktreeSelection = worktreeSelection;
    } else if (useWorktree && featureName) {
      // Legacy format - convert to new format
      // Get current branch for the working directory
      const currentBranch = await getCurrentBranch(workingDirectory);
      if (!currentBranch) {
        return NextResponse.json(
          {
            error:
              "Could not determine the current branch. Please ensure the directory is a git repository.",
          },
          { status: 400 }
        );
      }
      effectiveWorktreeSelection = {
        branch: currentBranch,
        mode: "isolated",
        featureName,
      };
    }

    // Determine if this session needs worktree setup
    const needsWorktreeSetup =
      effectiveWorktreeSelection?.mode === "isolated" &&
      effectiveWorktreeSelection?.featureName;

    // For direct mode, resolve the branch to its worktree path
    let branchWorktreeInfo: BranchWorktreeInfo | null = null;
    let existingWorktreeSession: Session | null = null;

    if (effectiveWorktreeSelection?.mode === "direct") {
      // Find the worktree for this branch
      branchWorktreeInfo = await findWorktreeForBranch(
        db,
        projectId,
        effectiveWorktreeSelection.branch,
        workingDirectory
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

      // If it's not the main worktree, find the existing session to copy worktree info
      if (!branchWorktreeInfo.isMainWorktree) {
        const existingSessions = db
          .prepare(
            `SELECT * FROM sessions WHERE worktree_path = ? AND lifecycle_status NOT IN ('failed', 'deleting') LIMIT 1`
          )
          .get(branchWorktreeInfo.worktreePath) as Session | undefined;
        existingWorktreeSession = existingSessions || null;

        if (!existingWorktreeSession) {
          return NextResponse.json(
            {
              error:
                "The worktree for this branch does not have any active sessions.",
            },
            { status: 400 }
          );
        }
      }
    }

    // Validate: skipPermissions cannot be used with project branch + direct mode
    if (autoApprove && agentType === "claude") {
      const isMainDirect =
        !effectiveWorktreeSelection ||
        (effectiveWorktreeSelection.mode === "direct" &&
          branchWorktreeInfo?.isMainWorktree);

      if (isMainDirect) {
        return NextResponse.json(
          {
            error:
              "Skip permissions cannot be used with the project branch in direct mode. " +
              "Please select a different branch or use isolated mode.",
          },
          { status: 400 }
        );
      }

      // If isolated mode, validate feature name is provided
      if (
        effectiveWorktreeSelection?.mode === "isolated" &&
        !effectiveWorktreeSelection?.featureName
      ) {
        return NextResponse.json(
          {
            error: "Isolated mode requires a feature name.",
          },
          { status: 400 }
        );
      }

      // Worktrees require a git repository
      const resolvedWorkDir = workingDirectory.replace(
        "~",
        process.env.HOME || ""
      );
      if (!(await isGitRepo(resolvedWorkDir))) {
        return NextResponse.json(
          {
            error:
              "Skipping permissions requires a git repository for worktree isolation. " +
              "The selected directory is not a git repository.",
          },
          { status: 400 }
        );
      }
    }

    // Validate extra mounts if provided
    const typedExtraMounts: MountConfig[] = extraMounts || [];
    if (typedExtraMounts.length > 0) {
      const mountsValidation = validateMounts(typedExtraMounts);
      if (!mountsValidation.valid) {
        return NextResponse.json(
          { error: `Invalid mount configuration: ${mountsValidation.error}` },
          { status: 400 }
        );
      }
    }

    // Validate extra allowed domains if provided
    const typedAllowedDomains: string[] = allowedDomains || [];
    if (typedAllowedDomains.length > 0) {
      const domainsValidation = validateDomains(typedAllowedDomains);
      if (!domainsValidation.valid) {
        return NextResponse.json(
          { error: `Invalid domain configuration: ${domainsValidation.error}` },
          { status: 400 }
        );
      }
    }

    // Auto-generate name if not provided
    const effectiveFeatureName =
      effectiveWorktreeSelection?.featureName || featureName;
    const name =
      providedName?.trim() ||
      (effectiveFeatureName ? effectiveFeatureName : generateSessionName(db));

    const id = randomUUID();

    // Determine the actual working directory for the session
    let actualWorkingDirectory = workingDirectory;
    if (
      branchWorktreeInfo?.worktreePath &&
      effectiveWorktreeSelection?.mode === "direct"
    ) {
      // Direct mode: use the worktree path for the selected branch
      actualWorkingDirectory = branchWorktreeInfo.worktreePath;
    }

    const tmuxName = `${agentType}-${id}`;
    queries.createSession(db).run(
      id,
      name,
      tmuxName,
      actualWorkingDirectory, // Will be updated to worktree path by background setup if isolated
      parentSessionId,
      model,
      systemPrompt,
      groupPath,
      agentType,
      autoApprove ? 1 : 0, // SQLite stores booleans as integers
      projectId,
      serializeMounts(typedExtraMounts),
      serializeDomains(normalizeDomains(typedAllowedDomains))
    );

    // Handle the worktree setup scenarios
    if (needsWorktreeSetup && effectiveWorktreeSelection) {
      // ISOLATED mode: Create new worktree branching from the selected branch
      queries.updateSessionSetupStatus(db).run("pending", null, id);
      queries.updateSessionLifecycleStatus(db).run("creating", id);

      // Broadcast initial status via SSE so UI shows creating state immediately
      statusBroadcaster.updateStatus({
        sessionId: id,
        status: "idle",
        lifecycleStatus: "creating",
        setupStatus: "pending",
      });

      // Use the selected branch as the base branch for the new worktree
      const baseBranchToUse = effectiveWorktreeSelection.branch;

      // Fire and forget - background setup will update status via SSE
      runSessionSetup({
        sessionId: id,
        projectPath: workingDirectory, // Always use main project path for worktree creation
        featureName: effectiveWorktreeSelection.featureName!.trim(),
        baseBranch: baseBranchToUse,
        initialPrompt: initialPrompt?.trim() || undefined,
      }).catch((error) => {
        console.error(
          `[session-setup] Unhandled error for session ${id}:`,
          error
        );
      });
    } else if (existingWorktreeSession) {
      // DIRECT mode with existing worktree: Copy worktree info (tracked sibling)
      queries
        .updateSessionWorktree(db)
        .run(
          existingWorktreeSession.worktree_path,
          existingWorktreeSession.branch_name,
          existingWorktreeSession.base_branch,
          id
        );

      // Start tmux session directly
      try {
        const agentCommand = buildAgentCommand(agentType, {
          model,
          autoApprove,
          initialPrompt,
        });
        await sessionManager.startTmuxSession(id, agentCommand);
      } catch (error) {
        console.error(
          `[sessions] Failed to start tmux session for ${id}:`,
          error
        );
        queries.updateSessionLifecycleStatus(db).run("failed", id);
        statusBroadcaster.updateStatus({
          sessionId: id,
          status: "idle",
          lifecycleStatus: "failed",
        });
        return NextResponse.json(
          { error: "Failed to start terminal session" },
          { status: 500 }
        );
      }
    } else {
      // DIRECT mode with main worktree (or no worktree selection): Start tmux directly
      try {
        const agentCommand = buildAgentCommand(agentType, {
          model,
          autoApprove,
          initialPrompt,
        });
        await sessionManager.startTmuxSession(id, agentCommand);
      } catch (error) {
        console.error(
          `[sessions] Failed to start tmux session for ${id}:`,
          error
        );
        queries.updateSessionLifecycleStatus(db).run("failed", id);
        statusBroadcaster.updateStatus({
          sessionId: id,
          status: "idle",
          lifecycleStatus: "failed",
        });
        return NextResponse.json(
          { error: "Failed to start terminal session" },
          { status: 500 }
        );
      }
    }

    // Set claude_session_id if provided (for importing external sessions)
    if (claudeSessionId) {
      db.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?").run(
        claudeSessionId,
        id
      );
    }

    // If forking, copy messages from parent (single batch query)
    if (parentSessionId) {
      queries.copySessionMessages(db).run(id, parentSessionId);
    }

    const session = queries.getSession(db).get(id) as Session;

    // Note: Sandbox initialization for auto-approve sessions is handled in
    // session-setup.ts after the worktree is created, so settings go to the
    // worktree's .claude/settings.json (not the main project)

    // Include initial prompt in response
    const response: {
      session: Session;
      initialPrompt?: string;
    } = { session };
    if (initialPrompt?.trim()) {
      response.initialPrompt = initialPrompt.trim();
    }

    // Notify all SSE clients that session list changed
    statusBroadcaster.broadcastSessionsChanged();

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error("Error creating session:", error);
    return NextResponse.json(
      { error: "Failed to create session" },
      { status: 500 }
    );
  }
}
