"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { PaneProvider, usePanes } from "@/contexts/PaneContext";
import { Pane } from "@/components/Pane";
import { useNotifications } from "@/hooks/useNotifications";
import { useViewport } from "@/hooks/useViewport";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useSessions } from "@/hooks/useSessions";
import { useProjects } from "@/hooks/useProjects";
import { useKeyboardNavigation } from "@/hooks/useKeyboardNavigation";
import { useSessionStatuses } from "@/hooks/useSessionStatuses";
import { useSessionAttachment } from "@/hooks/useSessionAttachment";
import type { Session } from "@/lib/db";
import { getOldestWaitingSession } from "@/lib/sessions";
import { DesktopView } from "@/components/views/DesktopView";
import { MobileView } from "@/components/views/MobileView";

function HomeContent() {
  // UI State
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showNewSessionDialog, setShowNewSessionDialog] = useState(false);
  const [newSessionProjectId, setNewSessionProjectId] = useState<string | null>(
    null
  );
  const [showNotificationSettings, setShowNotificationSettings] =
    useState(false);
  const [showQuickSwitcher, setShowQuickSwitcher] = useState(false);
  const [copiedSessionId, setCopiedSessionId] = useState(false);

  // Pane context
  const { focusedPaneId, getActiveTab, addTab, openQuickRespondTab } =
    usePanes();
  const focusedActiveTab = getActiveTab(focusedPaneId);
  const { isMobile, isHydrated } = useViewport();

  // Ref to track current focusedPaneId for callbacks (avoids stale closures)
  const focusedPaneIdRef = useRef(focusedPaneId);
  useEffect(() => {
    focusedPaneIdRef.current = focusedPaneId;
  }, [focusedPaneId]);

  // Session selection (server handles tmux attachment automatically)
  const { selectSession } = useSessionAttachment();

  // Data hooks
  const { sessions, fetchSessions } = useSessions();
  const { projects, fetchProjects } = useProjects();

  // Set CSS variable for viewport height (handles mobile keyboard)
  useViewportHeight();

  // Select session in focused pane - server handles tmux attachment automatically
  const attachToSession = useCallback(
    async (session: Session) => {
      await selectSession(session.id, focusedPaneIdRef.current);
    },
    [selectSession]
  );

  // Open session in new tab
  const openSessionInNewTab = useCallback(
    (session: Session) => {
      // Create tab with sessionId - Terminal will connect and server will attach to tmux
      addTab(focusedPaneIdRef.current, session.id);
    },
    [addTab]
  );

  // Notification click handler
  const handleNotificationClick = useCallback(
    (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId);
      if (session) {
        attachToSession(session);
      }
    },
    [sessions, attachToSession]
  );

  // Notifications
  const {
    settings: notificationSettings,
    checkStateChanges,
    updateSettings,
    requestPermission,
    permissionGranted,
  } = useNotifications({ onSessionClick: handleNotificationClick });

  // Session statuses
  const { sessionStatuses, connectionStatus } = useSessionStatuses({
    sessions,
    activeSessionId: focusedActiveTab?.sessionId,
    checkStateChanges,
  });

  // Set initial sidebar state based on viewport (only after hydration)
  useEffect(() => {
    if (isHydrated && !isMobile) setSidebarOpen(true);
  }, [isMobile, isHydrated]);

  // Keyboard shortcut: Cmd+K to open quick switcher
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowQuickSwitcher(true);
      }
    };
    // Also listen for custom event from terminal (which captures Ctrl+K)
    const handleCustomOpen = () => setShowQuickSwitcher(true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("open-quick-switcher", handleCustomOpen);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("open-quick-switcher", handleCustomOpen);
    };
  }, []);

  // Session selection handler
  const handleSelectSession = useCallback(
    (sessionId: string) => {
      selectSession(sessionId, focusedPaneId);
    },
    [selectSession, focusedPaneId]
  );

  // Keyboard navigation for sessions and tabs/panes
  useKeyboardNavigation({
    sessions,
    projects,
    onSelectSession: handleSelectSession,
  });

  // Open quick respond tab handler
  const handleOpenQuickRespond = useCallback(() => {
    // Find the oldest waiting session
    const oldestWaiting = getOldestWaitingSession(sessions, sessionStatuses);
    if (!oldestWaiting) return;

    // Open a quick respond tab with the oldest waiting session
    openQuickRespondTab(focusedPaneIdRef.current, oldestWaiting.id);
  }, [sessions, sessionStatuses, openQuickRespondTab]);

  // Defer session handler - refreshes staleness and moves to next waiting session
  const handleDeferSession = useCallback(
    async (sessionId: string) => {
      // Call API to update the session's timestamp
      await fetch(`/api/sessions/${sessionId}/defer`, { method: "POST" });

      // Refresh sessions to get updated timestamps
      await fetchSessions();

      // Find next waiting session (excluding the deferred one since it's now "newest")
      const nextWaiting = getOldestWaitingSession(
        sessions,
        sessionStatuses,
        sessionId
      );

      if (nextWaiting) {
        // Switch to next waiting session in focused pane
        openQuickRespondTab(focusedPaneIdRef.current, nextWaiting.id);
      }
      // If no more waiting sessions, stay on current (now deferred) session
    },
    [sessions, sessionStatuses, fetchSessions, openQuickRespondTab]
  );

  // Pane renderer
  const renderPane = useCallback(
    (paneId: string) => (
      <Pane
        key={paneId}
        paneId={paneId}
        sessions={sessions}
        projects={projects}
        sessionStatuses={sessionStatuses}
        onMenuClick={isMobile ? () => setSidebarOpen(true) : undefined}
        onSelectSession={handleSelectSession}
        onDeferSession={handleDeferSession}
      />
    ),
    [
      sessions,
      projects,
      sessionStatuses,
      isMobile,
      handleSelectSession,
      handleDeferSession,
    ]
  );

  // New session in project handler
  const handleNewSessionInProject = useCallback((projectId: string) => {
    setNewSessionProjectId(projectId);
    setShowNewSessionDialog(true);
  }, []);

  // Session created handler (shared between desktop/mobile)
  const handleSessionCreated = useCallback(
    async (sessionId: string) => {
      setShowNewSessionDialog(false);
      setNewSessionProjectId(null);
      await fetchSessions();

      const res = await fetch(`/api/sessions/${sessionId}`);
      const data = await res.json();
      if (!data.session) return;

      setTimeout(() => attachToSession(data.session), 100);
    },
    [fetchSessions, attachToSession]
  );

  // Project created handler (shared between desktop/mobile)
  const handleCreateProject = useCallback(
    async (
      name: string,
      workingDirectory: string,
      agentType?: string
    ): Promise<string | null> => {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, workingDirectory, agentType }),
      });
      const data = await res.json();
      if (data.project) {
        await fetchProjects();
        return data.project.id;
      }
      return null;
    },
    [fetchProjects]
  );

  // Open terminal in project handler (shell session, not AI agent)
  const handleOpenTerminal = useCallback(
    async (projectId: string) => {
      const project = projects.find((p) => p.id === projectId);
      if (!project) return;

      // Create a shell session with the project's working directory
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${project.name} Terminal`,
          workingDirectory: project.working_directory || "~",
          agentType: "shell",
          projectId,
        }),
      });

      const data = await res.json();
      if (!data.session) return;

      await fetchSessions();

      // Small delay to ensure state updates, then attach
      setTimeout(() => {
        attachToSession(data.session);
      }, 100);
    },
    [projects, fetchSessions, attachToSession]
  );

  // Active session
  const activeSession = sessions.find(
    (s) => s.id === focusedActiveTab?.sessionId
  );

  // View props
  const viewProps = {
    sessions,
    projects,
    sessionStatuses,
    connectionStatus,
    sidebarOpen,
    setSidebarOpen,
    activeSession,
    focusedActiveTab,
    copiedSessionId,
    setCopiedSessionId,
    showNewSessionDialog,
    setShowNewSessionDialog,
    newSessionProjectId,
    showNotificationSettings,
    setShowNotificationSettings,
    showQuickSwitcher,
    setShowQuickSwitcher,
    notificationSettings,
    permissionGranted,
    updateSettings,
    requestPermission,
    attachToSession,
    openSessionInNewTab,
    handleNewSessionInProject,
    handleOpenTerminal,
    handleSessionCreated,
    handleCreateProject,
    handleOpenQuickRespond,
    handleDeferSession,
    renderPane,
  };

  if (isMobile) {
    return <MobileView {...viewProps} />;
  }

  return <DesktopView {...viewProps} />;
}

export default function Home() {
  return (
    <PaneProvider>
      <HomeContent />
    </PaneProvider>
  );
}
