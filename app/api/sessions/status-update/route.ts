import { NextRequest, NextResponse } from "next/server";
import {
  statusBroadcaster,
  type SessionStatus,
} from "@/lib/status-broadcaster";
import { getDb } from "@/lib/db";
import { getSessionIdFromName, getManagedSessionPattern } from "@/lib/providers/registry";

/**
 * Claude Hook Events and their status mappings:
 * - PreToolUse, PostToolUse → "running" (Claude is actively working)
 * - Notification → "running" or "waiting" (depends on content)
 * - Stop → "idle" (Claude finished or was interrupted)
 *
 * Hook payload from Claude (as JSON on stdin):
 * {
 *   "hook_type": "PreToolUse" | "PostToolUse" | "Notification" | "Stop",
 *   "session_id": "...",  // Claude's internal session ID
 *   "tool_name": "...",   // For tool use events
 *   "message": "...",     // For notifications
 *   ...
 * }
 *
 * Our endpoint accepts either:
 * - The raw Claude hook payload with additional `agentos_session_id` or `tmux_session` field
 * - Or a simplified payload with just the fields we need
 */

interface HookPayload {
  // Required: At least one of these to identify the AgentOS session
  agentos_session_id?: string; // Direct AgentOS session ID
  session_id?: string; // AgentOS session ID (alias)
  tmux_session?: string; // Tmux session name (e.g., "claude-abc123")

  // Hook event info
  hook_type?: string; // PreToolUse, PostToolUse, Notification, Stop
  hook_event_name?: string; // Alias for hook_type
  event?: string; // Alias for hook_type
  tool_name?: string; // For tool use events
  message?: string; // For notifications

  // Optional: Direct status override (for testing or manual updates)
  status?: SessionStatus;
}

// Map Claude hook events to our status
function mapEventToStatus(event: string, message?: string): SessionStatus {
  const normalizedEvent = event.toLowerCase();

  switch (normalizedEvent) {
    case "pretooluse":
    case "posttooluse":
    case "sessionstart":
      return "running";

    case "stop":
    case "sessionend":
      return "idle";

    case "notification":
      // Check notification content for waiting indicators
      if (message) {
        const lowerMsg = message.toLowerCase();
        if (
          lowerMsg.includes("waiting") ||
          lowerMsg.includes("approval") ||
          lowerMsg.includes("confirm")
        ) {
          return "waiting";
        }
      }
      return "running";

    default:
      // Unknown events default to running (activity is happening)
      return "running";
  }
}

// Validate that session exists in our DB
function sessionExists(sessionId: string): boolean {
  try {
    const db = getDb();
    const stmt = db.prepare("SELECT id FROM sessions WHERE id = ?");
    const result = stmt.get(sessionId);
    return !!result;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    const payload: HookPayload = await request.json();

    // Extract session ID from various possible fields
    let sessionId: string | null = null;

    if (payload.agentos_session_id) {
      sessionId = payload.agentos_session_id;
    } else if (payload.session_id) {
      sessionId = payload.session_id;
    } else if (payload.tmux_session) {
      // Extract UUID from tmux session name (e.g., "claude-abc123" -> "abc123")
      const pattern = getManagedSessionPattern();
      if (pattern.test(payload.tmux_session)) {
        sessionId = getSessionIdFromName(payload.tmux_session);
      } else {
        return NextResponse.json(
          { error: "Invalid tmux session name format" },
          { status: 400 }
        );
      }
    }

    if (!sessionId) {
      return NextResponse.json(
        { error: "Missing session identifier (agentos_session_id, session_id, or tmux_session required)" },
        { status: 400 }
      );
    }

    // Validate session exists
    if (!sessionExists(sessionId)) {
      return NextResponse.json(
        { error: "Session not found", sessionId },
        { status: 404 }
      );
    }

    // Determine status from event or use provided status
    let status: SessionStatus;
    const event =
      payload.hook_type || payload.hook_event_name || payload.event;

    if (payload.status) {
      // Direct status override
      status = payload.status;
    } else if (event) {
      // Map event to status
      status = mapEventToStatus(event, payload.message);
    } else {
      return NextResponse.json(
        { error: "Missing status or event (hook_type, hook_event_name, event, or status required)" },
        { status: 400 }
      );
    }

    // Broadcast the update
    statusBroadcaster.updateStatus({
      sessionId,
      status,
      hookEvent: event,
      toolName: payload.tool_name,
    });

    return NextResponse.json({
      success: true,
      sessionId,
      status,
      event,
    });
  } catch (error) {
    console.error("Error processing status update:", error);
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }
}

// GET endpoint for testing/debugging
export async function GET() {
  return NextResponse.json({
    description: "POST hook payloads to this endpoint to update session status",
    subscriberCount: statusBroadcaster.getSubscriberCount(),
    currentStatuses: statusBroadcaster.getAllStatuses(),
  });
}
