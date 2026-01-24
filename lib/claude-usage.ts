/**
 * Claude Usage Collection - Fetches usage data from Anthropic API
 *
 * Caches results for 5 minutes to avoid rate limiting.
 * Reads OAuth token from ~/.claude/.credentials.json
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import path from "path";

export interface ClaudeUsageBucket {
  utilization: number;
  resets_at: string;
}

export interface ClaudeExtraUsage {
  is_enabled: boolean;
  monthly_limit: number;
  used_credits: number;
  utilization: number;
}

export interface ClaudeUsageResponse {
  five_hour: ClaudeUsageBucket | null;
  seven_day: ClaudeUsageBucket | null;
  seven_day_opus: ClaudeUsageBucket | null;
  seven_day_sonnet: ClaudeUsageBucket | null;
  seven_day_oauth_apps: ClaudeUsageBucket | null;
  seven_day_cowork: ClaudeUsageBucket | null;
  extra_usage: ClaudeExtraUsage | null;
}

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

// Cache for 5 minutes
const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedUsage: ClaudeUsage | null = null;
let lastFetchTime = 0;

/**
 * Get the OAuth access token from Claude credentials
 */
function getAccessToken(): string | null {
  try {
    const credentialsPath = path.join(
      homedir(),
      ".claude",
      ".credentials.json"
    );
    const credentials = JSON.parse(readFileSync(credentialsPath, "utf-8"));
    return credentials?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch usage from Anthropic API
 */
async function fetchUsageFromApi(): Promise<ClaudeUsage> {
  const token = getAccessToken();

  if (!token) {
    return {
      fiveHour: null,
      sevenDay: null,
      extraUsage: null,
      fetchedAt: Date.now(),
      error: "No OAuth token found",
    };
  }

  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as ClaudeUsageResponse;

    return {
      fiveHour: data.five_hour
        ? {
            utilization: Math.round(data.five_hour.utilization),
            resetsAt: data.five_hour.resets_at,
          }
        : null,
      sevenDay: data.seven_day
        ? {
            utilization: Math.round(data.seven_day.utilization),
            resetsAt: data.seven_day.resets_at,
          }
        : null,
      extraUsage: data.extra_usage
        ? {
            isEnabled: data.extra_usage.is_enabled,
            monthlyLimit: data.extra_usage.monthly_limit,
            usedCredits: Math.round(data.extra_usage.used_credits * 100) / 100,
            utilization: Math.round(data.extra_usage.utilization),
          }
        : null,
      fetchedAt: Date.now(),
    };
  } catch (error) {
    return {
      fiveHour: null,
      sevenDay: null,
      extraUsage: null,
      fetchedAt: Date.now(),
      error: error instanceof Error ? error.message : "Failed to fetch usage",
    };
  }
}

/**
 * Get Claude usage with caching (5 minute TTL)
 */
export async function getClaudeUsage(): Promise<ClaudeUsage> {
  const now = Date.now();

  // Return cached usage if still fresh
  if (cachedUsage && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedUsage;
  }

  // Fetch fresh data
  cachedUsage = await fetchUsageFromApi();
  lastFetchTime = now;

  return cachedUsage;
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
