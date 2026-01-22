"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { sessionKeys } from "@/data/sessions";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type SessionStatusType =
  | "idle"
  | "running"
  | "waiting"
  | "dead"
  | "unknown";

export type SetupStatusType =
  | "pending"
  | "creating_worktree"
  | "init_container"
  | "init_submodules"
  | "installing_deps"
  | "starting_session"
  | "ready"
  | "failed";

export type LifecycleStatusType = "creating" | "ready" | "failed" | "deleting";

export interface StatusData {
  status: SessionStatusType;
  lastLine?: string;
  updatedAt?: number;
  hookEvent?: string;
  toolName?: string;
  /** For Bash: the command, for file tools: the file path */
  toolDetail?: string;
  setupStatus?: SetupStatusType;
  setupError?: string;
  lifecycleStatus?: LifecycleStatusType;
  /** True if no status update received within the stale threshold */
  stale?: boolean;
}

interface StatusUpdate {
  sessionId: string;
  status: SessionStatusType;
  lastLine?: string;
  hookEvent?: string;
  toolName?: string;
  toolDetail?: string;
  setupStatus?: SetupStatusType;
  setupError?: string;
  lifecycleStatus?: LifecycleStatusType;
  /** True if no status update received within the stale threshold */
  stale?: boolean;
}

interface InitEvent {
  statuses: Record<string, StatusData>;
}

interface UseStatusStreamResult {
  statuses: Record<string, StatusData>;
  connectionStatus: ConnectionStatus;
  lastUpdate: number | null;
}

// Exponential backoff configuration
const INITIAL_RETRY_DELAY = 1000; // 1 second
const MAX_RETRY_DELAY = 30000; // 30 seconds
const BACKOFF_MULTIPLIER = 2;
// Connection timeout - if not connected within this time, reconnect
// 15 seconds balances fast failure detection with network latency tolerance
const CONNECTION_TIMEOUT_MS = 15000; // 15 seconds

/**
 * Hook for real-time session status updates via SSE
 *
 * Features:
 * - Automatic connection management
 * - Exponential backoff on disconnect
 * - Integration with React Query cache
 * - Connection status for UI indicators
 */
export function useStatusStream(): UseStatusStreamResult {
  const [statuses, setStatuses] = useState<Record<string, StatusData>>({});
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const queryClient = useQueryClient();

  // Refs for cleanup and reconnection
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const connectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryDelayRef = useRef(INITIAL_RETRY_DELAY);
  const mountedRef = useRef(true);
  const isConnectingRef = useRef(false);

  // Handle incoming status update
  const handleStatusUpdate = useCallback(
    (update: StatusUpdate) => {
      if (!mountedRef.current) return;

      setStatuses((prev) => {
        const existing = prev[update.sessionId];

        // Check if lifecycle status changed - this warrants a cache invalidation
        // since the session's DB data (lifecycle_status column) has changed
        const lifecycleChanged =
          update.lifecycleStatus &&
          existing?.lifecycleStatus !== update.lifecycleStatus;

        if (lifecycleChanged) {
          // Invalidate sessions cache so UI reflects the new lifecycle status from DB
          queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
        }

        return {
          ...prev,
          [update.sessionId]: {
            status: update.status,
            lastLine: update.lastLine,
            updatedAt: Date.now(),
            hookEvent: update.hookEvent,
            toolName: update.toolName,
            toolDetail: update.toolDetail,
            // Preserve setup status from existing or use new value
            setupStatus: update.setupStatus ?? existing?.setupStatus,
            setupError: update.setupError ?? existing?.setupError,
            lifecycleStatus:
              update.lifecycleStatus ?? existing?.lifecycleStatus,
            stale: update.stale,
          },
        };
      });

      setLastUpdate(Date.now());
    },
    [queryClient]
  );

  // Handle initial status dump
  const handleInit = useCallback((data: InitEvent) => {
    if (!mountedRef.current) return;

    setStatuses(data.statuses || {});
    setLastUpdate(Date.now());
  }, []);

  // Connect to SSE endpoint
  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    // Guard against concurrent connection attempts
    if (isConnectingRef.current) {
      return;
    }
    isConnectingRef.current = true;

    // Clear any pending retry to prevent concurrent connection attempts
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }

    // Clear any existing connection timeout
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setConnectionStatus("connecting");

    const eventSource = new EventSource("/api/sessions/status-stream");
    eventSourceRef.current = eventSource;

    // Set connection timeout - if not connected in time, force reconnect
    connectionTimeoutRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      if (eventSource.readyState !== EventSource.OPEN) {
        console.warn("[useStatusStream] Connection timeout, forcing reconnect");
        eventSource.close();
        eventSourceRef.current = null;
        isConnectingRef.current = false;
        setConnectionStatus("disconnected");

        // Schedule reconnection with current backoff
        retryTimeoutRef.current = setTimeout(() => {
          if (mountedRef.current) {
            connect();
          }
        }, retryDelayRef.current);

        // Increase delay for next retry
        retryDelayRef.current = Math.min(
          retryDelayRef.current * BACKOFF_MULTIPLIER,
          MAX_RETRY_DELAY
        );
      }
    }, CONNECTION_TIMEOUT_MS);

    eventSource.onopen = () => {
      if (!mountedRef.current) return;

      // Clear connection timeout on successful open
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }

      isConnectingRef.current = false;
      setConnectionStatus("connected");
      retryDelayRef.current = INITIAL_RETRY_DELAY; // Reset retry delay on successful connect
    };

    eventSource.addEventListener("init", (event) => {
      try {
        const data = JSON.parse(event.data) as InitEvent;
        handleInit(data);
      } catch (error) {
        console.error("Failed to parse init event:", error);
      }
    });

    eventSource.addEventListener("status", (event) => {
      try {
        const data = JSON.parse(event.data) as StatusUpdate;
        handleStatusUpdate(data);
      } catch (error) {
        console.error("Failed to parse status event:", error);
      }
    });

    eventSource.addEventListener("heartbeat", () => {
      // Heartbeat received - connection is alive
      // We could update a "lastHeartbeat" state here if needed
    });

    eventSource.onerror = () => {
      if (!mountedRef.current) return;

      // Clear connection timeout on error
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }

      isConnectingRef.current = false;
      eventSource.close();
      eventSourceRef.current = null;
      setConnectionStatus("disconnected");

      // Schedule reconnection with exponential backoff
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }

      retryTimeoutRef.current = setTimeout(() => {
        if (mountedRef.current) {
          connect();
        }
      }, retryDelayRef.current);

      // Increase delay for next retry (exponential backoff)
      retryDelayRef.current = Math.min(
        retryDelayRef.current * BACKOFF_MULTIPLIER,
        MAX_RETRY_DELAY
      );
    };
  }, [handleInit, handleStatusUpdate]);

  // Connect on mount, cleanup on unmount
  // Note: connect is intentionally excluded from deps to prevent reconnection loops.
  // The connect function uses refs (mountedRef, eventSourceRef) which don't need to
  // trigger re-renders, and the callbacks (handleInit, handleStatusUpdate) are stable.
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      isConnectingRef.current = false;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    statuses,
    connectionStatus,
    lastUpdate,
  };
}

/**
 * Convert StatusData to the format expected by SessionCard
 */
export function toSessionStatus(
  sessionId: string,
  data: StatusData | undefined
): { sessionName: string; status: SessionStatusType; lastLine?: string } {
  if (!data) {
    return {
      sessionName: sessionId,
      status: "unknown",
    };
  }

  return {
    sessionName: sessionId,
    status: data.status,
    lastLine: data.lastLine,
  };
}
