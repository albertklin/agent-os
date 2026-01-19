/**
 * Sandbox System
 *
 * Provides Claude's native sandbox isolation for auto-approve sessions.
 * When enabled, sessions run with OS-level isolation:
 * - Filesystem isolation (read/write only to working directory)
 * - Network isolation (proxy-based domain filtering)
 *
 * Uses Claude Code's built-in sandbox via settings.json configuration,
 * enforced by bubblewrap (Linux) or seatbelt (macOS).
 */

import * as fs from "fs";
import * as path from "path";
import { db, queries } from "./db";

export interface SandboxOptions {
  sessionId: string;
  workingDirectory: string;
}

/**
 * Claude sandbox settings to write to .claude/settings.json
 * This enables OS-level isolation for bash commands.
 */
interface ClaudeSandboxSettings {
  sandbox: {
    enabled: boolean;
    autoAllowBashIfSandboxed: boolean;
    allowUnsandboxedCommands: boolean;
    excludedCommands?: string[];
  };
  permissions?: {
    deny?: string[];
  };
}

/**
 * Generate sandbox settings for auto-approve sessions.
 * These settings enable strict sandbox mode with no escape hatch.
 */
function generateSandboxSettings(): ClaudeSandboxSettings {
  return {
    sandbox: {
      // Enable OS-level sandbox (bubblewrap on Linux, seatbelt on macOS)
      enabled: true,
      // Auto-approve bash commands when running inside sandbox
      autoAllowBashIfSandboxed: true,
      // CRITICAL: Disable escape hatch - prevents Claude from bypassing sandbox
      allowUnsandboxedCommands: false,
      // Commands that must run outside sandbox (add if needed)
      excludedCommands: ["docker", "git"],
    },
    permissions: {
      // Deny access to sensitive files even with read-only access
      deny: [
        "Read(.env)",
        "Read(.env.*)",
        "Read(./secrets/**)",
        "Read(~/.aws/**)",
        "Read(~/.ssh/**)",
        "Read(~/.config/gcloud/**)",
      ],
    },
  };
}

/**
 * Ensure Claude sandbox settings exist in the workspace.
 * Creates .claude/settings.json with sandbox enabled.
 */
export async function ensureSandboxSettings(
  workspaceFolder: string
): Promise<boolean> {
  const absoluteWorkspaceFolder = path.resolve(workspaceFolder);
  const claudeDir = path.join(absoluteWorkspaceFolder, ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");

  try {
    // Create .claude directory if it doesn't exist
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    // Read existing settings if present
    let existingSettings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        existingSettings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      } catch {
        // Invalid JSON, will overwrite
      }
    }

    // Merge sandbox settings (our sandbox config takes precedence)
    const sandboxSettings = generateSandboxSettings();
    const mergedSettings = {
      ...existingSettings,
      sandbox: sandboxSettings.sandbox,
      permissions: {
        ...((existingSettings.permissions as Record<string, unknown>) || {}),
        deny: [
          ...new Set([
            ...(((existingSettings.permissions as Record<string, unknown>)
              ?.deny as string[]) || []),
            ...(sandboxSettings.permissions?.deny || []),
          ]),
        ],
      },
    };

    // Write settings
    fs.writeFileSync(settingsPath, JSON.stringify(mergedSettings, null, 2));

    console.log(`[sandbox] Created Claude sandbox settings at ${settingsPath}`);
    return true;
  } catch (error) {
    console.error("[sandbox] Failed to create sandbox settings:", error);
    return false;
  }
}

/**
 * Initialize sandbox for a session by creating Claude settings.
 * This is synchronous and fast since it just writes a config file.
 */
export async function initializeSandbox(
  options: SandboxOptions
): Promise<boolean> {
  const { sessionId, workingDirectory } = options;

  // Update status to initializing
  queries.updateSessionSandbox(db).run(null, "initializing", sessionId);

  try {
    // Create sandbox settings in workspace
    const success = await ensureSandboxSettings(workingDirectory);

    if (!success) {
      queries.updateSessionSandbox(db).run(null, "failed", sessionId);
      return false;
    }

    // Mark as ready - sandbox settings are in place
    queries.updateSessionSandbox(db).run(null, "ready", sessionId);
    console.log(`[sandbox] Sandbox ready for session ${sessionId}`);

    return true;
  } catch (error) {
    console.error(`[sandbox] Failed to initialize sandbox:`, error);
    queries.updateSessionSandbox(db).run(null, "failed", sessionId);
    return false;
  }
}

/**
 * Check if a session should use sandbox (has auto_approve and is claude agent)
 */
export function shouldUseSandbox(session: {
  auto_approve: boolean;
  agent_type: string;
}): boolean {
  return session.auto_approve && session.agent_type === "claude";
}

/**
 * Get the sandbox status for a session
 */
export function getSandboxStatus(
  sessionId: string
): "pending" | "initializing" | "ready" | "failed" | null {
  const session = queries.getSession(db).get(sessionId) as {
    sandbox_status?: string;
  } | null;
  return (
    (session?.sandbox_status as ReturnType<typeof getSandboxStatus>) ?? null
  );
}

/**
 * Clean up sandbox settings when session is deleted.
 * Note: We don't remove .claude/settings.json since it may have user settings.
 * The sandbox settings will be overwritten on next auto-approve session.
 */
export async function cleanupSandbox(sessionId: string): Promise<void> {
  // Just clear the database status
  queries.updateSessionSandbox(db).run(null, null, sessionId);
  console.log(`[sandbox] Cleaned up sandbox status for session ${sessionId}`);
}
