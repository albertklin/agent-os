/**
 * Session Manager
 *
 * Centralized manager for session lifecycle operations including:
 * - Getting session information
 * - Starting tmux sessions
 * - Deleting sessions and cleaning up resources
 * - Checking session liveness
 * - Recovering sessions on server restart
 */

import { exec } from "child_process";
import { promisify } from "util";
import { getDb, queries, type Session } from "./db";
import { getTmuxSessionName } from "./sessions";
import * as tmux from "./tmux";
import { escapeShellArg } from "./tmux";
import {
  destroyContainer,
  isContainerRunning,
  cleanupOrphanContainers,
} from "./container";
import { deleteWorktree, getMainRepoFromWorktree } from "./worktrees";
import { statusBroadcaster } from "./status-broadcaster";

const execAsync = promisify(exec);

export interface CreateSessionOptions {
  name?: string;
  workingDirectory: string;
  agentType: string;
  model?: string;
  projectId?: string;
  autoApprove?: boolean;
  // For worktree sessions
  worktreePath?: string;
  branchName?: string;
  baseBranch?: string;
}

class SessionManager {
  /**
   * Get a session by ID.
   * Returns null if the session does not exist.
   */
  async getSession(sessionId: string): Promise<Session | null> {
    const db = getDb();
    const session = queries.getSession(db).get(sessionId) as
      | Session
      | undefined;
    return session ?? null;
  }

  /**
   * Get the command to view (attach to) a session.
   * For sandboxed: docker exec ... tmux attach
   * For non-sandboxed: tmux attach
   */
  getViewCommand(session: Session): { command: string; args: string[] } {
    const tmuxName = getTmuxSessionName(session);

    // Check if this is a sandboxed session (has container and it's ready)
    const isSandboxed =
      session.container_id && session.container_status === "ready";

    if (isSandboxed) {
      // Docker exec to attach to tmux inside the container (use agentos socket)
      return {
        command: "docker",
        args: [
          "exec",
          "-it",
          session.container_id!,
          "tmux",
          "-L",
          tmux.TMUX_SOCKET,
          "attach",
          "-t",
          tmuxName,
        ],
      };
    }

    // Standard tmux attach (use agentos socket)
    return {
      command: "tmux",
      args: ["-L", tmux.TMUX_SOCKET, "attach", "-t", tmuxName],
    };
  }

  /**
   * Start the tmux session for a session that's ready.
   * Called after worktree/container setup is complete.
   *
   * @param sessionId - The session ID
   * @param agentCommand - The command to run in the tmux session (e.g., "claude --resume xyz")
   */
  async startTmuxSession(
    sessionId: string,
    agentCommand: string
  ): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const tmuxName = getTmuxSessionName(session);

    // Determine the working directory
    // For sandboxed sessions, use /workspace (the mount point inside the container)
    // For non-sandboxed, use worktree_path if available, otherwise working_directory
    const isSandboxed =
      session.container_id && session.container_status === "ready";
    let cwd: string;

    if (isSandboxed) {
      cwd = "/workspace";
    } else {
      cwd = session.worktree_path || session.working_directory;
      // Expand ~ to $HOME
      cwd = cwd.replace(/^~/, process.env.HOME || "");
    }

    // Build the tmux command
    // Use escapeShellArg to properly handle quotes in session names and commands
    // IMPORTANT: Always use -L agentos socket for consistency with hooks (see generate-config.ts)
    let tmuxCmd: string;
    if (isSandboxed) {
      // Create tmux session inside the container using the agentos socket
      // Container has .tmux.conf with mouse/resize settings
      // The -L agentos is critical: hooks query this socket to get the session name
      if (agentCommand) {
        tmuxCmd = `docker exec -d ${session.container_id} tmux -L ${tmux.TMUX_SOCKET} new-session -d -s ${escapeShellArg(tmuxName)} -c ${escapeShellArg(cwd)} ${escapeShellArg(agentCommand)}`;
      } else {
        tmuxCmd = `docker exec -d ${session.container_id} tmux -L ${tmux.TMUX_SOCKET} new-session -d -s ${escapeShellArg(tmuxName)} -c ${escapeShellArg(cwd)}`;
      }
    } else {
      // Create tmux session on the host (use agentos socket for consistency with hooks)
      if (agentCommand) {
        tmuxCmd = `tmux -L ${tmux.TMUX_SOCKET} new-session -d -s ${escapeShellArg(tmuxName)} -c ${escapeShellArg(cwd)} ${escapeShellArg(agentCommand)}`;
      } else {
        tmuxCmd = `tmux -L ${tmux.TMUX_SOCKET} new-session -d -s ${escapeShellArg(tmuxName)} -c ${escapeShellArg(cwd)}`;
      }
    }

    try {
      await execAsync(tmuxCmd, { timeout: 30000 });
      console.log(`[session-manager] Started tmux session ${tmuxName}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      console.error(
        `[session-manager] Failed to start tmux session ${tmuxName}:`,
        errorMsg
      );
      throw new Error(`Failed to start tmux session: ${errorMsg}`);
    }

    // Update lifecycle_status to 'ready'
    const db = getDb();
    queries.updateSessionLifecycleStatus(db).run("ready", sessionId);
    // Broadcast lifecycle change via SSE
    statusBroadcaster.updateStatus({
      sessionId,
      status: "idle",
      lifecycleStatus: "ready",
    });
    console.log(
      `[session-manager] Session ${sessionId} lifecycle_status set to ready`
    );
  }

  /**
   * Delete a session and all its resources.
   * This includes:
   * - Killing the tmux session
   * - Destroying the container (if any)
   * - Deleting the worktree (if any)
   * - Clearing status broadcaster state
   * - Deleting from database
   */
  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      console.warn(
        `[session-manager] Session ${sessionId} not found, nothing to delete`
      );
      return;
    }

    // Race condition guard - prevent concurrent deletes
    if (session.lifecycle_status === "deleting") {
      console.warn(
        `[session-manager] Session ${sessionId} already being deleted`
      );
      return;
    }

    // Mark as deleting FIRST to prevent concurrent deletes
    const db = getDb();
    queries.updateSessionLifecycleStatus(db).run("deleting", sessionId);

    const tmuxName = getTmuxSessionName(session);
    const isSandboxed =
      session.container_id && session.container_status === "ready";

    // Kill tmux session
    try {
      if (isSandboxed) {
        // Kill tmux inside the container (use agentos socket for consistency)
        await execAsync(
          `docker exec ${session.container_id} tmux -L ${tmux.TMUX_SOCKET} kill-session -t ${escapeShellArg(tmuxName)} 2>/dev/null || true`,
          { timeout: 10000 }
        );
      } else {
        // Kill tmux on the host (use agentos socket)
        await execAsync(
          `tmux -L ${tmux.TMUX_SOCKET} kill-session -t ${escapeShellArg(tmuxName)} 2>/dev/null || true`,
          { timeout: 5000 }
        );
      }
      console.log(`[session-manager] Killed tmux session ${tmuxName}`);
    } catch {
      // Ignore errors - session might already be dead
      console.log(`[session-manager] Tmux session ${tmuxName} was not running`);
    }

    // Destroy container if present
    if (session.container_id) {
      try {
        await destroyContainer(session.container_id);
        console.log(
          `[session-manager] Destroyed container ${session.container_id}`
        );
      } catch (error) {
        console.error(
          `[session-manager] Failed to destroy container ${session.container_id}:`,
          error
        );
        // Continue with deletion even if container cleanup fails
      }
    }

    // Clean up worktree if present
    if (session.worktree_path) {
      try {
        // Derive the main repo path from the worktree itself
        const mainRepoPath = await getMainRepoFromWorktree(
          session.worktree_path
        );
        if (mainRepoPath) {
          await deleteWorktree(session.worktree_path, mainRepoPath, false);
          console.log(
            `[session-manager] Deleted worktree ${session.worktree_path}`
          );
        } else {
          console.warn(
            `[session-manager] Could not determine main repo for worktree ${session.worktree_path}, skipping cleanup`
          );
        }
      } catch (error) {
        console.error(
          `[session-manager] Failed to delete worktree ${session.worktree_path}:`,
          error
        );
        // Continue with deletion even if worktree cleanup fails
      }
    }

    // Clear status broadcaster state
    statusBroadcaster.clearStatus(sessionId);

    // Delete from database
    queries.deleteSession(db).run(sessionId);
    console.log(`[session-manager] Deleted session ${sessionId} from database`);
  }

  /**
   * Check if a session's tmux is running.
   * Handles both sandboxed (container) and non-sandboxed sessions.
   */
  async isSessionAlive(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return false;
    }

    const tmuxName = getTmuxSessionName(session);
    const isSandboxed =
      session.container_id && session.container_status === "ready";

    if (isSandboxed) {
      // First check if container is running
      const containerRunning = await isContainerRunning(session.container_id!);
      if (!containerRunning) {
        return false;
      }

      // Then check if tmux session exists inside the container (use agentos socket)
      try {
        await execAsync(
          `docker exec ${session.container_id} tmux -L ${tmux.TMUX_SOCKET} has-session -t ${escapeShellArg(tmuxName)} 2>/dev/null`,
          { timeout: 5000 }
        );
        return true;
      } catch {
        return false;
      }
    }

    // Non-sandboxed: use the standard tmux utility
    return tmux.tmuxSessionExists(tmuxName);
  }

  /**
   * Recover sessions on server restart.
   * Re-sync DB state with actual tmux/container state.
   *
   * This method:
   * 1. Finds all sessions with lifecycle_status = 'creating' (stuck) and marks them as failed
   * 2. Finds all sessions with lifecycle_status = 'ready'
   * 3. Checks if their tmux session is actually alive
   * 4. Marks dead sessions with lifecycle_status = 'failed'
   * 5. Cleans up orphaned containers for failed sessions
   *
   * @returns Stats about the recovery operation
   */
  async recoverSessions(): Promise<{
    synced: number;
    alive: number;
    dead: number;
    stuckRecovered: number;
    deletingCleaned: number;
    orphanContainersRemoved: number;
  }> {
    const db = getDb();

    // Step 0: Clean up sessions stuck in 'deleting' status
    // These sessions were being deleted when the server crashed - finish the job
    const deletingSessions = queries
      .getSessionsByLifecycleStatus(db)
      .all("deleting") as Session[];
    let deletingCleaned = 0;

    console.log(
      `[session-manager] Found ${deletingSessions.length} sessions stuck in 'deleting' status`
    );

    for (const session of deletingSessions) {
      console.log(
        `[session-manager] Session ${session.id} (${session.name}) stuck in 'deleting', completing deletion`
      );

      // Kill tmux session first (for non-sandboxed sessions, or if container kill fails)
      const tmuxName = getTmuxSessionName(session);
      try {
        if (session.container_id) {
          // Try to kill tmux inside container
          await execAsync(
            `docker exec ${session.container_id} tmux -L ${tmux.TMUX_SOCKET} kill-session -t ${escapeShellArg(tmuxName)} 2>/dev/null || true`,
            { timeout: 5000 }
          );
        } else {
          // Kill tmux on host
          await execAsync(
            `tmux -L ${tmux.TMUX_SOCKET} kill-session -t ${escapeShellArg(tmuxName)} 2>/dev/null || true`,
            { timeout: 5000 }
          );
        }
        console.log(
          `[session-manager] Killed orphaned tmux session ${tmuxName} for deleting session ${session.id}`
        );
      } catch {
        // Ignore - session might already be dead
      }

      // Clean up container if present
      if (session.container_id) {
        try {
          await destroyContainer(session.container_id);
          console.log(
            `[session-manager] Destroyed orphaned container ${session.container_id} for deleting session ${session.id}`
          );
        } catch (error) {
          console.error(
            `[session-manager] Failed to destroy orphaned container ${session.container_id}:`,
            error
          );
        }
      }

      // Note: We intentionally do NOT delete worktrees for sessions stuck in 'deleting' status.
      // The user initiated a delete, but the server crashed mid-operation. The worktree may
      // contain uncommitted work. We delete the session record so the user can re-create
      // sessions, but preserve the worktree on disk for manual recovery if needed.
      // The worktree can be cleaned up manually at: ~/.agent-os/worktrees/

      // Clear SSE state and delete the session from DB
      statusBroadcaster.clearStatus(session.id);
      queries.deleteSession(db).run(session.id);
      deletingCleaned++;
    }

    // Step 1: Recover sessions stuck in 'creating' status
    // These sessions were being set up when the server crashed
    const creatingSessions = queries
      .getSessionsByLifecycleStatus(db)
      .all("creating") as Session[];
    let stuckRecovered = 0;

    console.log(
      `[session-manager] Found ${creatingSessions.length} sessions stuck in 'creating' status`
    );

    for (const session of creatingSessions) {
      console.log(
        `[session-manager] Session ${session.id} (${session.name}) stuck in 'creating', marking as failed`
      );
      queries.updateSessionLifecycleStatus(db).run("failed", session.id);
      queries
        .updateSessionSetupStatus(db)
        .run("failed", "Server restarted during setup", session.id);
      // Broadcast lifecycle and setup status change via SSE
      statusBroadcaster.updateStatus({
        sessionId: session.id,
        status: "dead",
        lifecycleStatus: "failed",
        setupStatus: "failed",
        setupError: "Server restarted during setup",
      });

      // Clean up any orphaned container
      if (session.container_id) {
        try {
          await destroyContainer(session.container_id);
          console.log(
            `[session-manager] Destroyed orphaned container ${session.container_id} for stuck session ${session.id}`
          );
        } catch (error) {
          console.error(
            `[session-manager] Failed to destroy orphaned container ${session.container_id}:`,
            error
          );
        }
      }

      // Note: We intentionally do NOT delete worktrees for sessions stuck in 'creating' status.
      // The session was being set up when the server crashed. The worktree may contain work
      // that the user started before the crash. We mark the session as failed so it's visible
      // in the UI, and the user can manually clean up or recover the worktree.
      // The worktree can be found at: ~/.agent-os/worktrees/

      // Clear SSE state for stuck session
      statusBroadcaster.clearStatus(session.id);

      stuckRecovered++;
    }

    // Step 2: Check sessions that claim to be 'ready'
    const readySessions = queries
      .getSessionsByLifecycleStatus(db)
      .all("ready") as Session[];

    let alive = 0;
    let dead = 0;

    console.log(
      `[session-manager] Recovering ${readySessions.length} 'ready' sessions...`
    );

    for (const session of readySessions) {
      const isAlive = await this.isSessionAlive(session.id);

      if (isAlive) {
        alive++;
        console.log(
          `[session-manager] Session ${session.id} (${session.name}) is alive`
        );
      } else {
        dead++;
        console.log(
          `[session-manager] Session ${session.id} (${session.name}) is dead, marking as failed`
        );
        queries.updateSessionLifecycleStatus(db).run("failed", session.id);
        // Broadcast lifecycle change via SSE
        statusBroadcaster.updateStatus({
          sessionId: session.id,
          status: "dead",
          lifecycleStatus: "failed",
        });

        // Clean up orphaned container if present
        if (session.container_id) {
          try {
            await destroyContainer(session.container_id);
            console.log(
              `[session-manager] Destroyed orphaned container ${session.container_id} for dead session ${session.id}`
            );
          } catch (error) {
            console.error(
              `[session-manager] Failed to destroy orphaned container ${session.container_id}:`,
              error
            );
          }
        }

        // Note: We intentionally do NOT delete worktrees for dead sessions.
        // The tmux session died (crash, reboot, etc.) but the worktree may contain
        // uncommitted work or unmerged commits. We mark the session as failed so it's
        // visible in the UI, and the user can explicitly delete it (with merge options)
        // or recover their work. The worktree can be found at: ~/.agent-os/worktrees/
      }
    }

    // Step 3: Clean up any orphan containers not associated with any session
    // This catches containers left behind from crashes or incomplete deletions
    const allSessions = queries.getAllSessions(db).all() as Session[];
    const validSessionIds = new Set(allSessions.map((s) => s.id));
    const orphanCleanup = await cleanupOrphanContainers(validSessionIds);

    if (orphanCleanup.removed > 0) {
      console.log(
        `[session-manager] Cleaned up ${orphanCleanup.removed} orphan container(s) out of ${orphanCleanup.found} total`
      );
    }

    const stats = {
      synced: readySessions.length,
      alive,
      dead,
      stuckRecovered,
      deletingCleaned,
      orphanContainersRemoved: orphanCleanup.removed,
    };

    console.log(
      `[session-manager] Recovery complete: ${stats.synced} ready sessions checked, ${stats.alive} alive, ${stats.dead} dead, ${stats.stuckRecovered} stuck sessions recovered, ${stats.deletingCleaned} deleting sessions cleaned, ${stats.orphanContainersRemoved} orphan containers removed`
    );

    return stats;
  }
}

// Export singleton instance
export const sessionManager = new SessionManager();
