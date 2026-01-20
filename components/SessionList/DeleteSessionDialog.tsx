"use client";

import { useState, useEffect } from "react";
import { ADialog } from "@/components/a/ADialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Trash2, GitMerge } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface WorktreeStatus {
  hasWorktree: boolean;
  hasUncommittedChanges: boolean;
  branchWillBeDeleted: boolean;
  branchName: string | null;
  siblingSessionNames: string[];
  baseBranch: string | null;
  commitCount: number;
  branches: string[];
}

export interface DeleteOptions {
  mergeInto?: string;
}

interface DeleteSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  sessionName: string;
  onConfirm: (options?: DeleteOptions) => void;
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
  const [mergeOption, setMergeOption] = useState<"keep" | "merge">("keep");
  const [mergeBranch, setMergeBranch] = useState<string>("");

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setAcknowledged(false);
      setDeleting(false);
      setLoading(true);
      setError(null);
      setMergeOption("keep");
      setMergeBranch("");

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
        .then((data: WorktreeStatus) => {
          setStatus(data);
          // Default merge branch to baseBranch
          if (data.baseBranch) {
            setMergeBranch(data.baseBranch);
          }
        })
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
    const options: DeleteOptions =
      mergeOption === "merge" && mergeBranch ? { mergeInto: mergeBranch } : {};
    onConfirm(options);
  };

  const hasSiblings = (status?.siblingSessionNames?.length ?? 0) > 0;
  const requiresAcknowledgment =
    (status?.hasUncommittedChanges && !hasSiblings) ?? false;
  const canDelete = !requiresAcknowledgment || acknowledged;
  const canMerge =
    status?.hasWorktree &&
    status?.commitCount > 0 &&
    !hasSiblings &&
    !status?.hasUncommittedChanges;

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
        <p className="text-muted-foreground text-sm">
          Checking worktree status...
        </p>
      ) : error ? (
        <p className="text-destructive text-sm">{error}</p>
      ) : (
        <div className="space-y-4">
          {/* Worktree and branch info */}
          {status?.hasWorktree && status.branchName && (
            <div className="space-y-1 text-sm">
              {hasSiblings ? (
                <p className="text-muted-foreground">
                  Worktree and branch will be kept (shared with:{" "}
                  {status.siblingSessionNames.join(", ")})
                </p>
              ) : (
                <>
                  <p className="text-muted-foreground">
                    Worktree will be deleted
                  </p>
                  {status.commitCount > 0 ? (
                    <p className="text-muted-foreground">
                      Branch{" "}
                      <code className="bg-muted rounded px-1">
                        {status.branchName}
                      </code>{" "}
                      has {status.commitCount} commit
                      {status.commitCount !== 1 ? "s" : ""}
                    </p>
                  ) : (
                    <p className="text-muted-foreground">
                      Branch{" "}
                      <code className="bg-muted rounded px-1">
                        {status.branchName}
                      </code>{" "}
                      will be deleted (no commits)
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {/* Merge option - only show when branch has commits and can be merged */}
          {canMerge && status?.branches && status.branches.length > 0 && (
            <div className="border-border/50 bg-muted/30 space-y-3 rounded-lg border p-3">
              <div className="space-y-2">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="radio"
                    name="mergeOption"
                    checked={mergeOption === "keep"}
                    onChange={() => setMergeOption("keep")}
                    className="h-4 w-4"
                  />
                  <span className="text-sm">Just delete (keep branch)</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="radio"
                    name="mergeOption"
                    checked={mergeOption === "merge"}
                    onChange={() => setMergeOption("merge")}
                    className="h-4 w-4"
                  />
                  <span className="text-sm">Merge into:</span>
                  <Select
                    value={mergeBranch}
                    onValueChange={(value) => {
                      setMergeBranch(value);
                      setMergeOption("merge");
                    }}
                    disabled={deleting}
                  >
                    <SelectTrigger className="h-7 w-32">
                      <SelectValue placeholder="Select branch" />
                    </SelectTrigger>
                    <SelectContent>
                      {status.branches
                        .filter((b) => b !== status.branchName)
                        .map((branch) => (
                          <SelectItem key={branch} value={branch}>
                            {branch}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <span className="text-sm">then delete branch</span>
                </label>
              </div>
              {mergeOption === "merge" && (
                <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <GitMerge className="h-3 w-3" />
                  {status.commitCount} commit
                  {status.commitCount !== 1 ? "s" : ""} will be merged into{" "}
                  <code className="bg-muted rounded px-1">{mergeBranch}</code>
                </p>
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
                  {status?.commitCount > 0 && (
                    <p className="text-xs text-amber-200/70">
                      Merge option disabled - commit your changes first
                    </p>
                  )}
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
          <p className="text-muted-foreground text-sm">
            This action cannot be undone.
          </p>
        </div>
      )}
    </ADialog>
  );
}
