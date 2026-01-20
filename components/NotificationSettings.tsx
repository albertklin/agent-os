"use client";

import { useEffect, useState } from "react";
import {
  Bell,
  Volume2,
  VolumeX,
  AlertCircle,
  Zap,
  Smartphone,
} from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { NotificationSettings as NotificationSettingsType } from "@/lib/notifications";

interface WaitingSession {
  id: string;
  name: string;
}

interface NotificationSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: NotificationSettingsType;
  permissionGranted: boolean;
  waitingSessions?: WaitingSession[];
  onUpdateSettings: (settings: Partial<NotificationSettingsType>) => void;
  onRequestPermission: () => Promise<boolean>;
  onSelectSession?: (id: string) => void;
  onOpenQuickRespond?: () => void;
}

export function NotificationSettings({
  open,
  onOpenChange,
  settings,
  permissionGranted,
  waitingSessions = [],
  onUpdateSettings,
  onRequestPermission,
  onSelectSession,
  onOpenQuickRespond,
}: NotificationSettingsProps) {
  const waitingCount = waitingSessions.length;
  const [pushEnabled, setPushEnabled] = useState<boolean | null>(null);

  // Fetch push notification status
  useEffect(() => {
    fetch("/api/notifications/push")
      .then((res) => res.json())
      .then((data) => setPushEnabled(data.enabled))
      .catch(() => setPushEnabled(null));
  }, []);

  const togglePushNotifications = async () => {
    if (pushEnabled === null) return;
    const newState = !pushEnabled;
    setPushEnabled(newState);
    try {
      await fetch("/api/notifications/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: newState }),
      });
    } catch {
      // Revert on error
      setPushEnabled(!newState);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative">
          <Bell
            className={cn(
              "h-4 w-4",
              !settings.sound && "text-muted-foreground"
            )}
          />
          {waitingCount > 0 && (
            <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-yellow-500 text-[10px] font-bold text-yellow-950">
              {waitingCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {/* Waiting sessions section */}
        {waitingCount > 0 && (
          <>
            <DropdownMenuLabel className="flex items-center gap-2 text-xs text-yellow-500">
              <AlertCircle className="h-3 w-3" />
              Waiting for input
            </DropdownMenuLabel>
            {onOpenQuickRespond && (
              <DropdownMenuItem
                onClick={() => {
                  onOpenQuickRespond();
                  onOpenChange(false);
                }}
                className="text-sm font-medium"
              >
                <Zap className="mr-2 h-3 w-3 text-yellow-500" />
                Quick Respond ({waitingCount})
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {waitingSessions.map((session) => (
              <DropdownMenuItem
                key={session.id}
                onClick={() => {
                  onSelectSession?.(session.id);
                  onOpenChange(false);
                }}
                className="text-sm"
              >
                {session.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}

        {/* Sound toggle */}
        <DropdownMenuItem
          onClick={() => onUpdateSettings({ sound: !settings.sound })}
          className="flex items-center justify-between"
        >
          <span className="flex items-center gap-2">
            {settings.sound ? (
              <Volume2 className="h-3 w-3" />
            ) : (
              <VolumeX className="text-muted-foreground h-3 w-3" />
            )}
            Sound
          </span>
          <span
            className={cn(
              "relative h-4 w-8 rounded-full transition-colors",
              settings.sound ? "bg-primary" : "bg-muted"
            )}
          >
            <span
              className={cn(
                "bg-background absolute top-0.5 h-3 w-3 rounded-full transition-transform",
                settings.sound ? "translate-x-4" : "translate-x-0.5"
              )}
            />
          </span>
        </DropdownMenuItem>

        {/* Push notifications toggle */}
        {pushEnabled !== null && (
          <DropdownMenuItem
            onClick={togglePushNotifications}
            className="flex items-center justify-between"
          >
            <span className="flex items-center gap-2">
              <Smartphone
                className={cn(
                  "h-3 w-3",
                  !pushEnabled && "text-muted-foreground"
                )}
              />
              Push
            </span>
            <span
              className={cn(
                "relative h-4 w-8 rounded-full transition-colors",
                pushEnabled ? "bg-primary" : "bg-muted"
              )}
            >
              <span
                className={cn(
                  "bg-background absolute top-0.5 h-3 w-3 rounded-full transition-transform",
                  pushEnabled ? "translate-x-4" : "translate-x-0.5"
                )}
              />
            </span>
          </DropdownMenuItem>
        )}

        {/* Browser notifications - only show if not granted */}
        {!permissionGranted && (
          <DropdownMenuItem
            onClick={async () => {
              await onRequestPermission();
            }}
          >
            <Bell className="mr-2 h-3 w-3" />
            <span className="text-xs">Enable browser alerts</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
