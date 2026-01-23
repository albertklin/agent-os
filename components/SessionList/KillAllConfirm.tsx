import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { sessionKeys } from "@/data/sessions/keys";
import type { Session } from "@/lib/db";

interface KillAllConfirmProps {
  onCancel: () => void;
  onComplete: () => void;
}

export function KillAllConfirm({ onCancel, onComplete }: KillAllConfirmProps) {
  const queryClient = useQueryClient();
  const [killing, setKilling] = useState(false);
  const [worktreeCount, setWorktreeCount] = useState<number | null>(null);

  // Count sessions with worktrees from cached data
  useEffect(() => {
    const sessions = queryClient.getQueryData<Session[]>(sessionKeys.list());
    if (sessions) {
      const count = sessions.filter(
        (s) =>
          s.worktree_path?.startsWith(
            `${process.env.HOME || "~"}/.agent-os/worktrees`
          ) ||
          s.worktree_path?.startsWith("~/.agent-os/worktrees") ||
          s.worktree_path?.includes("/.agent-os/worktrees")
      ).length;
      setWorktreeCount(count);
    }
  }, [queryClient]);

  const handleKillAll = async () => {
    setKilling(true);
    try {
      await fetch("/api/tmux/kill-all", { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
      onComplete();
    } catch (error) {
      console.error("Failed to kill sessions:", error);
    } finally {
      setKilling(false);
    }
  };

  return (
    <div className="mx-4 mb-3 rounded-lg border border-red-500/20 bg-red-500/10 p-3">
      <p className="mb-2 text-sm font-medium text-red-400">
        Kill all sessions?
      </p>
      <p className="mb-3 text-xs text-red-400/80">
        This will kill all tmux sessions and destroy containers.
        {worktreeCount !== null && worktreeCount > 0 && (
          <>
            {" "}
            {worktreeCount} worktree{worktreeCount !== 1 ? "s" : ""} will be
            preserved at ~/.agent-os/worktrees/ for manual cleanup.
          </>
        )}
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          onClick={handleKillAll}
          disabled={killing}
        >
          {killing ? "Killing..." : "Yes, kill all"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={killing}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
