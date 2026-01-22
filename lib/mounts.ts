/**
 * Mount Configuration Utilities
 *
 * Handles parsing, serialization, and validation of extra mount configurations
 * for Docker containers in sandboxed sessions.
 *
 * Security: Certain host and container paths are blocked to prevent
 * mounting sensitive system directories.
 */

import * as path from "path";
import * as os from "os";
import type { MountConfig } from "./db/types";

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// Host paths that are blocked for security reasons
// These are critical system directories that should never be mounted
const BLOCKED_HOST_PATHS = [
  "/",
  "/etc",
  "/root",
  "/var",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/boot",
  "/proc",
  "/sys",
  "/dev",
];

// Container paths that are blocked to avoid conflicts
// These are used by the container setup or have special meaning
const BLOCKED_CONTAINER_PATHS = [
  "/workspace", // Already used for worktree
  "/home/node/.claude", // Claude config directory
  "/home/node/.claude-host", // Read-only Claude config mount
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
];

/**
 * Parse mounts from JSON string stored in database.
 * Returns empty array if null or invalid JSON.
 */
export function parseMounts(json: string | null): MountConfig[] {
  if (!json) {
    return [];
  }

  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return [];
    }
    // Basic structure validation
    return parsed.filter(
      (m): m is MountConfig =>
        typeof m === "object" &&
        m !== null &&
        typeof m.hostPath === "string" &&
        typeof m.containerPath === "string" &&
        (m.mode === "ro" || m.mode === "rw")
    );
  } catch {
    return [];
  }
}

/**
 * Serialize mounts to JSON string for database storage.
 * Returns null if empty array.
 */
export function serializeMounts(mounts: MountConfig[]): string | null {
  if (!mounts || mounts.length === 0) {
    return null;
  }
  return JSON.stringify(mounts);
}

/**
 * Normalize a path by resolving ~ and making it absolute.
 */
function normalizePath(p: string): string {
  const expanded = p.replace(/^~/, os.homedir());
  return path.resolve(expanded);
}

/**
 * Check if a path starts with any of the blocked paths.
 */
function isBlockedPath(
  normalizedPath: string,
  blockedPaths: string[]
): string | null {
  for (const blocked of blockedPaths) {
    // Exact match
    if (normalizedPath === blocked) {
      return blocked;
    }
    // Path is under blocked directory (e.g., /etc/passwd is under /etc)
    if (normalizedPath.startsWith(blocked + "/")) {
      return blocked;
    }
  }
  return null;
}

/**
 * Validate a host path for mounting.
 */
export function validateHostPath(hostPath: string): ValidationResult {
  if (!hostPath || typeof hostPath !== "string") {
    return { valid: false, error: "Host path is required" };
  }

  const trimmed = hostPath.trim();
  if (!trimmed) {
    return { valid: false, error: "Host path cannot be empty" };
  }

  // Must be absolute or start with ~
  if (!trimmed.startsWith("/") && !trimmed.startsWith("~")) {
    return {
      valid: false,
      error: "Host path must be absolute (start with / or ~)",
    };
  }

  const normalized = normalizePath(trimmed);

  // Check against blocked paths
  const blockedBy = isBlockedPath(normalized, BLOCKED_HOST_PATHS);
  if (blockedBy) {
    return {
      valid: false,
      error: `Host path '${blockedBy}' is not allowed for security reasons`,
    };
  }

  return { valid: true };
}

/**
 * Validate a container path for mounting.
 */
export function validateContainerPath(containerPath: string): ValidationResult {
  if (!containerPath || typeof containerPath !== "string") {
    return { valid: false, error: "Container path is required" };
  }

  const trimmed = containerPath.trim();
  if (!trimmed) {
    return { valid: false, error: "Container path cannot be empty" };
  }

  // Must be absolute
  if (!trimmed.startsWith("/")) {
    return {
      valid: false,
      error: "Container path must be absolute (start with /)",
    };
  }

  // Normalize (resolve . and ..)
  const normalized = path.resolve(trimmed);

  // Check against blocked paths
  const blockedBy = isBlockedPath(normalized, BLOCKED_CONTAINER_PATHS);
  if (blockedBy) {
    return {
      valid: false,
      error: `Container path '${blockedBy}' is not allowed (reserved or system directory)`,
    };
  }

  return { valid: true };
}

/**
 * Validate a complete mount configuration.
 */
export function validateMountConfig(mount: MountConfig): ValidationResult {
  if (!mount || typeof mount !== "object") {
    return { valid: false, error: "Mount configuration must be an object" };
  }

  // Validate host path
  const hostResult = validateHostPath(mount.hostPath);
  if (!hostResult.valid) {
    return hostResult;
  }

  // Validate container path
  const containerResult = validateContainerPath(mount.containerPath);
  if (!containerResult.valid) {
    return containerResult;
  }

  // Validate mode
  if (mount.mode !== "ro" && mount.mode !== "rw") {
    return { valid: false, error: "Mount mode must be 'ro' or 'rw'" };
  }

  return { valid: true };
}

/**
 * Validate an array of mount configurations.
 * Returns the first error found, or valid if all pass.
 */
export function validateMounts(mounts: MountConfig[]): ValidationResult {
  if (!Array.isArray(mounts)) {
    return { valid: false, error: "Mounts must be an array" };
  }

  for (let i = 0; i < mounts.length; i++) {
    const result = validateMountConfig(mounts[i]);
    if (!result.valid) {
      return { valid: false, error: `Mount ${i + 1}: ${result.error}` };
    }
  }

  // Check for duplicate container paths
  const containerPaths = new Set<string>();
  for (let i = 0; i < mounts.length; i++) {
    const normalized = path.resolve(mounts[i].containerPath);
    if (containerPaths.has(normalized)) {
      return {
        valid: false,
        error: `Mount ${i + 1}: Duplicate container path '${mounts[i].containerPath}'`,
      };
    }
    containerPaths.add(normalized);
  }

  return { valid: true };
}
