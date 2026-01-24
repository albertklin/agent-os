"use client";

import { useSystemStats, formatBytes } from "@/hooks/useSystemStats";
import { Cpu, MemoryStick, Monitor } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface StatItemProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  detail?: string;
}

function StatItem({ icon, label, value, detail }: StatItemProps) {
  // Color based on usage level
  const getColor = (pct: number) => {
    if (pct >= 90) return "text-red-500";
    if (pct >= 70) return "text-yellow-500";
    return "text-muted-foreground/60";
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex cursor-default items-center gap-1">
          <span className={getColor(value)}>{icon}</span>
          <span className={`font-mono text-[11px] ${getColor(value)}`}>
            {value}%
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="font-medium">{label}</p>
        {detail && <p className="text-muted-foreground text-xs">{detail}</p>}
      </TooltipContent>
    </Tooltip>
  );
}

export function SystemStats() {
  const { stats, error, isLoading } = useSystemStats({ interval: 1000 });

  // Don't show anything while loading or on error
  if (isLoading || error || !stats) {
    return null;
  }

  return (
    <div className="mr-3 flex items-center gap-3 border-r border-border/40 pr-3">
      {/* CPU */}
      <StatItem
        icon={<Cpu className="h-3 w-3" />}
        label="CPU Usage"
        value={stats.cpu.usage}
        detail={`${stats.cpu.cores} cores`}
      />

      {/* Memory */}
      <StatItem
        icon={<MemoryStick className="h-3 w-3" />}
        label="Memory"
        value={stats.memory.usage}
        detail={`${formatBytes(stats.memory.used)} / ${formatBytes(stats.memory.total)}`}
      />

      {/* GPU (only if available) */}
      {stats.gpu && (
        <>
          <StatItem
            icon={<Monitor className="h-3 w-3" />}
            label={stats.gpu.name || "GPU"}
            value={stats.gpu.usage}
            detail={`${formatBytes(stats.gpu.memoryUsed)} / ${formatBytes(stats.gpu.memoryTotal)} VRAM`}
          />
        </>
      )}
    </div>
  );
}
