/**
 * Background Session Setup
 *
 * Handles the entire session setup process in the background:
 * 1. Create worktree
 * 2. Initialize submodules
 * 3. Install dependencies
 *
 * Progress is tracked via DB updates and SSE broadcasts.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { getDb, queries } from "@/lib/db";
import type { SetupStatus } from "@/lib/db/types";
import { statusBroadcaster } from "@/lib/status-broadcaster";
import { createWorktree, deleteWorktree } from "@/lib/worktrees";
import { setupWorktree } from "@/lib/env-setup";
import {
  createContainer,
  isDockerAvailable,
  verifyContainerHealth,
  destroyContainer,
  logSecurityEvent,
  countActiveContainers,
} from "@/lib/container";

// Maximum number of concurrent containers to prevent system resource exhaustion
// Each container uses ~4GB RAM limit, so 20 containers = 80GB theoretical max
const MAX_ACTIVE_CONTAINERS = 20;
import { parseMounts } from "@/lib/mounts";
import { parseDomains } from "@/lib/domains";
import { sessionManager } from "@/lib/session-manager";
import { buildAgentCommand } from "@/lib/sessions";

const execAsync = promisify(exec);

export interface SessionSetupOptions {
  sessionId: string;
  projectPath: string;
  featureName: string;
  baseBranch: string;
  initialPrompt?: string;
}

/**
 * Clean up worktree on setup failure.
 * This prevents orphaned worktrees from accumulating.
 */
async function cleanupWorktreeOnFailure(
  worktreePath: string,
  projectPath: string
): Promise<void> {
  try {
    await deleteWorktree(worktreePath, projectPath);
    console.log(
      `[session-setup] Cleaned up worktree after failure: ${worktreePath}`
    );
  } catch (error) {
    // Log but don't throw - cleanup is best-effort
    console.error(
      `[session-setup] Failed to clean up worktree ${worktreePath}:`,
      error instanceof Error ? error.message : "Unknown error"
    );
  }
}

/**
 * Update session setup status in DB and broadcast via SSE
 */
function updateSetupStatus(
  sessionId: string,
  setupStatus: SetupStatus,
  setupError: string | null = null,
  lifecycleStatus?: "creating" | "ready" | "failed" | "deleting"
): void {
  try {
    const db = getDb();
    queries
      .updateSessionSetupStatus(db)
      .run(setupStatus, setupError, sessionId);

    // Update lifecycle_status if provided
    if (lifecycleStatus) {
      queries.updateSessionLifecycleStatus(db).run(lifecycleStatus, sessionId);
    }
  } catch (error) {
    console.error(`[session-setup] Failed to update DB status:`, error);
  }

  // Broadcast to SSE clients
  statusBroadcaster.updateStatus({
    sessionId,
    status: "idle",
    setupStatus,
    setupError: setupError ?? undefined,
    lifecycleStatus,
  });
}

/**
 * Run the entire session setup process in the background.
 * This function should be called fire-and-forget style.
 */
export async function runSessionSetup(
  options: SessionSetupOptions
): Promise<void> {
  const { sessionId, projectPath, featureName, baseBranch, initialPrompt } =
    options;

  console.log(`[session-setup] Starting setup for session ${sessionId}`);

  // Track worktree path for cleanup in catch block
  let worktreePath: string | null = null;
  // Track container ID for cleanup in catch block
  let containerId: string | null = null;

  try {
    // NOTE: With lifecycle guards, sessions cannot be deleted while in 'creating' state.
    // This means we don't need to check if the session was deleted during setup.
    // If setup fails, we clean up resources and mark the session as 'failed'.

    // Step 1: Create worktree
    updateSetupStatus(sessionId, "creating_worktree");

    const worktreeInfo = await createWorktree({
      projectPath,
      featureName,
      baseBranch,
    });
    worktreePath = worktreeInfo.worktreePath; // Track for cleanup

    // Update session with worktree info (atomic transaction)
    const db = getDb();
    db.transaction(() => {
      queries
        .updateSessionWorktree(db)
        .run(
          worktreeInfo.worktreePath,
          worktreeInfo.branchName,
          worktreeInfo.baseBranch,
          sessionId
        );

      // Also update the working directory to the worktree path
      db.prepare(
        "UPDATE sessions SET working_directory = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(worktreeInfo.worktreePath, sessionId);
    })();

    // Step 2: Initialize container for auto-approve sessions
    // This must happen AFTER worktree creation so container can mount the worktree
    const session = queries.getSession(db).get(sessionId) as {
      auto_approve: number;
      agent_type: string;
      extra_mounts: string | null;
      allowed_domains: string | null;
    } | null;

    if (session?.auto_approve && session?.agent_type === "claude") {
      // Check if Docker is available before attempting container creation
      if (await isDockerAvailable()) {
        // Enforce container count limit to prevent resource exhaustion
        const activeCount = await countActiveContainers();
        if (activeCount >= MAX_ACTIVE_CONTAINERS) {
          console.error(
            `[container] Container limit (${MAX_ACTIVE_CONTAINERS}) reached, cannot create container for session ${sessionId}`
          );
          await cleanupWorktreeOnFailure(
            worktreeInfo.worktreePath,
            projectPath
          );
          // Clear stale worktree DB fields after cleanup
          db.prepare(
            `
            UPDATE sessions
            SET worktree_path = NULL, branch_name = NULL, base_branch = NULL, working_directory = ?
            WHERE id = ?
          `
          ).run(projectPath, sessionId);
          updateSetupStatus(
            sessionId,
            "failed",
            `Container limit reached (${MAX_ACTIVE_CONTAINERS}). Please delete some existing sessions to create new sandboxed sessions.`,
            "failed"
          );
          return; // Abort setup
        }

        updateSetupStatus(sessionId, "init_container");

        try {
          console.log(
            `[container] Creating container for session ${sessionId}`
          );
          const containerResult = await createContainer({
            sessionId,
            worktreePath: worktreeInfo.worktreePath,
            extraMounts: parseMounts(session.extra_mounts),
            allowedDomains: parseDomains(session.allowed_domains),
          });
          containerId = containerResult.containerId; // Track for cleanup

          // SECURITY: Verify health BEFORE marking ready
          const health = await verifyContainerHealth(
            containerId,
            worktreeInfo.worktreePath
          );

          if (!health.healthy) {
            // Unhealthy - destroy and fail
            console.error(
              `[container] Health check failed for session ${sessionId}: ${health.error}`
            );
            await destroyContainer(containerId).catch(() => {});

            logSecurityEvent({
              type: "container_created",
              sessionId,
              containerId,
              success: false,
              error: `Health check failed: ${health.error}`,
            });

            queries
              .updateSessionContainerWithHealth(db)
              .run(null, "failed", "unhealthy", sessionId);

            // Container health check failed - clean up worktree and mark as failed
            await cleanupWorktreeOnFailure(
              worktreeInfo.worktreePath,
              projectPath
            );
            // Clear stale worktree DB fields after cleanup
            db.prepare(
              `
              UPDATE sessions
              SET worktree_path = NULL, branch_name = NULL, base_branch = NULL, working_directory = ?
              WHERE id = ?
            `
            ).run(projectPath, sessionId);
            updateSetupStatus(
              sessionId,
              "failed",
              `Container health check failed: ${health.error}`,
              "failed"
            );
            return; // Abort setup
          } else {
            // Healthy - mark as ready
            logSecurityEvent({
              type: "container_created",
              sessionId,
              containerId,
              success: true,
            });

            // ATOMIC: Update DB with health status
            queries
              .updateSessionContainerWithHealth(db)
              .run(containerId, "ready", "healthy", sessionId);
          }
        } catch (error) {
          // Container creation failed - mark as failed to prevent terminal access
          const errorMsg =
            error instanceof Error ? error.message : "Unknown error";
          console.error(
            `[container] Failed to create container for session ${sessionId}: ${errorMsg}`
          );

          logSecurityEvent({
            type: "container_created",
            sessionId,
            success: false,
            error: errorMsg,
          });

          queries
            .updateSessionContainerWithHealth(db)
            .run(null, "failed", "unhealthy", sessionId);

          // Container creation failed - clean up worktree and mark as failed
          await cleanupWorktreeOnFailure(
            worktreeInfo.worktreePath,
            projectPath
          );
          // Clear stale worktree DB fields after cleanup
          db.prepare(
            `
            UPDATE sessions
            SET worktree_path = NULL, branch_name = NULL, base_branch = NULL, working_directory = ?
            WHERE id = ?
          `
          ).run(projectPath, sessionId);
          updateSetupStatus(sessionId, "failed", errorMsg, "failed");
          return; // Abort setup
        }
      } else {
        console.warn(
          `[container] Docker not available, skipping container for session ${sessionId}`
        );
        // Mark container as failed since we can't provide isolation
        queries
          .updateSessionContainerWithHealth(db)
          .run(null, "failed", null, sessionId);

        // Docker not available - clean up worktree and mark as failed
        await cleanupWorktreeOnFailure(worktreeInfo.worktreePath, projectPath);
        // Clear stale worktree DB fields after cleanup
        db.prepare(
          `
          UPDATE sessions
          SET worktree_path = NULL, branch_name = NULL, base_branch = NULL, working_directory = ?
          WHERE id = ?
        `
        ).run(projectPath, sessionId);
        updateSetupStatus(
          sessionId,
          "failed",
          "Docker is not available for sandboxed session",
          "failed"
        );
        return; // Abort setup
      }
    }

    // Step 3: Initialize submodules
    updateSetupStatus(sessionId, "init_submodules");

    try {
      await execAsync(
        `git -C "${worktreeInfo.worktreePath}" submodule update --init --recursive`,
        { timeout: 120000 }
      );
    } catch {
      // Ignore submodule errors - repo might not have submodules
      console.log(
        `[session-setup] Submodule init completed (may have no submodules)`
      );
    }

    // Step 4: Install dependencies
    updateSetupStatus(sessionId, "installing_deps");

    const setupResult = await setupWorktree({
      worktreePath: worktreeInfo.worktreePath,
      sourcePath: projectPath,
    });

    if (!setupResult.success) {
      const errorMsg = setupResult.steps
        .filter((s) => !s.success && s.error)
        .map((s) => s.error)
        .join("; ");
      throw new Error(errorMsg || "Dependency installation failed");
    }

    // Step 5: Start the tmux session
    // This creates the tmux session that the terminal will attach to
    updateSetupStatus(sessionId, "starting_session");

    // Get full session info to build the agent command
    const fullSession = queries.getSession(db).get(sessionId) as {
      agent_type: string;
      model: string;
      auto_approve: number;
    } | null;

    const agentCommand = fullSession
      ? buildAgentCommand(fullSession.agent_type, {
          model: fullSession.model,
          autoApprove: Boolean(fullSession.auto_approve),
          initialPrompt,
        })
      : "";

    await sessionManager.startTmuxSession(sessionId, agentCommand);

    // Step 6: Mark as ready (both setup_status and lifecycle_status)
    updateSetupStatus(sessionId, "ready", null, "ready");

    console.log(`[session-setup] Setup completed for session ${sessionId}`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error(
      `[session-setup] Setup failed for session ${sessionId}:`,
      errorMsg
    );

    const db = getDb();

    // Clean up container if it was created
    if (containerId) {
      try {
        await destroyContainer(containerId);
        console.log(
          `[session-setup] Cleaned up container ${containerId} after failure`
        );
      } catch (cleanupError) {
        console.error(
          `[session-setup] Failed to clean up container ${containerId}:`,
          cleanupError instanceof Error ? cleanupError.message : "Unknown error"
        );
      }
      // Clear container DB fields regardless of whether destroy succeeded
      queries
        .updateSessionContainerWithHealth(db)
        .run(null, "failed", null, sessionId);
    }

    // Clean up worktree if it was created
    if (worktreePath) {
      await cleanupWorktreeOnFailure(worktreePath, projectPath);
      // Clear stale worktree DB fields after cleanup
      db.prepare(
        `
        UPDATE sessions
        SET worktree_path = NULL, branch_name = NULL, base_branch = NULL, working_directory = ?
        WHERE id = ?
      `
      ).run(projectPath, sessionId);
    }

    // Update both setup_status and lifecycle_status, and broadcast via SSE
    updateSetupStatus(sessionId, "failed", errorMsg, "failed");
  }
}
