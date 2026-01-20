/**
 * Session utilities
 *
 * The tmux session name is deterministically computed from the session's
 * agent_type and id. This eliminates the need to store tmux_name separately
 * and prevents desync issues.
 */

import type { Session } from "./db";
import type { AgentType } from "./providers";
import { getProvider } from "./providers";

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

/**
 * Build the agent command to run in the tmux session.
 * Uses the provider's command and builds appropriate flags.
 *
 * @param agentType - The agent type (e.g., "claude", "codex")
 * @param options - Options for building the command
 * @returns The full command string, or empty string for shell provider
 */
export function buildAgentCommand(
  agentType: AgentType | string,
  options: {
    claudeSessionId?: string | null;
    parentSessionId?: string | null;
    model?: string;
    autoApprove?: boolean;
    initialPrompt?: string | null;
  } = {}
): string {
  const provider = getProvider(agentType as AgentType);

  // Shell provider has no command
  if (!provider.command) {
    return "";
  }

  const flags = provider.buildFlags({
    sessionId: options.claudeSessionId,
    parentSessionId: options.parentSessionId,
    model: options.model,
    autoApprove: options.autoApprove,
    initialPrompt: options.initialPrompt ?? undefined,
  });

  if (flags.length === 0) {
    return provider.command;
  }

  return `${provider.command} ${flags.join(" ")}`;
}

/**
 * Status type for session status tracking
 */
export type SessionStatusType =
  | "idle"
  | "running"
  | "waiting"
  | "error"
  | "dead"
  | "unknown";

/**
 * Get the oldest waiting session from a list of sessions.
 * Oldest = has been waiting the longest (based on updated_at).
 *
 * @param sessions - Array of sessions to search
 * @param statuses - Map of session ID to status data
 * @param excludeId - Optional session ID to exclude from results
 * @returns The oldest waiting session, or undefined if none found
 */
export function getOldestWaitingSession(
  sessions: Session[],
  statuses: Record<string, { status: SessionStatusType }>,
  excludeId?: string
): Session | undefined {
  return sessions
    .filter((s) => s.id !== excludeId && statuses[s.id]?.status === "waiting")
    .sort(
      (a, b) =>
        new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
    )[0];
}
