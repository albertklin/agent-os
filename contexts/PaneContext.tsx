"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  type PaneState,
  type PaneData,
  type TabData,
  createInitialPaneState,
  createPaneData,
  createTab,
  splitPane,
  closePane,
  countPanes,
  savePaneState,
  loadPaneState,
  MAX_PANES,
} from "@/lib/panes";
import { useViewport } from "@/hooks/useViewport";

interface PaneContextValue {
  state: PaneState;
  focusedPaneId: string;
  canSplit: boolean;
  canClose: boolean;
  isMobile: boolean;
  focusPane: (paneId: string) => void;
  splitHorizontal: (paneId: string) => void;
  splitVertical: (paneId: string) => void;
  close: (paneId: string) => void;
  // Tab management
  addTab: (paneId: string, sessionId?: string) => void;
  closeTab: (paneId: string, tabId: string) => void;
  switchTab: (paneId: string, tabId: string) => void;
  reorderTabs: (paneId: string, fromIndex: number, toIndex: number) => void;
  moveTabToPane: (
    fromPaneId: string,
    toPaneId: string,
    tabId: string,
    toIndex?: number
  ) => void;
  // Session management (operates on active tab)
  setSession: (paneId: string, sessionId: string) => void;
  clearSession: (paneId: string) => void;
  clearSessionFromTabs: (sessionId: string) => void;
  getPaneData: (paneId: string) => PaneData;
  getActiveTab: (paneId: string) => TabData | null;
  // Quick respond tab management
  openQuickRespondTab: (paneId: string, sessionId: string) => void;
}

const PaneContext = createContext<PaneContextValue | null>(null);

// Default pane data for migration from old format
const defaultPaneData: PaneData = createPaneData();

export function PaneProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PaneState>(createInitialPaneState);
  const [hydrated, setHydrated] = useState(false);
  const { isMobile } = useViewport();

  // Load from localStorage after hydration
  useEffect(() => {
    const saved = loadPaneState();
    if (saved) {
      // Migrate old pane data format if needed
      const migratedPanes: Record<string, PaneData> = {};
      for (const [paneId, paneData] of Object.entries(saved.panes)) {
        if ("tabs" in paneData && Array.isArray(paneData.tabs)) {
          // New format
          migratedPanes[paneId] = paneData as PaneData;
        } else {
          // Old format - migrate to new
          const oldData = paneData as {
            sessionId?: string | null;
          };
          const tab = createTab();
          tab.sessionId = oldData.sessionId || null;
          migratedPanes[paneId] = {
            tabs: [tab],
            activeTabId: tab.id,
          };
        }
      }
      setState({ ...saved, panes: migratedPanes });
    }
    setHydrated(true);
  }, []);

  // Persist state changes to localStorage with debouncing (only after hydration)
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (hydrated) {
      // Clear any pending save
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      // Debounce localStorage writes to avoid blocking UI
      saveTimeoutRef.current = setTimeout(() => {
        savePaneState(state);
      }, 500);
    }
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
    };
  }, [state, hydrated]);

  const focusPane = useCallback((paneId: string) => {
    setState((prev) => ({ ...prev, focusedPaneId: paneId }));
  }, []);

  const splitHorizontal = useCallback((paneId: string) => {
    setState((prev) => {
      const newState = splitPane(prev, paneId, "horizontal");
      return newState || prev;
    });
  }, []);

  const splitVertical = useCallback((paneId: string) => {
    setState((prev) => {
      const newState = splitPane(prev, paneId, "vertical");
      return newState || prev;
    });
  }, []);

  const close = useCallback((paneId: string) => {
    setState((prev) => {
      const newState = closePane(prev, paneId);
      return newState || prev;
    });
  }, []);

  // Tab management
  const addTab = useCallback((paneId: string, sessionId?: string) => {
    setState((prev) => {
      const pane = prev.panes[paneId];
      if (!pane) return prev;
      const newTab = createTab();
      if (sessionId) {
        newTab.sessionId = sessionId;
      }
      return {
        ...prev,
        panes: {
          ...prev.panes,
          [paneId]: {
            ...pane,
            tabs: [...pane.tabs, newTab],
            activeTabId: newTab.id,
          },
        },
      };
    });
  }, []);

  const closeTab = useCallback((paneId: string, tabId: string) => {
    setState((prev) => {
      const pane = prev.panes[paneId];
      if (!pane) return prev;

      // If this is the last tab in the pane
      if (pane.tabs.length <= 1) {
        const paneCount = countPanes(prev.layout);

        // If there are multiple panes, close this pane
        if (paneCount > 1) {
          const newState = closePane(prev, paneId);
          return newState || prev;
        }

        // If this is the only pane, replace with a placeholder tab
        const newTab = createTab();
        return {
          ...prev,
          panes: {
            ...prev.panes,
            [paneId]: {
              tabs: [newTab],
              activeTabId: newTab.id,
            },
          },
        };
      }

      // Multiple tabs - just remove this one
      const newTabs = pane.tabs.filter((t) => t.id !== tabId);
      const newActiveTabId =
        pane.activeTabId === tabId ? newTabs[0].id : pane.activeTabId;

      return {
        ...prev,
        panes: {
          ...prev.panes,
          [paneId]: {
            ...pane,
            tabs: newTabs,
            activeTabId: newActiveTabId,
          },
        },
      };
    });
  }, []);

  const switchTab = useCallback((paneId: string, tabId: string) => {
    setState((prev) => {
      const pane = prev.panes[paneId];
      if (!pane) return prev;
      return {
        ...prev,
        panes: {
          ...prev.panes,
          [paneId]: {
            ...pane,
            activeTabId: tabId,
          },
        },
      };
    });
  }, []);

  const reorderTabs = useCallback(
    (paneId: string, fromIndex: number, toIndex: number) => {
      setState((prev) => {
        const pane = prev.panes[paneId];
        if (!pane) return prev;
        if (fromIndex === toIndex) return prev;
        if (fromIndex < 0 || fromIndex >= pane.tabs.length) return prev;
        if (toIndex < 0 || toIndex >= pane.tabs.length) return prev;

        const newTabs = [...pane.tabs];
        const [removed] = newTabs.splice(fromIndex, 1);
        newTabs.splice(toIndex, 0, removed);

        return {
          ...prev,
          panes: {
            ...prev.panes,
            [paneId]: {
              ...pane,
              tabs: newTabs,
            },
          },
        };
      });
    },
    []
  );

  // Move a tab from one pane to another
  const moveTabToPane = useCallback(
    (fromPaneId: string, toPaneId: string, tabId: string, toIndex?: number) => {
      if (fromPaneId === toPaneId) return;

      setState((prev) => {
        const fromPane = prev.panes[fromPaneId];
        const toPane = prev.panes[toPaneId];
        if (!fromPane || !toPane) return prev;

        // Find the tab to move
        const tabIndex = fromPane.tabs.findIndex((t) => t.id === tabId);
        if (tabIndex === -1) return prev;

        const tabToMove = fromPane.tabs[tabIndex];

        // Remove from source pane
        const newFromTabs = fromPane.tabs.filter((t) => t.id !== tabId);

        // If source pane would be empty, add a new empty tab
        let newFromActiveTabId = fromPane.activeTabId;
        if (newFromTabs.length === 0) {
          const newTab = createTab();
          newFromTabs.push(newTab);
          newFromActiveTabId = newTab.id;
        } else if (fromPane.activeTabId === tabId) {
          // If active tab was moved, select first remaining tab
          newFromActiveTabId = newFromTabs[0].id;
        }

        // Add to destination pane
        const newToTabs = [...toPane.tabs];
        const insertIndex =
          toIndex !== undefined
            ? Math.min(toIndex, newToTabs.length)
            : newToTabs.length;
        newToTabs.splice(insertIndex, 0, tabToMove);

        return {
          ...prev,
          focusedPaneId: toPaneId,
          panes: {
            ...prev.panes,
            [fromPaneId]: {
              ...fromPane,
              tabs: newFromTabs,
              activeTabId: newFromActiveTabId,
            },
            [toPaneId]: {
              ...toPane,
              tabs: newToTabs,
              activeTabId: tabId, // Activate the moved tab
            },
          },
        };
      });
    },
    []
  );

  // Set session on active tab
  const setSession = useCallback((paneId: string, sessionId: string) => {
    setState((prev) => {
      const pane = prev.panes[paneId];
      if (!pane) return prev;

      const newTabs = pane.tabs.map((tab) =>
        tab.id === pane.activeTabId ? { ...tab, sessionId } : tab
      );

      return {
        ...prev,
        panes: {
          ...prev.panes,
          [paneId]: { ...pane, tabs: newTabs },
        },
      };
    });
  }, []);

  // Clear session from active tab
  const clearSession = useCallback((paneId: string) => {
    setState((prev) => {
      const pane = prev.panes[paneId];
      if (!pane) return prev;

      const newTabs = pane.tabs.map((tab) =>
        tab.id === pane.activeTabId ? { ...tab, sessionId: null } : tab
      );

      return {
        ...prev,
        panes: {
          ...prev.panes,
          [paneId]: { ...pane, tabs: newTabs },
        },
      };
    });
  }, []);

  // Clear a deleted session from all tabs across all panes
  // Removes the tab if there are other tabs, otherwise clears the session reference
  const clearSessionFromTabs = useCallback((sessionId: string) => {
    setState((prev) => {
      const newPanes: Record<string, PaneData> = {};
      let changed = false;

      for (const [paneId, pane] of Object.entries(prev.panes)) {
        const affectedTabIds = pane.tabs
          .filter((tab) => tab.sessionId === sessionId)
          .map((tab) => tab.id);

        if (affectedTabIds.length === 0) {
          newPanes[paneId] = pane;
          continue;
        }

        changed = true;

        // If there are other tabs, remove the affected ones
        if (pane.tabs.length > affectedTabIds.length) {
          const newTabs = pane.tabs.filter(
            (tab) => tab.sessionId !== sessionId
          );
          const newActiveTabId = affectedTabIds.includes(pane.activeTabId)
            ? newTabs[0].id
            : pane.activeTabId;
          newPanes[paneId] = {
            ...pane,
            tabs: newTabs,
            activeTabId: newActiveTabId,
          };
        } else {
          // It's the only tab(s), just clear the session reference
          const newTabs = pane.tabs.map((tab) =>
            tab.sessionId === sessionId ? { ...tab, sessionId: null } : tab
          );
          newPanes[paneId] = { ...pane, tabs: newTabs };
        }
      }

      return changed ? { ...prev, panes: newPanes } : prev;
    });
  }, []);

  const getPaneData = useCallback(
    (paneId: string): PaneData => {
      return state.panes[paneId] || defaultPaneData;
    },
    [state.panes]
  );

  const getActiveTab = useCallback(
    (paneId: string): TabData | null => {
      const pane = state.panes[paneId];
      if (!pane) return null;
      return pane.tabs.find((t) => t.id === pane.activeTabId) || null;
    },
    [state.panes]
  );

  // Open or switch to a quick respond tab
  const openQuickRespondTab = useCallback(
    (paneId: string, sessionId: string) => {
      setState((prev) => {
        const pane = prev.panes[paneId];
        if (!pane) return prev;

        // Check if there's already a quick respond tab in this pane
        const existingQrTab = pane.tabs.find((t) => t.isQuickRespond);
        if (existingQrTab) {
          // Update the existing quick respond tab to the new session and switch to it
          const newTabs = pane.tabs.map((tab) =>
            tab.id === existingQrTab.id ? { ...tab, sessionId } : tab
          );
          return {
            ...prev,
            panes: {
              ...prev.panes,
              [paneId]: {
                ...pane,
                tabs: newTabs,
                activeTabId: existingQrTab.id,
              },
            },
          };
        }

        // Create a new quick respond tab
        const newTab: TabData = {
          id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          sessionId,
          isQuickRespond: true,
        };

        return {
          ...prev,
          panes: {
            ...prev.panes,
            [paneId]: {
              ...pane,
              tabs: [...pane.tabs, newTab],
              activeTabId: newTab.id,
            },
          },
        };
      });
    },
    []
  );

  // On mobile: disable splits (single pane only)
  const canSplit = !isMobile && countPanes(state.layout) < MAX_PANES;
  const canClose = !isMobile && countPanes(state.layout) > 1;

  // Memoize context value to prevent unnecessary re-renders of all consumers
  const contextValue = useMemo(
    () => ({
      state,
      focusedPaneId: state.focusedPaneId,
      canSplit,
      canClose,
      isMobile,
      focusPane,
      splitHorizontal,
      splitVertical,
      close,
      addTab,
      closeTab,
      switchTab,
      reorderTabs,
      moveTabToPane,
      setSession,
      clearSession,
      clearSessionFromTabs,
      getPaneData,
      getActiveTab,
      openQuickRespondTab,
    }),
    [
      state,
      canSplit,
      canClose,
      isMobile,
      focusPane,
      splitHorizontal,
      splitVertical,
      close,
      addTab,
      closeTab,
      switchTab,
      reorderTabs,
      moveTabToPane,
      setSession,
      clearSession,
      clearSessionFromTabs,
      getPaneData,
      getActiveTab,
      openQuickRespondTab,
    ]
  );

  return (
    <PaneContext.Provider value={contextValue}>{children}</PaneContext.Provider>
  );
}

export function usePanes() {
  const context = useContext(PaneContext);
  if (!context) {
    throw new Error("usePanes must be used within a PaneProvider");
  }
  return context;
}
