/**
 * Domain Configuration Utilities
 *
 * Handles parsing, serialization, and validation of extra allowed network domains
 * for Docker containers in sandboxed sessions.
 *
 * Domains are resolved to IPs at container startup and added to the firewall allowlist.
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// Valid domain name pattern (supports wildcards like *.googleapis.com)
// Allows: letters, numbers, hyphens, dots, and leading wildcard
const DOMAIN_PATTERN =
  /^(\*\.)?([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

// Domains that are already allowed by default (no need to add them)
const DEFAULT_ALLOWED_DOMAINS = [
  "registry.npmjs.org",
  "api.anthropic.com",
  "sentry.io",
  "statsig.anthropic.com",
  "statsig.com",
  "marketplace.visualstudio.com",
  "vscode.blob.core.windows.net",
  "update.code.visualstudio.com",
  // GitHub is handled separately via api.github.com/meta
];

/**
 * Parse domains from JSON string stored in database.
 * Returns empty array if null or invalid JSON.
 */
export function parseDomains(json: string | null): string[] {
  if (!json) {
    return [];
  }

  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return [];
    }
    // Filter to only valid strings
    return parsed.filter(
      (d): d is string => typeof d === "string" && d.length > 0
    );
  } catch {
    return [];
  }
}

/**
 * Serialize domains to JSON string for database storage.
 * Returns null if empty array.
 */
export function serializeDomains(domains: string[]): string | null {
  if (!domains || domains.length === 0) {
    return null;
  }
  return JSON.stringify(domains);
}

/**
 * Validate a single domain name.
 */
export function validateDomain(domain: string): ValidationResult {
  if (!domain || typeof domain !== "string") {
    return { valid: false, error: "Domain is required" };
  }

  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) {
    return { valid: false, error: "Domain cannot be empty" };
  }

  // Check for valid domain format
  if (!DOMAIN_PATTERN.test(trimmed)) {
    return {
      valid: false,
      error: `Invalid domain format: '${domain}'. Must be a valid domain name (e.g., 'example.com' or '*.googleapis.com')`,
    };
  }

  // Check if it's already in the default list (warning, not error)
  const normalizedDomain = trimmed.replace(/^\*\./, "");
  if (
    DEFAULT_ALLOWED_DOMAINS.some(
      (d) => d === normalizedDomain || d.endsWith(`.${normalizedDomain}`)
    )
  ) {
    // This is fine, just redundant - we'll allow it
  }

  return { valid: true };
}

/**
 * Validate an array of domain names.
 * Returns the first error found, or valid if all pass.
 */
export function validateDomains(domains: string[]): ValidationResult {
  if (!Array.isArray(domains)) {
    return { valid: false, error: "Domains must be an array" };
  }

  for (let i = 0; i < domains.length; i++) {
    const result = validateDomain(domains[i]);
    if (!result.valid) {
      return { valid: false, error: `Domain ${i + 1}: ${result.error}` };
    }
  }

  // Check for duplicates
  const seen = new Set<string>();
  for (let i = 0; i < domains.length; i++) {
    const normalized = domains[i].trim().toLowerCase();
    if (seen.has(normalized)) {
      return {
        valid: false,
        error: `Domain ${i + 1}: Duplicate domain '${domains[i]}'`,
      };
    }
    seen.add(normalized);
  }

  return { valid: true };
}

/**
 * Normalize domains for passing to the container.
 * - Trims whitespace
 * - Converts to lowercase
 * - Removes duplicates
 */
export function normalizeDomains(domains: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const domain of domains) {
    const normalized = domain.trim().toLowerCase();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}
