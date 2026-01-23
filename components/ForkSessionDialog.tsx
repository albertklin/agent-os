"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Loader2, Shield } from "lucide-react";
import {
  WorktreeSelector,
  type WorktreeSelection,
} from "@/components/NewSessionDialog/WorktreeSelector";
import { generateFeatureName } from "@/components/NewSessionDialog/NewSessionDialog.types";
import type { GitInfo } from "@/components/NewSessionDialog/NewSessionDialog.types";

export interface ForkOptions {
  worktreeSelection: WorktreeSelection;
  autoApprove: boolean;
}

interface ForkSessionDialogProps {
  sessionName: string;
  workingDirectory: string;
  projectId: string | null;
  parentBranchName?: string | null; // Parent's branch name for defaulting
  parentAutoApprove?: boolean; // Parent's auto-approve setting for defaulting
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFork: (options: ForkOptions) => Promise<void>;
  isPending?: boolean;
}

export function ForkSessionDialog({
  sessionName,
  workingDirectory,
  projectId,
  parentBranchName,
  parentAutoApprove = false,
  open,
  onOpenChange,
  onFork,
  isPending = false,
}: ForkSessionDialogProps) {
  const [worktreeSelection, setWorktreeSelection] = useState<WorktreeSelection>(
    {
      branch: parentBranchName || "",
      mode: "direct",
    }
  );
  const [skipPermissions, setSkipPermissions] = useState(parentAutoApprove);
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [loadingGit, setLoadingGit] = useState(false);

  // Fetch git info when dialog opens
  useEffect(() => {
    if (open && workingDirectory) {
      setLoadingGit(true);
      fetch("/api/git/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: workingDirectory }),
      })
        .then((res) => res.json())
        .then((data) => {
          setGitInfo(data);
          // Set default branch when git info is loaded
          if (data.isGitRepo) {
            const defaultBranch = parentBranchName || data.currentBranch || "";
            setWorktreeSelection((prev) => ({
              ...prev,
              branch: defaultBranch,
            }));
          }
        })
        .catch(console.error)
        .finally(() => setLoadingGit(false));
    }
  }, [open, workingDirectory, parentBranchName]);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setWorktreeSelection({
        branch: parentBranchName || "",
        mode: "direct",
      });
      setSkipPermissions(parentAutoApprove);
    }
  }, [open, parentBranchName, parentAutoApprove]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate isolated mode requires feature name
    if (
      worktreeSelection.mode === "isolated" &&
      !worktreeSelection.featureName?.trim()
    ) {
      return;
    }

    await onFork({ worktreeSelection, autoApprove: skipPermissions });
    onOpenChange(false);
  };

  // Handle switching to isolated mode - auto-populate feature name
  const handleWorktreeSelectionChange = useCallback(
    (newSelection: WorktreeSelection) => {
      setWorktreeSelection((prev) => {
        if (
          newSelection.mode === "isolated" &&
          prev.mode !== "isolated" &&
          !newSelection.featureName
        ) {
          // Auto-populate feature name when switching to isolated mode
          return {
            ...newSelection,
            featureName: generateFeatureName(),
          };
        }
        return newSelection;
      });
    },
    []
  );

  const canSubmit =
    worktreeSelection.mode === "direct" ||
    (worktreeSelection.mode === "isolated" &&
      worktreeSelection.featureName?.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Fork Session</DialogTitle>
          <DialogDescription>
            Create a copy of &ldquo;{sessionName}&rdquo; to work on
            independently.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {loadingGit ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-muted-foreground ml-2 text-sm">
                Loading git info...
              </span>
            </div>
          ) : gitInfo?.isGitRepo ? (
            <>
              <WorktreeSelector
                projectId={projectId}
                workingDirectory={workingDirectory}
                gitInfo={gitInfo}
                value={worktreeSelection}
                onChange={handleWorktreeSelectionChange}
                skipPermissions={skipPermissions}
                defaultBranch={
                  parentBranchName || gitInfo?.currentBranch || undefined
                }
                parentBranch={parentBranchName || undefined}
                disabled={isPending}
              />

              {/* Skip Permissions Toggle */}
              <div className="flex items-center justify-between gap-4 border-t pt-4">
                <div className="space-y-0.5">
                  <label
                    htmlFor="skip-permissions"
                    className="flex items-center gap-2 text-sm font-medium"
                  >
                    <Shield className="h-4 w-4" />
                    Skip permission prompts
                  </label>
                  <p className="text-muted-foreground text-xs">
                    Auto-approve file edits and commands (sandboxed)
                  </p>
                </div>
                <Switch
                  id="skip-permissions"
                  checked={skipPermissions}
                  onCheckedChange={setSkipPermissions}
                  disabled={isPending}
                />
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              This session is not in a git repository. The fork will work in the
              same directory.
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || isPending}>
              {isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Forking...
                </>
              ) : (
                "Fork"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
