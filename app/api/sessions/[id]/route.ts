import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { getDb, queries, type Session } from "@/lib/db";
import {
  deleteWorktree,
  isAgentOSWorktree,
  branchHasChanges,
} from "@/lib/worktrees";
import {
  generateBranchName,
  getCurrentBranch,
  renameBranch,
  mergeBranch,
  deleteBranch,
  remoteBranchExists,
  slugify,
} from "@/lib/git";
import {
  getMainRepoFromWorktree,
  hasUncommittedChanges,
  discardUncommittedChanges,
} from "@/lib/worktrees";
import { runInBackground } from "@/lib/async-operations";
import { destroyContainer, logSecurityEvent } from "@/lib/container";
import { statusBroadcaster } from "@/lib/status-broadcaster";
import { clearPendingPrompt } from "@/stores/initialPrompt";
import { TMUX_SOCKET } from "@/lib/tmux";
import { getTmuxSessionName } from "@/lib/sessions";

const execAsync = promisify(exec);

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/sessions/[id] - Get single session
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();
    const session = queries.getSession(db).get(id) as Session | undefined;

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    return NextResponse.json({ session });
  } catch (error) {
    console.error("Error fetching session:", error);
    return NextResponse.json(
      { error: "Failed to fetch session" },
      { status: 500 }
    );
  }
}

// PATCH /api/sessions/[id] - Update session
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json();
    const db = getDb();

    const existing = queries.getSession(db).get(id) as Session | undefined;
    if (!existing) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Lifecycle guard: only allow updates when session is ready
    if (existing.lifecycle_status !== "ready") {
      return NextResponse.json(
        {
          error: "Session is not ready for updates",
          lifecycle_status: existing.lifecycle_status,
        },
        { status: 409 }
      );
    }

    // Build update query dynamically based on provided fields
    const updates: string[] = [];
    const values: unknown[] = [];

    // Handle name change - also rename git branch (for worktrees)
    // Note: We intentionally do NOT rename the tmux session. The tmux session name
    // is deterministic ({agent_type}-{session_id}) to prevent desync issues.
    // The session "name" is purely a UI display name.
    if (body.name !== undefined && body.name !== existing.name) {
      // Reject names that don't contain at least one alphanumeric character
      const newSlug = slugify(body.name);
      if (!newSlug) {
        return NextResponse.json(
          {
            error:
              "Session name must contain at least one alphanumeric character",
          },
          { status: 400 }
        );
      }

      // If this is a worktree session, also rename the git branch
      if (existing.worktree_path && isAgentOSWorktree(existing.worktree_path)) {
        try {
          const currentBranch = await getCurrentBranch(existing.worktree_path);
          const newBranchName = generateBranchName(body.name);

          if (currentBranch !== newBranchName) {
            const result = await renameBranch(
              existing.worktree_path,
              currentBranch,
              newBranchName
            );
            console.log(
              `Renamed branch ${currentBranch} → ${newBranchName}`,
              result.remoteRenamed ? "(also on remote)" : "(local only)"
            );
            // Update branch_name in database to stay in sync
            updates.push("branch_name = ?");
            values.push(newBranchName);
          }
        } catch (error) {
          console.error("Failed to rename git branch:", error);
          // Continue with session rename even if branch rename fails
        }
      }

      updates.push("name = ?");
      values.push(body.name);
    }
    if (body.status !== undefined) {
      updates.push("status = ?");
      values.push(body.status);
    }
    if (body.workingDirectory !== undefined) {
      updates.push("working_directory = ?");
      values.push(body.workingDirectory);
    }
    if (body.systemPrompt !== undefined) {
      updates.push("system_prompt = ?");
      values.push(body.systemPrompt);
    }
    if (body.groupPath !== undefined) {
      updates.push("group_path = ?");
      values.push(body.groupPath);
    }
    if (body.projectId !== undefined) {
      updates.push("project_id = ?");
      values.push(body.projectId);
    }
    if (body.sortOrder !== undefined) {
      updates.push("sort_order = ?");
      values.push(body.sortOrder);
    }
    if (body.claude_session_id !== undefined) {
      updates.push("claude_session_id = ?");
      values.push(body.claude_session_id);
    }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      values.push(id);

      db.prepare(`UPDATE sessions SET ${updates.join(", ")} WHERE id = ?`).run(
        ...values
      );
    }

    const session = queries.getSession(db).get(id) as Session;
    return NextResponse.json({ session });
  } catch (error) {
    console.error("Error updating session:", error);
    return NextResponse.json(
      { error: "Failed to update session" },
      { status: 500 }
    );
  }
}

interface DeleteRequestBody {
  mergeInto?: string; // target branch name, or null to skip merge
  discardUncommittedChanges?: boolean; // discard uncommitted changes before merge
}

// DELETE /api/sessions/[id] - Delete session
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();

    // Parse optional body for merge options
    let body: DeleteRequestBody = {};
    try {
      const text = await request.text();
      if (text) {
        body = JSON.parse(text);
      }
    } catch {
      // No body or invalid JSON - that's fine, use defaults
    }

    const existing = queries.getSession(db).get(id) as Session | undefined;
    if (!existing) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Lifecycle guard: only prevent deletion if already deleting
    // Allow deletion in any other state (ready, failed, creating) for cleanup
    if (existing.lifecycle_status === "deleting") {
      return NextResponse.json(
        {
          error: "Session is already being deleted",
          lifecycle_status: existing.lifecycle_status,
        },
        { status: 409 }
      );
    }

    // Mark session as deleting immediately for UI feedback and to prevent new connections
    queries.updateSessionLifecycleStatus(db).run("deleting", id);
    // Broadcast lifecycle change via SSE
    statusBroadcaster.updateStatus({
      sessionId: id,
      status: "idle",
      lifecycleStatus: "deleting",
    });

    // NOTE: We intentionally delay killing tmux and destroying the container until AFTER
    // the merge check succeeds. This way, if a merge conflict occurs:
    // - The session is restored to "ready" status
    // - The tmux session remains running (user can ask Claude to resolve conflicts)
    // - The container remains intact (files are preserved)

    // Check if branch has changes before deleting (for user feedback)
    let branchDeleted = false;
    let branchMerged = false;
    let branchName: string | undefined;
    let shouldDeleteBranch = false;
    let shouldDeleteWorktree = true;
    let mainRepoPath: string | null = null;

    if (existing.worktree_path && isAgentOSWorktree(existing.worktree_path)) {
      const worktreePath = existing.worktree_path;
      if (!existing.base_branch) {
        return NextResponse.json(
          {
            error:
              "Session has a worktree but no base branch recorded. This may be a legacy session that needs manual cleanup.",
          },
          { status: 400 }
        );
      }
      const baseBranch = existing.base_branch;
      branchName = existing.branch_name || undefined;

      // Get main repo path for merge operations
      mainRepoPath = await getMainRepoFromWorktree(worktreePath);

      // Check if other ACTIVE sessions share this worktree
      // (excludes failed/deleting sessions that shouldn't prevent cleanup)
      const siblings = queries
        .getActiveSiblingSessionsByWorktree(db)
        .all(worktreePath, id) as Session[];
      if (siblings.length > 0) {
        // Other sessions use this worktree - don't delete it
        shouldDeleteWorktree = false;
      } else {
        // Check synchronously so we can report the outcome to the user
        const hasChanges = await branchHasChanges(worktreePath, baseBranch);

        // Handle merge request if provided
        if (body.mergeInto && branchName && hasChanges && mainRepoPath) {
          // Check for uncommitted changes
          const hasUncommitted = await hasUncommittedChanges(worktreePath);
          if (hasUncommitted) {
            if (body.discardUncommittedChanges) {
              // User chose to discard uncommitted changes
              await discardUncommittedChanges(worktreePath);
            } else {
              // Restore lifecycle status since we're not deleting
              queries.updateSessionLifecycleStatus(db).run("ready", id);
              statusBroadcaster.updateStatus({
                sessionId: id,
                status: "idle",
                lifecycleStatus: "ready",
              });
              return NextResponse.json(
                {
                  success: false,
                  error: "uncommitted_changes",
                  message: "Cannot merge: session has uncommitted changes",
                },
                { status: 400 }
              );
            }
          }

          // Attempt the merge
          const mergeResult = await mergeBranch(
            mainRepoPath,
            branchName,
            body.mergeInto
          );

          if (!mergeResult.success) {
            // Restore lifecycle status since we're not deleting
            queries.updateSessionLifecycleStatus(db).run("ready", id);
            statusBroadcaster.updateStatus({
              sessionId: id,
              status: "idle",
              lifecycleStatus: "ready",
            });
            return NextResponse.json(
              {
                success: false,
                error: "merge_conflict",
                message:
                  "Merge aborted due to conflicts. Resolve conflicts in session branch before retrying.",
                conflictFiles: mergeResult.conflictFiles,
                branchStatus: "clean", // Branch is not in a conflict state - merge was aborted
              },
              { status: 409 }
            );
          }

          // Merge succeeded - mark branch for deletion
          branchMerged = true;
          shouldDeleteBranch = true;
        } else {
          // No merge requested - only delete branch if it has no commits
          shouldDeleteBranch = !hasChanges;
        }
        branchDeleted = shouldDeleteBranch;
      }
    }

    // At this point, all merge checks have passed (or no merge was needed).
    // Now we can safely clean up the tmux session and container.

    // Kill the tmux session if it exists
    // Use deterministic tmux name to ensure we kill the correct session
    const tmuxName = getTmuxSessionName(existing);
    try {
      await execAsync(
        `tmux -L ${TMUX_SOCKET} kill-session -t "${tmuxName}" 2>/dev/null || true`
      );
    } catch {
      // Ignore errors - session might already be dead
    }

    // Clean up container if this session had one (synchronous with logging)
    if (existing.container_id) {
      try {
        await destroyContainer(existing.container_id);
        logSecurityEvent({
          type: "container_destroyed",
          sessionId: id,
          containerId: existing.container_id,
          success: true,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        logSecurityEvent({
          type: "container_destroyed",
          sessionId: id,
          containerId: existing.container_id,
          success: false,
          error: errorMsg,
        });
        console.error(
          `[session] WARNING: Orphaned container ${existing.container_id} - manual cleanup required:`,
          err
        );
        // Don't fail the deletion, but log the orphaned container
      }
    }

    // Delete from database immediately for instant UI feedback
    queries.deleteSession(db).run(id);

    // Clean up in-memory state to prevent memory leaks
    statusBroadcaster.clearStatus(id);
    clearPendingPrompt(id);

    // Clean up worktree in background (non-blocking) - only if no siblings
    if (
      shouldDeleteWorktree &&
      existing.worktree_path &&
      isAgentOSWorktree(existing.worktree_path)
    ) {
      const worktreePath = existing.worktree_path; // Capture for closure
      const branchToDelete = shouldDeleteBranch ? branchName : undefined;
      const wasMerged = branchMerged; // Capture for closure
      runInBackground(async () => {
        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        const execAsync = promisify(exec);

        const { stdout } = await execAsync(
          `git -C "${worktreePath}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo ""`,
          { timeout: 5000 }
        );
        const gitCommonDir = stdout.trim().replace(/\/.git$/, "");

        if (gitCommonDir) {
          // Delete worktree first (without deleting branch - we'll handle that separately)
          await deleteWorktree(worktreePath, gitCommonDir, false);

          // Then delete branch if needed (including remote if it was merged)
          if (branchToDelete) {
            try {
              await deleteBranch(gitCommonDir, branchToDelete, wasMerged);
            } catch (error) {
              console.warn(
                `[session] Branch deletion failed for ${branchToDelete}:`,
                error instanceof Error ? error.message : "Unknown error"
              );
            }
          }
        }
      }, `cleanup-worktree-${id}`);
    }

    return NextResponse.json({
      success: true,
      branchDeleted,
      branchMerged,
      branchName,
    });
  } catch (error) {
    console.error("Error deleting session:", error);
    return NextResponse.json(
      { error: "Failed to delete session" },
      { status: 500 }
    );
  }
}
