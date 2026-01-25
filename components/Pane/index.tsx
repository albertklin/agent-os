"use client";

import { useRef, useCallback, useEffect, memo, useState } from "react";
import dynamic from "next/dynamic";
import { usePanes } from "@/contexts/PaneContext";
import type { Session, Project } from "@/lib/db";
import { sessionRegistry } from "@/lib/client/session-registry";
import {
  getOldestWaitingSession,
  type SessionStatusType,
} from "@/lib/sessions";
import type { LifecycleStatusType } from "@/hooks/useStatusStream";
import { cn } from "@/lib/utils";
import { useFileEditor } from "@/hooks/useFileEditor";
import { useTerminalFocusRedirect } from "@/hooks/useTerminalFocusRedirect";
import { MobileTabBar } from "./MobileTabBar";
import { DesktopTabBar } from "./DesktopTabBar";
import type { TerminalHandle } from "@/components/Terminal";
import {
  TerminalSkeleton,
  FileExplorerSkeleton,
  GitPanelSkeleton,
  EmptySessionPlaceholder,
} from "./PaneSkeletons";
import {
  Panel as ResizablePanel,
  Group as ResizablePanelGroup,
  Separator as ResizablePanelHandle,
} from "react-resizable-panels";
import { GitDrawer } from "@/components/GitDrawer";
import { ShellDrawer } from "@/components/ShellDrawer";
import { useSnapshot } from "valtio";
import { fileOpenStore, fileOpenActions } from "@/stores/fileOpen";

// Dynamic imports for client-only components with loading states
const Terminal = dynamic(
  () => import("@/components/Terminal").then((mod) => mod.Terminal),
  { ssr: false, loading: () => <TerminalSkeleton /> }
);

const FileExplorer = dynamic(
  () => import("@/components/FileExplorer").then((mod) => mod.FileExplorer),
  { ssr: false, loading: () => <FileExplorerSkeleton /> }
);

const GitPanel = dynamic(
  () => import("@/components/GitPanel").then((mod) => mod.GitPanel),
  { ssr: false, loading: () => <GitPanelSkeleton /> }
);

interface PaneProps {
  paneId: string;
  sessions: Session[];
  projects: Project[];
  sessionStatuses?: Record<
    string,
    { status: SessionStatusType; lifecycleStatus?: LifecycleStatusType }
  >;
  onMenuClick?: () => void;
  onSelectSession?: (sessionId: string) => void;
  onDeferSession?: (sessionId: string) => Promise<void>;
}

type ViewMode = "terminal" | "files" | "git";

export const Pane = memo(function Pane({
  paneId,
  sessions,
  projects,
  sessionStatuses = {},
  onMenuClick,
  onSelectSession,
  onDeferSession,
}: PaneProps) {
  // Use isMobile from usePanes() to stay consistent with PaneLayout's TabDndProvider wrapping
  const {
    isMobile,
    focusedPaneId,
    canSplit,
    canClose,
    focusPane,
    splitHorizontal,
    splitVertical,
    close,
    getPaneData,
    getActiveTab,
    addTab,
    closeTab,
    switchTab,
    setSession,
  } = usePanes();

  const [viewMode, setViewMode] = useState<ViewMode>("terminal");
  const [gitDrawerOpen, setGitDrawerOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem("gitDrawerOpen");
    return stored === null ? true : stored === "true";
  });
  const [shellDrawerOpen, setShellDrawerOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    const stored = localStorage.getItem("shellDrawerOpen");
    return stored === "true";
  });
  // Track sessions that have been reported as failed via WebSocket
  // This provides immediate UI feedback before SSE update arrives
  const [failedSessions, setFailedSessions] = useState<Set<string>>(
    () => new Set()
  );
  const paneData = getPaneData(paneId);
  const activeTab = getActiveTab(paneId);
  const isFocused = focusedPaneId === paneId;
  const session = activeTab
    ? sessions.find((s) => s.id === activeTab.sessionId)
    : null;

  // File editor state - lifted here so it persists across view switches
  const fileEditor = useFileEditor();

  // Terminal refs - one per tab, keyed by tab ID
  const terminalRefs = useRef<Map<string, TerminalHandle>>(new Map());

  // Get focus function for active terminal (only when terminal view is active and pane is focused)
  const focusActiveTerminal = useCallback(() => {
    if (!activeTab || viewMode !== "terminal") return;
    const terminalHandle = terminalRefs.current.get(activeTab.id);
    terminalHandle?.focus();
  }, [activeTab, viewMode]);

  // Mark a session as failed (called when WebSocket reports session failure)
  // This provides immediate UI feedback before SSE update arrives
  const markSessionFailed = useCallback((sessionId: string) => {
    setFailedSessions((prev) => new Set(prev).add(sessionId));
  }, []);

  // Redirect keyboard input to terminal when no input element is focused
  useTerminalFocusRedirect(
    isFocused && viewMode === "terminal" ? focusActiveTerminal : null,
    isFocused && viewMode === "terminal"
  );

  // Watch for file open requests
  const { request: fileOpenRequest } = useSnapshot(fileOpenStore);

  // Reset view mode and file editor when session changes
  useEffect(() => {
    setViewMode("terminal");
    fileEditor.reset();
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist drawer states
  useEffect(() => {
    localStorage.setItem("gitDrawerOpen", String(gitDrawerOpen));
  }, [gitDrawerOpen]);

  useEffect(() => {
    localStorage.setItem("shellDrawerOpen", String(shellDrawerOpen));
  }, [shellDrawerOpen]);

  // Handle file open requests (only if this pane is focused)
  useEffect(() => {
    if (fileOpenRequest && isFocused && session) {
      // Switch to files view
      setViewMode("files");
      // Open the file
      fileEditor.openFile(fileOpenRequest.path);
      // Clear the request
      fileOpenActions.clearRequest();
      // TODO: Scroll to line (requires FileEditor enhancement)
    }
  }, [fileOpenRequest, isFocused, session, fileEditor]);

  // Auto-switch logic for quick respond tabs
  // When a quick respond tab's session changes from "waiting" to idle/running,
  // automatically switch to the next waiting session
  useEffect(() => {
    if (!activeTab?.isQuickRespond || !activeTab.sessionId) return;

    const currentStatus = sessionStatuses[activeTab.sessionId]?.status;

    // If current session is no longer waiting, find next waiting session
    if (currentStatus && currentStatus !== "waiting") {
      const nextWaiting = getOldestWaitingSession(
        sessions,
        sessionStatuses,
        activeTab.sessionId
      );
      if (nextWaiting) {
        setSession(paneId, nextWaiting.id);
      }
      // If no more waiting sessions, tab stays on current session (user can close manually)
    }
  }, [sessionStatuses, activeTab, sessions, paneId, setSession]);

  const handleFocus = useCallback(() => {
    focusPane(paneId);
  }, [focusPane, paneId]);

  // Swipe gesture handling for mobile session switching (terminal view only)
  const touchStartX = useRef<number | null>(null);
  const currentIndex = session
    ? sessions.findIndex((s) => s.id === session.id)
    : -1;
  const SWIPE_THRESHOLD = 120;

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (viewMode !== "terminal") return;
      touchStartX.current = e.touches[0].clientX;
    },
    [viewMode]
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (viewMode !== "terminal" || touchStartX.current === null) return;

      const diff = e.changedTouches[0].clientX - touchStartX.current;
      touchStartX.current = null;

      if (Math.abs(diff) <= SWIPE_THRESHOLD) return;

      const nextIndex = diff > 0 ? currentIndex - 1 : currentIndex + 1;
      if (nextIndex >= 0 && nextIndex < sessions.length) {
        onSelectSession?.(sessions[nextIndex].id);
      }
    },
    [viewMode, currentIndex, sessions, onSelectSession]
  );

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden",
        !isMobile && "rounded-lg shadow-lg shadow-black/10 dark:shadow-black/30"
      )}
      onMouseDown={handleFocus}
    >
      {/* Tab Bar - Mobile vs Desktop */}
      {isMobile ? (
        <MobileTabBar
          session={session}
          sessions={sessions}
          projects={projects}
          viewMode={viewMode}
          onMenuClick={onMenuClick}
          onViewModeChange={setViewMode}
          onSelectSession={onSelectSession}
        />
      ) : (
        <DesktopTabBar
          paneId={paneId}
          tabs={paneData.tabs}
          activeTabId={paneData.activeTabId}
          session={session}
          sessions={sessions}
          sessionStatuses={sessionStatuses}
          viewMode={viewMode}
          isFocused={isFocused}
          canSplit={canSplit}
          canClose={canClose}
          gitDrawerOpen={gitDrawerOpen}
          shellDrawerOpen={shellDrawerOpen}
          onTabSwitch={(tabId) => switchTab(paneId, tabId)}
          onTabClose={(tabId) => closeTab(paneId, tabId)}
          onTabAdd={() => addTab(paneId)}
          onViewModeChange={setViewMode}
          onGitDrawerToggle={() => setGitDrawerOpen((prev) => !prev)}
          onShellDrawerToggle={() => setShellDrawerOpen((prev) => !prev)}
          onSplitHorizontal={() => splitHorizontal(paneId)}
          onSplitVertical={() => splitVertical(paneId)}
          onClose={() => close(paneId)}
          onDeferSession={onDeferSession}
        />
      )}

      {/* Content Area - Mobile: simple flex, Desktop: resizable panels */}
      {isMobile ? (
        <div
          className="relative min-h-0 w-full flex-1"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {/* Terminals - one per tab, or placeholder if no session */}
          {paneData.tabs.map((tab) => {
            const isActive = tab.id === activeTab?.id;
            const hasSession = tab.sessionId !== null;
            const tabSession = hasSession
              ? sessions.find((s) => s.id === tab.sessionId)
              : null;
            const savedState = sessionRegistry.getTerminalState(paneId, tab.id);

            return (
              <div
                key={tab.id}
                className={
                  viewMode === "terminal" && isActive
                    ? "h-full w-full"
                    : "hidden"
                }
              >
                {hasSession ? (
                  <Terminal
                    ref={(handle) => {
                      if (handle) {
                        terminalRefs.current.set(tab.id, handle);
                      } else {
                        terminalRefs.current.delete(tab.id);
                      }
                    }}
                    sessionId={tab.sessionId ?? undefined}
                    lifecycleStatus={
                      // Check local failedSessions first for immediate feedback,
                      // then prefer SSE lifecycle status (real-time) over DB value
                      tab.sessionId && failedSessions.has(tab.sessionId)
                        ? "failed"
                        : (tab.sessionId &&
                            sessionStatuses[tab.sessionId]?.lifecycleStatus) ||
                          tabSession?.lifecycle_status
                    }
                    setupStatus={tabSession?.setup_status ?? undefined}
                    onSessionFailed={
                      tab.sessionId
                        ? () => markSessionFailed(tab.sessionId!)
                        : undefined
                    }
                    onBeforeUnmount={(scrollState) => {
                      sessionRegistry.saveTerminalState(paneId, tab.id, {
                        scrollTop: scrollState.scrollTop,
                        scrollHeight: 0,
                        lastActivity: Date.now(),
                        cursorY: scrollState.cursorY,
                      });
                    }}
                    initialScrollState={
                      savedState
                        ? {
                            scrollTop: savedState.scrollTop,
                            cursorY: savedState.cursorY,
                            baseY: 0,
                          }
                        : undefined
                    }
                  />
                ) : (
                  <EmptySessionPlaceholder />
                )}
              </div>
            );
          })}

          {/* Files */}
          {session?.working_directory && (
            <div className={viewMode === "files" ? "h-full" : "hidden"}>
              <FileExplorer
                workingDirectory={session.working_directory}
                fileEditor={fileEditor}
              />
            </div>
          )}

          {/* Git - mobile only */}
          {session?.working_directory && (
            <div className={viewMode === "git" ? "h-full" : "hidden"}>
              <GitPanel workingDirectory={session.working_directory} />
            </div>
          )}
        </div>
      ) : (
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1"
        >
          {/* Left column: Main content + Shell drawer */}
          <ResizablePanel defaultSize={gitDrawerOpen ? 70 : 100} minSize={20}>
            <ResizablePanelGroup orientation="vertical" className="h-full">
              {/* Main content */}
              <ResizablePanel
                defaultSize={shellDrawerOpen ? 70 : 100}
                minSize={10}
              >
                <div className="relative h-full">
                  {/* Terminals - one per tab, or placeholder if no session */}
                  {paneData.tabs.map((tab) => {
                    const isActive = tab.id === activeTab?.id;
                    const hasSession = tab.sessionId !== null;
                    const tabSession = hasSession
                      ? sessions.find((s) => s.id === tab.sessionId)
                      : null;
                    const savedState = sessionRegistry.getTerminalState(
                      paneId,
                      tab.id
                    );

                    return (
                      <div
                        key={tab.id}
                        className={
                          viewMode === "terminal" && isActive
                            ? "h-full"
                            : "hidden"
                        }
                      >
                        {hasSession ? (
                          <Terminal
                            ref={(handle) => {
                              if (handle) {
                                terminalRefs.current.set(tab.id, handle);
                              } else {
                                terminalRefs.current.delete(tab.id);
                              }
                            }}
                            sessionId={tab.sessionId ?? undefined}
                            lifecycleStatus={
                              // Check local failedSessions first for immediate feedback,
                              // then prefer SSE lifecycle status (real-time) over DB value
                              tab.sessionId && failedSessions.has(tab.sessionId)
                                ? "failed"
                                : (tab.sessionId &&
                                    sessionStatuses[tab.sessionId]
                                      ?.lifecycleStatus) ||
                                  tabSession?.lifecycle_status
                            }
                            setupStatus={tabSession?.setup_status ?? undefined}
                            onSessionFailed={
                              tab.sessionId
                                ? () => markSessionFailed(tab.sessionId!)
                                : undefined
                            }
                            onBeforeUnmount={(scrollState) => {
                              sessionRegistry.saveTerminalState(
                                paneId,
                                tab.id,
                                {
                                  scrollTop: scrollState.scrollTop,
                                  scrollHeight: 0,
                                  lastActivity: Date.now(),
                                  cursorY: scrollState.cursorY,
                                }
                              );
                            }}
                            initialScrollState={
                              savedState
                                ? {
                                    scrollTop: savedState.scrollTop,
                                    cursorY: savedState.cursorY,
                                    baseY: 0,
                                  }
                                : undefined
                            }
                          />
                        ) : (
                          <EmptySessionPlaceholder />
                        )}
                      </div>
                    );
                  })}

                  {/* Files */}
                  {session?.working_directory && (
                    <div className={viewMode === "files" ? "h-full" : "hidden"}>
                      <FileExplorer
                        workingDirectory={session.working_directory}
                        fileEditor={fileEditor}
                      />
                    </div>
                  )}
                </div>
              </ResizablePanel>

              {/* Shell drawer - under main content */}
              {shellDrawerOpen && session?.working_directory && (
                <>
                  <ResizablePanelHandle className="bg-border/30 hover:bg-primary/30 active:bg-primary/50 h-px cursor-row-resize transition-colors" />
                  <ResizablePanel defaultSize={30} minSize={10}>
                    <ShellDrawer
                      open={true}
                      onOpenChange={setShellDrawerOpen}
                      workingDirectory={session.working_directory}
                    />
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
          </ResizablePanel>

          {/* Git drawer - right side, full height */}
          {gitDrawerOpen && session?.working_directory && (
            <>
              <ResizablePanelHandle className="bg-border/30 hover:bg-primary/30 active:bg-primary/50 w-px cursor-col-resize transition-colors" />
              <ResizablePanel defaultSize={30} minSize={10}>
                <GitDrawer
                  open={true}
                  onOpenChange={setGitDrawerOpen}
                  workingDirectory={session.working_directory}
                />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      )}
    </div>
  );
});
