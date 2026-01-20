import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { TMUX_SOCKET } from "@/lib/tmux";

const execAsync = promisify(exec);

// POST /api/tmux/rename - Rename a tmux session
export async function POST(request: NextRequest) {
  try {
    const { oldName, newName } = await request.json();

    if (!oldName || !newName) {
      return NextResponse.json(
        { error: "oldName and newName are required" },
        { status: 400 }
      );
    }

    // Rename the tmux session
    await execAsync(
      `tmux -L ${TMUX_SOCKET} rename-session -t "${oldName}" "${newName}"`
    );

    return NextResponse.json({ success: true, newName });
  } catch (error) {
    console.error("Error renaming tmux session:", error);
    return NextResponse.json(
      { error: "Failed to rename tmux session" },
      { status: 500 }
    );
  }
}
