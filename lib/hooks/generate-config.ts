/**
 * Claude Hooks Configuration Generator
 *
 * Generates hooks.json configuration for Claude that sends status updates
 * to the AgentOS status-update endpoint.
 *
 * The hooks are designed to:
 * - Be non-blocking (timeout after 2s)
 * - Fail silently (|| true) so they don't interrupt Claude
 * - Send the full hook payload plus tmux session info
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface HooksConfig {
  hooks: {
    PreToolUse?: HookDefinition[];
    PostToolUse?: HookDefinition[];
    Notification?: HookDefinition[];
    Stop?: HookDefinition[];
  };
}

interface HookDefinition {
  type: "command";
  command: string;
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
  return `bash -c '
HOOK_INPUT=$(cat)
TMUX_SESSION=$(tmux display-message -p "#{session_name}" 2>/dev/null || echo "")
if command -v jq >/dev/null 2>&1 && [ -n "$HOOK_INPUT" ]; then
  PAYLOAD=$(echo "$HOOK_INPUT" | jq -c --arg ts "$TMUX_SESSION" --arg ht "${hookType}" ". + {tmux_session: \\$ts, hook_type: \\$ht}")
else
  PAYLOAD="{\\"tmux_session\\":\\"$TMUX_SESSION\\",\\"hook_type\\":\\"${hookType}\\"}"
fi
curl -X POST "${url}" -H "Content-Type: application/json" -d "$PAYLOAD" --silent --max-time 2 >/dev/null 2>&1 || true
exit 0
'`;
}

/**
 * Generate the full hooks configuration
 */
export function generateHooksConfig(port: number = 3011): HooksConfig {
  return {
    hooks: {
      PreToolUse: [
        {
          type: "command",
          command: generateHookCommand("PreToolUse", port),
        },
      ],
      PostToolUse: [
        {
          type: "command",
          command: generateHookCommand("PostToolUse", port),
        },
      ],
      Stop: [
        {
          type: "command",
          command: generateHookCommand("Stop", port),
        },
      ],
    },
  };
}

/**
 * Get the path to the Claude hooks config directory for a project
 */
export function getHooksConfigDir(projectDir: string): string {
  return path.join(projectDir, ".claude");
}

/**
 * Get the path to the hooks.json file for a project
 */
export function getHooksConfigPath(projectDir: string): string {
  return path.join(getHooksConfigDir(projectDir), "hooks.json");
}

/**
 * Check if hooks are configured for a project
 */
export function isHooksConfigured(projectDir: string): boolean {
  const configPath = getHooksConfigPath(projectDir);
  try {
    if (!fs.existsSync(configPath)) {
      return false;
    }
    const content = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(content);
    // Check if any hooks are configured
    return !!(
      config.hooks &&
      (config.hooks.PreToolUse?.length ||
        config.hooks.PostToolUse?.length ||
        config.hooks.Stop?.length)
    );
  } catch {
    return false;
  }
}

/**
 * Check if hooks are configured with AgentOS status updates
 */
export function hasAgentOsHooks(projectDir: string): boolean {
  const configPath = getHooksConfigPath(projectDir);
  try {
    if (!fs.existsSync(configPath)) {
      return false;
    }
    const content = fs.readFileSync(configPath, "utf-8");
    // Check if the config contains our status-update URL
    return content.includes("/api/sessions/status-update");
  } catch {
    return false;
  }
}

/**
 * Write hooks configuration to a project directory
 *
 * @param projectDir - The project directory to write hooks to
 * @param port - The AgentOS server port (default 3011)
 * @param merge - If true, merge with existing hooks instead of replacing
 */
export function writeHooksConfig(
  projectDir: string,
  port: number = 3011,
  merge: boolean = true
): { success: boolean; path: string; merged: boolean } {
  const configDir = getHooksConfigDir(projectDir);
  const configPath = getHooksConfigPath(projectDir);

  try {
    // Ensure .claude directory exists
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    let finalConfig: HooksConfig;
    let merged = false;

    if (merge && fs.existsSync(configPath)) {
      // Read existing config and merge
      try {
        const existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        const generated = generateHooksConfig(port);

        finalConfig = {
          ...existing,
          hooks: {
            ...existing.hooks,
          },
        };

        // Merge each hook type
        for (const hookType of ["PreToolUse", "PostToolUse", "Stop"] as const) {
          const existingHooks = existing.hooks?.[hookType] || [];
          const newHook = generated.hooks[hookType]?.[0];

          if (newHook) {
            // Filter out any existing AgentOS hooks
            const filteredHooks = existingHooks.filter(
              (h: HookDefinition) =>
                !h.command?.includes("/api/sessions/status-update")
            );
            finalConfig.hooks[hookType] = [...filteredHooks, newHook];
          }
        }

        merged = true;
      } catch {
        // If parsing fails, use generated config
        finalConfig = generateHooksConfig(port);
      }
    } else {
      finalConfig = generateHooksConfig(port);
    }

    fs.writeFileSync(configPath, JSON.stringify(finalConfig, null, 2));

    return { success: true, path: configPath, merged };
  } catch (error) {
    console.error("Failed to write hooks config:", error);
    return { success: false, path: configPath, merged: false };
  }
}

/**
 * Remove AgentOS hooks from a project's hooks.json
 */
export function removeAgentOsHooks(projectDir: string): boolean {
  const configPath = getHooksConfigPath(projectDir);

  try {
    if (!fs.existsSync(configPath)) {
      return true; // Nothing to remove
    }

    const content = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(content);

    if (!config.hooks) {
      return true;
    }

    // Filter out AgentOS hooks from each type
    for (const hookType of [
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "Notification",
    ]) {
      if (config.hooks[hookType]) {
        config.hooks[hookType] = config.hooks[hookType].filter(
          (h: HookDefinition) =>
            !h.command?.includes("/api/sessions/status-update")
        );
        // Remove empty arrays
        if (config.hooks[hookType].length === 0) {
          delete config.hooks[hookType];
        }
      }
    }

    // Remove hooks object if empty
    if (Object.keys(config.hooks).length === 0) {
      delete config.hooks;
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Get path to user's global Claude config
 */
export function getGlobalClaudeConfigDir(): string {
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  if (claudeConfigDir) {
    return claudeConfigDir;
  }
  return path.join(os.homedir(), ".claude");
}
