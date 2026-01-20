/**
 * Database Constraint Validation
 *
 * Validates security-critical database constraints on startup:
 * - Auto-approve sessions with ready container_status MUST have a container_id
 * - Detects any inconsistent states that could lead to security issues
 */

import type Database from "better-sqlite3";
import type { Session } from "./types";

export interface ValidationResult {
  valid: boolean;
  violations: string[];
}

/**
 * Validate database constraints that ensure security invariants.
 *
 * Checks:
 * 1. Auto-approve sessions with container_status='ready' must have container_id
 * 2. Sessions with container_id should have container_status='ready' or 'failed'
 */
export function validateDatabaseConstraints(
  db: Database.Database
): ValidationResult {
  const violations: string[] = [];

  // Check 1: Auto-approve sessions with ready sandbox must have container
  const orphanedReady = db
    .prepare(
      `SELECT id, name FROM sessions
       WHERE auto_approve = 1
       AND agent_type = 'claude'
       AND container_status = 'ready'
       AND container_id IS NULL`
    )
    .all() as { id: string; name: string }[];

  for (const session of orphanedReady) {
    violations.push(
      `Session "${session.name}" (${session.id}): container_status='ready' but no container_id`
    );
  }

  // Check 2: Sessions with container_id should have valid container_status
  const invalidStatus = db
    .prepare(
      `SELECT id, name, container_status FROM sessions
       WHERE container_id IS NOT NULL
       AND (container_status IS NULL OR container_status NOT IN ('ready', 'failed'))`
    )
    .all() as { id: string; name: string; container_status: string | null }[];

  for (const session of invalidStatus) {
    violations.push(
      `Session "${session.name}" (${session.id}): has container_id but invalid container_status='${session.container_status}'`
    );
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Fix orphaned auto-approve sessions by marking them as failed.
 *
 * This should be run on startup to clean up any inconsistent states
 * from previous crashes or incomplete operations.
 */
export function fixOrphanedAutoApproveSessions(db: Database.Database): number {
  const result = db
    .prepare(
      `UPDATE sessions
       SET container_status = 'failed',
           updated_at = datetime('now')
       WHERE auto_approve = 1
       AND agent_type = 'claude'
       AND (container_id IS NULL OR container_status IS NULL)
       AND container_status != 'failed'`
    )
    .run();

  return result.changes;
}

/**
 * Mark sessions with missing containers as failed.
 *
 * Called after checking that containers no longer exist.
 */
export function markSessionsWithMissingContainersAsFailed(
  db: Database.Database,
  sessionIds: string[]
): number {
  if (sessionIds.length === 0) return 0;

  const placeholders = sessionIds.map(() => "?").join(",");
  const result = db
    .prepare(
      `UPDATE sessions
       SET container_status = 'failed',
           container_health_status = 'unhealthy',
           container_health_last_check = datetime('now'),
           updated_at = datetime('now')
       WHERE id IN (${placeholders})`
    )
    .run(...sessionIds);

  return result.changes;
}
