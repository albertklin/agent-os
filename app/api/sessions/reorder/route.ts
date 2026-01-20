import { NextRequest, NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";

interface SessionOrder {
  sessionId: string;
  projectId: string;
  sortOrder: number;
}

// POST /api/sessions/reorder - Bulk update session order and project assignments
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessions } = body as { sessions: SessionOrder[] };

    if (!Array.isArray(sessions)) {
      return NextResponse.json(
        { error: "sessions must be an array" },
        { status: 400 }
      );
    }

    const db = getDb();

    // Update all sessions in a transaction for consistency
    const updateStmt = queries.updateSessionProjectAndOrder(db);

    db.transaction(() => {
      for (const { sessionId, projectId, sortOrder } of sessions) {
        updateStmt.run(projectId, sortOrder, sessionId);
      }
    })();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error reordering sessions:", error);
    return NextResponse.json(
      { error: "Failed to reorder sessions" },
      { status: 500 }
    );
  }
}
