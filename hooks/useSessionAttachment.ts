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
  const { setSession, getActiveTab, addTab } = usePanes();

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

      // Block selection for failed/deleting sessions, but allow "creating"
      // sessions to navigate - Terminal will show the loading splash
      if (
        session.lifecycle_status === "failed" ||
        session.lifecycle_status === "deleting"
      ) {
        const statusMessages: Record<string, string> = {
          failed: "Session failed to start",
          deleting: "Session is being deleted",
        };
        toast.info(statusMessages[session.lifecycle_status], {
          description:
            session.lifecycle_status === "failed"
              ? "Try rebooting the session from the menu, or delete and create a new one"
              : "Please wait for deletion to complete",
        });
        return false;
      }

      // If the active tab is a Quick Respond tab, open in a new tab instead
      // to preserve the Quick Respond workflow
      if (activeTab?.isQuickRespond) {
        addTab(paneId, sessionId);
      } else {
        // Update the pane's sessionId - Terminal will reconnect automatically
        setSession(paneId, sessionId);
      }
      return true;
    },
    [fetchSession, getActiveTab, setSession, addTab]
  );

  return {
    fetchSession,
    selectSession,
  };
}
