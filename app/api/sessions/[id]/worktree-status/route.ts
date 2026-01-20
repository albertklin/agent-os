import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import {
  isAgentOSWorktree,
  hasUncommittedChanges,
  branchHasChanges,
} from "@/lib/worktrees";

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
      });
    }

    const baseBranch = session.base_branch || "main";

    // Check for uncommitted changes and branch status in parallel
    const [uncommitted, hasCommits] = await Promise.all([
      hasUncommittedChanges(session.worktree_path),
      branchHasChanges(session.worktree_path, baseBranch),
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
    });
  } catch (error) {
    console.error("Error checking worktree status:", error);
    return NextResponse.json(
      { error: "Failed to check worktree status" },
      { status: 500 }
    );
  }
}
