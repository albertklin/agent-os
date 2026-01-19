/**
 * Session utilities
 *
 * The tmux session name is deterministically computed from the session's
 * agent_type and id. This eliminates the need to store tmux_name separately
 * and prevents desync issues.
 */

import type { Session } from "./db";
import type { AgentType } from "./providers";

/**
 * Compute the tmux session name for a session.
 * Format: {agent_type}-{session_id}
 */
export function getTmuxSessionName(session: {
  agent_type: AgentType | string;
  id: string;
}): string {
  return `${session.agent_type}-${session.id}`;
}

/**
 * Compute the tmux session name from individual components.
 * Useful when you have the parts but not a full session object.
 */
export function buildTmuxSessionName(
  sessionId: string,
  agentType: AgentType | string = "claude"
): string {
  return `${agentType}-${sessionId}`;
}

/**
 * Parse a tmux session name back into its components.
 * Returns null if the format doesn't match.
 */
export function parseTmuxSessionName(
  tmuxName: string
): { agentType: string; sessionId: string } | null {
  // Format: {agent_type}-{uuid}
  // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  const uuidPattern =
    /^(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  const match = tmuxName.match(uuidPattern);
  if (!match) return null;

  return {
    agentType: match[1],
    sessionId: match[2],
  };
}

/**
 * Get the working directory for a session, with ~ expanded to $HOME.
 */
export function getSessionCwd(session: Session): string {
  return session.working_directory?.replace("~", "$HOME") || "$HOME";
}
