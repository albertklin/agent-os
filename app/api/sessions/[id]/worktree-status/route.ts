import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { isAgentOSWorktree, hasUncommittedChanges } from "@/lib/worktrees";

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
      });
    }

    // Check for uncommitted changes
    const uncommitted = await hasUncommittedChanges(session.worktree_path);

    return NextResponse.json({
      hasWorktree: true,
      hasUncommittedChanges: uncommitted,
    });
  } catch (error) {
    console.error("Error checking worktree status:", error);
    return NextResponse.json(
      { error: "Failed to check worktree status" },
      { status: 500 }
    );
  }
}
