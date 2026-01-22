import type { AgentType } from "../providers";

/**
 * Configuration for mounting additional directories into Docker containers.
 * Mounts are fixed at container creation time and cannot be changed afterwards.
 */
export interface MountConfig {
  hostPath: string; // Absolute path on host
  containerPath: string; // Path inside container
  mode: "ro" | "rw"; // Read-only or read-write
}

export type SetupStatus =
  | "pending"
  | "creating_worktree"
  | "init_container"
  | "init_submodules"
  | "installing_deps"
  | "starting_session"
  | "ready"
  | "failed";

/**
 * Lifecycle status for a session.
 * - creating: Session resources are being set up (worktree, container, tmux)
 * - ready: Session is ready (tmux running, container if needed)
 * - failed: Session setup failed
 * - deleting: Session is being deleted
 */
export type LifecycleStatus = "creating" | "ready" | "failed" | "deleting";

/**
 * Container status for sandboxed sessions.
 * - creating: Container is being created
 * - ready: Container is running and healthy
 * - failed: Container creation or health check failed
 */
export type ContainerStatus = "creating" | "ready" | "failed";

export interface Session {
  id: string;
  name: string;
  tmux_name: string;
  created_at: string;
  updated_at: string;
  status: "idle" | "running" | "waiting" | "error";
  working_directory: string;
  parent_session_id: string | null;
  claude_session_id: string | null;
  model: string;
  system_prompt: string | null;
  group_path: string; // Deprecated - use project_id
  project_id: string | null;
  agent_type: AgentType;
  auto_approve: boolean;
  sort_order: number;
  // Worktree fields (optional)
  worktree_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  // PR tracking
  pr_url: string | null;
  pr_number: number | null;
  pr_status: "open" | "merged" | "closed" | null;
  // Setup tracking for worktree sessions (legacy - kept for backward compat)
  setup_status: SetupStatus;
  setup_error: string | null;
  // New lifecycle status (server-owned)
  lifecycle_status: LifecycleStatus;
  // Container fields (sandboxed sessions)
  container_id: string | null;
  container_status: ContainerStatus | null;
  // Container health tracking
  container_health_last_check: string | null;
  container_health_status: "healthy" | "unhealthy" | null;
  // Extra mounts for sandboxed sessions (JSON-encoded MountConfig[])
  extra_mounts: string | null;
  // Extra allowed network domains for sandboxed sessions (JSON-encoded string[])
  allowed_domains: string | null;
}

export interface Group {
  path: string;
  name: string;
  expanded: boolean;
  sort_order: number;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  working_directory: string;
  expanded: boolean;
  sort_order: number;
  is_uncategorized: boolean;
  created_at: string;
  updated_at: string;
  // Default session settings (JSON-encoded, used to pre-populate session creation form)
  default_extra_mounts: string | null;
  default_allowed_domains: string | null;
}

export interface Message {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string; // JSON array
  timestamp: string;
  duration_ms: number | null;
}

export interface ToolCall {
  id: number;
  message_id: number;
  session_id: string;
  tool_name: string;
  tool_input: string; // JSON
  tool_result: string | null; // JSON
  status: "pending" | "running" | "completed" | "error";
  timestamp: string;
}
