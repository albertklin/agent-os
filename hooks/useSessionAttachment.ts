"use client";

import { useCallback } from "react";
import { usePanes } from "@/contexts/PaneContext";
import { toast } from "sonner";
import type { Session } from "@/lib/db";

/**
 * Hook for selecting sessions in panes.
 *
 * The server now handles tmux attachment automatically - when the Terminal
 * component connects via /ws/terminal?sessionId=xxx, the server spawns a PTY
 * that directly attaches to the tmux session.
 *
 * This hook just needs to:
 * 1. Fetch fresh session data from the API
 * 2. Check if the session is ready (lifecycle_status === 'ready')
 * 3. Update the pane's sessionId via PaneContext
 */
export function useSessionAttachment() {
  const { setSession, getActiveTab } = usePanes();

  /**
   * Fetch fresh session data from the API.
   */
  const fetchSession = useCallback(
    async (sessionId: string): Promise<Session | null> => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`);
        if (!res.ok) return null;
        const { session } = await res.json();
        return session || null;
      } catch {
        return null;
      }
    },
    []
  );

  /**
   * Select a session in a pane.
   *
   * This updates the pane's sessionId, which causes the Terminal component
   * to reconnect with the new sessionId. The server then handles tmux attachment.
   *
   * @returns true if selection succeeded, false if blocked (e.g., not ready)
   */
  const selectSession = useCallback(
    async (sessionId: string, paneId: string): Promise<boolean> => {
      // Check if already showing this session
      const activeTab = getActiveTab(paneId);
      if (activeTab?.sessionId === sessionId) {
        return true;
      }

      // Fetch fresh session data to check status
      const session = await fetchSession(sessionId);
      if (!session) {
        console.error("[useSessionAttachment] Session not found:", sessionId);
        return false;
      }

      // Block selection if session isn't ready yet
      if (session.lifecycle_status !== "ready") {
        const statusMessages: Record<string, string> = {
          creating: "Session is being created...",
          failed: "Session failed to start",
          deleting: "Session is being deleted",
        };
        const message =
          statusMessages[session.lifecycle_status] ||
          "Session is not ready yet";
        toast.info(message, {
          description: "Please wait for the session to be ready",
        });
        return false;
      }

      // Update the pane's sessionId - Terminal will reconnect automatically
      setSession(paneId, sessionId);
      return true;
    },
    [fetchSession, getActiveTab, setSession]
  );

  return {
    fetchSession,
    selectSession,
  };
}
