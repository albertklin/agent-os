import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDb, queries, type Session, type Group } from "@/lib/db";
import { isValidAgentType, type AgentType } from "@/lib/providers";
import { runSessionSetup } from "@/lib/session-setup";
import { hasAgentOsHooks, writeHooksConfig } from "@/lib/hooks/generate-config";
import { initializeSandbox } from "@/lib/sandbox";

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
function generateSessionName(db: ReturnType<typeof getDb>): string {
  const sessions = queries.getAllSessions(db).all() as Session[];
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
      model = "sonnet",
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
      // Tmux option
      useTmux = true,
      // Initial prompt to send when session starts
      initialPrompt = null,
    } = body;

    // Validate agent type
    const agentType: AgentType = isValidAgentType(rawAgentType)
      ? rawAgentType
      : "claude";

    // Auto-generate name if not provided
    const name =
      providedName?.trim() ||
      (featureName ? featureName : generateSessionName(db));

    const id = randomUUID();

    // For worktree sessions, we create the session immediately with pending status
    // and run the setup (worktree creation, submodule init, dep install) in background
    const isWorktreeSession = useWorktree && featureName;

    const tmuxName = useTmux ? `${agentType}-${id}` : null;
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
      projectId
    );

    // For worktree sessions, set setup_status to pending and trigger background setup
    if (isWorktreeSession) {
      queries.updateSessionSetupStatus(db).run("pending", null, id);

      // Fire and forget - background setup will update status via SSE
      runSessionSetup({
        sessionId: id,
        projectPath: workingDirectory,
        featureName: featureName.trim(),
        baseBranch,
      }).catch((error) => {
        console.error(`[session-setup] Unhandled error for session ${id}:`, error);
      });
    }

    // Set claude_session_id if provided (for importing external sessions)
    if (claudeSessionId) {
      db.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?").run(
        claudeSessionId,
        id
      );
    }

    // If forking, copy messages from parent
    if (parentSessionId) {
      const parentMessages = queries
        .getSessionMessages(db)
        .all(parentSessionId);
      for (const msg of parentMessages as Array<{
        role: string;
        content: string;
        duration_ms: number | null;
      }>) {
        queries
          .createMessage(db)
          .run(id, msg.role, msg.content, msg.duration_ms);
      }
    }

    const session = queries.getSession(db).get(id) as Session;

    // Auto-configure hooks for Claude sessions if not already configured
    // This enables real-time status updates via the status-stream SSE endpoint
    let hooksConfigured = false;
    if (agentType === "claude" && workingDirectory) {
      const projectDir = workingDirectory.replace(
        "~",
        process.env.HOME || ""
      );
      if (!hasAgentOsHooks(projectDir)) {
        const result = writeHooksConfig(projectDir);
        hooksConfigured = result.success;
        if (result.success) {
          console.log(`[hooks] Configured AgentOS hooks at ${result.path}`);
        }
      } else {
        hooksConfigured = true;
      }
    }

    // Initialize Claude's native sandbox for auto-approve sessions
    // This creates .claude/settings.json with sandbox enabled
    if (autoApprove && agentType === "claude") {
      const workDir = workingDirectory.replace(
        "~",
        process.env.HOME || ""
      );

      console.log(`[sandbox] Initializing sandbox for session ${id}`);
      const sandboxReady = await initializeSandbox({
        sessionId: id,
        workingDirectory: workDir,
      });

      if (!sandboxReady) {
        // Clean up the session we just created
        queries.deleteSession(db).run(id);
        return NextResponse.json(
          {
            error:
              "Failed to initialize sandbox for auto-approve session. " +
              "Could not create sandbox settings.",
          },
          { status: 500 }
        );
      }

      // Refresh session data after sandbox initialization
      const updatedSession = queries.getSession(db).get(id) as Session;
      if (updatedSession) {
        Object.assign(session, updatedSession);
      }
    }

    // Include initial prompt in response
    const response: {
      session: Session;
      initialPrompt?: string;
      hooksConfigured?: boolean;
    } = { session, hooksConfigured };
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
