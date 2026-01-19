"use client";

import React, { useState, useRef, useEffect, memo } from "react";
import { cn } from "@/lib/utils";
import {
  GitFork,
  GitBranch,
  GitPullRequest,
  Circle,
  AlertCircle,
  Loader2,
  MoreHorizontal,
  FolderInput,
  Trash2,
  Copy,
  Pencil,
  Square,
  CheckSquare,
  ExternalLink,
  XCircle,
  Shield,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type { SetupStatusType } from "@/hooks/useStatusStream";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { ForkSessionDialog, type ForkOptions } from "./ForkSessionDialog";
import type { Session, Group } from "@/lib/db";
import type { ProjectWithDevServers } from "@/lib/projects";

type TmuxStatus = "idle" | "running" | "waiting" | "error" | "dead" | "unknown";

interface SessionCardProps {
  session: Session;
  isActive?: boolean;
  isForking?: boolean;
  tmuxStatus?: TmuxStatus;
  setupStatus?: SetupStatusType;
  setupError?: string;
  groups?: Group[];
  projects?: ProjectWithDevServers[];
  // Selection props
  isSelected?: boolean;
  isInSelectMode?: boolean;
  onToggleSelect?: (shiftKey: boolean) => void;
  // Navigation
  onClick?: () => void;
  onOpenInTab?: () => void;
  onMove?: (groupPath: string) => void;
  onMoveToProject?: (projectId: string) => void;
  onFork?: (options: ForkOptions | null) => Promise<void>;
  onDelete?: () => void;
  onRename?: (newName: string) => void;
  onCreatePR?: () => void;
  onHoverStart?: (rect: DOMRect) => void;
  onHoverEnd?: () => void;
}

const statusConfig: Record<
  TmuxStatus,
  { color: string; label: string; icon: React.ReactNode }
> = {
  idle: {
    color: "text-muted-foreground",
    label: "idle",
    icon: <Circle className="h-2 w-2 fill-current" />,
  },
  running: {
    color: "text-blue-500",
    label: "running",
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
  },
  waiting: {
    color: "text-yellow-500 animate-pulse",
    label: "waiting",
    icon: <AlertCircle className="h-3 w-3" />,
  },
  error: {
    color: "text-red-500",
    label: "error",
    icon: <Circle className="h-2 w-2 fill-current" />,
  },
  dead: {
    color: "text-muted-foreground/50",
    label: "stopped",
    icon: <Circle className="h-2 w-2" />,
  },
  unknown: {
    color: "text-muted-foreground/30",
    label: "no status - hooks not configured",
    icon: (
      <Circle
        className="h-2 w-2 stroke-current stroke-1"
        strokeDasharray="2 2"
      />
    ),
  },
};

const setupStatusConfig: Record<
  Exclude<SetupStatusType, "ready">,
  { label: string; shortLabel: string }
> = {
  pending: { label: "Setting up...", shortLabel: "Setup" },
  creating_worktree: { label: "Creating worktree...", shortLabel: "Worktree" },
  init_submodules: { label: "Initializing submodules...", shortLabel: "Submodules" },
  installing_deps: { label: "Installing dependencies...", shortLabel: "Installing" },
  failed: { label: "Setup failed", shortLabel: "Failed" },
};

function SessionCardComponent({
  session,
  isActive,
  isForking,
  tmuxStatus,
  setupStatus,
  setupError,
  groups = [],
  projects = [],
  isSelected,
  isInSelectMode,
  onToggleSelect,
  onClick,
  onOpenInTab,
  onMove,
  onMoveToProject,
  onFork,
  onDelete,
  onRename,
  onCreatePR,
  onHoverStart,
  onHoverEnd,
}: SessionCardProps) {
  const timeAgo = getTimeAgo(session.updated_at);
  const status = tmuxStatus || "dead";
  const config = statusConfig[status];

  // Check if session is still setting up
  const isSettingUp =
    setupStatus && setupStatus !== "ready" && setupStatus !== "failed";
  const setupFailed = setupStatus === "failed";
  const setupConfig =
    setupStatus && setupStatus !== "ready"
      ? setupStatusConfig[setupStatus]
      : null;
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(session.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [forkDialogOpen, setForkDialogOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const justStartedEditingRef = useRef(false);

  const handleMouseEnter = () => {
    if (!onHoverStart || !cardRef.current || menuOpen) return;
    // Debounce hover to avoid flickering
    hoverTimeoutRef.current = setTimeout(() => {
      if (cardRef.current && !menuOpen) {
        onHoverStart(cardRef.current.getBoundingClientRect());
      }
    }, 300);
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    onHoverEnd?.();
  };

  const handleMenuOpenChange = (open: boolean) => {
    setMenuOpen(open);
    if (open) {
      // Cancel hover preview when menu opens
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = null;
      }
      onHoverEnd?.();
    }
  };

  useEffect(() => {
    if (isEditing && inputRef.current) {
      const input = inputRef.current;
      // Mark that we just started editing to ignore immediate blur
      justStartedEditingRef.current = true;
      // Small timeout to ensure input is fully mounted
      setTimeout(() => {
        input.focus();
        input.select();
        // Clear the flag after focus is established
        setTimeout(() => {
          justStartedEditingRef.current = false;
        }, 100);
      }, 0);
    }
  }, [isEditing]);

  const handleRename = () => {
    // Ignore blur events that happen immediately after starting to edit
    if (justStartedEditingRef.current) return;

    if (editName.trim() && editName !== session.name && onRename) {
      onRename(editName.trim());
    }
    setIsEditing(false);
  };

  const hasActions =
    onMove ||
    onMoveToProject ||
    onFork ||
    onDelete ||
    onRename ||
    onCreatePR ||
    onOpenInTab;

  // Handle card click - coordinates selection with navigation
  const handleCardClick = (e: React.MouseEvent) => {
    if (isEditing) return;

    // Don't allow clicking if session is still setting up
    if (isSettingUp) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // If in select mode (any items selected), any click toggles selection
    if (isInSelectMode && onToggleSelect) {
      e.preventDefault();
      e.stopPropagation();
      onToggleSelect(e.shiftKey);
      return;
    }

    // Not in select mode - shift+click starts selection
    if (e.shiftKey && onToggleSelect) {
      e.preventDefault();
      e.stopPropagation();
      onToggleSelect(false);
      return;
    }

    // Normal click - navigate to session
    onClick?.();
  };

  // Handle checkbox click
  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleSelect?.(e.shiftKey);
  };

  // Shared menu items renderer for both context menu and dropdown
  const renderMenuItems = (isContextMenu: boolean) => {
    const MenuItem = isContextMenu ? ContextMenuItem : DropdownMenuItem;
    const MenuSeparator = isContextMenu
      ? ContextMenuSeparator
      : DropdownMenuSeparator;
    const MenuSub = isContextMenu ? ContextMenuSub : DropdownMenuSub;
    const MenuSubTrigger = isContextMenu
      ? ContextMenuSubTrigger
      : DropdownMenuSubTrigger;
    const MenuSubContent = isContextMenu
      ? ContextMenuSubContent
      : DropdownMenuSubContent;

    return (
      <>
        {/* Branch info for worktree sessions */}
        {session.branch_name && (
          <>
            <div className="text-muted-foreground flex items-center gap-2 px-2 py-1.5 text-xs">
              <GitBranch className="h-3 w-3" />
              <span className="truncate">{session.branch_name}</span>
            </div>
            <MenuSeparator />
          </>
        )}
        {onOpenInTab && (
          <MenuItem onClick={() => onOpenInTab()}>
            <ExternalLink className="mr-2 h-3 w-3" />
            Open in new tab
          </MenuItem>
        )}
        {onRename && (
          <MenuItem onClick={() => setIsEditing(true)}>
            <Pencil className="mr-2 h-3 w-3" />
            Rename
          </MenuItem>
        )}
        {onFork && session.agent_type === "claude" && (
          <MenuItem onClick={() => setForkDialogOpen(true)}>
            <Copy className="mr-2 h-3 w-3" />
            Fork session
          </MenuItem>
        )}
        {onCreatePR && session.branch_name && (
          <MenuItem
            onClick={() => {
              if (session.pr_url) {
                window.open(session.pr_url, "_blank");
              } else {
                onCreatePR();
              }
            }}
          >
            <GitPullRequest className="mr-2 h-3 w-3" />
            {session.pr_url ? "Open PR" : "Create PR"}
          </MenuItem>
        )}
        {onMoveToProject && projects.length > 0 && (
          <MenuSub>
            <MenuSubTrigger>
              <FolderInput className="mr-2 h-3 w-3" />
              Move to project...
            </MenuSubTrigger>
            <MenuSubContent>
              {projects
                .filter((p) => p.id !== session.project_id)
                .map((project) => (
                  <MenuItem
                    key={project.id}
                    onClick={() => onMoveToProject(project.id)}
                  >
                    {project.name}
                  </MenuItem>
                ))}
            </MenuSubContent>
          </MenuSub>
        )}
        {onMove && groups.length > 0 && (
          <MenuSub>
            <MenuSubTrigger>
              <FolderInput className="mr-2 h-3 w-3" />
              Move to group...
            </MenuSubTrigger>
            <MenuSubContent>
              {groups
                .filter((g) => g.path !== session.group_path)
                .map((group) => (
                  <MenuItem key={group.path} onClick={() => onMove(group.path)}>
                    {group.name}
                  </MenuItem>
                ))}
            </MenuSubContent>
          </MenuSub>
        )}
        {onDelete && (
          <>
            <MenuSeparator />
            <MenuItem
              onClick={() => onDelete()}
              className="text-red-500 focus:text-red-500"
            >
              <Trash2 className="mr-2 h-3 w-3" />
              Delete session
            </MenuItem>
          </>
        )}
      </>
    );
  };

  const cardContent = (
    <div
      ref={cardRef}
      onClick={handleCardClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={cn(
        "group flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left transition-colors",
        "min-h-[36px] md:min-h-0", // Compact touch target
        isSettingUp ? "cursor-wait opacity-70" : "cursor-pointer",
        setupFailed && "border-red-500/30 border",
        isSelected
          ? "bg-primary/20"
          : isActive
            ? "bg-primary/10"
            : isSettingUp
              ? "bg-muted/50"
              : "hover:bg-accent/50",
        status === "waiting" && !isActive && !isSelected && "bg-yellow-500/5"
      )}
    >
      {/* Selection checkbox - visible when in select mode */}
      {isInSelectMode && onToggleSelect && (
        <button
          onClick={handleCheckboxClick}
          className="text-primary hover:text-primary/80 flex-shrink-0"
        >
          {isSelected ? (
            <CheckSquare className="h-4 w-4" />
          ) : (
            <Square className="h-4 w-4" />
          )}
        </button>
      )}

      {/* Status indicator - show setup status if setting up, otherwise normal status */}
      {!isInSelectMode && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "flex-shrink-0",
                isSettingUp
                  ? "text-blue-500"
                  : setupFailed
                    ? "text-red-500"
                    : config.color
              )}
            >
              {isSettingUp ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : setupFailed ? (
                <XCircle className="h-3 w-3" />
              ) : (
                config.icon
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">
            {setupConfig ? (
              <div className="flex flex-col gap-1">
                <span>{setupConfig.label}</span>
                {setupError && (
                  <span className="text-red-400 text-xs">{setupError}</span>
                )}
              </div>
            ) : (
              <span className="capitalize">{config.label}</span>
            )}
          </TooltipContent>
        </Tooltip>
      )}

      {/* Session name */}
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleRename();
            if (e.key === "Escape") {
              setEditName(session.name);
              setIsEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
          className="border-primary min-w-0 flex-1 border-b bg-transparent text-sm outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm">{session.name}</span>
      )}

      {/* Fork indicator */}
      {session.parent_session_id && (
        <GitFork className="text-muted-foreground h-3 w-3 flex-shrink-0" />
      )}

      {/* Sandbox status indicator - only for auto-approve sessions */}
      {session.auto_approve && session.sandbox_status && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "flex flex-shrink-0 items-center gap-0.5 rounded px-1 text-[10px]",
                session.sandbox_status === "ready" &&
                  "bg-green-500/20 text-green-400",
                session.sandbox_status === "initializing" &&
                  "bg-blue-500/20 text-blue-400",
                session.sandbox_status === "pending" &&
                  "bg-yellow-500/20 text-yellow-400",
                session.sandbox_status === "failed" &&
                  "bg-red-500/20 text-red-400"
              )}
            >
              {session.sandbox_status === "ready" ? (
                <ShieldCheck className="h-2.5 w-2.5" />
              ) : session.sandbox_status === "failed" ? (
                <ShieldAlert className="h-2.5 w-2.5" />
              ) : session.sandbox_status === "initializing" ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <Shield className="h-2.5 w-2.5" />
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="top">
            <span>
              Sandbox:{" "}
              {session.sandbox_status === "ready"
                ? "Protected"
                : session.sandbox_status === "initializing"
                  ? "Starting container..."
                  : session.sandbox_status === "pending"
                    ? "Pending"
                    : "Failed"}
            </span>
          </TooltipContent>
        </Tooltip>
      )}

      {/* TODO: Show port indicator once auto dev server management is implemented.
          Each worktree gets a unique port (3100, 3110, etc.) for running dev servers.
          See lib/ports.ts and ideas.md for the planned feature. */}

      {/* PR status badge */}
      {session.pr_status && (
        <a
          href={session.pr_url || "#"}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "flex flex-shrink-0 items-center gap-0.5 rounded px-1 text-[10px]",
            session.pr_status === "open" && "bg-green-500/20 text-green-400",
            session.pr_status === "merged" &&
              "bg-purple-500/20 text-purple-400",
            session.pr_status === "closed" && "bg-red-500/20 text-red-400"
          )}
          title={`PR #${session.pr_number}: ${session.pr_status}`}
        >
          <GitPullRequest className="h-2.5 w-2.5" />
          <span>
            {session.pr_status === "merged"
              ? "M"
              : session.pr_status === "closed"
                ? "X"
                : "O"}
          </span>
        </a>
      )}

      {/* Setup status badge */}
      {setupConfig && (
        <span
          className={cn(
            "flex flex-shrink-0 items-center gap-0.5 rounded px-1 text-[10px]",
            setupFailed
              ? "bg-red-500/20 text-red-400"
              : "bg-blue-500/20 text-blue-400"
          )}
        >
          {setupConfig.shortLabel}
        </span>
      )}

      {/* Time ago - hide when setting up */}
      {!setupConfig && (
        <span className="text-muted-foreground hidden flex-shrink-0 text-[10px] group-hover:hidden sm:block">
          {timeAgo}
        </span>
      )}

      {/* Actions menu (button) */}
      {hasActions && (
        <DropdownMenu onOpenChange={handleMenuOpenChange}>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-6 w-6 flex-shrink-0 opacity-100 md:h-5 md:w-5 md:opacity-0 md:group-hover:opacity-100"
            >
              <MoreHorizontal className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            {renderMenuItems(false)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );

  const forkDialog = onFork && (
    <ForkSessionDialog
      sessionId={session.id}
      sessionName={session.name}
      defaultBaseBranch={session.base_branch || "main"}
      open={forkDialogOpen}
      onOpenChange={setForkDialogOpen}
      onFork={onFork}
      isPending={isForking}
    />
  );

  // Wrap with context menu if actions are available
  if (hasActions) {
    return (
      <>
        <ContextMenu>
          <ContextMenuTrigger asChild>{cardContent}</ContextMenuTrigger>
          <ContextMenuContent>{renderMenuItems(true)}</ContextMenuContent>
        </ContextMenu>
        {forkDialog}
      </>
    );
  }

  return (
    <>
      {cardContent}
      {forkDialog}
    </>
  );
}

function getTimeAgo(dateStr: string): string {
  const date = new Date(dateStr + "Z"); // Assume UTC
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

/**
 * Memoized SessionCard to prevent unnecessary re-renders
 * Only re-renders when:
 * - session.id, session.name, session.updated_at changes
 * - tmuxStatus, setupStatus, setupError changes
 * - isActive, isSelected, isInSelectMode, isForking changes
 * - groups or projects array references change (for menu rendering)
 */
export const SessionCard = memo(SessionCardComponent, (prev, next) => {
  // Check primitive props that matter for rendering
  if (prev.session.id !== next.session.id) return false;
  if (prev.session.name !== next.session.name) return false;
  if (prev.session.updated_at !== next.session.updated_at) return false;
  if (prev.session.pr_status !== next.session.pr_status) return false;
  if (prev.session.branch_name !== next.session.branch_name) return false;
  if (prev.session.sandbox_status !== next.session.sandbox_status) return false;
  if (prev.tmuxStatus !== next.tmuxStatus) return false;
  if (prev.setupStatus !== next.setupStatus) return false;
  if (prev.setupError !== next.setupError) return false;
  if (prev.isActive !== next.isActive) return false;
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.isInSelectMode !== next.isInSelectMode) return false;
  if (prev.isForking !== next.isForking) return false;

  // Groups and projects are used for menu rendering
  // We do a shallow length check as a proxy for changes
  if ((prev.groups?.length || 0) !== (next.groups?.length || 0)) return false;
  if ((prev.projects?.length || 0) !== (next.projects?.length || 0))
    return false;

  return true;
});
