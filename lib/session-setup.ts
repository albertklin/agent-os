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
import { createWorktree, type CreateWorktreeOptions } from "@/lib/worktrees";
import { setupWorktree } from "@/lib/env-setup";
import { findAvailablePort } from "@/lib/ports";

const execAsync = promisify(exec);

export interface SessionSetupOptions {
  sessionId: string;
  projectPath: string;
  featureName: string;
  baseBranch: string;
}

/**
 * Update session setup status in DB and broadcast via SSE
 */
function updateSetupStatus(
  sessionId: string,
  setupStatus: SetupStatus,
  setupError: string | null = null
): void {
  try {
    const db = getDb();
    queries.updateSessionSetupStatus(db).run(setupStatus, setupError, sessionId);
  } catch (error) {
    console.error(`[session-setup] Failed to update DB status:`, error);
  }

  // Broadcast to SSE clients
  statusBroadcaster.updateStatus({
    sessionId,
    status: "idle",
    setupStatus,
    setupError: setupError ?? undefined,
  });
}

/**
 * Run the entire session setup process in the background.
 * This function should be called fire-and-forget style.
 */
export async function runSessionSetup(
  options: SessionSetupOptions
): Promise<void> {
  const { sessionId, projectPath, featureName, baseBranch } = options;

  console.log(`[session-setup] Starting setup for session ${sessionId}`);

  try {
    // Step 1: Create worktree
    updateSetupStatus(sessionId, "creating_worktree");

    const worktreeInfo = await createWorktree({
      projectPath,
      featureName,
      baseBranch,
    });

    // Update session with worktree info
    const port = await findAvailablePort();
    const db = getDb();
    queries
      .updateSessionWorktree(db)
      .run(
        worktreeInfo.worktreePath,
        worktreeInfo.branchName,
        worktreeInfo.baseBranch,
        port,
        sessionId
      );

    // Also update the working directory to the worktree path
    db.prepare(
      "UPDATE sessions SET working_directory = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(worktreeInfo.worktreePath, sessionId);

    // Step 2: Initialize submodules
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

    // Step 3: Install dependencies
    updateSetupStatus(sessionId, "installing_deps");

    const setupResult = await setupWorktree({
      worktreePath: worktreeInfo.worktreePath,
      sourcePath: projectPath,
      port,
    });

    if (!setupResult.success) {
      const errorMsg = setupResult.steps
        .filter((s) => !s.success && s.error)
        .map((s) => s.error)
        .join("; ");
      throw new Error(errorMsg || "Dependency installation failed");
    }

    // Step 4: Mark as ready
    updateSetupStatus(sessionId, "ready");
    console.log(`[session-setup] Setup completed for session ${sessionId}`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[session-setup] Setup failed for session ${sessionId}:`, errorMsg);
    updateSetupStatus(sessionId, "failed", errorMsg);
  }
}
