import type Database from "better-sqlite3";

// Prepared statement cache
const stmtCache = new Map<string, Database.Statement>();

function getStmt(db: Database.Database, sql: string): Database.Statement {
  const key = sql;
  let stmt = stmtCache.get(key);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(key, stmt);
  }
  return stmt;
}

export const queries = {
  // Sessions
  createSession: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO sessions (id, name, tmux_name, working_directory, parent_session_id, model, system_prompt, group_path, agent_type, auto_approve, project_id, extra_mounts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),

  getSession: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM sessions WHERE id = ?`),

  getAllSessions: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM sessions ORDER BY sort_order ASC, created_at ASC`
    ),

  updateSessionStatus: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionClaudeId: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET claude_session_id = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionName: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET name = ?, tmux_name = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  deleteSession: (db: Database.Database) =>
    getStmt(db, `DELETE FROM sessions WHERE id = ?`),

  updateSessionWorktree: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET worktree_path = ?, branch_name = ?, base_branch = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionPR: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET pr_url = ?, pr_number = ?, pr_status = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionGroup: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET group_path = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  getSessionsByGroup: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM sessions WHERE group_path = ? ORDER BY sort_order ASC, created_at ASC`
    ),

  moveSessionsToGroup: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET group_path = ?, updated_at = datetime('now') WHERE group_path = ?`
    ),

  updateSessionProject: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET project_id = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // Batch move all sessions from one project to another (for project deletion)
  moveAllSessionsToProject: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET project_id = ?, updated_at = datetime('now') WHERE project_id = ?`
    ),

  updateSessionSortOrder: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET sort_order = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionProjectAndOrder: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET project_id = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  getMaxSortOrderForProject: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT COALESCE(MAX(sort_order), -1) as max_order FROM sessions WHERE project_id = ?`
    ),

  getSessionsByProject: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM sessions WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC`
    ),

  // Get active sessions only (excludes 'failed' and 'deleting' lifecycle statuses)
  // Use this for operations like name generation where we want to ignore dead sessions
  getActiveSessions: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM sessions
       WHERE lifecycle_status NOT IN ('failed', 'deleting')
       ORDER BY sort_order ASC, created_at ASC`
    ),

  // Get ready sessions only (lifecycle_status = 'ready')
  // Use this for operations that require the session to be fully operational
  getReadySessions: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM sessions
       WHERE lifecycle_status = 'ready'
       ORDER BY sort_order ASC, created_at ASC`
    ),

  // Get active sessions by project (excludes 'failed' and 'deleting')
  getActiveSessionsByProject: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM sessions
       WHERE project_id = ? AND lifecycle_status NOT IN ('failed', 'deleting')
       ORDER BY sort_order ASC, created_at ASC`
    ),

  // Get sessions sharing the same worktree (excluding the given session)
  getSiblingSessionsByWorktree: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM sessions WHERE worktree_path = ? AND id != ? ORDER BY updated_at DESC`
    ),

  // Get ACTIVE sessions sharing the same worktree (excludes failed/deleting sessions)
  // Use this for operations like worktree cleanup that should only consider live sessions
  getActiveSiblingSessionsByWorktree: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM sessions
       WHERE worktree_path = ? AND id != ?
       AND lifecycle_status NOT IN ('failed', 'deleting')
       ORDER BY updated_at DESC`
    ),

  updateSessionSetupStatus: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET setup_status = ?, setup_error = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionContainer: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET container_id = ?, container_status = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionContainerWithHealth: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET
        container_id = ?,
        container_status = ?,
        container_health_last_check = datetime('now'),
        container_health_status = ?,
        updated_at = datetime('now')
      WHERE id = ?`
    ),

  updateSessionLifecycleStatus: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET lifecycle_status = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // Get sessions with unhealthy or unchecked containers
  // Excludes failed/deleting sessions to avoid checking containers being cleaned up
  getSessionsWithUnhealthyContainers: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM sessions
       WHERE container_id IS NOT NULL
       AND container_status = 'ready'
       AND lifecycle_status NOT IN ('failed', 'deleting')
       AND (container_health_status IS NULL
            OR container_health_status != 'healthy'
            OR container_health_last_check IS NULL
            OR datetime(container_health_last_check) < datetime('now', '-5 minutes'))`
    ),

  // Get all sessions with active containers
  // Excludes failed/deleting sessions to avoid operating on containers being cleaned up
  getSessionsWithContainers: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM sessions
       WHERE container_id IS NOT NULL
       AND container_status = 'ready'
       AND lifecycle_status NOT IN ('failed', 'deleting')`
    ),

  validateAutoApproveContainerConstraints: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM sessions
       WHERE auto_approve = 1
       AND agent_type = 'claude'
       AND container_status = 'ready'
       AND container_id IS NULL`
    ),

  getSessionsByLifecycleStatus: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM sessions WHERE lifecycle_status = ?`),

  // Messages
  createMessage: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO messages (session_id, role, content, duration_ms)
       VALUES (?, ?, ?, ?)`
    ),

  // Batch copy messages from one session to another (for fork)
  copySessionMessages: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO messages (session_id, role, content, duration_ms)
       SELECT ?, role, content, duration_ms
       FROM messages
       WHERE session_id = ?
       ORDER BY timestamp ASC`
    ),

  getSessionMessages: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC`
    ),

  getLastMessage: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`
    ),

  updateMessageDuration: (db: Database.Database) =>
    getStmt(db, `UPDATE messages SET duration_ms = ? WHERE id = ?`),

  // Tool calls
  createToolCall: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO tool_calls (message_id, session_id, tool_name, tool_input, status)
       VALUES (?, ?, ?, ?, 'pending')`
    ),

  updateToolCallResult: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE tool_calls SET tool_result = ?, status = ? WHERE id = ?`
    ),

  updateToolCallStatus: (db: Database.Database) =>
    getStmt(db, `UPDATE tool_calls SET status = ? WHERE id = ?`),

  getSessionToolCalls: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM tool_calls WHERE session_id = ? ORDER BY timestamp ASC`
    ),

  getMessageToolCalls: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM tool_calls WHERE message_id = ? ORDER BY timestamp ASC`
    ),

  // Groups
  getAllGroups: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM groups ORDER BY sort_order ASC, name ASC`),

  getGroup: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM groups WHERE path = ?`),

  createGroup: (db: Database.Database) =>
    getStmt(db, `INSERT INTO groups (path, name, sort_order) VALUES (?, ?, ?)`),

  updateGroupName: (db: Database.Database) =>
    getStmt(db, `UPDATE groups SET name = ? WHERE path = ?`),

  updateGroupExpanded: (db: Database.Database) =>
    getStmt(db, `UPDATE groups SET expanded = ? WHERE path = ?`),

  updateGroupOrder: (db: Database.Database) =>
    getStmt(db, `UPDATE groups SET sort_order = ? WHERE path = ?`),

  deleteGroup: (db: Database.Database) =>
    getStmt(db, `DELETE FROM groups WHERE path = ?`),

  // Projects
  createProject: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO projects (id, name, working_directory, sort_order)
       VALUES (?, ?, ?, ?)`
    ),

  getProject: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM projects WHERE id = ?`),

  getAllProjects: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM projects ORDER BY is_uncategorized ASC, sort_order ASC, name ASC`
    ),

  updateProject: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE projects SET name = ?, working_directory = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateProjectExpanded: (db: Database.Database) =>
    getStmt(db, `UPDATE projects SET expanded = ? WHERE id = ?`),

  updateProjectOrder: (db: Database.Database) =>
    getStmt(db, `UPDATE projects SET sort_order = ? WHERE id = ?`),

  deleteProject: (db: Database.Database) =>
    getStmt(db, `DELETE FROM projects WHERE id = ? AND is_uncategorized = 0`),
};
