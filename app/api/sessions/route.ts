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

// Worktree selection for new session creation
interface WorktreeSelection {
  base: string; // worktree path (project dir = main worktree)
  mode: "direct" | "isolated";
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
      // New unified format
      effectiveWorktreeSelection = worktreeSelection;
    } else if (useWorktree && featureName) {
      // Legacy format - convert to new format (main + isolated)
      effectiveWorktreeSelection = {
        base: workingDirectory,
        mode: "isolated",
        featureName,
      };
    }

    // Determine if this session needs worktree setup
    const needsWorktreeSetup =
      effectiveWorktreeSelection?.mode === "isolated" &&
      effectiveWorktreeSelection?.featureName;

    // For existing worktree + direct mode, find the existing session to copy worktree info
    let existingWorktreeSession: Session | null = null;
    if (
      effectiveWorktreeSelection?.mode === "direct" &&
      effectiveWorktreeSelection.base !== workingDirectory
    ) {
      // This is an existing isolated worktree - find session with this worktree_path
      const existingSessions = db
        .prepare(
          `SELECT * FROM sessions WHERE worktree_path = ? AND lifecycle_status NOT IN ('failed', 'deleting') LIMIT 1`
        )
        .get(effectiveWorktreeSelection.base) as Session | undefined;
      existingWorktreeSession = existingSessions || null;

      if (!existingWorktreeSession) {
        return NextResponse.json(
          {
            error:
              "The selected worktree does not exist or has no active sessions",
          },
          { status: 400 }
        );
      }
    }

    // Validate: skipPermissions requires isolated mode (not main + direct)
    if (autoApprove && agentType === "claude") {
      const isMainDirect =
        !effectiveWorktreeSelection ||
        (effectiveWorktreeSelection.mode === "direct" &&
          effectiveWorktreeSelection.base === workingDirectory);

      if (isMainDirect) {
        return NextResponse.json(
          {
            error:
              "Skipping permissions requires an isolated worktree. " +
              "Please select 'Isolated' mode and provide a feature name.",
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
            error:
              "Skipping permissions requires a feature name for the isolated worktree.",
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
    if (existingWorktreeSession?.worktree_path) {
      // existing + direct: use the existing worktree path
      actualWorkingDirectory = existingWorktreeSession.worktree_path;
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

    // Handle the 4 worktree combinations
    if (needsWorktreeSetup && effectiveWorktreeSelection) {
      // ISOLATED mode: Create new worktree (either from main or from existing)
      queries.updateSessionSetupStatus(db).run("pending", null, id);
      queries.updateSessionLifecycleStatus(db).run("creating", id);

      // Broadcast initial status via SSE so UI shows creating state immediately
      statusBroadcaster.updateStatus({
        sessionId: id,
        status: "idle",
        lifecycleStatus: "creating",
        setupStatus: "pending",
      });

      // Get current branch from the selected base worktree
      // This is independent of step 1 selection - we always use whatever branch
      // is currently checked out in the selected worktree
      const currentBranch = await getCurrentBranch(
        effectiveWorktreeSelection.base
      );
      if (!currentBranch) {
        // Clean up the session we just created
        queries.deleteSession(db).run(id);
        return NextResponse.json(
          {
            error: "Could not determine current branch for worktree creation",
          },
          { status: 400 }
        );
      }
      const baseBranchToUse = currentBranch;

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

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error("Error creating session:", error);
    return NextResponse.json(
      { error: "Failed to create session" },
      { status: 500 }
    );
  }
}
