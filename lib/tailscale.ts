import { networkInterfaces } from "os";
import { execSync } from "child_process";

/**
 * Detects the Tailscale IP address for this machine.
 *
 * Tries multiple methods:
 * 1. `tailscale ip -4` command (most reliable)
 * 2. Network interface detection (fallback)
 *
 * @returns The Tailscale IPv4 address, or null if not found
 */
export function getTailscaleIP(): string | null {
  // Method 1: Use tailscale CLI (most reliable)
  try {
    const ip = execSync("tailscale ip -4", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (ip && isValidTailscaleIP(ip)) {
      return ip;
    }
  } catch {
    // tailscale CLI not available or failed, try network interfaces
  }

  // Method 2: Scan network interfaces for Tailscale IP
  const interfaces = networkInterfaces();

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;

    for (const addr of addrs) {
      // Skip non-IPv4 and internal addresses
      if (addr.family !== "IPv4" || addr.internal) continue;

      // Check if this looks like a Tailscale IP (100.64.0.0/10 CGNAT range)
      if (isValidTailscaleIP(addr.address)) {
        // Prefer interfaces named tailscale0 or similar
        if (name.toLowerCase().includes("tailscale")) {
          return addr.address;
        }
      }
    }
  }

  // Second pass: accept any IP in the Tailscale range
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;

    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal) continue;

      if (isValidTailscaleIP(addr.address)) {
        return addr.address;
      }
    }
  }

  return null;
}

/**
 * Checks if an IP address is in the Tailscale CGNAT range (100.64.0.0/10).
 * Tailscale uses this range for all device IPs.
 */
export function isValidTailscaleIP(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;

  const firstOctet = parseInt(parts[0], 10);
  const secondOctet = parseInt(parts[1], 10);

  // 100.64.0.0/10 means:
  // - First octet must be 100
  // - Second octet: 64-127 (bits 64-127 in the second octet)
  // The /10 mask means the first 10 bits are fixed: 01100100 01 (100.64-127.x.x)
  return firstOctet === 100 && secondOctet >= 64 && secondOctet <= 127;
}

/**
 * Checks if Tailscale is running and connected.
 */
export function isTailscaleRunning(): boolean {
  try {
    const status = execSync("tailscale status --json", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const parsed = JSON.parse(status);
    return parsed.BackendState === "Running";
  } catch {
    return false;
  }
}
