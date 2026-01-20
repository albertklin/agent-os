import type {
  ConnectionStatus,
  SetupStatusType,
} from "@/hooks/useStatusStream";

export interface SessionStatus {
  sessionName: string;
  status: "idle" | "running" | "waiting" | "error" | "dead" | "unknown";
  lastLine?: string;
  /** Current tool name (e.g., "Bash", "Edit") */
  toolName?: string;
  /** Current tool detail (e.g., the command or file path) */
  toolDetail?: string;
  setupStatus?: SetupStatusType;
  setupError?: string;
}

export interface SessionListProps {
  activeSessionId?: string;
  sessionStatuses?: Record<string, SessionStatus>;
  connectionStatus?: ConnectionStatus;
  onSelect: (sessionId: string) => void;
  onOpenInTab?: (sessionId: string) => void;
  onNewSessionInProject?: (projectId: string) => void;
  onOpenTerminal?: (projectId: string) => void;
  onStartDevServer?: (projectId: string) => void;
  onCreateDevServer?: (opts: {
    projectId: string;
    type: "node" | "docker";
    name: string;
    command: string;
    workingDirectory: string;
    ports?: number[];
  }) => Promise<void>;
}
