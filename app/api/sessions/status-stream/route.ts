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

  const stream = new ReadableStream({
    start(controller) {
      // Helper to send SSE events
      const sendEvent = (eventType: string, data: unknown) => {
        try {
          const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(message));
        } catch {
          // Ignore encoding errors
        }
      };

      // Send initial status dump
      const currentStatuses = statusBroadcaster.getAllStatuses();
      sendEvent("init", { statuses: currentStatuses });

      // Subscribe to updates
      const callback = (update: StatusUpdate) => {
        if (update.sessionId === "__heartbeat__") {
          // Send heartbeat event
          sendEvent("heartbeat", { timestamp: Date.now() });
        } else {
          // Send status update
          sendEvent("status", update);
        }
      };

      statusBroadcaster.subscribe(callback);

      // Store callback reference for cleanup
      // @ts-expect-error - Adding custom property to controller for cleanup
      controller._cleanup = () => {
        statusBroadcaster.unsubscribe(callback);
      };
    },
    cancel(controller) {
      // Clean up subscription
      const ctrl = controller as ReadableStreamDefaultController & { _cleanup?: () => void };
      if (ctrl._cleanup) {
        ctrl._cleanup();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering
    },
  });
}
