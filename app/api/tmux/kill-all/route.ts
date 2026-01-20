import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { getDb, queries, type Session } from "@/lib/db";
import { destroyContainer } from "@/lib/container";
import { deleteWorktree, isAgentOSWorktree } from "@/lib/worktrees";
import { statusBroadcaster } from "@/lib/status-broadcaster";
import { TMUX_SOCKET } from "@/lib/tmux";

const execAsync = promisify(exec);

// POST /api/tmux/kill-all - Kill all AgentOS tmux sessions and remove from database
export async function POST() {
  try {
    const db = getDb();

    // Get all tmux sessions from the AgentOS server
    const { stdout } = await execAsync(
      `tmux -L ${TMUX_SOCKET} list-sessions -F "#{session_name}" 2>/dev/null || echo ""`,
      { timeout: 5000 }
    );

    const tmuxSessions = stdout
      .trim()
      .split("\n")
      .filter(
        (s) => s && /^(claude|codex|opencode|gemini|aider|cursor)-/.test(s)
      );

    // Kill each tmux session
    const killed: string[] = [];
    for (const session of tmuxSessions) {
      try {
        await execAsync(`tmux -L ${TMUX_SOCKET} kill-session -t "${session}"`, {
          timeout: 5000,
        });
        killed.push(session);
      } catch {
        // Session might already be dead, continue
      }
    }

    // Get all sessions from database for cleanup
    const dbSessions = queries.getAllSessions(db).all() as Session[];
    let containersDestroyed = 0;
    let worktreesDeleted = 0;

    // Clean up resources for each session
    for (const session of dbSessions) {
      // Destroy container if present
      if (session.container_id) {
        try {
          await destroyContainer(session.container_id);
          containersDestroyed++;
        } catch {
          // Continue even if container cleanup fails
        }
      }

      // Delete worktree if present and it's an AgentOS worktree
      // Note: We use a simplified cleanup here - no sibling checks since we're deleting all
      if (session.worktree_path && isAgentOSWorktree(session.worktree_path)) {
        try {
          // Get the git common dir from the worktree
          const { stdout: gitDir } = await execAsync(
            `git -C "${session.worktree_path}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo ""`,
            { timeout: 5000 }
          );
          const gitCommonDir = gitDir.trim().replace(/\/.git$/, "");

          if (gitCommonDir) {
            // Delete without branch deletion - let git prune handle orphan branches
            await deleteWorktree(session.worktree_path, gitCommonDir, false);
            worktreesDeleted++;
          }
        } catch {
          // Continue even if worktree cleanup fails
        }
      }

      // Clear SSE state
      statusBroadcaster.clearStatus(session.id);

      // Delete from database
      try {
        queries.deleteSession(db).run(session.id);
      } catch {
        // Continue on error
      }
    }

    return NextResponse.json({
      killed: killed.length,
      sessions: killed,
      deletedFromDb: dbSessions.length,
      containersDestroyed,
      worktreesDeleted,
    });
  } catch (error) {
    console.error("Error killing tmux sessions:", error);
    return NextResponse.json(
      { error: "Failed to kill sessions" },
      { status: 500 }
    );
  }
}
