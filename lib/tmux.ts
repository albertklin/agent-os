/**
 * Tmux Utilities
 *
 * Simple utilities for interacting with tmux sessions.
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Check if a tmux session exists
 */
export async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    await execAsync(`tmux has-session -t "${sessionName}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a list of all tmux sessions
 */
export async function listTmuxSessions(): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      "tmux list-sessions -F '#{session_name}' 2>/dev/null || true"
    );
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get the last few lines of a tmux pane
 */
export async function captureTmuxPane(
  sessionName: string,
  lines: number = 50
): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `tmux capture-pane -t "${sessionName}" -p -S -${lines} 2>/dev/null || echo ""`
    );
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Get the current working directory of a tmux session
 */
export async function getTmuxSessionCwd(
  sessionName: string
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `tmux display-message -t "${sessionName}" -p "#{pane_current_path}" 2>/dev/null || echo ""`
    );
    const cwd = stdout.trim();
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
  sessionName: string
): Promise<"alive" | "dead"> {
  const exists = await tmuxSessionExists(sessionName);
  return exists ? "alive" : "dead";
}
