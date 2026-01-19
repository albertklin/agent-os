import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Plus,
  FolderPlus,
  FolderOpen,
  MoreHorizontal,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConnectionStatus } from "@/hooks/useStatusStream";

interface SessionListHeaderProps {
  onNewProject: () => void;
  onOpenProject: () => void;
  onKillAll: () => void;
  connectionStatus?: ConnectionStatus;
}

export function SessionListHeader({
  onNewProject,
  onOpenProject,
  onKillAll,
  connectionStatus = "connecting",
}: SessionListHeaderProps) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <div className="flex items-center gap-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          className="h-5 w-5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        >
          <path d="M12 8V4H8" />
          <rect width="16" height="12" x="4" y="8" rx="2" />
          <path d="M2 14h2" />
          <path d="M20 14h2" />
          <path d="M15 13v2" />
          <path d="M9 13v2" />
        </svg>
        <h2 className="font-semibold">AgentOS</h2>
        {/* SSE Connection Status Indicator */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "flex h-4 w-4 items-center justify-center",
                connectionStatus === "connected" && "text-green-500",
                connectionStatus === "connecting" && "text-yellow-500",
                connectionStatus === "disconnected" && "text-red-500"
              )}
            >
              {connectionStatus === "connected" ? (
                <Wifi className="h-3 w-3" />
              ) : connectionStatus === "connecting" ? (
                <Wifi className="h-3 w-3 animate-pulse" />
              ) : (
                <WifiOff className="h-3 w-3" />
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {connectionStatus === "connected" && "Real-time updates active"}
            {connectionStatus === "connecting" && "Connecting to status stream..."}
            {connectionStatus === "disconnected" && "Disconnected - reconnecting..."}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex gap-1">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm">
                  <Plus className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>New project</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onNewProject}>
              <FolderPlus className="mr-2 h-3 w-3" />
              New Project
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenProject}>
              <FolderOpen className="mr-2 h-3 w-3" />
              Open Project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>More options</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={onKillAll}
              className="text-red-500 focus:text-red-500"
            >
              <Trash2 className="mr-2 h-3 w-3" />
              Kill all sessions
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
