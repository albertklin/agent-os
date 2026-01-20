import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/sessions/[id]/defer - Defer a session
 *
 * Updates the session's updated_at timestamp to make it the "newest"
 * in the queue. Used for Quick Respond to skip a session temporarily.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();

    const existing = queries.getSession(db).get(id) as Session | undefined;
    if (!existing) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Update the timestamp to make this session the "newest"
    db.prepare(
      `UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`
    ).run(id);

    const session = queries.getSession(db).get(id) as Session;
    return NextResponse.json({ session });
  } catch (error) {
    console.error("Error deferring session:", error);
    return NextResponse.json(
      { error: "Failed to defer session" },
      { status: 500 }
    );
  }
}
