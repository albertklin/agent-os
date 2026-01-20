import type { Session, Project } from "@/lib/db";
import type { NotificationSettings } from "@/lib/notifications";
import type { TabData } from "@/lib/panes";
import type { ConnectionStatus } from "@/hooks/useStatusStream";
import type { SessionStatus } from "@/components/SessionList/SessionList.types";
// Re-export SessionStatus from canonical location
export type { SessionStatus };

export interface ViewProps {
  sessions: Session[];
  projects: Project[];
  sessionStatuses: Record<string, SessionStatus>;
  connectionStatus?: ConnectionStatus;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  activeSession: Session | undefined;
  focusedActiveTab: TabData | null;
  copiedSessionId: boolean;
  setCopiedSessionId: (copied: boolean) => void;

  // Dialogs
  showNewSessionDialog: boolean;
  setShowNewSessionDialog: (show: boolean) => void;
  newSessionProjectId: string | null;
  showNotificationSettings: boolean;
  setShowNotificationSettings: (show: boolean) => void;
  showQuickSwitcher: boolean;
  setShowQuickSwitcher: (show: boolean) => void;

  // Notification settings
  notificationSettings: NotificationSettings;
  permissionGranted: boolean;
  updateSettings: (settings: Partial<NotificationSettings>) => void;
  requestPermission: () => Promise<boolean>;

  // Handlers
  attachToSession: (session: Session) => void;
  openSessionInNewTab: (session: Session) => void;
  handleNewSessionInProject: (projectId: string) => void;
  handleOpenTerminal: (projectId: string) => void;
  handleSessionCreated: (sessionId: string) => Promise<void>;
  handleCreateProject: (
    name: string,
    workingDirectory: string,
    agentType?: string
  ) => Promise<string | null>;

  // Pane
  renderPane: (paneId: string) => React.ReactNode;
}
