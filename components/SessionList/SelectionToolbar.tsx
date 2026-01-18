"use client";

import { useEffect, useCallback, useState } from "react";
import { useSnapshot } from "valtio";
import { Button } from "@/components/ui/button";
import { Trash2, X, AlertTriangle } from "lucide-react";
import { selectionStore, selectionActions } from "@/stores/sessionSelection";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface SelectionToolbarProps {
  allSessionIds: string[];
  sessionNames: Map<string, string>;
  onDeleteSessions: (sessionIds: string[]) => Promise<void>;
}

export function SelectionToolbar({
  allSessionIds,
  sessionNames,
  onDeleteSessions,
}: SelectionToolbarProps) {
  const { selectedIds } = useSnapshot(selectionStore);
  const selectedCount = selectedIds.size;
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [uncommittedCount, setUncommittedCount] = useState(0);
  const [branchesToDelete, setBranchesToDelete] = useState<string[]>([]);
  const [branchesToRetain, setBranchesToRetain] = useState<string[]>([]);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);

  // Check for uncommitted changes and branch status when dialog opens
  useEffect(() => {
    if (!showDeleteDialog) {
      setUncommittedCount(0);
      setBranchesToDelete([]);
      setBranchesToRetain([]);
      return;
    }

    const checkWorktreeStatus = async () => {
      setIsCheckingStatus(true);
      const ids = selectionActions.getSelectedIds();
      let uncommitted = 0;
      const toDelete: string[] = [];
      const toRetain: string[] = [];

      await Promise.all(
        ids.map(async (sessionId) => {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            const res = await fetch(`/api/sessions/${sessionId}/worktree-status`, {
              signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (res.ok) {
              const status = await res.json();
              if (status.hasUncommittedChanges) {
                uncommitted++;
              }
              if (status.hasWorktree && status.branchName) {
                if (status.branchWillBeDeleted) {
                  toDelete.push(status.branchName);
                } else {
                  toRetain.push(status.branchName);
                }
              }
            }
          } catch {
            // Ignore errors and timeouts
          }
        })
      );

      setUncommittedCount(uncommitted);
      setBranchesToDelete(toDelete);
      setBranchesToRetain(toRetain);
      setIsCheckingStatus(false);
    };

    checkWorktreeStatus();
  }, [showDeleteDialog]);

  // Get names of selected sessions for display (keep id for unique keys)
  const selectedSessionsForDisplay = Array.from(selectedIds)
    .map((id) => ({ id, name: sessionNames.get(id) || id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const maxNamesToShow = 5;
  const displayedSessions = selectedSessionsForDisplay.slice(0, maxNamesToShow);
  const remainingCount = selectedSessionsForDisplay.length - maxNamesToShow;

  const handleSelectAll = useCallback(() => {
    selectionActions.selectAll(allSessionIds);
  }, [allSessionIds]);

  const handleDelete = useCallback(async () => {
    const ids = selectionActions.getSelectedIds();
    if (ids.length === 0) return;

    setIsDeleting(true);
    try {
      await onDeleteSessions(ids);
      selectionActions.clear();
    } finally {
      setIsDeleting(false);
      setShowDeleteDialog(false);
    }
  }, [onDeleteSessions]);

  // Keyboard shortcuts
  useEffect(() => {
    if (selectedCount === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Delete key - show delete confirmation
      if (e.key === "Delete" || e.key === "Backspace") {
        // Don't trigger if typing in an input
        if (
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement
        ) {
          return;
        }
        e.preventDefault();
        setShowDeleteDialog(true);
      }

      // Escape - clear selection
      if (e.key === "Escape") {
        e.preventDefault();
        selectionActions.clear();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedCount]);

  if (selectedCount === 0) return null;

  const allSelected = selectedCount === allSessionIds.length;

  return (
    <>
      <div className="bg-primary/10 border-primary/20 flex items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium whitespace-nowrap">
          {selectedCount} selected
        </span>
        <div className="ml-auto flex items-center gap-1">
          {!allSelected && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={handleSelectAll}
            >
              Select all
            </Button>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-destructive hover:text-destructive hover:bg-destructive/10 h-6 w-6"
                onClick={() => setShowDeleteDialog(true)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete selected</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-6 w-6"
                onClick={selectionActions.clear}
              >
                <X className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear selection</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              Delete {selectedCount} session{selectedCount > 1 ? "s" : ""}?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <ul className="text-muted-foreground list-inside list-disc text-sm">
                  {displayedSessions.map(({ id, name }) => (
                    <li key={id} className="truncate">
                      {name}
                    </li>
                  ))}
                  {remainingCount > 0 && (
                    <li className="text-muted-foreground/70">
                      and {remainingCount} more...
                    </li>
                  )}
                </ul>
                <p>
                  This will permanently delete the selected sessions and their
                  tmux sessions. This action cannot be undone.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>

          {/* Branch status info */}
          {!isCheckingStatus && (branchesToDelete.length > 0 || branchesToRetain.length > 0) && (
            <div className="text-muted-foreground space-y-1 text-sm">
              {branchesToDelete.length > 0 && (
                <p>
                  <span className="text-foreground font-medium">
                    {branchesToDelete.length} branch{branchesToDelete.length > 1 ? "es" : ""}
                  </span>{" "}
                  will be deleted (no commits)
                </p>
              )}
              {branchesToRetain.length > 0 && (
                <p>
                  <span className="text-foreground font-medium">
                    {branchesToRetain.length} branch{branchesToRetain.length > 1 ? "es" : ""}
                  </span>{" "}
                  will be retained (has commits)
                </p>
              )}
            </div>
          )}

          {/* Warning for uncommitted changes */}
          {!isCheckingStatus && uncommittedCount > 0 && (
            <div className="bg-destructive/10 border-destructive/20 flex items-start gap-2 rounded-md border p-3">
              <AlertTriangle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-destructive text-sm">
                <strong>Warning:</strong> {uncommittedCount} session
                {uncommittedCount > 1 ? "s have" : " has"} uncommitted changes
                that will be lost!
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setShowDeleteDialog(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting || isCheckingStatus}
            >
              {isDeleting
                ? "Deleting..."
                : isCheckingStatus
                  ? "Checking..."
                  : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
