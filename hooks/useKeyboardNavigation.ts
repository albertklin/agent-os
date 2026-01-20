import { useEffect, useCallback, useMemo } from "react";
import { usePanes } from "@/contexts/PaneContext";
import { getPanesInReadingOrder } from "@/lib/panes";
import type { Session } from "@/lib/db";
import type { ProjectWithDevServers } from "@/lib/projects";

interface UseKeyboardNavigationProps {
  sessions: Session[];
  projects: ProjectWithDevServers[];
  onSelectSession: (sessionId: string) => void;
}

/**
 * Hook for keyboard navigation of sessions and tabs/panes.
 *
 * Shortcuts:
 * - Cmd/Ctrl + Up: Previous session in list
 * - Cmd/Ctrl + Down: Next session in list
 * - Cmd/Ctrl + Left: Previous tab (flows to left pane when at edge)
 * - Cmd/Ctrl + Right: Next tab (flows to right pane when at edge)
 */
export function useKeyboardNavigation({
  sessions,
  projects,
  onSelectSession,
}: UseKeyboardNavigationProps) {
  const {
    state,
    focusedPaneId,
    focusPane,
    switchTab,
    getPaneData,
    getActiveTab,
  } = usePanes();

  // Flatten all session IDs from projects (same logic as ProjectsSection)
  const allSessionIds = useMemo(() => {
    const ids: string[] = [];
    for (const project of projects) {
      const projectSessions = sessions.filter(
        (s) => (s.project_id || "uncategorized") === project.id
      );
      for (const session of projectSessions) {
        ids.push(session.id);
      }
    }
    return ids;
  }, [projects, sessions]);

  // Get currently active session ID from focused pane's active tab
  const focusedActiveTab = getActiveTab(focusedPaneId);
  const currentSessionId = focusedActiveTab?.sessionId ?? null;

  // Navigate to previous session in the flattened list
  const navigateToPreviousSession = useCallback(() => {
    if (allSessionIds.length === 0) return;

    const currentIndex = currentSessionId
      ? allSessionIds.indexOf(currentSessionId)
      : -1;

    let newIndex: number;
    if (currentIndex <= 0) {
      // Wrap to last session
      newIndex = allSessionIds.length - 1;
    } else {
      newIndex = currentIndex - 1;
    }

    onSelectSession(allSessionIds[newIndex]);
  }, [allSessionIds, currentSessionId, onSelectSession]);

  // Navigate to next session in the flattened list
  const navigateToNextSession = useCallback(() => {
    if (allSessionIds.length === 0) return;

    const currentIndex = currentSessionId
      ? allSessionIds.indexOf(currentSessionId)
      : -1;

    let newIndex: number;
    if (currentIndex === -1 || currentIndex >= allSessionIds.length - 1) {
      // Wrap to first session
      newIndex = 0;
    } else {
      newIndex = currentIndex + 1;
    }

    onSelectSession(allSessionIds[newIndex]);
  }, [allSessionIds, currentSessionId, onSelectSession]);

  // Navigate tabs within or across panes
  const navigateTabOrPane = useCallback(
    (direction: "left" | "right") => {
      const paneData = getPaneData(focusedPaneId);
      const tabs = paneData.tabs;
      const activeTabId = paneData.activeTabId;

      // Find current tab index
      const currentTabIndex = tabs.findIndex((t) => t.id === activeTabId);
      if (currentTabIndex === -1) return;

      const isAtLeftEdge = currentTabIndex === 0;
      const isAtRightEdge = currentTabIndex === tabs.length - 1;

      // Navigate within current pane if not at edge
      if (direction === "left" && !isAtLeftEdge) {
        switchTab(focusedPaneId, tabs[currentTabIndex - 1].id);
        return;
      }
      if (direction === "right" && !isAtRightEdge) {
        switchTab(focusedPaneId, tabs[currentTabIndex + 1].id);
        return;
      }

      // At edge - try to move to adjacent pane
      const panesInOrder = getPanesInReadingOrder(state.layout);
      const currentPaneIndex = panesInOrder.indexOf(focusedPaneId);
      if (currentPaneIndex === -1) return;

      if (direction === "left" && isAtLeftEdge) {
        // Move to previous pane (select its rightmost tab)
        if (currentPaneIndex === 0) return; // No wrap for panes
        const prevPaneId = panesInOrder[currentPaneIndex - 1];
        const prevPaneData = getPaneData(prevPaneId);
        focusPane(prevPaneId);
        // Select rightmost tab
        const lastTab = prevPaneData.tabs[prevPaneData.tabs.length - 1];
        if (lastTab) {
          switchTab(prevPaneId, lastTab.id);
        }
      } else if (direction === "right" && isAtRightEdge) {
        // Move to next pane (select its leftmost tab)
        if (currentPaneIndex === panesInOrder.length - 1) return; // No wrap for panes
        const nextPaneId = panesInOrder[currentPaneIndex + 1];
        const nextPaneData = getPaneData(nextPaneId);
        focusPane(nextPaneId);
        // Select leftmost tab
        const firstTab = nextPaneData.tabs[0];
        if (firstTab) {
          switchTab(nextPaneId, firstTab.id);
        }
      }
    },
    [focusedPaneId, getPaneData, state.layout, focusPane, switchTab]
  );

  // Handle navigation for a given arrow key
  const handleNavigation = useCallback(
    (key: string) => {
      switch (key) {
        case "ArrowUp":
          navigateToPreviousSession();
          break;
        case "ArrowDown":
          navigateToNextSession();
          break;
        case "ArrowLeft":
          navigateTabOrPane("left");
          break;
        case "ArrowRight":
          navigateTabOrPane("right");
          break;
      }
    },
    [navigateToPreviousSession, navigateToNextSession, navigateTabOrPane]
  );

  useEffect(() => {
    // Handle regular keydown events (when terminal is not focused)
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle Cmd/Ctrl + Shift + Arrow keys
      if (!(e.metaKey || e.ctrlKey)) return;
      if (!e.shiftKey) return;
      if (!e.key.startsWith("Arrow")) return;

      e.preventDefault();
      handleNavigation(e.key);
    };

    // Handle custom events dispatched from terminal (which captures Cmd/Ctrl+Arrow)
    const handleCustomNav = (e: Event) => {
      const customEvent = e as CustomEvent<{ key: string }>;
      handleNavigation(customEvent.detail.key);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyboard-nav", handleCustomNav);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyboard-nav", handleCustomNav);
    };
  }, [handleNavigation]);
}
