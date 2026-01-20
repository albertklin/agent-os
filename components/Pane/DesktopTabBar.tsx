"use client";

import { useCallback } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import {
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
  Unplug,
  Plus,
  FolderOpen,
  GitBranch,
  Home,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Session } from "@/lib/db";

type ViewMode = "terminal" | "files" | "git";

interface Tab {
  id: string;
  sessionId: string | null;
  attachedTmux: string | null;
}

interface DesktopTabBarProps {
  tabs: Tab[];
  activeTabId: string;
  session: Session | null | undefined;
  sessions: Session[];
  viewMode: ViewMode;
  isFocused: boolean;
  canSplit: boolean;
  canClose: boolean;
  hasAttachedTmux: boolean;
  gitDrawerOpen: boolean;
  shellDrawerOpen: boolean;
  onTabSwitch: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onTabAdd: () => void;
  onReorderTabs: (fromIndex: number, toIndex: number) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onGitDrawerToggle: () => void;
  onShellDrawerToggle: () => void;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  onClose: () => void;
  onDetach: () => void;
}

// Sortable tab component
interface SortableTabProps {
  tab: Tab;
  isActive: boolean;
  tabName: string;
  canClose: boolean;
  onSwitch: () => void;
  onClose: () => void;
}

function SortableTab({
  tab,
  isActive,
  tabName,
  canClose,
  onSwitch,
  onClose,
}: SortableTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id });

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
      <span className="max-w-[120px] truncate">{tabName}</span>
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
  tabs,
  activeTabId,
  session,
  sessions,
  viewMode,
  isFocused,
  canSplit,
  canClose,
  hasAttachedTmux,
  gitDrawerOpen,
  shellDrawerOpen,
  onTabSwitch,
  onTabClose,
  onTabAdd,
  onReorderTabs,
  onViewModeChange,
  onGitDrawerToggle,
  onShellDrawerToggle,
  onSplitHorizontal,
  onSplitVertical,
  onClose,
  onDetach,
}: DesktopTabBarProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Require 8px of movement before starting drag
      },
    })
  );

  const getTabName = useCallback(
    (tab: Tab) => {
      if (tab.sessionId) {
        const s = sessions.find((sess) => sess.id === tab.sessionId);
        return s?.name || tab.attachedTmux || "Session";
      }
      if (tab.attachedTmux) return tab.attachedTmux;
      return "New Tab";
    },
    [sessions]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = tabs.findIndex((t) => t.id === active.id);
      const newIndex = tabs.findIndex((t) => t.id === over.id);

      if (oldIndex !== -1 && newIndex !== -1) {
        onReorderTabs(oldIndex, newIndex);
      }
    },
    [tabs, onReorderTabs]
  );

  return (
    <div
      className={cn(
        "flex items-center gap-1 overflow-x-auto px-1 pt-1 transition-colors",
        isFocused ? "bg-muted" : "bg-muted/50"
      )}
    >
      {/* Tabs */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={tabs.map((t) => t.id)}
            strategy={horizontalListSortingStrategy}
          >
            {tabs.map((tab) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                isActive={tab.id === activeTabId}
                tabName={getTabName(tab)}
                canClose={tabs.length > 1}
                onSwitch={() => onTabSwitch(tab.id)}
                onClose={() => onTabClose(tab.id)}
              />
            ))}
          </SortableContext>
        </DndContext>
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
        {hasAttachedTmux && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onDetach();
                }}
                className="h-6 w-6"
              >
                <Unplug className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Detach from tmux</TooltipContent>
          </Tooltip>
        )}
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
