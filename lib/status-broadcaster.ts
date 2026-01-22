/**
 * Status Broadcaster - Real-time status updates via SSE
 *
 * This module provides:
 * - In-memory status store for fast access
 * - SSE client registry for broadcasting updates
 * - DB persistence for status changes
 * - Tmux sync for initial status population
 */

import { execSync } from "child_process";
import { getDb } from "@/lib/db";
import type { SetupStatus, LifecycleStatus } from "@/lib/db/types";
import { TMUX_SOCKET } from "@/lib/tmux";

export type SessionStatus = "running" | "waiting" | "idle" | "dead" | "unknown";

export interface StatusData {
  status: SessionStatus;
  lastLine?: string;
  updatedAt: number;
  hookEvent?: string;
  toolName?: string;
  /** For Bash: the command, for file tools: the file path */
  toolDetail?: string;
  setupStatus?: SetupStatus;
  setupError?: string;
  lifecycleStatus?: LifecycleStatus;
  /** True if no status update received within the stale threshold */
  stale?: boolean;
}

export interface StatusUpdate {
  sessionId: string;
  status: SessionStatus;
  lastLine?: string;
  hookEvent?: string;
  toolName?: string;
  /** For Bash: the command, for file tools: the file path */
  toolDetail?: string;
  setupStatus?: SetupStatus;
  setupError?: string;
  lifecycleStatus?: LifecycleStatus;
  /** True if no status update received within the stale threshold */
  stale?: boolean;
}

type SSECallback = (data: StatusUpdate) => void;

class StatusBroadcaster {
  private statusStore = new Map<string, StatusData>();
  private subscribers = new Set<SSECallback>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private syncInProgress = false;

  constructor() {
    // Start cleanup interval unconditionally to prevent memory growth
    // even when no subscribers are connected
    this.startCleanup();
  }

  /**
   * Update status for a session and broadcast to all subscribers
   */
  updateStatus(update: StatusUpdate): void {
    const {
      sessionId,
      status,
      lastLine,
      hookEvent,
      toolName,
      toolDetail,
      setupStatus,
      setupError,
      lifecycleStatus,
    } = update;

    // Get existing data to preserve fields not in this update
    const existing = this.statusStore.get(sessionId);

    // Update in-memory store (fresh update clears stale flag)
    this.statusStore.set(sessionId, {
      status,
      lastLine,
      updatedAt: Date.now(),
      hookEvent,
      toolName,
      toolDetail,
      setupStatus: setupStatus ?? existing?.setupStatus,
      setupError: setupError ?? existing?.setupError,
      lifecycleStatus: lifecycleStatus ?? existing?.lifecycleStatus,
      stale: false,
    });

    // Update DB timestamp for running/waiting states
    if (status === "running" || status === "waiting") {
      try {
        const db = getDb();
        const stmt = db.prepare(
          "UPDATE sessions SET updated_at = datetime('now') WHERE id = ?"
        );
        stmt.run(sessionId);
      } catch (error) {
        console.error("Failed to update session timestamp:", error);
      }
    }

    // Broadcast to all SSE clients
    this.broadcast(update);
  }

  /**
   * Get current status for a session
   */
  getStatus(sessionId: string): StatusData | undefined {
    return this.statusStore.get(sessionId);
  }

  /**
   * Get all current statuses
   */
  getAllStatuses(): Record<string, StatusData> {
    const result: Record<string, StatusData> = {};
    for (const [id, data] of this.statusStore) {
      result[id] = data;
    }
    return result;
  }

  /**
   * Subscribe to status updates (for SSE connections)
   */
  subscribe(callback: SSECallback): void {
    this.subscribers.add(callback);

    // Start heartbeat if this is the first subscriber
    // (cleanup is already running from constructor)
    if (this.subscribers.size === 1) {
      this.startHeartbeat();
    }
  }

  /**
   * Unsubscribe from status updates
   */
  unsubscribe(callback: SSECallback): void {
    this.subscribers.delete(callback);

    // Stop heartbeat if no more subscribers (cleanup keeps running to prevent memory growth)
    if (this.subscribers.size === 0) {
      this.stopHeartbeat();
    }
  }

  /**
   * Get current subscriber count (for debugging)
   */
  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Broadcast update to all subscribers
   */
  private broadcast(update: StatusUpdate): void {
    for (const callback of this.subscribers) {
      try {
        callback(update);
      } catch (error) {
        console.error("Error broadcasting to subscriber:", error);
      }
    }
  }

  /**
   * Send heartbeat to keep connections alive
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      // Send a heartbeat event (empty update with special type)
      for (const callback of this.subscribers) {
        try {
          // We use a special "heartbeat" session ID that clients can filter
          callback({ sessionId: "__heartbeat__", status: "idle" });
        } catch {
          // Ignore heartbeat errors
        }
      }
    }, 30000); // 30 second heartbeat
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Start periodic cleanup of stale statuses
   */
  private startCleanup(): void {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(
      () => {
        this.cleanupStale();
      },
      5 * 60 * 1000
    ); // 5 minutes
  }

  private stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Shutdown the broadcaster - stop all intervals.
   * Call this during graceful server shutdown.
   */
  shutdown(): void {
    this.stopHeartbeat();
    this.stopCleanup();
    console.log("[status-broadcaster] Shutdown complete");
  }

  /**
   * Clear status for a session (when session is deleted)
   */
  clearStatus(sessionId: string): void {
    this.statusStore.delete(sessionId);
  }

  /**
   * Clean up stale and orphaned statuses:
   * - Sessions not updated in 10 minutes are marked as stale
   * - Sessions deleted from DB are removed from the store
   */
  cleanupStale(): void {
    const now = Date.now();
    const staleThreshold = 10 * 60 * 1000; // 10 minutes

    // Get list of valid session IDs from DB
    let validSessionIds: Set<string>;
    try {
      const db = getDb();
      const sessions = db.prepare("SELECT id FROM sessions").all() as Array<{
        id: string;
      }>;
      validSessionIds = new Set(sessions.map((s) => s.id));
    } catch {
      // If DB fails, don't remove anything
      return;
    }

    for (const [id, data] of this.statusStore) {
      // Remove entries for deleted sessions
      if (!validSessionIds.has(id)) {
        this.statusStore.delete(id);
        continue;
      }

      // Mark sessions as stale (but preserve their status)
      if (now - data.updatedAt > staleThreshold && data.status !== "dead") {
        if (!data.stale) {
          this.statusStore.set(id, {
            ...data,
            stale: true,
          });
        }
      }
    }
  }

  /**
   * Sync status from tmux sessions at startup.
   * This populates initial status for all sessions based on whether their
   * tmux session exists.
   *
   * Protected against concurrent calls - only one sync runs at a time.
   */
  syncFromTmux(): { synced: number; alive: number; dead: number } {
    // Prevent concurrent syncs
    if (this.syncInProgress) {
      return { synced: 0, alive: 0, dead: 0 };
    }
    this.syncInProgress = true;

    let synced = 0;
    let alive = 0;
    let dead = 0;

    try {
      // Get list of active tmux sessions
      const tmuxOutput = execSync(
        `tmux -L ${TMUX_SOCKET} list-sessions -F '#{session_name}'`,
        {
          encoding: "utf-8",
          timeout: 5000,
        }
      );
      const activeTmuxSessions = new Set(
        tmuxOutput.trim().split("\n").filter(Boolean)
      );

      // Get all sessions from database
      const db = getDb();
      const sessions = db
        .prepare(
          "SELECT id, tmux_name, setup_status, setup_error, lifecycle_status FROM sessions"
        )
        .all() as Array<{
        id: string;
        tmux_name: string;
        setup_status: SetupStatus | null;
        setup_error: string | null;
        lifecycle_status: LifecycleStatus | null;
      }>;

      const now = Date.now();

      for (const session of sessions) {
        // Skip if we already have a recent status for this session
        const existing = this.statusStore.get(session.id);
        if (existing && now - existing.updatedAt < 60000) {
          // Status updated in last minute, skip
          continue;
        }

        const tmuxExists = activeTmuxSessions.has(session.tmux_name);
        const status: SessionStatus = tmuxExists ? "idle" : "dead";

        this.statusStore.set(session.id, {
          status,
          updatedAt: now,
          setupStatus: session.setup_status ?? undefined,
          setupError: session.setup_error ?? undefined,
          lifecycleStatus: session.lifecycle_status ?? undefined,
          stale: false,
        });

        synced++;
        if (tmuxExists) alive++;
        else dead++;
      }
    } catch (error) {
      // tmux not running or no sessions - mark all as dead
      console.warn("Failed to sync from tmux:", error);
      try {
        const db = getDb();
        const sessions = db
          .prepare(
            "SELECT id, setup_status, setup_error, lifecycle_status FROM sessions"
          )
          .all() as Array<{
          id: string;
          setup_status: SetupStatus | null;
          setup_error: string | null;
          lifecycle_status: LifecycleStatus | null;
        }>;

        const now = Date.now();
        for (const session of sessions) {
          const existing = this.statusStore.get(session.id);
          if (existing && now - existing.updatedAt < 60000) continue;

          this.statusStore.set(session.id, {
            status: "dead",
            updatedAt: now,
            setupStatus: session.setup_status ?? undefined,
            setupError: session.setup_error ?? undefined,
            lifecycleStatus: session.lifecycle_status ?? undefined,
            stale: false,
          });
          synced++;
          dead++;
        }
      } catch {
        // DB not available, nothing to sync
      }
    } finally {
      this.syncInProgress = false;
    }

    return { synced, alive, dead };
  }
}

// Singleton instance
export const statusBroadcaster = new StatusBroadcaster();
