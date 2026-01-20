/**
 * Tmux Utilities
 *
 * Utilities for managing tmux sessions, both local and inside containers.
 */

import { exec as execCallback } from "child_process";
import { promisify } from "util";

const exec = promisify(execCallback);

/**
 * Escape a string for safe use in shell commands.
 */
function escapeShellArg(arg: string): string {
  // Wrap in single quotes and escape any existing single quotes
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Create a new tmux session with a command running inside.
 * For sandboxed sessions, runs inside a container.
 */
export async function createTmuxSession(options: {
  name: string;
  cwd: string;
  command: string;
  insideContainer?: string; // Container ID if sandboxed
}): Promise<void> {
  const { name, cwd, command, insideContainer } = options;

  if (insideContainer) {
    // For sandboxed sessions, the container typically runs tmux as entrypoint.
    // This function can create a new tmux session inside the container if needed.
    await exec(
      `docker exec ${insideContainer} tmux new-session -d -s ${escapeShellArg(name)} -c ${escapeShellArg(cwd)} ${escapeShellArg(command)}`
    );
  } else {
    // Create a local tmux session
    await exec(
      `tmux new-session -d -s ${escapeShellArg(name)} -c ${escapeShellArg(cwd)} ${escapeShellArg(command)}`
    );
  }
}

/**
 * Check if a tmux session exists and is running.
 */
export async function isTmuxSessionAlive(
  name: string,
  insideContainer?: string
): Promise<boolean> {
  try {
    if (insideContainer) {
      await exec(
        `docker exec ${insideContainer} tmux has-session -t ${escapeShellArg(name)}`
      );
    } else {
      await exec(`tmux has-session -t ${escapeShellArg(name)}`);
    }
    return true;
  } catch {
    // Exit code non-zero means session doesn't exist
    return false;
  }
}

/**
 * Kill a tmux session.
 */
export async function killTmuxSession(
  name: string,
  insideContainer?: string
): Promise<void> {
  try {
    if (insideContainer) {
      await exec(
        `docker exec ${insideContainer} tmux kill-session -t ${escapeShellArg(name)}`
      );
    } else {
      await exec(`tmux kill-session -t ${escapeShellArg(name)}`);
    }
  } catch (error) {
    // Log at debug level - session may not exist which is expected
    const msg = error instanceof Error ? error.message : "Unknown error";
    // Only log if it's not the expected "session not found" error
    if (
      !msg.includes("session not found") &&
      !msg.includes("no server running")
    ) {
      console.warn(`[tmux] Failed to kill session ${name}:`, msg);
    }
  }
}

/**
 * Get the command and args to attach to a tmux session.
 * This is used by the server to spawn a PTY that views the session.
 */
export function getTmuxAttachCommand(
  name: string,
  insideContainer?: string
): { command: string; args: string[] } {
  if (insideContainer) {
    return {
      command: "docker",
      args: ["exec", "-it", insideContainer, "tmux", "attach", "-t", name],
    };
  } else {
    return {
      command: "tmux",
      args: ["attach", "-t", name],
    };
  }
}

/**
 * List all tmux sessions (for recovery on server restart).
 */
export async function listTmuxSessions(
  insideContainer?: string
): Promise<string[]> {
  try {
    let result;
    if (insideContainer) {
      result = await exec(
        `docker exec ${insideContainer} tmux list-sessions -F '#{session_name}'`
      );
    } else {
      result = await exec(`tmux list-sessions -F '#{session_name}'`);
    }

    const sessions = result.stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    return sessions;
  } catch {
    // tmux not running or no sessions returns empty list
    return [];
  }
}

// =============================================================================
// Legacy functions (preserved for backward compatibility)
// =============================================================================

/**
 * Check if a tmux session exists (legacy, use isTmuxSessionAlive instead)
 */
export async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  return isTmuxSessionAlive(sessionName);
}

/**
 * Get the last few lines of a tmux pane
 */
export async function captureTmuxPane(
  sessionName: string,
  lines: number = 50,
  insideContainer?: string
): Promise<string> {
  try {
    const escapedName = escapeShellArg(sessionName);
    let result;
    if (insideContainer) {
      result = await exec(
        `docker exec ${insideContainer} tmux capture-pane -t ${escapedName} -p -S -${lines}`
      );
    } else {
      result = await exec(
        `tmux capture-pane -t ${escapedName} -p -S -${lines} 2>/dev/null || echo ""`
      );
    }
    return result.stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Get the current working directory of a tmux session
 */
export async function getTmuxSessionCwd(
  sessionName: string,
  insideContainer?: string
): Promise<string | null> {
  try {
    const escapedName = escapeShellArg(sessionName);
    let result;
    if (insideContainer) {
      result = await exec(
        `docker exec ${insideContainer} tmux display-message -t ${escapedName} -p "#{pane_current_path}"`
      );
    } else {
      result = await exec(
        `tmux display-message -t ${escapedName} -p "#{pane_current_path}" 2>/dev/null || echo ""`
      );
    }
    const cwd = result.stdout.trim();
    return cwd || null;
  } catch {
    return null;
  }
}

/**
 * Simple status check - returns "alive" or "dead"
 * For more detailed status, use the statusBroadcaster (SSE-based)
 */
export async function getSimpleStatus(
  sessionName: string,
  insideContainer?: string
): Promise<"alive" | "dead"> {
  const exists = await isTmuxSessionAlive(sessionName, insideContainer);
  return exists ? "alive" : "dead";
}
