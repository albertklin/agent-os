/**
 * Claude Usage API - Returns current Claude usage stats
 *
 * GET /api/claude-usage
 *
 * Data is cached for 5 minutes to avoid rate limiting.
 */

import { NextResponse } from "next/server";
import { getClaudeUsage } from "@/lib/claude-usage";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const usage = await getClaudeUsage();
    return NextResponse.json(usage);
  } catch (error) {
    console.error("[claude-usage] Failed to get usage:", error);
    return NextResponse.json(
      { error: "Failed to get Claude usage" },
      { status: 500 }
    );
  }
}
