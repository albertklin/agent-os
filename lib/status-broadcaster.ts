/**
 * Status Broadcaster - Real-time status updates via SSE
 *
 * This module provides:
 * - In-memory status store for fast access
 * - SSE client registry for broadcasting updates
 * - DB persistence for status changes
 */

import { getDb } from "@/lib/db";
import type { SetupStatus } from "@/lib/db/types";

export type SessionStatus = "running" | "waiting" | "idle" | "dead" | "unknown";

export interface StatusData {
  status: SessionStatus;
  lastLine?: string;
  updatedAt: number;
  hookEvent?: string;
  toolName?: string;
  setupStatus?: SetupStatus;
  setupError?: string;
}

export interface StatusUpdate {
  sessionId: string;
  status: SessionStatus;
  lastLine?: string;
  hookEvent?: string;
  toolName?: string;
  setupStatus?: SetupStatus;
  setupError?: string;
}

type SSECallback = (data: StatusUpdate) => void;

class StatusBroadcaster {
  private statusStore = new Map<string, StatusData>();
  private subscribers = new Set<SSECallback>();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start heartbeat when first subscriber joins (lazy initialization)
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
      setupStatus,
      setupError,
    } = update;

    // Get existing data to preserve fields not in this update
    const existing = this.statusStore.get(sessionId);

    // Update in-memory store
    this.statusStore.set(sessionId, {
      status,
      lastLine,
      updatedAt: Date.now(),
      hookEvent,
      toolName,
      setupStatus: setupStatus ?? existing?.setupStatus,
      setupError: setupError ?? existing?.setupError,
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
    if (this.subscribers.size === 1) {
      this.startHeartbeat();
    }
  }

  /**
   * Unsubscribe from status updates
   */
  unsubscribe(callback: SSECallback): void {
    this.subscribers.delete(callback);

    // Stop heartbeat if no more subscribers
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
   * Clear status for a session (when session is deleted)
   */
  clearStatus(sessionId: string): void {
    this.statusStore.delete(sessionId);
  }

  /**
   * Clean up stale statuses (sessions not updated in 5 minutes become unknown)
   */
  cleanupStale(): void {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes

    for (const [id, data] of this.statusStore) {
      if (now - data.updatedAt > staleThreshold && data.status !== "dead") {
        // Mark as unknown instead of deleting - let client handle display
        this.statusStore.set(id, {
          ...data,
          status: "unknown",
          updatedAt: now,
        });
      }
    }
  }
}

// Singleton instance
export const statusBroadcaster = new StatusBroadcaster();
