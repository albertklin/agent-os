"use client";

import { useState, useEffect } from "react";
import { ADialog } from "@/components/a/ADialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Trash2 } from "lucide-react";

export interface WorktreeStatus {
  hasWorktree: boolean;
  hasUncommittedChanges: boolean;
  branchWillBeDeleted: boolean;
  branchName: string | null;
  siblingSessionNames: string[];
}

interface DeleteSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  sessionName: string;
  onConfirm: () => void;
}

export function DeleteSessionDialog({
  open,
  onOpenChange,
  sessionId,
  sessionName,
  onConfirm,
}: DeleteSessionDialogProps) {
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setAcknowledged(false);
      setDeleting(false);
      setLoading(true);
      setError(null);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      fetch(`/api/sessions/${sessionId}/worktree-status`, {
        signal: controller.signal,
      })
        .then((res) => {
          clearTimeout(timeoutId);
          if (!res.ok) throw new Error("Failed to fetch status");
          return res.json();
        })
        .then(setStatus)
        .catch((err) => {
          if (err.name === "AbortError") {
            setError("Timed out checking worktree status");
          } else {
            setError("Failed to check worktree status");
          }
        })
        .finally(() => setLoading(false));

      return () => {
        clearTimeout(timeoutId);
        controller.abort();
      };
    }
  }, [open, sessionId]);

  const handleConfirm = async () => {
    setDeleting(true);
    onConfirm();
  };

  const hasSiblings = (status?.siblingSessionNames?.length ?? 0) > 0;
  const requiresAcknowledgment = (status?.hasUncommittedChanges && !hasSiblings) ?? false;
  const canDelete = !requiresAcknowledgment || acknowledged;

  return (
    <ADialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete "${sessionName}"?`}
      icon={<Trash2 className="text-destructive" />}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={loading || !!error || !canDelete || deleting}
          >
            {deleting ? "Deleting..." : "Delete"}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="text-sm text-muted-foreground">Checking worktree status...</p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        <div className="space-y-4">
          {/* Worktree and branch info */}
          {status?.hasWorktree && status.branchName && (
            <div className="space-y-1 text-sm">
              {hasSiblings ? (
                <>
                  <p className="text-muted-foreground">
                    Worktree and branch will be kept (shared with:{" "}
                    {status.siblingSessionNames.join(", ")})
                  </p>
                </>
              ) : (
                <>
                  <p className="text-muted-foreground">
                    Worktree will be deleted
                  </p>
                  <p className="text-muted-foreground">
                    Branch <code className="rounded bg-muted px-1">{status.branchName}</code>{" "}
                    {status.branchWillBeDeleted
                      ? "will be deleted (no commits)"
                      : "will be retained (has commits)"}
                  </p>
                </>
              )}
            </div>
          )}

          {/* Uncommitted changes warning with checkbox - only show when worktree will be deleted */}
          {status?.hasUncommittedChanges && !hasSiblings && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
                <div className="space-y-2">
                  <p className="text-sm font-medium text-amber-200">
                    This session has uncommitted changes that will be lost!
                  </p>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      onChange={(e) => setAcknowledged(e.target.checked)}
                      className="h-4 w-4 rounded border-amber-500/50 bg-transparent accent-amber-500"
                    />
                    <span className="text-sm text-amber-200/80">
                      I understand my changes will be lost
                    </span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* Final confirmation text */}
          <p className="text-sm text-muted-foreground">
            This action cannot be undone.
          </p>
        </div>
      )}
    </ADialog>
  );
}
