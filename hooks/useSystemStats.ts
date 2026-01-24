"use client";

import { useState, useEffect, useRef, useCallback } from "react";

export interface SystemStats {
  cpu: {
    usage: number;
    cores: number;
  };
  memory: {
    used: number;
    total: number;
    usage: number;
  };
  gpu?: {
    usage: number;
    memoryUsed: number;
    memoryTotal: number;
    memoryUsage: number;
    name?: string;
  };
  timestamp: number;
}

interface UseSystemStatsOptions {
  /** Polling interval in milliseconds (default: 5000) */
  interval?: number;
  /** Whether to enable polling (default: true) */
  enabled?: boolean;
}

interface UseSystemStatsResult {
  stats: SystemStats | null;
  error: string | null;
  isLoading: boolean;
}

const DEFAULT_INTERVAL = 5000; // 5 seconds

/**
 * Hook for polling system stats (CPU, memory, GPU)
 *
 * Uses lightweight polling with configurable interval.
 * Automatically pauses when tab is not visible to save resources.
 */
export function useSystemStats(
  options: UseSystemStatsOptions = {}
): UseSystemStatsResult {
  const { interval = DEFAULT_INTERVAL, enabled = true } = options;

  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const mountedRef = useRef(true);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchStats = useCallback(async () => {
    if (!mountedRef.current) return;

    try {
      const response = await fetch("/api/system-stats");
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as SystemStats;

      if (mountedRef.current) {
        setStats(data);
        setError(null);
        setIsLoading(false);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Failed to fetch stats");
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
    fetchStats();

    // Set up polling
    intervalRef.current = setInterval(fetchStats, interval);

    // Pause polling when tab is hidden
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } else {
        // Resume polling and fetch immediately
        fetchStats();
        intervalRef.current = setInterval(fetchStats, interval);
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
  }, [enabled, interval, fetchStats]);

  return { stats, error, isLoading };
}

/**
 * Format bytes to human-readable string (e.g., "4.2GB")
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
