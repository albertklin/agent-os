"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { sessionKeys } from "@/data/sessions/keys";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type SessionStatusType =
  | "idle"
  | "running"
  | "waiting"
  | "dead"
  | "unknown";

export interface StatusData {
  status: SessionStatusType;
  lastLine?: string;
  updatedAt?: number;
  hookEvent?: string;
  toolName?: string;
}

interface StatusUpdate {
  sessionId: string;
  status: SessionStatusType;
  lastLine?: string;
  hookEvent?: string;
  toolName?: string;
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
  const queryClient = useQueryClient();
  const [statuses, setStatuses] = useState<Record<string, StatusData>>({});
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  // Refs for cleanup and reconnection
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryDelayRef = useRef(INITIAL_RETRY_DELAY);
  const mountedRef = useRef(true);

  // Handle incoming status update
  const handleStatusUpdate = useCallback(
    (update: StatusUpdate) => {
      if (!mountedRef.current) return;

      setStatuses((prev) => ({
        ...prev,
        [update.sessionId]: {
          status: update.status,
          lastLine: update.lastLine,
          updatedAt: Date.now(),
          hookEvent: update.hookEvent,
          toolName: update.toolName,
        },
      }));

      setLastUpdate(Date.now());

      // Update React Query cache to trigger re-renders in components using session data
      // This invalidates the sessions query to get updated timestamps
      if (update.status === "running" || update.status === "waiting") {
        queryClient.invalidateQueries({ queryKey: sessionKeys.all });
      }
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
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setConnectionStatus("connecting");

    const eventSource = new EventSource("/api/sessions/status-stream");
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      if (!mountedRef.current) return;
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
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };
  }, [connect]);

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
