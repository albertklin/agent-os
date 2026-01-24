"use client";

import { useState, useEffect, useRef, useCallback } from "react";

export interface ClaudeUsage {
  fiveHour: {
    utilization: number;
    resetsAt: string;
  } | null;
  sevenDay: {
    utilization: number;
    resetsAt: string;
  } | null;
  extraUsage: {
    isEnabled: boolean;
    monthlyLimit: number;
    usedCredits: number;
    utilization: number;
  } | null;
  fetchedAt: number;
  error?: string;
}

interface UseClaudeUsageOptions {
  /** Polling interval in milliseconds (default: 60000 = 1 minute) */
  interval?: number;
  /** Whether to enable polling (default: true) */
  enabled?: boolean;
}

interface UseClaudeUsageResult {
  usage: ClaudeUsage | null;
  error: string | null;
  isLoading: boolean;
  /** Timestamp when data was last fetched from API (not cache) */
  lastRefresh: number | null;
}

// Poll every minute - the backend caches for 5 minutes anyway
const DEFAULT_INTERVAL = 60000;

/**
 * Hook for polling Claude usage stats
 *
 * Uses lightweight polling with configurable interval.
 * Backend caches data for 5 minutes to avoid rate limiting.
 * Automatically pauses when tab is not visible.
 */
export function useClaudeUsage(
  options: UseClaudeUsageOptions = {}
): UseClaudeUsageResult {
  const { interval = DEFAULT_INTERVAL, enabled = true } = options;

  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);

  const mountedRef = useRef(true);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchUsage = useCallback(async () => {
    if (!mountedRef.current) return;

    try {
      const response = await fetch("/api/claude-usage");
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as ClaudeUsage;

      if (mountedRef.current) {
        setUsage(data);
        setLastRefresh(data.fetchedAt);
        setError(data.error ?? null);
        setIsLoading(false);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Failed to fetch usage");
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    if (!enabled) {
      return;
    }

    // Initial fetch
    fetchUsage();

    // Set up polling
    intervalRef.current = setInterval(fetchUsage, interval);

    // Pause polling when tab is hidden
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } else {
        // Resume polling and fetch immediately
        fetchUsage();
        intervalRef.current = setInterval(fetchUsage, interval);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      mountedRef.current = false;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, interval, fetchUsage]);

  return { usage, error, isLoading, lastRefresh };
}

/**
 * Format a relative time string (e.g., "in 2h 30m")
 */
export function formatTimeUntilReset(resetsAt: string): string {
  const resetDate = new Date(resetsAt);
  const now = new Date();
  const diffMs = resetDate.getTime() - now.getTime();

  if (diffMs <= 0) {
    return "now";
  }

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Format time since last refresh (e.g., "2m ago")
 */
export function formatTimeSinceRefresh(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;

  if (diffMs < 60000) {
    return "just now";
  }

  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
