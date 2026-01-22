/**
 * Status Broadcaster - Real-time status updates via SSE
 *
 * This module provides:
 * - In-memory status store for fast access
 * - SSE client registry for broadcasting updates
 * - DB persistence for status changes
 * - Database sync for initial status population
 */

import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import type { SetupStatus, LifecycleStatus } from "@/lib/db/types";

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
type CloseCallback = () => void;

interface Subscriber {
  callback: SSECallback;
  closeCallback?: CloseCallback;
  id: string;
  addedAt: number;
  lastSuccessfulWrite: number;
}

// Maximum number of sessions to track in memory
const MAX_STATUS_STORE_SIZE = 10000;
// Maximum number of SSE subscribers
const MAX_SUBSCRIBERS = 1000;
// Subscriber is considered dead if no successful write in this time
const SUBSCRIBER_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

class StatusBroadcaster {
  private statusStore = new Map<string, StatusData>();
  private subscribers = new Map<string, Subscriber>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private syncInProgress = false;
  private syncPromise: Promise<{
    synced: number;
    alive: number;
    dead: number;
  }> | null = null;

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

    // For new sessions (not already in store), verify they exist in DB
    // This prevents ghost sessions from appearing after deletion
    if (!existing) {
      // Enforce max store size first - evict oldest entries if at limit
      if (this.statusStore.size >= MAX_STATUS_STORE_SIZE) {
        this.evictOldestStatuses(100); // Remove 100 oldest to make room
      }

      // Check DB existence right before insert to minimize TOCTOU window
      // This is still not fully atomic, but reduces the race window significantly
      if (!this.sessionExistsInDb(sessionId)) {
        // Session was deleted - don't add to store
        return;
      }
    }

    // Build the new status data
    const newData: StatusData = {
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
    };

    // Update in-memory store (fresh update clears stale flag)
    this.statusStore.set(sessionId, newData);

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
   * Returns a subscriber ID for cleanup
   * @param callback - Called on each status update
   * @param closeCallback - Optional callback to forcibly close the connection (for shutdown)
   */
  subscribe(callback: SSECallback, closeCallback?: CloseCallback): string {
    // Enforce max subscribers to prevent memory exhaustion
    if (this.subscribers.size >= MAX_SUBSCRIBERS) {
      // Remove oldest subscriber to make room
      const oldest = this.findOldestSubscriber();
      if (oldest) {
        this.subscribers.delete(oldest);
        console.warn(
          `[status-broadcaster] Removed oldest subscriber ${oldest} due to limit`
        );
      }
    }

    const id = `sub_${randomUUID()}`;
    const now = Date.now();
    this.subscribers.set(id, {
      callback,
      closeCallback,
      id,
      addedAt: now,
      lastSuccessfulWrite: now,
    });

    // Start heartbeat if this is the first subscriber
    // (cleanup is already running from constructor)
    if (this.subscribers.size === 1) {
      this.startHeartbeat();
    }

    return id;
  }

  /**
   * Unsubscribe from status updates by ID
   */
  unsubscribe(subscriberId: string): void {
    this.subscribers.delete(subscriberId);

    // Stop heartbeat if no more subscribers (cleanup keeps running to prevent memory growth)
    if (this.subscribers.size === 0) {
      this.stopHeartbeat();
    }
  }

  /**
   * Unsubscribe by callback reference (legacy support)
   */
  unsubscribeByCallback(callback: SSECallback): void {
    for (const [id, sub] of this.subscribers) {
      if (sub.callback === callback) {
        this.subscribers.delete(id);
        break;
      }
    }

    if (this.subscribers.size === 0) {
      this.stopHeartbeat();
    }
  }

  /**
   * Find the oldest subscriber ID
   */
  private findOldestSubscriber(): string | null {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [id, sub] of this.subscribers) {
      if (sub.addedAt < oldestTime) {
        oldestTime = sub.addedAt;
        oldest = id;
      }
    }
    return oldest;
  }

  /**
   * Get current subscriber count (for debugging)
   */
  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Broadcast update to all subscribers
   * Uses a snapshot to avoid concurrent modification issues
   */
  private broadcast(update: StatusUpdate): void {
    const deadSubscribers: string[] = [];
    const now = Date.now();

    // Snapshot subscriber IDs to avoid concurrent modification during iteration
    const subscriberIds = Array.from(this.subscribers.keys());

    for (const id of subscriberIds) {
      const sub = this.subscribers.get(id);
      if (!sub) continue; // Already removed

      try {
        sub.callback(update);
        sub.lastSuccessfulWrite = now;
      } catch (error) {
        // If callback throws, subscriber is likely dead
        console.error(`Error broadcasting to subscriber ${id}:`, error);
        deadSubscribers.push(id);
      }
    }

    // Remove dead subscribers
    for (const id of deadSubscribers) {
      this.subscribers.delete(id);
      console.log(`[status-broadcaster] Removed dead subscriber ${id}`);
    }
  }

  /**
   * Send heartbeat to keep connections alive and detect dead subscribers
   * Uses a snapshot to avoid concurrent modification issues
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      const deadSubscribers: string[] = [];
      const now = Date.now();

      // Snapshot subscriber IDs to avoid concurrent modification during iteration
      const subscriberIds = Array.from(this.subscribers.keys());

      // Send a heartbeat event and detect dead subscribers
      for (const id of subscriberIds) {
        const sub = this.subscribers.get(id);
        if (!sub) continue; // Already removed

        try {
          // We use a special "heartbeat" session ID that clients can filter
          sub.callback({ sessionId: "__heartbeat__", status: "idle" });
          sub.lastSuccessfulWrite = now;
        } catch {
          // Callback threw - subscriber is dead
          deadSubscribers.push(id);
          continue; // Skip stale check - already marked for removal
        }

        // Also check for stale subscribers (no successful write in a while)
        if (now - sub.lastSuccessfulWrite > SUBSCRIBER_TIMEOUT_MS) {
          deadSubscribers.push(id);
        }
      }

      // Remove dead subscribers
      for (const id of deadSubscribers) {
        this.subscribers.delete(id);
        console.log(`[status-broadcaster] Removed stale/dead subscriber ${id}`);
      }

      // Stop heartbeat if no more subscribers
      if (this.subscribers.size === 0) {
        this.stopHeartbeat();
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
   * Shutdown the broadcaster - close all SSE connections and stop all intervals.
   * Call this during graceful server shutdown.
   */
  shutdown(): void {
    // Close all SSE connections first so server.close() can complete
    const subscriberCount = this.subscribers.size;
    for (const [id, sub] of this.subscribers) {
      if (sub.closeCallback) {
        try {
          sub.closeCallback();
        } catch {
          // Ignore errors closing connections
        }
      }
    }
    this.subscribers.clear();

    this.stopHeartbeat();
    this.stopCleanup();
    console.log(
      `[status-broadcaster] Shutdown complete (closed ${subscriberCount} SSE connection(s))`
    );
  }

  /**
   * Clear status for a session (when session is deleted)
   */
  clearStatus(sessionId: string): void {
    this.statusStore.delete(sessionId);
  }

  /**
   * Check if a session exists in the database
   */
  private sessionExistsInDb(sessionId: string): boolean {
    try {
      const db = getDb();
      const result = db
        .prepare("SELECT 1 FROM sessions WHERE id = ?")
        .get(sessionId);
      return !!result;
    } catch (error) {
      // If DB fails, assume session exists to avoid dropping valid updates
      // Log warning so operators can detect DB issues
      console.warn(
        `[status-broadcaster] DB check failed for session ${sessionId}, assuming exists:`,
        error
      );
      return true;
    }
  }

  /**
   * Evict oldest statuses when store is full
   * Uses a two-phase approach to avoid expensive sorting when possible:
   * 1. First try to evict entries older than a threshold (fast O(n) scan)
   * 2. Fall back to sorting only if needed
   */
  private evictOldestStatuses(count: number): void {
    const now = Date.now();
    // First pass: try to evict entries older than 30 minutes (fast O(n) scan)
    const staleThreshold = 30 * 60 * 1000;
    const toEvict: string[] = [];

    for (const [id, data] of this.statusStore) {
      if (now - data.updatedAt > staleThreshold) {
        toEvict.push(id);
        if (toEvict.length >= count) break;
      }
    }

    // If we found enough stale entries, evict them
    if (toEvict.length >= count) {
      for (const id of toEvict.slice(0, count)) {
        this.statusStore.delete(id);
      }
      console.log(`[status-broadcaster] Evicted ${count} stale statuses`);
      return;
    }

    // Second pass: if not enough stale entries, fall back to sorting
    // This is more expensive but only happens rarely
    const entries = Array.from(this.statusStore.entries()).sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt
    );

    const evictCount = Math.min(count, entries.length);
    for (let i = 0; i < evictCount; i++) {
      this.statusStore.delete(entries[i][0]);
    }

    console.log(
      `[status-broadcaster] Evicted ${evictCount} oldest statuses (sorted)`
    );
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
   * Sync status from database at startup or after hot reload.
   * This populates the in-memory status store from the database's lifecycle_status.
   *
   * Note: This does NOT check tmux directly because sessions run inside Docker
   * containers with separate tmux sockets. The session-manager's recoverSessions()
   * handles the actual liveness checks at server startup.
   *
   * Protected against concurrent calls - concurrent callers will receive
   * the result of the in-progress sync.
   */
  syncFromDatabase(): { synced: number; alive: number; dead: number } {
    // If sync is already in progress, wait for it (but return synchronously for backwards compat)
    if (this.syncInProgress && this.syncPromise) {
      // Return a "pending" result - caller should retry or use syncFromDatabaseAsync
      return { synced: 0, alive: 0, dead: 0 };
    }

    this.syncInProgress = true;
    try {
      return this.performSync();
    } finally {
      this.syncInProgress = false;
      this.syncPromise = null;
    }
  }

  /**
   * Async version of syncFromDatabase that waits for in-progress syncs
   */
  async syncFromDatabaseAsync(): Promise<{
    synced: number;
    alive: number;
    dead: number;
  }> {
    // If sync is already in progress, wait for it
    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncInProgress = true;
    this.syncPromise = Promise.resolve(this.performSync());

    try {
      return await this.syncPromise;
    } finally {
      this.syncInProgress = false;
      this.syncPromise = null;
    }
  }

  /**
   * Internal sync implementation
   */
  private performSync(): { synced: number; alive: number; dead: number } {
    let synced = 0;
    let alive = 0;
    let dead = 0;

    try {
      // Get all sessions from database - use lifecycle_status as source of truth
      // (set correctly by session-manager's recoverSessions)
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

        // Derive status from lifecycle_status (set by session-manager recovery)
        const isAlive = session.lifecycle_status === "ready";
        const status: SessionStatus = isAlive ? "idle" : "dead";

        this.statusStore.set(session.id, {
          status,
          updatedAt: now,
          setupStatus: session.setup_status ?? undefined,
          setupError: session.setup_error ?? undefined,
          lifecycleStatus: session.lifecycle_status ?? undefined,
          stale: false,
        });

        synced++;
        if (isAlive) alive++;
        else dead++;
      }
    } catch {
      // DB not available, nothing to sync
    }

    return { synced, alive, dead };
  }
}

// Singleton instance
export const statusBroadcaster = new StatusBroadcaster();
