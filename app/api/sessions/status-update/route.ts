import { NextRequest, NextResponse } from "next/server";
import {
  statusBroadcaster,
  type SessionStatus,
} from "@/lib/status-broadcaster";
import { getDb } from "@/lib/db";
import {
  getSessionIdFromName,
  getManagedSessionPattern,
} from "@/lib/providers/registry";

/**
 * Claude Hook Events and their status mappings:
 * - UserPromptSubmit → "running" (user sent message, Claude processing)
 * - PreToolUse, PostToolUse → "running" (Claude is actively working)
 * - PostToolUse (AskUserQuestion) → "waiting" (waiting for user response)
 * - Notification → "waiting" (permission prompts, etc.)
 * - Stop → "idle" (Claude finished responding)
 * - SessionStart → "idle" (session ready, waiting for input)
 * - SessionEnd → "dead" (session terminated)
 *
 * Hook payload from Claude (as JSON on stdin):
 * {
 *   "hook_event_name": "PreToolUse" | "PostToolUse" | "Notification" | "Stop" | "SessionStart" | "SessionEnd",
 *   "session_id": "...",     // Claude's internal session ID
 *   "tool_name": "...",      // For tool use events
 *   "tool_input": {...},     // Tool-specific input (command for Bash, file_path for Read/Write/Edit)
 *   "message": "...",        // For notifications
 *   "source": "...",         // For SessionStart: "startup" | "resume" | "clear" | "compact"
 *   "reason": "...",         // For SessionEnd: "clear" | "logout" | "prompt_input_exit" | "other"
 *   ...
 * }
 *
 * Our endpoint accepts either:
 * - The raw Claude hook payload with additional `agentos_session_id` or `tmux_session` field
 * - Or a simplified payload with just the fields we need
 */

/** Tool input structure varies by tool */
interface ToolInput {
  // Bash
  command?: string;
  description?: string;
  // Read/Write/Edit
  file_path?: string;
  // Edit specific
  old_string?: string;
  new_string?: string;
  // Generic
  [key: string]: unknown;
}

interface HookPayload {
  // Required: At least one of these to identify the AgentOS session
  agentos_session_id?: string; // Direct AgentOS session ID
  session_id?: string; // Claude's internal session ID (also used as fallback for AgentOS ID)
  tmux_session?: string; // Tmux session name (e.g., "claude-abc123")

  // Hook event info
  hook_type?: string; // PreToolUse, PostToolUse, Notification, Stop, SessionStart, SessionEnd
  hook_event_name?: string; // Alias for hook_type
  event?: string; // Alias for hook_type
  tool_name?: string; // For tool use events
  tool_input?: ToolInput; // Tool-specific input data
  message?: string; // For notifications

  // SessionStart/SessionEnd specific
  source?: string; // For SessionStart: "startup" | "resume" | "clear" | "compact"
  reason?: string; // For SessionEnd: "clear" | "logout" | "prompt_input_exit" | "other"

  // Claude's internal session ID (for capturing and storing)
  claude_session_id?: string;

  // Optional: Direct status override (for testing or manual updates)
  status?: SessionStatus;
}

// Tools that indicate Claude is waiting for user input
const WAITING_TOOLS = new Set([
  "askuserquestion",
  "ask",
  "ask_user",
  "user_input",
]);

// Max lengths for string fields to prevent memory bloat
const MAX_HOOK_EVENT_LENGTH = 50;
const MAX_TOOL_NAME_LENGTH = 100;

/**
 * Truncate a string to a maximum length, adding ellipsis if truncated
 */
function truncateString(
  str: string | undefined,
  maxLength: number
): string | undefined {
  if (!str) return str;
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + "...";
}

// Map Claude hook events to our status
function mapEventToStatus(
  event: string,
  message?: string,
  toolName?: string
): SessionStatus {
  const normalizedEvent = event.toLowerCase();
  const normalizedTool = toolName?.toLowerCase();

  switch (normalizedEvent) {
    case "userpromptsubmit":
      // User just sent a message - Claude is now processing
      return "running";

    case "pretooluse":
      return "running";

    case "posttooluse":
      // After using a question/input tool, Claude is waiting for user response
      if (normalizedTool && WAITING_TOOLS.has(normalizedTool)) {
        return "waiting";
      }
      return "running";

    case "sessionstart":
      // Session started/resumed - waiting for user input
      return "idle";

    case "stop":
      return "idle";

    case "sessionend":
      return "dead";

    case "notification":
      // Notifications typically mean Claude is waiting for user input/response
      return "waiting";

    default:
      // Unknown events default to running (activity is happening)
      return "running";
  }
}

/**
 * Extract a human-readable detail from tool_input based on tool_name
 * Returns a short string suitable for display (e.g., command or file path)
 */
function extractToolDetail(
  toolName: string | undefined,
  toolInput: ToolInput | undefined
): string | undefined {
  if (!toolName || !toolInput) return undefined;

  const name = toolName.toLowerCase();

  // Bash: show the command (truncated if long)
  if (name === "bash") {
    const cmd = toolInput.command;
    if (cmd) {
      // Truncate long commands for display
      return cmd.length > 100 ? cmd.slice(0, 100) + "..." : cmd;
    }
  }

  // File tools: show the file path
  if (["read", "write", "edit", "glob", "grep"].includes(name)) {
    const filePath = toolInput.file_path;
    if (filePath) {
      // Show just the filename for brevity, or short paths
      if (filePath.length > 50) {
        const parts = filePath.split("/");
        return ".../" + parts.slice(-2).join("/");
      }
      return filePath;
    }
  }

  // Task/subagent: show description if available
  if (name === "task") {
    const desc = toolInput.description;
    if (typeof desc === "string") {
      return desc.length > 50 ? desc.slice(0, 50) + "..." : desc;
    }
  }

  return undefined;
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

    // Debug: Log incoming requests to diagnose container sync issues
    const clientIp = request.headers.get("x-forwarded-for") || "unknown";
    console.log(`[status-update] Received request from ${clientIp}:`, {
      tmux_session: payload.tmux_session,
      agentos_session_id: payload.agentos_session_id,
      session_id: payload.session_id,
      hook_type: payload.hook_type,
    });

    // Extract session ID from various possible fields
    // IMPORTANT: Check tmux_session BEFORE session_id because Claude's hook payload
    // includes its own internal session_id which is different from our AgentOS session ID
    let sessionId: string | null = null;

    if (payload.agentos_session_id) {
      sessionId = payload.agentos_session_id;
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
    } else if (payload.session_id) {
      // Fallback to session_id (for non-Claude agents or direct API calls)
      sessionId = payload.session_id;
    }

    if (!sessionId) {
      return NextResponse.json(
        {
          error:
            "Missing session identifier (agentos_session_id, session_id, or tmux_session required)",
        },
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
    const event = payload.hook_type || payload.hook_event_name || payload.event;

    if (payload.status) {
      // Direct status override
      status = payload.status;
    } else if (event) {
      // Map event to status (pass tool_name to detect waiting tools like AskUserQuestion)
      status = mapEventToStatus(event, payload.message, payload.tool_name);
    } else {
      return NextResponse.json(
        {
          error:
            "Missing status or event (hook_type, hook_event_name, event, or status required)",
        },
        { status: 400 }
      );
    }

    // Extract tool detail from tool_input (command, file path, etc.)
    const toolDetail = extractToolDetail(payload.tool_name, payload.tool_input);

    // Capture Claude's session ID on SessionStart event
    // The session_id in the payload is Claude's internal ID, not our AgentOS ID
    const normalizedEvent = event?.toLowerCase();
    if (normalizedEvent === "sessionstart" && payload.session_id) {
      try {
        const db = getDb();
        db.prepare(
          "UPDATE sessions SET claude_session_id = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(payload.session_id, sessionId);
      } catch (error) {
        console.error("Failed to store claude_session_id:", error);
      }
    }

    // Broadcast the update with truncated string fields to prevent memory bloat
    try {
      statusBroadcaster.updateStatus({
        sessionId,
        status,
        hookEvent: truncateString(event, MAX_HOOK_EVENT_LENGTH),
        toolName: truncateString(payload.tool_name, MAX_TOOL_NAME_LENGTH),
        toolDetail, // Already truncated by extractToolDetail()
      });
    } catch (broadcastError) {
      // Log but don't fail the request - status was valid, broadcast had issues
      console.error("Error broadcasting status update:", broadcastError);
      // Still return success since we received and processed the update
      // The next update will likely succeed
    }

    return NextResponse.json({
      success: true,
      sessionId,
      status,
      event,
      toolDetail,
    });
  } catch (error) {
    // Distinguish between JSON parse errors and other issues
    if (error instanceof SyntaxError) {
      console.error("Invalid JSON in status update request:", error);
      return NextResponse.json(
        { error: "Invalid JSON in request body" },
        { status: 400 }
      );
    }
    console.error("Error processing status update:", error);
    return NextResponse.json(
      { error: "Internal error processing status update" },
      { status: 500 }
    );
  }
}

// GET endpoint for testing/debugging
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const sync = url.searchParams.get("sync");

  // Trigger sync if requested
  if (sync === "true") {
    const syncResult = statusBroadcaster.syncFromDatabase();
    return NextResponse.json({
      description: "Sync completed",
      syncResult,
      subscriberCount: statusBroadcaster.getSubscriberCount(),
      currentStatuses: statusBroadcaster.getAllStatuses(),
    });
  }

  return NextResponse.json({
    description: "POST hook payloads to this endpoint to update session status",
    subscriberCount: statusBroadcaster.getSubscriberCount(),
    currentStatuses: statusBroadcaster.getAllStatuses(),
  });
}
