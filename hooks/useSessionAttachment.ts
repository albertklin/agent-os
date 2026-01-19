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
   */
  const buildAgentCommand = useCallback(
    (session: Session, sessions: Session[]): string => {
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
        autoApprove: session.auto_approve,
        model: session.model,
        initialPrompt: initialPrompt || undefined,
      });

      const flagsStr = flags.join(" ");
      return flagsStr ? `${provider.command} ${flagsStr}` : provider.command;
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
        const session = await fetchSession(sessionId);
        if (!session) {
          console.error("[useSessionAttachment] Session not found:", sessionId);
          return false;
        }

        // 1.5. Check if session setup is complete
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

        // 2. Compute tmux session name (deterministic from agent_type + id)
        const tmuxName = getTmuxSessionName(session);
        const cwd = getSessionCwd(session);

        // 3. Detach from current tmux if needed
        const activeTab = getActiveTab(paneId);
        if (activeTab?.sessionId && activeTab.sessionId !== sessionId) {
          terminal.sendInput("\x02d"); // Ctrl+B d (tmux detach)
          await sleep(100);
        }

        // 4. Clear any running command
        terminal.sendInput("\x03"); // Ctrl+C
        await sleep(50);

        // 5. Build tmux command
        const agentCommand = buildAgentCommand(session, sessions);
        const tmuxNew = agentCommand
          ? `tmux new -s ${tmuxName} -c "${cwd}" "${agentCommand}"`
          : `tmux new -s ${tmuxName} -c "${cwd}"`;

        const tmuxCmd = `tmux attach -t ${tmuxName} 2>/dev/null || ${tmuxNew}`;

        // 6. Send the tmux command
        terminal.sendCommand(tmuxCmd);

        // 7. Wait a moment for tmux to attach
        // (In the future, could poll terminal output to confirm)
        await sleep(150);

        // 8. Update UI state
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
