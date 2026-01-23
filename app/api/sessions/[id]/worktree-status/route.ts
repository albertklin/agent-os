import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs";
import * as os from "os";
import { getDb, queries, type Session } from "@/lib/db";
import {
  isAgentOSWorktree,
  hasUncommittedChanges,
  branchHasChanges,
  getMainRepoFromWorktree,
} from "@/lib/worktrees";
import { getCommitCount, getBranches } from "@/lib/git";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/sessions/[id]/worktree-status - Check worktree status before deletion
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();
    const session = queries.getSession(db).get(id) as Session | undefined;

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // If not a worktree session, no warnings needed
    if (!session.worktree_path || !isAgentOSWorktree(session.worktree_path)) {
      return NextResponse.json({
        hasWorktree: false,
        hasUncommittedChanges: false,
        branchWillBeDeleted: false,
        branchName: null,
        siblingSessionNames: [],
        baseBranch: null,
        commitCount: 0,
        branches: [],
      });
    }

    // If worktree path is set but directory doesn't exist (e.g., session failed to start),
    // treat as no worktree - safe to delete without warnings
    const resolvedWorktreePath = session.worktree_path.replace(
      /^~/,
      os.homedir()
    );
    if (!fs.existsSync(resolvedWorktreePath)) {
      return NextResponse.json({
        hasWorktree: false,
        hasUncommittedChanges: false,
        branchWillBeDeleted: false,
        branchName: null,
        siblingSessionNames: [],
        baseBranch: null,
        commitCount: 0,
        branches: [],
      });
    }

    if (!session.base_branch) {
      return NextResponse.json(
        {
          error:
            "Session has a worktree but no base branch recorded. This may be a legacy session.",
        },
        { status: 400 }
      );
    }
    const baseBranch = session.base_branch;

    // Get main repo for branch listing
    const mainRepo = await getMainRepoFromWorktree(session.worktree_path);

    // Check for uncommitted changes, branch status, and get commit count in parallel
    const [uncommitted, hasCommits, commitCount, branches] = await Promise.all([
      hasUncommittedChanges(session.worktree_path),
      branchHasChanges(session.worktree_path, baseBranch),
      getCommitCount(session.worktree_path, baseBranch),
      mainRepo ? getBranches(mainRepo) : Promise.resolve([]),
    ]);

    // Check for active sibling sessions sharing this worktree
    // (excludes failed/deleting sessions that shouldn't prevent cleanup)
    const siblings = queries
      .getActiveSiblingSessionsByWorktree(db)
      .all(session.worktree_path, id) as Session[];
    const siblingSessionNames = siblings.map((s) => s.name);

    return NextResponse.json({
      hasWorktree: true,
      hasUncommittedChanges: uncommitted,
      branchWillBeDeleted: !hasCommits,
      branchName: session.branch_name || null,
      siblingSessionNames,
      baseBranch,
      commitCount,
      branches,
    });
  } catch (error) {
    console.error("Error checking worktree status:", error);
    return NextResponse.json(
      { error: "Failed to check worktree status" },
      { status: 500 }
    );
  }
}
