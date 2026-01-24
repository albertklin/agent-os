/**
 * System Stats Collection - Lightweight CPU, memory, and GPU metrics
 *
 * Designed for minimal overhead:
 * - Uses Node.js os module (single syscalls)
 * - Caches GPU availability check
 * - GPU stats via nvidia-smi only when available
 */

import os from "os";
import { execSync } from "child_process";

export interface SystemStats {
  cpu: {
    /** CPU usage as percentage (0-100), based on 1-minute load average */
    usage: number;
    /** Number of CPU cores */
    cores: number;
  };
  memory: {
    /** Used memory in bytes */
    used: number;
    /** Total memory in bytes */
    total: number;
    /** Usage as percentage (0-100) */
    usage: number;
  };
  gpu?: {
    /** GPU utilization percentage (0-100) */
    usage: number;
    /** GPU memory used in bytes */
    memoryUsed: number;
    /** GPU memory total in bytes */
    memoryTotal: number;
    /** GPU memory usage as percentage (0-100) */
    memoryUsage: number;
    /** GPU name/model */
    name?: string;
  };
  /** Timestamp when stats were collected */
  timestamp: number;
}

// Cache for GPU availability (checked once)
let gpuAvailable: boolean | null = null;
let gpuCheckAttempted = false;

// Cache for stats to avoid hammering the system
let cachedStats: SystemStats | null = null;
let lastCollectionTime = 0;
const CACHE_TTL_MS = 2000; // Cache for 2 seconds

/**
 * Check if NVIDIA GPU is available (cached)
 */
function checkGpuAvailable(): boolean {
  if (gpuCheckAttempted) {
    return gpuAvailable ?? false;
  }

  gpuCheckAttempted = true;
  try {
    execSync("which nvidia-smi", { stdio: "ignore" });
    // Also verify nvidia-smi actually works
    execSync("nvidia-smi --query-gpu=name --format=csv,noheader,nounits", {
      stdio: "ignore",
      timeout: 2000,
    });
    gpuAvailable = true;
  } catch {
    gpuAvailable = false;
  }

  return gpuAvailable;
}

/**
 * Get GPU stats via nvidia-smi
 * Returns undefined if GPU not available or on error
 */
function getGpuStats(): SystemStats["gpu"] | undefined {
  if (!checkGpuAvailable()) {
    return undefined;
  }

  try {
    // Query GPU utilization and memory in one call
    const output = execSync(
      "nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,name --format=csv,noheader,nounits",
      { encoding: "utf-8", timeout: 2000 }
    ).trim();

    // Parse: "45, 2048, 8192, NVIDIA GeForce RTX 3080"
    const parts = output.split(",").map((s: string) => s.trim());
    if (parts.length >= 3) {
      const usage = parseInt(parts[0], 10);
      const memoryUsedMiB = parseInt(parts[1], 10);
      const memoryTotalMiB = parseInt(parts[2], 10);
      const name = parts[3] || undefined;

      // Convert MiB to bytes
      const memoryUsed = memoryUsedMiB * 1024 * 1024;
      const memoryTotal = memoryTotalMiB * 1024 * 1024;

      return {
        usage: isNaN(usage) ? 0 : usage,
        memoryUsed,
        memoryTotal,
        memoryUsage:
          memoryTotal > 0 ? Math.round((memoryUsed / memoryTotal) * 100) : 0,
        name,
      };
    }
  } catch {
    // GPU query failed - might be temporarily unavailable
  }

  return undefined;
}

/**
 * Collect system stats with caching
 * Safe to call frequently - uses internal cache
 */
export function collectSystemStats(): SystemStats {
  const now = Date.now();

  // Return cached stats if still fresh
  if (cachedStats && now - lastCollectionTime < CACHE_TTL_MS) {
    return cachedStats;
  }

  // CPU: Use 1-minute load average normalized to number of cores
  const loadAvg = os.loadavg()[0]; // 1-minute average
  const cpuCores = os.cpus().length;
  // Load average represents queue length, normalize to percentage
  // A load of 1.0 on a single-core = 100%, on 4-core = 25%
  const cpuUsage = Math.min(100, Math.round((loadAvg / cpuCores) * 100));

  // Memory: Simple free/total calculation
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsage = Math.round((usedMem / totalMem) * 100);

  // GPU: Only if available
  const gpuStats = getGpuStats();

  cachedStats = {
    cpu: {
      usage: cpuUsage,
      cores: cpuCores,
    },
    memory: {
      used: usedMem,
      total: totalMem,
      usage: memUsage,
    },
    gpu: gpuStats,
    timestamp: now,
  };

  lastCollectionTime = now;
  return cachedStats;
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}GB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * Check if GPU monitoring is available
 */
export function isGpuAvailable(): boolean {
  return checkGpuAvailable();
}
