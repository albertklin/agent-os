import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDb, queries, type Session, type Group } from "@/lib/db";
import { isValidAgentType, type AgentType, getProvider } from "@/lib/providers";
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
      // Worktree options
      useWorktree = false,
      featureName = null,
      baseBranch = "main",
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

    // Sandboxed sessions require an isolated worktree for clean settings management
    if (autoApprove && agentType === "claude") {
      if (!useWorktree || !featureName) {
        return NextResponse.json(
          {
            error:
              "Skipping permissions requires an isolated worktree. " +
              "Please enable 'Isolated worktree' and provide a feature name.",
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
    const name =
      providedName?.trim() ||
      (featureName ? featureName : generateSessionName(db));

    const id = randomUUID();

    // For worktree sessions, we create the session immediately with pending status
    // and run the setup (worktree creation, submodule init, dep install) in background
    const isWorktreeSession = useWorktree && featureName;

    const tmuxName = `${agentType}-${id}`;
    queries.createSession(db).run(
      id,
      name,
      tmuxName,
      workingDirectory, // Will be updated to worktree path by background setup
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

    // For worktree sessions, set setup_status to pending and lifecycle_status to creating
    // Then trigger background setup
    if (isWorktreeSession) {
      queries.updateSessionSetupStatus(db).run("pending", null, id);
      queries.updateSessionLifecycleStatus(db).run("creating", id);

      // Broadcast initial status via SSE so UI shows creating state immediately
      statusBroadcaster.updateStatus({
        sessionId: id,
        status: "idle",
        lifecycleStatus: "creating",
        setupStatus: "pending",
      });

      // Fire and forget - background setup will update status via SSE
      runSessionSetup({
        sessionId: id,
        projectPath: workingDirectory,
        featureName: featureName.trim(),
        baseBranch: baseBranch || "main", // Handle null from frontend
        initialPrompt: initialPrompt?.trim() || undefined,
      }).catch((error) => {
        console.error(
          `[session-setup] Unhandled error for session ${id}:`,
          error
        );
      });
    } else {
      // Non-worktree sessions need their tmux session created before they're ready
      // startTmuxSession creates the tmux session and sets lifecycle_status to 'ready'
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
        // Mark session as failed if tmux creation fails
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
