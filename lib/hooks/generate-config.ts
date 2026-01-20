/**
 * Claude Hooks Configuration Generator
 *
 * Generates hooks configuration for Claude that sends status updates
 * to the AgentOS status-update endpoint.
 *
 * IMPORTANT: Claude Code reads hooks from settings.json files, NOT from hooks.json.
 * This module writes to ~/.claude/settings.json (global) to avoid per-project bloat.
 *
 * The hooks are designed to:
 * - Be non-blocking (timeout after 2s)
 * - Fail silently (|| true) so they don't interrupt Claude
 * - Send the full hook payload plus tmux session info
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface HookCommand {
  type: "command";
  command: string;
}

interface HookDefinition {
  matcher: string; // Pattern to match tools: "" or "*" for all, "Bash" for exact, "Edit|Write" for regex
  hooks: HookCommand[];
}

interface HooksSection {
  PreToolUse?: HookDefinition[];
  PostToolUse?: HookDefinition[];
  Notification?: HookDefinition[];
  Stop?: HookDefinition[];
  SessionStart?: HookDefinition[];
  SessionEnd?: HookDefinition[];
  UserPromptSubmit?: HookDefinition[];
}

interface PermissionsSection {
  additionalDirectories?: string[];
  allow?: string[];
  deny?: string[];
  ask?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface ClaudeSettings extends Record<string, any> {
  hooks?: HooksSection;
  permissions?: PermissionsSection;
}

/**
 * Get the URL for the status-update endpoint
 */
export function getStatusUpdateUrl(port: number = 3011): string {
  return `http://localhost:${port}/api/sessions/status-update`;
}

/**
 * Generate the hook command that sends status updates
 *
 * The command:
 * 1. Reads the hook payload from stdin
 * 2. Adds the tmux session name to identify the AgentOS session
 * 3. POSTs to the status-update endpoint
 * 4. Times out after 2s to not block Claude
 * 5. Exits with 0 to not disrupt Claude's flow
 */
export function generateHookCommand(
  hookType: string,
  port: number = 3011
): string {
  const url = getStatusUpdateUrl(port);

  // The command reads stdin (hook payload), adds tmux_session, and POSTs
  // Using jq to add the tmux_session field if available, otherwise just the hook_type
  // Falls back to basic curl if jq isn't available
  // Note: Uses -L agentos to connect to the AgentOS tmux server
  return `bash -c '
HOOK_INPUT=$(cat)
TMUX_SESSION=$(tmux -L agentos display-message -p "#{session_name}" 2>/dev/null || echo "")
if command -v jq >/dev/null 2>&1 && [ -n "$HOOK_INPUT" ]; then
  PAYLOAD=$(echo "$HOOK_INPUT" | jq -c --arg ts "$TMUX_SESSION" --arg ht "${hookType}" ". + {tmux_session: \\$ts, hook_type: \\$ht}")
else
  PAYLOAD="{\\"tmux_session\\":\\"$TMUX_SESSION\\",\\"hook_type\\":\\"${hookType}\\"}"
fi
curl -X POST "${url}" -H "Content-Type: application/json" -d "$PAYLOAD" --silent --max-time 0.5 >/dev/null 2>&1 || true
exit 0
'`;
}

/**
 * Generate the hooks section for settings.json
 *
 * Uses the new hooks format with matchers:
 * { "matcher": {}, "hooks": [{ "type": "command", "command": "..." }] }
 */
export function generateHooksSection(port: number = 3011): HooksSection {
  return {
    PreToolUse: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: generateHookCommand("PreToolUse", port),
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: generateHookCommand("PostToolUse", port),
          },
        ],
      },
    ],
    Notification: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: generateHookCommand("Notification", port),
          },
        ],
      },
    ],
    Stop: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: generateHookCommand("Stop", port),
          },
        ],
      },
    ],
    SessionStart: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: generateHookCommand("SessionStart", port),
          },
        ],
      },
    ],
    SessionEnd: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: generateHookCommand("SessionEnd", port),
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: generateHookCommand("UserPromptSubmit", port),
          },
        ],
      },
    ],
  };
}

/**
 * Get path to user's global Claude config directory
 */
export function getGlobalClaudeConfigDir(): string {
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  if (claudeConfigDir) {
    return claudeConfigDir;
  }
  return path.join(os.homedir(), ".claude");
}

/**
 * Get the path to the global settings.json file
 */
export function getGlobalSettingsPath(): string {
  return path.join(getGlobalClaudeConfigDir(), "settings.json");
}

/**
 * Check if global hooks are configured with AgentOS status updates
 */
export function hasGlobalAgentOsHooks(): boolean {
  const configPath = getGlobalSettingsPath();
  try {
    if (!fs.existsSync(configPath)) {
      return false;
    }
    const content = fs.readFileSync(configPath, "utf-8");
    // Check if the config contains our status-update URL in a properly structured hook
    if (!content.includes("/api/sessions/status-update")) {
      return false;
    }
    // Verify the structure is correct
    const settings: ClaudeSettings = JSON.parse(content);
    if (!settings.hooks) {
      return false;
    }
    // Check if at least one hook type has our hook (new format with matcher/hooks)
    for (const hookType of [
      "PreToolUse",
      "PostToolUse",
      "Notification",
      "Stop",
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
    ] as const) {
      const hookDefs = settings.hooks[hookType];
      if (Array.isArray(hookDefs)) {
        const hasAgentOsHook = hookDefs.some((def) => {
          // New format: { matcher: "", hooks: [{ type, command }] }
          if (def.hooks && Array.isArray(def.hooks)) {
            return def.hooks.some(
              (h: HookCommand) =>
                h.type === "command" &&
                h.command?.includes("/api/sessions/status-update")
            );
          }
          return false;
        });
        if (hasAgentOsHook) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Write hooks configuration to the global Claude settings.json
 *
 * This merges AgentOS hooks into the existing settings, preserving
 * all other settings (model, mcpServers, etc.)
 *
 * @param port - The AgentOS server port (default 3011)
 */
export function writeGlobalHooksConfig(port: number = 3011): {
  success: boolean;
  path: string;
  merged: boolean;
} {
  const configDir = getGlobalClaudeConfigDir();
  const configPath = getGlobalSettingsPath();

  try {
    // Ensure .claude directory exists
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    let settings: ClaudeSettings = {};
    let merged = false;

    // Read existing settings if they exist
    if (fs.existsSync(configPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        merged = true;
      } catch {
        // If parsing fails, start fresh but preserve the file
        console.warn(
          "Failed to parse existing settings.json, creating new hooks section"
        );
      }
    }

    // Initialize hooks section if it doesn't exist
    if (!settings.hooks) {
      settings.hooks = {};
    }

    const generatedHooks = generateHooksSection(port);

    // Merge each hook type, preserving existing non-AgentOS hooks
    for (const hookType of [
      "PreToolUse",
      "PostToolUse",
      "Notification",
      "Stop",
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
    ] as const) {
      const existingHooks = settings.hooks[hookType] || [];
      const newHookDef = generatedHooks[hookType]?.[0];

      if (newHookDef) {
        // Filter out any existing AgentOS hooks (both old and new format)
        const filteredHooks = existingHooks.filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (h: any) => {
            // New format: { matcher: "", hooks: [...] }
            if (h.hooks && Array.isArray(h.hooks)) {
              const hasAgentOsHook = h.hooks.some(
                (cmd: HookCommand) =>
                  cmd.type === "command" &&
                  cmd.command?.includes("/api/sessions/status-update")
              );
              if (hasAgentOsHook) {
                return false;
              }
            }
            // Old format: { type: "command", command: "..." }
            if (
              h.type === "command" &&
              h.command?.includes("/api/sessions/status-update")
            ) {
              return false;
            }
            return true;
          }
        );
        settings.hooks[hookType] = [...filteredHooks, newHookDef];
      }
    }

    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2));

    return { success: true, path: configPath, merged };
  } catch (error) {
    console.error("Failed to write global hooks config:", error);
    return { success: false, path: configPath, merged: false };
  }
}

/**
 * Remove AgentOS hooks from the global settings.json
 */
export function removeGlobalAgentOsHooks(): boolean {
  const configPath = getGlobalSettingsPath();

  try {
    if (!fs.existsSync(configPath)) {
      return true; // Nothing to remove
    }

    const content = fs.readFileSync(configPath, "utf-8");
    const settings: ClaudeSettings = JSON.parse(content);

    if (!settings.hooks) {
      return true;
    }

    // Filter out AgentOS hooks from each type (handle both old and new format)
    for (const hookType of [
      "PreToolUse",
      "PostToolUse",
      "Notification",
      "Stop",
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
    ] as const) {
      if (settings.hooks[hookType]) {
        settings.hooks[hookType] = settings.hooks[hookType]!.filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (h: any) => {
            // New format: { matcher: "", hooks: [...] }
            if (h.hooks && Array.isArray(h.hooks)) {
              const hasAgentOsHook = h.hooks.some(
                (cmd: HookCommand) =>
                  cmd.type === "command" &&
                  cmd.command?.includes("/api/sessions/status-update")
              );
              return !hasAgentOsHook;
            }
            // Old format: { type: "command", command: "..." }
            if (h.command?.includes("/api/sessions/status-update")) {
              return false;
            }
            return true;
          }
        );
        // Remove empty arrays
        if (settings.hooks[hookType]!.length === 0) {
          delete settings.hooks[hookType];
        }
      }
    }

    // Remove hooks object if empty
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2));
    return true;
  } catch {
    return false;
  }
}
