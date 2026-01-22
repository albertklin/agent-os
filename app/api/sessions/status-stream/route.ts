import { statusBroadcaster, type StatusUpdate } from "@/lib/status-broadcaster";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * SSE endpoint for real-time status updates
 *
 * Event format:
 * - "status": Session status update
 * - "init": Initial status dump on connect
 * - "heartbeat": Keep-alive (every 30s)
 */
export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();

  // Track subscriber ID for proper cleanup
  let subscriberId: string | null = null;
  let isCleanedUp = false;

  const cleanup = () => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    if (subscriberId) {
      statusBroadcaster.unsubscribe(subscriberId);
      subscriberId = null;
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      // Helper to send SSE events
      const sendEvent = (eventType: string, data: unknown): boolean => {
        try {
          const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(message));
          return true;
        } catch {
          // Controller closed or encoding error - trigger cleanup
          cleanup();
          return false;
        }
      };

      // Sync from database if status store is empty (e.g., after hot reload)
      let currentStatuses = statusBroadcaster.getAllStatuses();
      if (Object.keys(currentStatuses).length === 0) {
        statusBroadcaster.syncFromDatabase();
        currentStatuses = statusBroadcaster.getAllStatuses();
      }

      // Send initial status dump
      sendEvent("init", { statuses: currentStatuses });

      // Subscribe to updates - callback throws on dead connection for cleanup detection
      const callback = (update: StatusUpdate) => {
        if (isCleanedUp) {
          throw new Error("Connection closed");
        }
        if (update.sessionId === "__heartbeat__") {
          // Send heartbeat event
          if (!sendEvent("heartbeat", { timestamp: Date.now() })) {
            throw new Error("Failed to send heartbeat");
          }
        } else {
          // Send status update
          if (!sendEvent("status", update)) {
            throw new Error("Failed to send status update");
          }
        }
      };

      // Close callback for graceful shutdown - closes the stream controller
      const closeCallback = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      };

      subscriberId = statusBroadcaster.subscribe(callback, closeCallback);
    },
    cancel() {
      // Clean up subscription when stream is cancelled
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering
    },
  });
}
