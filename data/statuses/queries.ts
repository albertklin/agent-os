/**
 * Session Status Queries (SSE-based)
 *
 * This module provides real-time session status updates via Server-Sent Events (SSE).
 * Status updates are pushed from the server when Claude hooks fire, eliminating polling.
 *
 * Sessions without hooks configured will show "unknown" status.
 */

import { useEffect, useMemo } from "react";
import { useStatusStream, type StatusData } from "@/hooks/useStatusStream";
import type { Session } from "@/lib/db";
import type { SessionStatus } from "@/components/views/types";

// Re-export types from useStatusStream
export type { StatusData, ConnectionStatus } from "@/hooks/useStatusStream";

// Re-export the raw hook for components that need direct access
export { useStatusStream } from "@/hooks/useStatusStream";

/**
 * Convert internal StatusData to the SessionStatus format expected by components
 */
function toSessionStatus(
  sessionId: string,
  data: StatusData | undefined,
  session?: Session
): SessionStatus {
  const sessionName = session?.name || `session-${sessionId}`;

  if (!data) {
    // Check if session has setup status or lifecycle status from DB (for newly created sessions)
    if (session?.setup_status && session.setup_status !== "ready") {
      return {
        sessionName,
        status: "unknown",
        setupStatus: session.setup_status,
        setupError: session.setup_error ?? undefined,
        lifecycleStatus: session.lifecycle_status ?? undefined,
      };
    }
    return {
      sessionName,
      status: "unknown",
      lifecycleStatus: session?.lifecycle_status ?? undefined,
    };
  }

  return {
    sessionName,
    status: data.status === "unknown" ? "dead" : data.status,
    lastLine: data.lastLine,
    toolName: data.toolName,
    toolDetail: data.toolDetail,
    // Fall back to DB values if SSE data doesn't have these fields
    setupStatus: data.setupStatus ?? session?.setup_status ?? undefined,
    setupError: data.setupError ?? session?.setup_error ?? undefined,
    lifecycleStatus:
      data.lifecycleStatus ?? session?.lifecycle_status ?? undefined,
    stale: data.stale,
  };
}

interface UseSessionStatusesOptions {
  sessions: Session[];
  activeSessionId?: string | null;
  checkStateChanges: (
    states: Array<{
      id: string;
      name: string;
      status: SessionStatus["status"];
    }>,
    activeSessionId?: string | null
  ) => void;
}

/**
 * Hook for session statuses with notification integration
 *
 * This replaces the old polling-based useSessionStatusesQuery.
 * It uses SSE for real-time updates and calls checkStateChanges for notifications.
 */
export function useSessionStatusesQuery({
  sessions,
  activeSessionId,
  checkStateChanges,
}: UseSessionStatusesOptions) {
  const { statuses: rawStatuses, connectionStatus } = useStatusStream();

  // Convert raw statuses to SessionStatus format
  const sessionStatuses = useMemo(() => {
    const result: Record<string, SessionStatus> = {};

    for (const session of sessions) {
      const rawStatus = rawStatuses[session.id];
      result[session.id] = toSessionStatus(session.id, rawStatus, session);
    }

    return result;
  }, [sessions, rawStatuses]);

  // Call checkStateChanges when statuses update (for notifications)
  useEffect(() => {
    if (Object.keys(rawStatuses).length === 0) return;

    const sessionStates = sessions.map((s) => ({
      id: s.id,
      name: s.name,
      status: (sessionStatuses[s.id]?.status ||
        "unknown") as SessionStatus["status"],
    }));

    checkStateChanges(sessionStates, activeSessionId);
  }, [
    rawStatuses,
    sessions,
    activeSessionId,
    checkStateChanges,
    sessionStatuses,
  ]);

  return {
    sessionStatuses,
    connectionStatus,
    isLoading: false, // SSE is always "loaded" after initial connection
  };
}
