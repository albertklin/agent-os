"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// Debug log buffer - persists even if console is closed
const debugLogs: string[] = [];
const MAX_DEBUG_LOGS = 100;

function debugLog(message: string) {
  const timestamp = new Date().toISOString().split("T")[1].slice(0, 12);
  const entry = `[${timestamp}] ${message}`;
  debugLogs.push(entry);
  if (debugLogs.length > MAX_DEBUG_LOGS) debugLogs.shift();
  console.log(`[AgentOS] ${message}`);
}

// Expose to window for debugging
if (typeof window !== "undefined") {
  (window as unknown as { agentOSLogs: () => void }).agentOSLogs = () => {
    console.log("=== AgentOS Debug Logs ===");
    debugLogs.forEach((log) => console.log(log));
    console.log("=== End Logs ===");
  };
}
import { PaneProvider, usePanes } from "@/contexts/PaneContext";
import { Pane } from "@/components/Pane";
import { useNotifications } from "@/hooks/useNotifications";
import { useViewport } from "@/hooks/useViewport";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useSessions } from "@/hooks/useSessions";
import { useProjects } from "@/hooks/useProjects";
import { useDevServersManager } from "@/hooks/useDevServersManager";
import { useSessionStatuses } from "@/hooks/useSessionStatuses";
import { useSessionAttachment } from "@/hooks/useSessionAttachment";
import type { Session } from "@/lib/db";
import type { TerminalHandle } from "@/components/Terminal";
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
  const terminalRefs = useRef<Map<string, TerminalHandle>>(new Map());

  // Pane context
  const { focusedPaneId, attachSession, getActiveTab, addTab } = usePanes();
  const focusedActiveTab = getActiveTab(focusedPaneId);
  const { isMobile, isHydrated } = useViewport();

  // Session attachment with locking
  const { attachToSession: attachToSessionWithLock } = useSessionAttachment();

  // Data hooks
  const { sessions, fetchSessions } = useSessions();
  const { projects, fetchProjects } = useProjects();
  const {
    startDevServerProjectId,
    setStartDevServerProjectId,
    startDevServer,
    createDevServer,
  } = useDevServersManager();

  // Set CSS variable for viewport height (handles mobile keyboard)
  useViewportHeight();

  // Terminal ref management
  const registerTerminalRef = useCallback(
    (paneId: string, tabId: string, ref: TerminalHandle | null) => {
      const key = `${paneId}:${tabId}`;
      if (ref) {
        terminalRefs.current.set(key, ref);
        debugLog(
          `Terminal registered: ${key}, total refs: ${terminalRefs.current.size}`
        );
      } else {
        terminalRefs.current.delete(key);
        debugLog(
          `Terminal unregistered: ${key}, total refs: ${terminalRefs.current.size}`
        );
      }
    },
    []
  );

  // Get terminal for a pane, with fallback to first available
  const getTerminalWithFallback = useCallback(():
    | { terminal: TerminalHandle; paneId: string; tabId: string }
    | undefined => {
    debugLog(
      `getTerminalWithFallback called, total refs: ${terminalRefs.current.size}, focusedPaneId: ${focusedPaneId}`
    );

    // Try focused pane first
    const activeTab = getActiveTab(focusedPaneId);
    debugLog(`activeTab for focused pane: ${activeTab?.id || "null"}`);

    if (activeTab) {
      const key = `${focusedPaneId}:${activeTab.id}`;
      const terminal = terminalRefs.current.get(key);
      debugLog(
        `Looking for terminal at key "${key}": ${terminal ? "found" : "not found"}`
      );
      if (terminal) {
        return { terminal, paneId: focusedPaneId, tabId: activeTab.id };
      }
    }

    // Fallback to first available terminal
    const firstEntry = terminalRefs.current.entries().next().value;
    if (firstEntry) {
      const [key, terminal] = firstEntry as [string, TerminalHandle];
      const [paneId, tabId] = key.split(":");
      debugLog(`Using fallback terminal: ${key}`);
      return { terminal, paneId, tabId };
    }

    debugLog(
      `NO TERMINAL FOUND. Available keys: ${Array.from(terminalRefs.current.keys()).join(", ") || "none"}`
    );
    return undefined;
  }, [focusedPaneId, getActiveTab]);

  // Attach session to terminal
  // Uses the new hook with locking to prevent race conditions
  const attachToSession = useCallback(
    async (session: Session) => {
      const terminalInfo = getTerminalWithFallback();
      if (!terminalInfo) {
        debugLog(
          `ERROR: No terminal available to attach session: ${session.name}`
        );
        alert(
          `[AgentOS Debug] No terminal available!\n\nRun agentOSLogs() in console to see debug logs.`
        );
        return;
      }

      const { terminal, paneId } = terminalInfo;
      debugLog(`Attaching to session ${session.name} in pane ${paneId}`);

      // Use the new hook with locking - pass sessions for parent lookup during fork
      const success = await attachToSessionWithLock(
        session.id,
        terminal,
        paneId,
        sessions
      );

      if (!success) {
        debugLog(`Failed to attach to session ${session.name}`);
      }
    },
    [getTerminalWithFallback, attachToSessionWithLock, sessions]
  );

  // Open session in new tab
  const openSessionInNewTab = useCallback(
    (session: Session) => {
      const existingKeys = new Set(terminalRefs.current.keys());
      addTab(focusedPaneId);

      let attempts = 0;
      const maxAttempts = 20;

      const waitForNewTerminal = () => {
        attempts++;

        for (const key of terminalRefs.current.keys()) {
          if (!existingKeys.has(key) && key.startsWith(`${focusedPaneId}:`)) {
            const terminal = terminalRefs.current.get(key);
            if (terminal) {
              // Use the new hook with locking
              attachToSessionWithLock(
                session.id,
                terminal,
                focusedPaneId,
                sessions
              );
              return;
            }
          }
        }

        if (attempts < maxAttempts) {
          setTimeout(waitForNewTerminal, 50);
        } else {
          debugLog(`Failed to find new terminal after ${maxAttempts} attempts`);
        }
      };

      setTimeout(waitForNewTerminal, 50);
    },
    [addTab, focusedPaneId, attachToSessionWithLock, sessions]
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
  const { sessionStatuses } = useSessionStatuses({
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
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Session selection handler
  const handleSelectSession = useCallback(
    (sessionId: string) => {
      debugLog(`handleSelectSession called for: ${sessionId}`);
      const session = sessions.find((s) => s.id === sessionId);
      if (session) {
        debugLog(`Found session: ${session.name}, calling attachToSession`);
        attachToSession(session);
      } else {
        debugLog(
          `Session not found in sessions array (length: ${sessions.length})`
        );
      }
    },
    [sessions, attachToSession]
  );

  // Pane renderer
  const renderPane = useCallback(
    (paneId: string) => (
      <Pane
        key={paneId}
        paneId={paneId}
        sessions={sessions}
        projects={projects}
        onRegisterTerminal={registerTerminalRef}
        onMenuClick={isMobile ? () => setSidebarOpen(true) : undefined}
        onSelectSession={handleSelectSession}
      />
    ),
    [sessions, projects, registerTerminalRef, isMobile, handleSelectSession]
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

  // Active session and dev server project
  const activeSession = sessions.find(
    (s) => s.id === focusedActiveTab?.sessionId
  );
  const startDevServerProject = startDevServerProjectId
    ? (projects.find((p) => p.id === startDevServerProjectId) ?? null)
    : null;

  // View props
  const viewProps = {
    sessions,
    projects,
    sessionStatuses,
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
    handleStartDevServer: startDevServer,
    handleCreateDevServer: createDevServer,
    startDevServerProject,
    setStartDevServerProjectId,
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
