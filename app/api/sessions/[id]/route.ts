import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { getDb, queries, type Session } from "@/lib/db";
import {
  deleteWorktree,
  isAgentOSWorktree,
  branchHasChanges,
} from "@/lib/worktrees";
import { generateBranchName, getCurrentBranch, renameBranch } from "@/lib/git";
import { runInBackground } from "@/lib/async-operations";
import { destroyContainer, logSecurityEvent } from "@/lib/container";
import { statusBroadcaster } from "@/lib/status-broadcaster";
import { clearPendingPrompt } from "@/stores/initialPrompt";

const execAsync = promisify(exec);

// Sanitize a name for use as tmux session name
function sanitizeTmuxName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-") // Replace non-alphanumeric with dashes
    .replace(/-+/g, "-") // Collapse multiple dashes
    .replace(/^-|-$/g, "") // Remove leading/trailing dashes
    .slice(0, 50); // Limit length
}

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

    // Handle name change - also rename tmux session and git branch (for worktrees)
    if (body.name !== undefined && body.name !== existing.name) {
      const newTmuxName = sanitizeTmuxName(body.name);
      const oldTmuxName = existing.tmux_name;

      // Try to rename the tmux session
      if (oldTmuxName && newTmuxName) {
        try {
          await execAsync(
            `tmux rename-session -t "${oldTmuxName}" "${newTmuxName}"`
          );
          updates.push("tmux_name = ?");
          values.push(newTmuxName);
        } catch {
          // tmux session might not exist or rename failed - that's ok, just update the name
          // Still update tmux_name in DB so future attachments use the new name
          updates.push("tmux_name = ?");
          values.push(newTmuxName);
        }
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

// DELETE /api/sessions/[id] - Delete session
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();

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

    // Kill the tmux session if it exists
    if (existing.tmux_name) {
      try {
        await execAsync(
          `tmux kill-session -t "${existing.tmux_name}" 2>/dev/null || true`
        );
      } catch {
        // Ignore errors - session might already be dead
      }
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

    // Check if branch has changes before deleting (for user feedback)
    let branchDeleted = false;
    let branchName: string | undefined;
    let shouldDeleteBranch = false;
    let shouldDeleteWorktree = true;

    if (existing.worktree_path && isAgentOSWorktree(existing.worktree_path)) {
      const worktreePath = existing.worktree_path;
      const baseBranch = existing.base_branch || "main";
      branchName = existing.branch_name || undefined;

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
        shouldDeleteBranch = !hasChanges;
        branchDeleted = shouldDeleteBranch;
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
      const deleteBranch = shouldDeleteBranch; // Capture the pre-computed value
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
          await deleteWorktree(worktreePath, gitCommonDir, deleteBranch);
        }
      }, `cleanup-worktree-${id}`);
    }

    return NextResponse.json({ success: true, branchDeleted, branchName });
  } catch (error) {
    console.error("Error deleting session:", error);
    return NextResponse.json(
      { error: "Failed to delete session" },
      { status: 500 }
    );
  }
}
