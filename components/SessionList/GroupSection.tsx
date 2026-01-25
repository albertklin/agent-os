"use client";

import { useState } from "react";
import { SessionCard } from "@/components/SessionCard";
import { type ForkOptions } from "@/components/ForkSessionDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  ChevronRight,
  ChevronDown,
  FolderPlus,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import type { Session, Group } from "@/lib/db";
import type { SessionStatus } from "./SessionList.types";

interface GroupSectionProps {
  groups: Group[];
  sessions: Session[];
  activeSessionId?: string;
  sessionStatuses?: Record<string, SessionStatus>;
  isForkingSession?: boolean;
  onToggleGroup: (path: string, expanded: boolean) => void;
  onCreateGroup: (name: string, parentPath?: string) => void;
  onDeleteGroup: (path: string) => void;
  onSelectSession: (sessionId: string) => void;
  onForkSession: (sessionId: string, options: ForkOptions) => Promise<void>;
  onDeleteSession: (sessionId: string, sessionName?: string) => void;
  onRenameSession: (sessionId: string, newName: string) => void;
  onRebootSession?: (sessionId: string) => void;
}

export function GroupSection({
  groups,
  sessions,
  activeSessionId,
  sessionStatuses,
  isForkingSession,
  onToggleGroup,
  onCreateGroup,
  onDeleteGroup,
  onSelectSession,
  onForkSession,
  onDeleteSession,
  onRenameSession,
  onRebootSession,
}: GroupSectionProps) {
  const [newGroupName, setNewGroupName] = useState("");
  const [showNewGroupInput, setShowNewGroupInput] = useState<string | null>(
    null
  );

  // Group sessions by group_path
  const sessionsByGroup = sessions.reduce(
    (acc, session) => {
      const path = session.group_path || "sessions";
      if (!acc[path]) acc[path] = [];
      acc[path].push(session);
      return acc;
    },
    {} as Record<string, Session[]>
  );

  // Build group hierarchy
  const rootGroups = groups.filter((g) => !g.path.includes("/"));

  // Get child groups for a parent
  const getChildGroups = (parentPath: string) => {
    return groups.filter((g) => {
      const parts = g.path.split("/");
      parts.pop();
      return parts.join("/") === parentPath;
    });
  };

  // Render a group and its contents recursively
  const renderGroup = (group: Group, level: number = 0) => {
    const groupSessions = sessionsByGroup[group.path] || [];
    const childGroups = getChildGroups(group.path);
    const indent = level * 10;

    const groupHeader = (
      <div
        className="hover:bg-accent/50 group flex cursor-pointer items-center gap-1 rounded px-2 py-1"
        style={{ marginLeft: indent }}
        onClick={() => onToggleGroup(group.path, !group.expanded)}
      >
        <button className="p-0.5">
          {group.expanded ? (
            <ChevronDown className="text-muted-foreground h-3 w-3" />
          ) : (
            <ChevronRight className="text-muted-foreground h-3 w-3" />
          )}
        </button>
        <span className="flex-1 truncate text-sm font-medium">
          {group.name}
        </span>
        <span className="text-muted-foreground text-xs">
          {groupSessions.length}
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-6 w-6 opacity-0 group-hover:opacity-100"
            >
              <MoreHorizontal className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                setShowNewGroupInput(group.path);
              }}
            >
              <FolderPlus className="mr-2 h-3 w-3" />
              Add subgroup
            </DropdownMenuItem>
            {group.path !== "sessions" && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteGroup(group.path);
                }}
                className="text-red-500"
              >
                Delete group
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );

    return (
      <div key={group.path} className="space-y-0.5">
        <ContextMenu>
          <ContextMenuTrigger asChild>{groupHeader}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => setShowNewGroupInput(group.path)}>
              <FolderPlus className="mr-2 h-3 w-3" />
              Add subgroup
            </ContextMenuItem>
            {group.path !== "sessions" && (
              <ContextMenuItem
                onClick={() => onDeleteGroup(group.path)}
                className="text-red-500 focus:text-red-500"
              >
                <Trash2 className="mr-2 h-3 w-3" />
                Delete group
              </ContextMenuItem>
            )}
          </ContextMenuContent>
        </ContextMenu>

        {showNewGroupInput === group.path && (
          <div className="flex gap-1 px-2" style={{ marginLeft: indent }}>
            <input
              type="text"
              placeholder="Group name"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newGroupName.trim()) {
                  onCreateGroup(newGroupName.trim(), group.path);
                  setNewGroupName("");
                  setShowNewGroupInput(null);
                } else if (e.key === "Escape") {
                  setNewGroupName("");
                  setShowNewGroupInput(null);
                }
              }}
              className="bg-muted/50 focus:bg-muted focus:ring-primary/50 flex-1 rounded px-2 py-1 text-sm focus:ring-1 focus:outline-none"
              autoFocus
            />
          </div>
        )}

        {group.expanded && (
          <div
            className="border-border/50 ml-2 border-l"
            style={{ marginLeft: indent + 10, paddingLeft: 6 }}
          >
            {childGroups.map((child) => renderGroup(child, level + 1))}

            {groupSessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                isForking={isForkingSession}
                tmuxStatus={sessionStatuses?.[session.id]?.status}
                toolName={sessionStatuses?.[session.id]?.toolName}
                toolDetail={sessionStatuses?.[session.id]?.toolDetail}
                setupStatus={sessionStatuses?.[session.id]?.setupStatus}
                setupError={sessionStatuses?.[session.id]?.setupError}
                lifecycleStatus={sessionStatuses?.[session.id]?.lifecycleStatus}
                stale={sessionStatuses?.[session.id]?.stale}
                groups={groups}
                onClick={() => onSelectSession(session.id)}
                onFork={async (options) => onForkSession(session.id, options)}
                onDelete={() => onDeleteSession(session.id, session.name)}
                onRename={(newName) => onRenameSession(session.id, newName)}
                onReboot={
                  onRebootSession
                    ? () => onRebootSession(session.id)
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  return <>{rootGroups.map((group) => renderGroup(group))}</>;
}
