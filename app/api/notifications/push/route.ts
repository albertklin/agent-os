import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const DISABLE_FILE = path.join(os.homedir(), ".agent-os", "notify-disabled");

// GET /api/notifications/push - Check if push notifications are enabled
export async function GET() {
  try {
    const enabled = !fs.existsSync(DISABLE_FILE);
    return NextResponse.json({ enabled });
  } catch (error) {
    console.error("Error checking push notification status:", error);
    return NextResponse.json(
      { error: "Failed to check status" },
      { status: 500 }
    );
  }
}

// POST /api/notifications/push - Enable or disable push notifications
export async function POST(request: NextRequest) {
  try {
    const { enabled } = await request.json();

    if (typeof enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled must be a boolean" },
        { status: 400 }
      );
    }

    const dir = path.dirname(DISABLE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (enabled) {
      // Remove disable file to enable notifications
      if (fs.existsSync(DISABLE_FILE)) {
        fs.unlinkSync(DISABLE_FILE);
      }
    } else {
      // Create disable file to disable notifications
      fs.writeFileSync(DISABLE_FILE, "");
    }

    return NextResponse.json({ enabled });
  } catch (error) {
    console.error("Error setting push notification status:", error);
    return NextResponse.json(
      { error: "Failed to set status" },
      { status: 500 }
    );
  }
}
