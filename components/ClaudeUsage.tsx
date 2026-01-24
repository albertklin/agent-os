"use client";

import {
  useClaudeUsage,
  formatTimeUntilReset,
  formatTimeSinceRefresh,
} from "@/hooks/useClaudeUsage";
import { Sparkles } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface UsageItemProps {
  label: string;
  value: number;
  detail?: string;
}

function UsageItem({ label, value, detail }: UsageItemProps) {
  // Color based on usage level
  const getColor = (pct: number) => {
    if (pct >= 90) return "text-red-500";
    if (pct >= 70) return "text-yellow-500";
    return "text-muted-foreground/60";
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex cursor-default items-center gap-0.5">
          <span className={`font-mono text-[11px] ${getColor(value)}`}>
            {label}:
          </span>
          <span className={`font-mono text-[11px] ${getColor(value)}`}>
            {value}%
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="font-medium">{label} Usage</p>
        {detail && <p className="text-muted-foreground text-xs">{detail}</p>}
      </TooltipContent>
    </Tooltip>
  );
}

export function ClaudeUsage() {
  const { usage, error, isLoading, lastRefresh } = useClaudeUsage({
    interval: 60000,
  });

  // Don't show anything while loading or on error
  if (isLoading || error || !usage) {
    return null;
  }

  // Don't show if we have no usage data
  if (!usage.fiveHour && !usage.sevenDay) {
    return null;
  }

  const refreshInfo = lastRefresh
    ? `Updated ${formatTimeSinceRefresh(lastRefresh)}`
    : "";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="border-border/40 mr-3 flex cursor-default items-center gap-2 border-r pr-3">
          <Sparkles className="text-muted-foreground/60 h-3 w-3" />
          {usage.fiveHour && (
            <UsageItem
              label="5h"
              value={usage.fiveHour.utilization}
              detail={`Resets in ${formatTimeUntilReset(usage.fiveHour.resetsAt)}`}
            />
          )}
          {usage.sevenDay && (
            <UsageItem
              label="7d"
              value={usage.sevenDay.utilization}
              detail={`Resets in ${formatTimeUntilReset(usage.sevenDay.resetsAt)}`}
            />
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <p className="font-medium">Claude Usage</p>
        {usage.fiveHour && (
          <p className="text-muted-foreground text-xs">
            5-hour: {usage.fiveHour.utilization}% (resets in{" "}
            {formatTimeUntilReset(usage.fiveHour.resetsAt)})
          </p>
        )}
        {usage.sevenDay && (
          <p className="text-muted-foreground text-xs">
            7-day: {usage.sevenDay.utilization}% (resets in{" "}
            {formatTimeUntilReset(usage.sevenDay.resetsAt)})
          </p>
        )}
        {usage.extraUsage?.isEnabled && (
          <p className="text-muted-foreground text-xs">
            Extra: ${usage.extraUsage.usedCredits} / $
            {usage.extraUsage.monthlyLimit} ({usage.extraUsage.utilization}%)
          </p>
        )}
        {refreshInfo && (
          <p className="text-muted-foreground/60 mt-1 text-xs">{refreshInfo}</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
