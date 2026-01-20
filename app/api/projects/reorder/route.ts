import { NextRequest, NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";

interface ProjectOrder {
  projectId: string;
  sortOrder: number;
}

// POST /api/projects/reorder - Bulk update project order
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { projects } = body as { projects: ProjectOrder[] };

    if (!Array.isArray(projects)) {
      return NextResponse.json(
        { error: "projects must be an array" },
        { status: 400 }
      );
    }

    const db = getDb();

    // Update all projects in a transaction for consistency
    const updateStmt = queries.updateProjectOrder(db);

    db.transaction(() => {
      for (const { projectId, sortOrder } of projects) {
        updateStmt.run(sortOrder, projectId);
      }
    })();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error reordering projects:", error);
    return NextResponse.json(
      { error: "Failed to reorder projects" },
      { status: 500 }
    );
  }
}
