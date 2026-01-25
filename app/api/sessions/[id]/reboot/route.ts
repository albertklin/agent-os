import { NextRequest, NextResponse } from "next/server";
import { sessionManager } from "@/lib/session-manager";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/sessions/[id]/reboot
 *
 * Reboot a failed session by creating a new tmux session and resuming
 * the existing Claude conversation.
 *
 * Requirements:
 * - Session must have lifecycle_status = "failed"
 * - Session must have a claude_session_id to resume
 * - Agent type must support resume (e.g., Claude)
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const result = await sessionManager.rebootSession(id);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Failed to reboot session" },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error rebooting session:", error);
    return NextResponse.json(
      { error: "Failed to reboot session" },
      { status: 500 }
    );
  }
}
