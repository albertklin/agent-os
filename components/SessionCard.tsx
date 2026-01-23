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
  Clock,
} from "lucide-react";
import type {
  SetupStatusType,
  LifecycleStatusType,
} from "@/hooks/useStatusStream";
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

type TmuxStatus = "idle" | "running" | "waiting" | "error" | "dead" | "unknown";

interface SessionCardProps {
  session: Session;
  isActive?: boolean;
  isForking?: boolean;
  tmuxStatus?: TmuxStatus;
  /** Current tool name (e.g., "Bash", "Edit") */
  toolName?: string;
  /** Current tool detail (e.g., the command or file path) */
  toolDetail?: string;
  setupStatus?: SetupStatusType;
  setupError?: string;
  lifecycleStatus?: LifecycleStatusType;
  /** True if no status update received within the stale threshold */
  stale?: boolean;
  groups?: Group[];
  // Selection props
  isSelected?: boolean;
  isInSelectMode?: boolean;
  onToggleSelect?: (shiftKey: boolean) => void;
  // Navigation
  onClick?: () => void;
  onOpenInTab?: () => void;
  onMove?: (groupPath: string) => void;
  onFork?: (options: ForkOptions | null) => Promise<void>;
  onDelete?: () => void;
  onRename?: (newName: string) => void;
  onCreatePR?: () => void;
  onSetStatus?: (status: "idle" | "running" | "waiting") => void;
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
  init_container: { label: "Starting container...", shortLabel: "Container" },
  init_submodules: {
    label: "Initializing submodules...",
    shortLabel: "Submodules",
  },
  installing_deps: {
    label: "Installing dependencies...",
    shortLabel: "Installing",
  },
  starting_session: {
    label: "Starting session...",
    shortLabel: "Starting",
  },
  failed: { label: "Setup failed", shortLabel: "Failed" },
};

function SessionCardComponent({
  session,
  isActive,
  isForking,
  tmuxStatus,
  toolName,
  toolDetail,
  setupStatus,
  setupError,
  lifecycleStatus,
  stale,
  groups = [],
  isSelected,
  isInSelectMode,
  onToggleSelect,
  onClick,
  onOpenInTab,
  onMove,
  onFork,
  onDelete,
  onRename,
  onCreatePR,
  onSetStatus,
}: SessionCardProps) {
  const timeAgo = getTimeAgo(session.updated_at);
  const status = tmuxStatus || "dead";
  const config = statusConfig[status];

  // Check lifecycle status - use it if available, otherwise fall back to setupStatus for compatibility
  const isSettingUp =
    lifecycleStatus === "creating" ||
    (setupStatus && setupStatus !== "ready" && setupStatus !== "failed");
  const isFailed = lifecycleStatus === "failed" || setupStatus === "failed";
  const isDeleting = lifecycleStatus === "deleting";
  const setupFailed = setupStatus === "failed";
  const setupConfig =
    setupStatus && setupStatus !== "ready"
      ? setupStatusConfig[setupStatus]
      : null;
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(session.name);
  const [forkDialogOpen, setForkDialogOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // Track whether blur should close editing - only true after focus acquired and settled
  const allowBlurCloseRef = useRef(false);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      // Don't allow blur to close until focus is acquired and settled
      allowBlurCloseRef.current = false;

      // Use multiple animation frames to ensure we're past Radix's focus restoration
      // This is more reliable than setTimeout across different browsers/machines
      const focusInput = () => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (inputRef.current) {
              inputRef.current.focus();
              inputRef.current.select();
            }
            // Allow blur-based closing after focus is acquired and a delay
            // to handle any late focus restoration from Radix
            setTimeout(() => {
              allowBlurCloseRef.current = true;
            }, 300);
          });
        });
      };

      focusInput();
    }
  }, [isEditing]);

  const handleRename = (fromBlur = false) => {
    // Ignore blur events until focus has been acquired and settled
    if (fromBlur && !allowBlurCloseRef.current) return;

    if (editName.trim() && editName !== session.name && onRename) {
      onRename(editName.trim());
    }
    setIsEditing(false);
  };

  const hasActions =
    onMove ||
    onFork ||
    onDelete ||
    onRename ||
    onCreatePR ||
    onOpenInTab ||
    onSetStatus;

  // Handle card click - coordinates selection with navigation
  const handleCardClick = (e: React.MouseEvent) => {
    if (isEditing) return;

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
        {onSetStatus && (
          <MenuSub>
            <MenuSubTrigger>
              <Circle className="mr-2 h-3 w-3" />
              Set status...
            </MenuSubTrigger>
            <MenuSubContent>
              <MenuItem onClick={() => onSetStatus("idle")}>
                <Circle className="fill-muted-foreground mr-2 h-2 w-2" />
                Idle
              </MenuItem>
              <MenuItem onClick={() => onSetStatus("running")}>
                <Loader2 className="mr-2 h-3 w-3 text-blue-500" />
                Running
              </MenuItem>
              <MenuItem onClick={() => onSetStatus("waiting")}>
                <AlertCircle className="mr-2 h-3 w-3 text-yellow-500" />
                Waiting
              </MenuItem>
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
      className={cn(
        "group flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left transition-colors",
        "min-h-[36px] md:min-h-0", // Compact touch target
        "cursor-pointer",
        (isSettingUp || isDeleting) && "opacity-70",
        setupFailed && "border border-red-500/30",
        isSelected
          ? "bg-primary/20"
          : isActive
            ? "bg-primary/10"
            : isSettingUp || isDeleting
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
                isSettingUp || isDeleting
                  ? "text-blue-500"
                  : setupFailed
                    ? "text-red-500"
                    : stale && status === "running"
                      ? "text-orange-500"
                      : config.color
              )}
            >
              {isSettingUp || isDeleting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : setupFailed ? (
                <XCircle className="h-3 w-3" />
              ) : stale && status === "running" ? (
                <Clock className="h-3 w-3" />
              ) : (
                config.icon
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">
            {isDeleting ? (
              <span>Deleting session...</span>
            ) : setupConfig ? (
              <div className="flex flex-col gap-1">
                <span>{setupConfig.label}</span>
                {setupError && (
                  <span className="text-xs text-red-400">{setupError}</span>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <span className="capitalize">
                  {config.label}
                  {toolName && status === "running" && (
                    <span className="text-muted-foreground ml-1">
                      ({toolName})
                    </span>
                  )}
                </span>
                {toolDetail && status === "running" && (
                  <span className="text-muted-foreground max-w-[300px] truncate font-mono text-xs">
                    {toolDetail}
                  </span>
                )}
                {stale && status === "running" && (
                  <span className="text-xs text-orange-400">
                    No updates received recently
                  </span>
                )}
              </div>
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
          onBlur={() => handleRename(true)}
          onFocus={(e) => {
            // Re-select text when focus is gained (handles edge cases)
            e.target.select();
          }}
          onKeyDown={(e) => {
            // Stop propagation for all keys to prevent parent handlers
            // (like dnd-kit's keyboard listeners) from intercepting input
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              handleRename();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setEditName(session.name);
              setIsEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="border-primary min-w-0 flex-1 border-b bg-transparent text-sm outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm">{session.name}</span>
      )}

      {/* Branch indicator */}
      {session.branch_name && !isEditing && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="text-muted-foreground flex-shrink-0">
              <GitBranch className="h-3 w-3" />
            </div>
          </TooltipTrigger>
          <TooltipContent side="top">
            <span>{session.branch_name}</span>
          </TooltipContent>
        </Tooltip>
      )}

      {/* Fork indicator */}
      {session.parent_session_id && (
        <GitFork className="text-muted-foreground h-3 w-3 flex-shrink-0" />
      )}

      {/* Container status indicator - only for auto-approve sessions */}
      {!!session.auto_approve && session.container_status && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "flex flex-shrink-0 items-center gap-0.5 rounded px-1 text-[10px]",
                session.container_status === "ready" &&
                  "bg-green-500/20 text-green-400",
                session.container_status === "creating" &&
                  "bg-blue-500/20 text-blue-400",
                session.container_status === "failed" &&
                  "bg-red-500/20 text-red-400"
              )}
            >
              {session.container_status === "ready" ? (
                <ShieldCheck className="h-2.5 w-2.5" />
              ) : session.container_status === "failed" ? (
                <ShieldAlert className="h-2.5 w-2.5" />
              ) : session.container_status === "creating" ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <Shield className="h-2.5 w-2.5" />
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="top">
            <div className="flex flex-col gap-1">
              <span>
                Container:{" "}
                {session.container_status === "ready"
                  ? "Protected"
                  : session.container_status === "creating"
                    ? "Starting container..."
                    : "Failed"}
              </span>
              {session.container_status === "failed" && (
                <span className="text-xs text-red-400">
                  Container unavailable - recreate session
                </span>
              )}
              {session.container_health_status === "unhealthy" && (
                <span className="text-xs text-yellow-400">
                  Container may have crashed
                </span>
              )}
            </div>
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

      {/* Deleting status badge */}
      {isDeleting && (
        <span className="flex flex-shrink-0 items-center gap-0.5 rounded bg-blue-500/20 px-1 text-[10px] text-blue-400">
          Deleting
        </span>
      )}

      {/* Time ago - hide when setting up or deleting */}
      {!setupConfig && !isDeleting && (
        <span className="text-muted-foreground hidden flex-shrink-0 text-[10px] group-hover:hidden sm:block">
          {timeAgo}
        </span>
      )}

      {/* Actions menu (button) */}
      {hasActions && (
        <DropdownMenu modal={false}>
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
      sessionName={session.name}
      workingDirectory={session.working_directory}
      projectId={session.project_id || null}
      parentWorktreePath={session.worktree_path}
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
        <ContextMenu modal={false}>
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
  if (prev.session.container_status !== next.session.container_status)
    return false;
  if (
    prev.session.container_health_status !==
    next.session.container_health_status
  )
    return false;
  if (prev.tmuxStatus !== next.tmuxStatus) return false;
  if (prev.toolName !== next.toolName) return false;
  if (prev.toolDetail !== next.toolDetail) return false;
  if (prev.setupStatus !== next.setupStatus) return false;
  if (prev.setupError !== next.setupError) return false;
  if (prev.lifecycleStatus !== next.lifecycleStatus) return false;
  if (prev.stale !== next.stale) return false;
  if (prev.isActive !== next.isActive) return false;
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.isInSelectMode !== next.isInSelectMode) return false;
  if (prev.isForking !== next.isForking) return false;

  // Groups are used for menu rendering
  // We do a shallow length check as a proxy for changes
  if ((prev.groups?.length || 0) !== (next.groups?.length || 0)) return false;

  return true;
});
