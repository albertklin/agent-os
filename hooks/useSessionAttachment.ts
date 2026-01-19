"use client";

import { useRef, useCallback } from "react";
import { usePanes } from "@/contexts/PaneContext";
import { getProvider } from "@/lib/providers";
import { getTmuxSessionName, getSessionCwd } from "@/lib/sessions";
import { getPendingPrompt, clearPendingPrompt } from "@/stores/initialPrompt";
import { toast } from "sonner";
import type { TerminalHandle } from "@/components/Terminal";
import type { Session } from "@/lib/db";

interface AttachmentLock {
  paneId: string;
  sessionId: string;
  resolve: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Update a session's claude_session_id in the database.
 */
async function updateClaudeSessionId(
  sessionId: string,
  claudeSessionId: string
): Promise<boolean> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claude_session_id: claudeSessionId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Hook for managing session attachment with proper locking and fresh data.
 *
 * Key improvements over the old approach:
 * 1. Uses a lock to prevent concurrent attachments to the same pane
 * 2. Fetches fresh session data from API (not stale React state)
 * 3. Computes tmux session name deterministically
 * 4. Updates UI state only after tmux command is sent
 */
export function useSessionAttachment() {
  const lockRef = useRef<AttachmentLock | null>(null);
  const { attachSession, getActiveTab } = usePanes();

  /**
   * Fetch fresh session data from the API.
   * This ensures we always have the latest working_directory, etc.
   */
  const fetchSession = useCallback(
    async (sessionId: string): Promise<Session | null> => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`);
        if (!res.ok) return null;
        const { session } = await res.json();
        return session || null;
      } catch {
        return null;
      }
    },
    []
  );

  /**
   * Build the CLI command for the agent (e.g., "claude --resume abc123").
   * For auto-approve sessions, Claude's native sandbox is enabled via
   * .claude/settings.json, so no command wrapping is needed.
   * @param newSessionId - Pre-generated UUID for new sessions or forks
   */
  const buildAgentCommand = useCallback(
    (
      session: Session,
      sessions: Session[],
      newSessionId?: string | null
    ): string => {
      const provider = getProvider(session.agent_type || "claude");

      // Shell sessions don't have a command
      if (provider.id === "shell") {
        return "";
      }

      // Get parent session ID for forking
      let parentSessionId: string | null = null;
      if (!session.claude_session_id && session.parent_session_id) {
        const parentSession = sessions.find(
          (s) => s.id === session.parent_session_id
        );
        parentSessionId = parentSession?.claude_session_id || null;
      }

      // Check for pending initial prompt
      const initialPrompt = getPendingPrompt(session.id);
      if (initialPrompt) {
        clearPendingPrompt(session.id);
      }

      const flags = provider.buildFlags({
        sessionId: session.claude_session_id,
        parentSessionId,
        newSessionId: newSessionId || undefined,
        autoApprove: session.auto_approve,
        model: session.model,
        initialPrompt: initialPrompt || undefined,
      });

      const flagsStr = flags.join(" ");
      const command = flagsStr
        ? `${provider.command} ${flagsStr}`
        : provider.command;

      // Note: For auto-approve sessions, sandbox is enabled via .claude/settings.json
      // Claude will automatically apply sandbox restrictions when it starts

      return command;
    },
    []
  );

  /**
   * Attach to a session in a terminal.
   *
   * This is the main function - it handles:
   * - Locking to prevent races
   * - Fetching fresh session data
   * - Detaching from current tmux if needed
   * - Attaching to new tmux session (or creating it)
   * - Updating UI state
   */
  const attachToSession = useCallback(
    async (
      sessionId: string,
      terminal: TerminalHandle,
      paneId: string,
      sessions: Session[] = []
    ): Promise<boolean> => {
      // Wait for any pending attachment on this pane to complete
      if (lockRef.current?.paneId === paneId) {
        // Create a promise to wait for the current lock
        await new Promise<void>((resolve) => {
          const checkLock = () => {
            if (!lockRef.current || lockRef.current.paneId !== paneId) {
              resolve();
            } else {
              setTimeout(checkLock, 50);
            }
          };
          checkLock();
        });
      }

      // Acquire lock for this pane
      let resolveLock: () => void = () => {};
      lockRef.current = {
        paneId,
        sessionId,
        resolve: () => resolveLock(),
      };
      const lockPromise = new Promise<void>((r) => {
        resolveLock = r;
      });

      try {
        // 1. Fetch fresh session data from API
        let session = await fetchSession(sessionId);
        if (!session) {
          console.error("[useSessionAttachment] Session not found:", sessionId);
          return false;
        }

        // 1.5. Check if session setup is complete (for worktree sessions)
        if (
          session.setup_status &&
          session.setup_status !== "ready" &&
          session.setup_status !== "failed"
        ) {
          const statusMessages: Record<string, string> = {
            pending: "Setting up session...",
            creating_worktree: "Creating worktree...",
            init_submodules: "Initializing submodules...",
            installing_deps: "Installing dependencies...",
          };
          const message =
            statusMessages[session.setup_status] || "Session is still setting up...";
          toast.info(message, {
            description: "Please wait for setup to complete",
          });
          return false;
        }

        // 2. For auto-approve sessions, verify sandbox settings are ready
        // (Sandbox initialization writes .claude/settings.json, which is fast)
        if (session.auto_approve && session.agent_type === "claude") {
          // Brief wait if still initializing (should be very fast since it's just writing a file)
          if (
            session.sandbox_status === "pending" ||
            session.sandbox_status === "initializing"
          ) {
            console.log(
              "[useSessionAttachment] Waiting for sandbox settings..."
            );
            const maxWaitMs = 5000; // 5 second timeout (file write should be instant)
            const pollIntervalMs = 500;
            const startTime = Date.now();

            while (Date.now() - startTime < maxWaitMs) {
              await sleep(pollIntervalMs);
              session = await fetchSession(sessionId);

              if (!session) {
                console.error(
                  "[useSessionAttachment] Session disappeared while waiting"
                );
                return false;
              }

              if (session.sandbox_status === "ready") {
                break;
              }

              if (session.sandbox_status === "failed") {
                console.error(
                  "[useSessionAttachment] Sandbox settings failed - cannot attach"
                );
                return false;
              }
            }
          }

          // Refuse attachment if sandbox settings aren't ready
          if (session.sandbox_status !== "ready") {
            console.error(
              "[useSessionAttachment] Cannot attach: sandbox settings not ready",
              { status: session.sandbox_status }
            );
            return false;
          }
        }

        // 3. Compute tmux session name (deterministic from agent_type + id)
        const tmuxName = getTmuxSessionName(session);
        const cwd = getSessionCwd(session);

        // 4. Detach from current tmux if needed
        const activeTab = getActiveTab(paneId);
        if (activeTab?.sessionId && activeTab.sessionId !== sessionId) {
          terminal.sendInput("\x02d"); // Ctrl+B d (tmux detach)
          await sleep(100);
        }

        // 5. Clear any running command
        terminal.sendInput("\x03"); // Ctrl+C
        await sleep(50);

        // 6. Generate claude_session_id if needed (for Claude-type agents only)
        let newSessionId: string | null = null;
        const provider = getProvider(session.agent_type || "claude");
        if (
          provider.id === "claude" &&
          !session.claude_session_id &&
          provider.supportsResume
        ) {
          // Generate a new UUID for this session
          newSessionId = generateUUID();
          // Store it in the database before starting Claude
          const updated = await updateClaudeSessionId(session.id, newSessionId);
          if (!updated) {
            console.warn(
              "[useSessionAttachment] Failed to store claude_session_id, continuing anyway"
            );
          }
        }

        // 7. Build tmux command
        const agentCommand = buildAgentCommand(session, sessions, newSessionId);
        const tmuxNew = agentCommand
          ? `tmux new -s ${tmuxName} -c "${cwd}" "${agentCommand}"`
          : `tmux new -s ${tmuxName} -c "${cwd}"`;

        const tmuxCmd = `tmux attach -t ${tmuxName} 2>/dev/null || ${tmuxNew}`;

        // 7. Send the tmux command
        terminal.sendCommand(tmuxCmd);

        // 8. Wait a moment for tmux to attach
        // (In the future, could poll terminal output to confirm)
        await sleep(150);

        // 9. Update UI state
        attachSession(paneId, session.id, tmuxName);
        terminal.focus();

        return true;
      } catch (error) {
        console.error("[useSessionAttachment] Error attaching:", error);
        return false;
      } finally {
        // Release lock
        resolveLock();
        if (
          lockRef.current?.paneId === paneId &&
          lockRef.current?.sessionId === sessionId
        ) {
          lockRef.current = null;
        }
      }
    },
    [fetchSession, buildAgentCommand, getActiveTab, attachSession]
  );

  /**
   * Check if there's an ongoing attachment for a pane.
   */
  const isAttaching = useCallback((paneId: string): boolean => {
    return lockRef.current?.paneId === paneId;
  }, []);

  return {
    attachToSession,
    isAttaching,
    fetchSession,
  };
}
