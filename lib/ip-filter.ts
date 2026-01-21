/**
 * IP Address Filtering for Network Security
 *
 * Allows connections only from trusted sources:
 * - localhost (127.0.0.1, ::1) - for non-containerized session hooks
 * - Docker bridge network (172.16.0.0/12) - for containerized session hooks
 * - Tailscale CGNAT range (100.64.0.0/10) - for remote web UI access
 */

import { IncomingMessage, ServerResponse } from "http";

/**
 * Check if an IP is in a CIDR range
 */
function ipInCidr(ip: string, cidr: string): boolean {
  const [range, prefixLength] = cidr.split("/");
  const prefix = parseInt(prefixLength, 10);

  // Convert IP strings to 32-bit integers
  const ipParts = ip.split(".").map(Number);
  const rangeParts = range.split(".").map(Number);

  if (ipParts.length !== 4 || rangeParts.length !== 4) {
    return false;
  }

  const ipInt =
    (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
  const rangeInt =
    (rangeParts[0] << 24) |
    (rangeParts[1] << 16) |
    (rangeParts[2] << 8) |
    rangeParts[3];

  // Create mask from prefix length
  const mask = ~((1 << (32 - prefix)) - 1);

  return (ipInt & mask) === (rangeInt & mask);
}

/**
 * Normalize IPv6-mapped IPv4 addresses (::ffff:127.0.0.1 -> 127.0.0.1)
 */
function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) {
    return ip.slice(7);
  }
  return ip;
}

/**
 * Check if an IP address is from a trusted source
 */
export function isTrustedSource(ip: string): boolean {
  const normalizedIp = normalizeIp(ip);

  // Localhost (IPv4 and IPv6)
  if (normalizedIp === "127.0.0.1" || normalizedIp === "::1" || ip === "::1") {
    return true;
  }

  // Docker bridge networks (172.16.0.0/12 covers 172.16.x.x through 172.31.x.x)
  // Also check 172.17.0.0/16 explicitly as the default Docker bridge
  if (
    ipInCidr(normalizedIp, "172.16.0.0/12") ||
    ipInCidr(normalizedIp, "192.168.0.0/16")
  ) {
    return true;
  }

  // Tailscale CGNAT range (100.64.0.0/10 covers 100.64.x.x through 100.127.x.x)
  if (ipInCidr(normalizedIp, "100.64.0.0/10")) {
    return true;
  }

  return false;
}

/**
 * Get the client IP from an HTTP request
 */
export function getClientIp(req: IncomingMessage): string {
  // Check X-Forwarded-For header (if behind a proxy)
  // Only trust the last IP in the chain as it's the one connecting to us
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const ips = forwarded.split(",").map((ip) => ip.trim());
    // Use the rightmost IP (most recent proxy) as it's the one we can trust
    // In our case, we don't expect proxies, but handle it defensively
    return ips[ips.length - 1];
  }

  // Fall back to socket remote address
  return req.socket.remoteAddress || "";
}

/**
 * Middleware that rejects requests from untrusted IP addresses
 */
export function createIpFilterMiddleware(): (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void
) => void {
  return (req, res, next) => {
    const clientIp = getClientIp(req);

    if (!isTrustedSource(clientIp)) {
      console.warn(
        `[ip-filter] Blocked request from untrusted IP: ${clientIp}`
      );
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "Forbidden",
          message:
            "Access denied. This server only accepts connections from localhost, Docker containers, or Tailscale network.",
        })
      );
      return;
    }

    next();
  };
}

/**
 * Describe the trusted networks (for logging/documentation)
 */
export function describeTrustedNetworks(): string {
  return [
    "localhost (127.0.0.1, ::1)",
    "Docker bridge (172.16.0.0/12)",
    "Private networks (192.168.0.0/16)",
    "Tailscale (100.64.0.0/10)",
  ].join(", ");
}
