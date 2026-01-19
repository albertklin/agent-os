/**
 * Sandbox System
 *
 * Provides comprehensive isolation for auto-approve sessions with both
 * filesystem and network protection:
 *
 * FILESYSTEM PROTECTION:
 * - Bash commands: OS-level sandbox (bubblewrap/seatbelt) restricts access
 * - Write/Edit tools: Deny rules block all absolute (//**) and home (~/**)
 *   paths. Allow rules permit only ./** (working directory).
 * - Read tool: Sensitive files (.env, secrets, credentials) are denied
 *
 * NETWORK PROTECTION:
 * - Bash commands: OS sandbox provides network isolation
 * - WebFetch/WebSearch: Entirely blocked via deny rules
 * - Network CLI tools: curl, wget, ssh, etc. blocked via Bash deny rules
 *
 * Uses Claude Code's built-in sandbox via settings.json configuration.
 *
 * Path syntax (critical for deny rules to work):
 * - //path = absolute path from filesystem root
 * - ~/path = path from home directory
 * - /path = path relative to settings file directory (project root)
 * - ./path = path relative to current working directory
 * See: https://github.com/anthropics/claude-code/issues/6699#issuecomment-3243297584
 *
 * Limitations:
 * - Can't use blanket "Write"/"Edit" deny (would block ./** too)
 * - Path escapes via symlinks or .. may not be fully blocked
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
 * This enables OS-level isolation for bash commands and restricts
 * Write/Edit tools to the working directory via permissions.
 *
 * Note: The OS sandbox (bubblewrap/seatbelt) only applies to Bash commands.
 * Write/Edit/Read tools are restricted via the permissions system instead.
 */
interface ClaudeSandboxSettings {
  sandbox: {
    enabled: boolean;
    autoAllowBashIfSandboxed: boolean;
    allowUnsandboxedCommands: boolean;
    excludedCommands?: string[];
  };
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
}

/**
 * Generate sandbox settings for auto-approve sessions.
 * These settings enable strict sandbox mode with no escape hatch.
 *
 * Security model:
 * - Bash commands: Restricted by OS sandbox (bubblewrap/seatbelt)
 * - Write/Edit tools: Explicit deny rules for sensitive paths
 *   (Note: blanket deny doesn't work because deny rules take precedence
 *   over allow rules - "Write" deny would block ALL writes including ./)
 * - Read tool: Sensitive paths denied
 *
 * Path format (per Claude Code docs):
 * - //path = absolute path from filesystem root
 * - ~/path = path from home directory
 * - /path = relative to settings file (NOT absolute!)
 * - ./path = relative to current working directory
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
      // Allow Write/Edit only within the working directory
      allow: ["Write(./**)", "Edit(./**)"],
      //
      // DENY RULES - Comprehensive protection for filesystem and network
      //
      // Path format reference:
      // - //path = absolute path from filesystem root
      // - ~/path = path from home directory
      // - /path = path relative to settings file directory (project root)
      // - ./path = path relative to current working directory
      //
      // Note: Can't use blanket "Write"/"Edit" deny because deny takes
      // precedence over allow, which would block ./** too.
      deny: [
        // ===== FILESYSTEM PROTECTION =====
        // Block ALL writes/edits to absolute paths (covers /etc, /tmp, /usr, etc.)
        "Write(//**)",
        "Edit(//**)",
        // Block ALL writes/edits to home directory
        "Write(~/**)",
        "Edit(~/**)",
        // Block reading sensitive files in project
        "Read(/.env)",
        "Read(/**/.env)",
        "Read(/.env.*)",
        "Read(/**/.env.*)",
        "Read(/secrets/**)",
        // Block reading sensitive files in home directory
        "Read(~/.aws/**)",
        "Read(~/.ssh/**)",
        "Read(~/.gnupg/**)",
        "Read(~/.config/gcloud/**)",

        // ===== NETWORK PROTECTION =====
        // Block web fetch and search tools entirely
        "WebFetch",
        "WebSearch",
        // Block network-capable Bash commands
        // (Note: OS sandbox also restricts network, this is defense in depth)
        "Bash(curl:*)",
        "Bash(wget:*)",
        "Bash(nc:*)",
        "Bash(netcat:*)",
        "Bash(ssh:*)",
        "Bash(scp:*)",
        "Bash(rsync:*)",
        "Bash(ftp:*)",
        "Bash(sftp:*)",
        "Bash(telnet:*)",
        "Bash(nmap:*)",
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
    const existingPermissions =
      (existingSettings.permissions as Record<string, unknown>) || {};

    const mergedSettings = {
      ...existingSettings,
      sandbox: sandboxSettings.sandbox,
      permissions: {
        ...existingPermissions,
        // Merge allow rules (sandbox rules take precedence by being first)
        allow: [
          ...new Set([
            ...(sandboxSettings.permissions?.allow || []),
            ...((existingPermissions.allow as string[]) || []),
          ]),
        ],
        // Merge deny rules (sandbox rules take precedence by being first)
        deny: [
          ...new Set([
            ...(sandboxSettings.permissions?.deny || []),
            ...((existingPermissions.deny as string[]) || []),
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
