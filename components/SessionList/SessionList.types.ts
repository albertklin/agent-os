import type {
  ConnectionStatus,
  SetupStatusType,
  LifecycleStatusType,
} from "@/hooks/useStatusStream";

export interface SessionStatus {
  sessionName: string;
  status: "idle" | "running" | "waiting" | "error" | "dead" | "unknown";
  lastLine?: string;
  claudeSessionId?: string | null;
  /** Current tool name (e.g., "Bash", "Edit") */
  toolName?: string;
  /** Current tool detail (e.g., the command or file path) */
  toolDetail?: string;
  setupStatus?: SetupStatusType;
  setupError?: string;
  lifecycleStatus?: LifecycleStatusType;
}

export interface SessionListProps {
  activeSessionId?: string;
  sessionStatuses?: Record<string, SessionStatus>;
  connectionStatus?: ConnectionStatus;
  onSelect: (sessionId: string) => void;
  onOpenInTab?: (sessionId: string) => void;
  onNewSessionInProject?: (projectId: string) => void;
  onOpenTerminal?: (projectId: string) => void;
}
