/**
 * System Stats API - Returns current CPU, memory, and GPU usage
 *
 * GET /api/system-stats
 *
 * Designed for lightweight polling (default: 1 second).
 * Response is ~200 bytes, collection uses syscalls (negligible overhead).
 */

import { NextResponse } from "next/server";
import { collectSystemStats } from "@/lib/system-stats";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const stats = collectSystemStats();
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[system-stats] Failed to collect stats:", error);
    return NextResponse.json(
      { error: "Failed to collect system stats" },
      { status: 500 }
    );
  }
}
