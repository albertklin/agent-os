"use client";

import { useCallback } from "react";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import {
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
  Plus,
  FolderOpen,
  GitBranch,
  Home,
  Zap,
  SkipForward,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Session } from "@/lib/db";
import {
  createDraggableId,
  createDropzoneId,
  useTabDnd,
} from "@/contexts/TabDndContext";

type ViewMode = "terminal" | "files" | "git";

interface Tab {
  id: string;
  sessionId: string | null;
  isQuickRespond?: boolean;
}

interface DesktopTabBarProps {
  paneId: string;
  tabs: Tab[];
  activeTabId: string;
  session: Session | null | undefined;
  sessions: Session[];
  sessionStatuses?: Record<string, { status: string }>;
  viewMode: ViewMode;
  isFocused: boolean;
  canSplit: boolean;
  canClose: boolean;
  gitDrawerOpen: boolean;
  shellDrawerOpen: boolean;
  onTabSwitch: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onTabAdd: () => void;
  onViewModeChange: (mode: ViewMode) => void;
  onGitDrawerToggle: () => void;
  onShellDrawerToggle: () => void;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  onClose: () => void;
  onDeferSession?: (sessionId: string) => Promise<void>;
}

// Sortable tab component
interface SortableTabProps {
  paneId: string;
  tab: Tab;
  isActive: boolean;
  tabName: string;
  canClose: boolean;
  waitingCount?: number;
  onSwitch: () => void;
  onClose: () => void;
  onDefer?: () => void;
}

function SortableTab({
  paneId,
  tab,
  isActive,
  tabName,
  canClose,
  waitingCount,
  onSwitch,
  onClose,
  onDefer,
}: SortableTabProps) {
  const draggableId = createDraggableId(paneId, tab.id);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: draggableId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        e.stopPropagation();
        onSwitch();
      }}
      className={cn(
        "group flex cursor-grab items-center gap-1.5 rounded-t-md px-3 py-1.5 text-xs transition-colors active:cursor-grabbing",
        isActive
          ? "bg-background text-foreground"
          : "text-muted-foreground hover:text-foreground/80 hover:bg-accent/50"
      )}
    >
      {/* Quick respond indicator */}
      {tab.isQuickRespond && (
        <span className="flex items-center gap-1 text-yellow-500">
          <Zap className="h-3 w-3" />
          {waitingCount !== undefined && waitingCount > 0 && (
            <span className="text-xs font-medium">{waitingCount}</span>
          )}
        </span>
      )}
      <span className="max-w-[120px] truncate">{tabName}</span>
      {/* Defer button for quick respond tabs */}
      {tab.isQuickRespond && onDefer && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDefer();
              }}
              className="text-muted-foreground hover:text-foreground ml-1"
            >
              <SkipForward className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Skip (handle later)</TooltipContent>
        </Tooltip>
      )}
      {canClose && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="hover:text-foreground ml-1 opacity-0 group-hover:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export function DesktopTabBar({
  paneId,
  tabs,
  activeTabId,
  session,
  sessions,
  sessionStatuses = {},
  viewMode,
  isFocused,
  canSplit,
  canClose,
  gitDrawerOpen,
  shellDrawerOpen,
  onTabSwitch,
  onTabClose,
  onTabAdd,
  onViewModeChange,
  onGitDrawerToggle,
  onShellDrawerToggle,
  onSplitHorizontal,
  onSplitVertical,
  onClose,
  onDeferSession,
}: DesktopTabBarProps) {
  const { dragState } = useTabDnd();
  const isDraggingOverThis =
    dragState.overPaneId === paneId && dragState.activePaneId !== paneId;

  // Make the tab bar a drop zone for cross-pane drops
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: createDropzoneId(paneId),
  });

  // Calculate waiting count for quick respond tabs
  const waitingCount = sessions.filter(
    (s) => sessionStatuses[s.id]?.status === "waiting"
  ).length;

  const getTabName = useCallback(
    (tab: Tab) => {
      if (tab.isQuickRespond) {
        return "Quick Respond";
      }
      if (tab.sessionId) {
        const s = sessions.find((sess) => sess.id === tab.sessionId);
        return s?.name || "Session";
      }
      return "Shell";
    },
    [sessions]
  );

  // Create sortable IDs for this pane's tabs
  const sortableIds = tabs.map((t) => createDraggableId(paneId, t.id));

  return (
    <div
      ref={setDroppableRef}
      className={cn(
        "flex items-center gap-1 overflow-x-auto px-1 pt-1 transition-colors",
        isFocused
          ? "bg-muted border-primary/50 border-b-2"
          : "bg-muted/50 border-b-2 border-transparent",
        (isDraggingOverThis || isOver) && "ring-primary/50 ring-2 ring-inset"
      )}
    >
      {/* Tabs */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5">
        <SortableContext
          items={sortableIds}
          strategy={horizontalListSortingStrategy}
        >
          {tabs.map((tab) => (
            <SortableTab
              key={tab.id}
              paneId={paneId}
              tab={tab}
              isActive={tab.id === activeTabId}
              tabName={getTabName(tab)}
              canClose={true}
              waitingCount={tab.isQuickRespond ? waitingCount : undefined}
              onSwitch={() => onTabSwitch(tab.id)}
              onClose={() => onTabClose(tab.id)}
              onDefer={
                tab.isQuickRespond && tab.sessionId && onDeferSession
                  ? () => onDeferSession(tab.sessionId!)
                  : undefined
              }
            />
          ))}
        </SortableContext>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => {
                e.stopPropagation();
                onTabAdd();
              }}
              className="mx-1 h-6 w-6"
            >
              <Plus className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New tab</TooltipContent>
        </Tooltip>
      </div>

      {/* View Toggle */}
      {session?.working_directory && (
        <div className="bg-accent/50 mx-2 flex items-center rounded-md p-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onViewModeChange("terminal");
                }}
                className={cn(
                  "rounded px-2 py-1 transition-colors",
                  viewMode === "terminal"
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Home className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Terminal</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onViewModeChange("files");
                }}
                className={cn(
                  "rounded px-2 py-1 transition-colors",
                  viewMode === "files"
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Files</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onGitDrawerToggle();
                }}
                className={cn(
                  "rounded px-2 py-1 transition-colors",
                  gitDrawerOpen
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Git</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onShellDrawerToggle();
                }}
                className={cn(
                  "rounded px-2 py-1 font-mono text-xs transition-colors",
                  shellDrawerOpen
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {">_"}
              </button>
            </TooltipTrigger>
            <TooltipContent>Shell</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Pane Controls */}
      <div className="ml-auto flex items-center gap-0.5 px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => {
                e.stopPropagation();
                onSplitHorizontal();
              }}
              disabled={!canSplit}
              className="h-6 w-6"
            >
              <SplitSquareHorizontal className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Split horizontal</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => {
                e.stopPropagation();
                onSplitVertical();
              }}
              disabled={!canSplit}
              className="h-6 w-6"
            >
              <SplitSquareVertical className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Split vertical</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              disabled={!canClose}
              className="h-6 w-6"
            >
              <X className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close pane</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
