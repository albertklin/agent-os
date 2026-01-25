import { proxy } from "valtio";

/**
 * Global store for tracking sessions that have been detected as failed.
 * This provides immediate UI feedback before SSE/DB updates arrive.
 *
 * Used by:
 * - Pane: marks sessions as failed when WebSocket detects tmux crash
 * - GroupSection/SessionCard: checks this store to show reboot option immediately
 */
export const failedSessionsStore = proxy<{
  sessionIds: Set<string>;
}>({
  sessionIds: new Set(),
});

export const failedSessionsActions = {
  markFailed: (sessionId: string) => {
    // Valtio requires creating a new Set for reactivity
    const newSet = new Set(failedSessionsStore.sessionIds);
    newSet.add(sessionId);
    failedSessionsStore.sessionIds = newSet;
  },
  clearFailed: (sessionId: string) => {
    const newSet = new Set(failedSessionsStore.sessionIds);
    newSet.delete(sessionId);
    failedSessionsStore.sessionIds = newSet;
  },
  isFailed: (sessionId: string): boolean => {
    return failedSessionsStore.sessionIds.has(sessionId);
  },
};
