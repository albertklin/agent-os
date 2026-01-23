import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { getDb, queries, type Project } from "@/lib/db";

const execAsync = promisify(exec);

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface WorktreeRow {
  worktree_path: string;
  branch_name: string | null;
  base_branch: string | null;
  session_count: number;
}

interface WorktreeInfo {
  path: string;
  branchName: string;
  sessionCount: number;
  isMain: boolean;
}

/**
 * Get current branch name for a directory
 */
async function getCurrentBranch(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `git -C "${dir}" rev-parse --abbrev-ref HEAD`,
      { timeout: 5000 }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * GET /api/projects/[id]/worktrees
 *
 * Returns all worktrees for a project:
 * - Main worktree (project directory)
 * - Isolated worktrees (from sessions with worktree_path)
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id: projectId } = await params;
    const db = getDb();

    // Get project to find main worktree path
    const project = queries.getProject(db).get(projectId) as
      | Project
      | undefined;
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const mainWorktreePath = project.working_directory;
    const worktrees: WorktreeInfo[] = [];

    // Get current branch for main worktree
    const mainBranch = await getCurrentBranch(mainWorktreePath);

    // Count active sessions using the main worktree (no worktree_path)
    const mainWorktreeSessionCount = (
      db
        .prepare(
          `SELECT COUNT(*) as count FROM sessions
         WHERE project_id = ?
         AND (worktree_path IS NULL OR worktree_path = ?)
         AND lifecycle_status NOT IN ('failed', 'deleting')`
        )
        .get(projectId, mainWorktreePath) as { count: number }
    ).count;

    // Add main worktree
    worktrees.push({
      path: mainWorktreePath,
      branchName: mainBranch || "unknown",
      sessionCount: mainWorktreeSessionCount,
      isMain: true,
    });

    // Get isolated worktrees from sessions
    const isolatedWorktrees = queries
      .getWorktreesByProject(db)
      .all(projectId) as WorktreeRow[];

    for (const wt of isolatedWorktrees) {
      // Skip if this is the main worktree path
      if (wt.worktree_path === mainWorktreePath) {
        continue;
      }

      worktrees.push({
        path: wt.worktree_path,
        branchName: wt.branch_name || "unknown",
        sessionCount: wt.session_count,
        isMain: false,
      });
    }

    return NextResponse.json({ worktrees });
  } catch (error) {
    console.error("Error fetching worktrees:", error);
    return NextResponse.json(
      { error: "Failed to fetch worktrees" },
      { status: 500 }
    );
  }
}
