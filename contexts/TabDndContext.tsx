"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { usePanes } from "./PaneContext";

// ID format: "pane:{paneId}:tab:{tabId}"
// Drop zone ID format: "dropzone:{paneId}"
export function createDraggableId(paneId: string, tabId: string): string {
  return `pane:${paneId}:tab:${tabId}`;
}

export function createDropzoneId(paneId: string): string {
  return `dropzone:${paneId}`;
}

export function parseDraggableId(id: string): {
  paneId: string;
  tabId: string;
} | null {
  const match = id.match(/^pane:(.+):tab:(.+)$/);
  if (!match) return null;
  return { paneId: match[1], tabId: match[2] };
}

export function parseDropzoneId(id: string): string | null {
  const match = id.match(/^dropzone:(.+)$/);
  return match ? match[1] : null;
}

interface DragState {
  activeId: string | null;
  activePaneId: string | null;
  activeTabId: string | null;
  overPaneId: string | null;
}

interface TabDndContextValue {
  dragState: DragState;
}

const TabDndContext = createContext<TabDndContextValue | null>(null);

export function useTabDnd() {
  const context = useContext(TabDndContext);
  if (!context) {
    throw new Error("useTabDnd must be used within a TabDndProvider");
  }
  return context;
}

interface TabDndProviderProps {
  children: ReactNode;
}

export function TabDndProvider({ children }: TabDndProviderProps) {
  const { reorderTabs, moveTabToPane, getPaneData } = usePanes();

  const [dragState, setDragState] = useState<DragState>({
    activeId: null,
    activePaneId: null,
    activeTabId: null,
    overPaneId: null,
  });

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    const parsed = parseDraggableId(active.id as string);

    if (parsed) {
      setDragState({
        activeId: active.id as string,
        activePaneId: parsed.paneId,
        activeTabId: parsed.tabId,
        overPaneId: parsed.paneId,
      });
    }
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;

    if (!over) {
      setDragState((prev) => ({ ...prev, overPaneId: null }));
      return;
    }

    // Check if over a dropzone
    const dropzonePaneId = parseDropzoneId(over.id as string);
    if (dropzonePaneId) {
      setDragState((prev) => ({ ...prev, overPaneId: dropzonePaneId }));
      return;
    }

    // Check if over another tab
    const parsed = parseDraggableId(over.id as string);
    if (parsed) {
      setDragState((prev) => ({ ...prev, overPaneId: parsed.paneId }));
    }
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      // Reset drag state
      setDragState({
        activeId: null,
        activePaneId: null,
        activeTabId: null,
        overPaneId: null,
      });

      if (!over) return;

      const activeData = parseDraggableId(active.id as string);
      if (!activeData) return;

      // Check if dropped on a dropzone (pane)
      const dropzonePaneId = parseDropzoneId(over.id as string);
      if (dropzonePaneId) {
        // Moving to a different pane (at the end)
        if (dropzonePaneId !== activeData.paneId) {
          moveTabToPane(activeData.paneId, dropzonePaneId, activeData.tabId);
        }
        return;
      }

      // Check if dropped on another tab
      const overData = parseDraggableId(over.id as string);
      if (!overData) return;

      if (activeData.paneId === overData.paneId) {
        // Same pane - reorder
        if (activeData.tabId === overData.tabId) return;

        const paneData = getPaneData(activeData.paneId);
        const oldIndex = paneData.tabs.findIndex(
          (t) => t.id === activeData.tabId
        );
        const newIndex = paneData.tabs.findIndex(
          (t) => t.id === overData.tabId
        );

        if (oldIndex !== -1 && newIndex !== -1) {
          reorderTabs(activeData.paneId, oldIndex, newIndex);
        }
      } else {
        // Different pane - move tab
        const toPaneData = getPaneData(overData.paneId);
        const toIndex = toPaneData.tabs.findIndex(
          (t) => t.id === overData.tabId
        );

        moveTabToPane(
          activeData.paneId,
          overData.paneId,
          activeData.tabId,
          toIndex !== -1 ? toIndex : undefined
        );
      }
    },
    [reorderTabs, moveTabToPane, getPaneData]
  );

  const handleDragCancel = useCallback(() => {
    setDragState({
      activeId: null,
      activePaneId: null,
      activeTabId: null,
      overPaneId: null,
    });
  }, []);

  // Memoize context value to prevent unnecessary re-renders
  const contextValue = useMemo(() => ({ dragState }), [dragState]);

  return (
    <TabDndContext.Provider value={contextValue}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {dragState.activeId && (
            <div className="bg-accent/90 text-foreground rounded-t-md px-3 py-1.5 text-xs shadow-lg">
              Dragging tab...
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </TabDndContext.Provider>
  );
}
