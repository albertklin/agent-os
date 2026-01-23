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

export interface BranchInfo {
  name: string; // branch name
  worktreePath: string | null; // null if no worktree exists for this branch
  sessionCount: number; // sessions using this branch's worktree
  isCheckedOutInMain: boolean; // true if this is the current branch in project dir
  hasUncommittedChanges?: boolean; // true if the worktree has uncommitted changes
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
 * Get all local branch names
 */
async function getAllBranches(dir: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      `git -C "${dir}" branch --list --format="%(refname:short)"`,
      { timeout: 5000 }
    );
    return stdout
      .trim()
      .split("\n")
      .filter((b) => b.length > 0);
  } catch {
    return [];
  }
}

/**
 * Check if a directory has uncommitted changes (staged or unstaged)
 */
async function hasUncommittedChanges(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`git -C "${dir}" status --porcelain`, {
      timeout: 5000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * GET /api/projects/[id]/worktrees
 *
 * Returns all branches for a project with worktree information:
 * - Branch name
 * - Worktree path (null if no worktree exists)
 * - Session count (for branches with worktrees)
 * - Whether this branch is checked out in the main project directory
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

    // Get current branch in main worktree
    const mainBranch = await getCurrentBranch(mainWorktreePath);

    // Get all local branches
    const allBranches = await getAllBranches(mainWorktreePath);

    // Count active sessions using the main worktree (no worktree_path or main path)
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

    // Get isolated worktrees from sessions (branch -> worktree mapping)
    const isolatedWorktrees = queries
      .getWorktreesByProject(db)
      .all(projectId) as WorktreeRow[];

    // Build a map of branch name -> worktree info
    const branchToWorktree = new Map<
      string,
      { path: string; sessionCount: number }
    >();

    for (const wt of isolatedWorktrees) {
      if (wt.branch_name && wt.worktree_path !== mainWorktreePath) {
        branchToWorktree.set(wt.branch_name, {
          path: wt.worktree_path,
          sessionCount: wt.session_count,
        });
      }
    }

    // Build the branches response, checking uncommitted changes for worktrees
    const branchPromises = allBranches.map(async (branchName) => {
      const isMainBranch = branchName === mainBranch;
      const worktreeInfo = branchToWorktree.get(branchName);
      const worktreePath = isMainBranch
        ? mainWorktreePath
        : worktreeInfo?.path || null;

      // Check for uncommitted changes if this branch has a worktree
      let uncommittedChanges: boolean | undefined;
      if (worktreePath) {
        uncommittedChanges = await hasUncommittedChanges(worktreePath);
      }

      return {
        name: branchName,
        worktreePath,
        sessionCount: isMainBranch
          ? mainWorktreeSessionCount
          : worktreeInfo?.sessionCount || 0,
        isCheckedOutInMain: isMainBranch,
        hasUncommittedChanges: uncommittedChanges,
      } as BranchInfo;
    });

    const branches = await Promise.all(branchPromises);

    // Sort: main branch first, then alphabetically
    branches.sort((a, b) => {
      if (a.isCheckedOutInMain) return -1;
      if (b.isCheckedOutInMain) return 1;
      return a.name.localeCompare(b.name);
    });

    // Also return worktrees for backward compatibility and for the WorktreeSelector
    // to know about existing worktrees
    const worktrees = branches
      .filter((b) => b.worktreePath !== null)
      .map((b) => ({
        path: b.worktreePath!,
        branchName: b.name,
        sessionCount: b.sessionCount,
        isMain: b.isCheckedOutInMain,
      }));

    return NextResponse.json({ branches, worktrees });
  } catch (error) {
    console.error("Error fetching branches:", error);
    return NextResponse.json(
      { error: "Failed to fetch branches" },
      { status: 500 }
    );
  }
}
