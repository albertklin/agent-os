import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  useDeleteSession,
  useRenameSession,
  useForkSession,
  useSetSessionStatus,
  useRebootSession,
  type ForkSessionInput,
  type DeleteSessionOptions,
} from "@/data/sessions";
import {
  useToggleProject,
  useDeleteProject,
  useRenameProject,
} from "@/data/projects";
import { useToggleGroup, useCreateGroup, useDeleteGroup } from "@/data/groups";
import { sessionKeys } from "@/data/sessions/keys";

interface UseSessionListMutationsOptions {
  onSelectSession: (sessionId: string) => void;
  onSessionDeleted?: (sessionId: string) => void;
}

export interface DeleteDialogState {
  open: boolean;
  sessionId: string;
  sessionName: string;
}

export function useSessionListMutations({
  onSelectSession,
  onSessionDeleted,
}: UseSessionListMutationsOptions) {
  const queryClient = useQueryClient();

  // Session mutations
  const deleteSessionMutation = useDeleteSession();
  const renameSessionMutation = useRenameSession();
  const forkSessionMutation = useForkSession();
  const setSessionStatusMutation = useSetSessionStatus();
  const rebootSessionMutation = useRebootSession();

  // Project mutations
  const toggleProjectMutation = useToggleProject();
  const deleteProjectMutation = useDeleteProject();
  const renameProjectMutation = useRenameProject();

  // Group mutations
  const toggleGroupMutation = useToggleGroup();
  const createGroupMutation = useCreateGroup();
  const deleteGroupMutation = useDeleteGroup();

  // Delete dialog state
  const [deleteDialogState, setDeleteDialogState] = useState<DeleteDialogState>(
    {
      open: false,
      sessionId: "",
      sessionName: "",
    }
  );

  // Session handlers - opens the dialog instead of using confirm()
  const handleDeleteSession = useCallback(
    (sessionId: string, sessionName?: string) => {
      setDeleteDialogState({
        open: true,
        sessionId,
        sessionName: sessionName || "this session",
      });
    },
    []
  );

  // Called when dialog is confirmed
  const confirmDeleteSession = useCallback(
    async (options?: DeleteSessionOptions) => {
      const { sessionId } = deleteDialogState;
      setDeleteDialogState((s) => ({ ...s, open: false }));
      try {
        await deleteSessionMutation.mutateAsync({ sessionId, options });
        onSessionDeleted?.(sessionId);
      } catch (error) {
        // Handle merge conflict errors - reopen dialog is handled by the component
        const errorData = (
          error as Error & {
            data?: { error?: string; conflictFiles?: string[] };
          }
        ).data;
        if (errorData?.error === "merge_conflict") {
          const files = errorData.conflictFiles?.slice(0, 3).join(", ") || "";
          toast.error(
            `Merge conflict${files ? `: ${files}${errorData.conflictFiles && errorData.conflictFiles.length > 3 ? "..." : ""}` : ""}`
          );
        } else if (errorData?.error === "uncommitted_changes") {
          toast.error("Cannot merge: session has uncommitted changes");
        } else {
          toast.error(
            error instanceof Error ? error.message : "Failed to delete session"
          );
        }
      }
    },
    [deleteDialogState, deleteSessionMutation, onSessionDeleted]
  );

  // Called when dialog is dismissed
  const closeDeleteDialog = useCallback(() => {
    setDeleteDialogState((s) => ({ ...s, open: false }));
  }, []);

  const handleRenameSession = useCallback(
    async (sessionId: string, newName: string) => {
      await renameSessionMutation.mutateAsync({ sessionId, newName });
    },
    [renameSessionMutation]
  );

  const handleForkSession = useCallback(
    async (input: ForkSessionInput) => {
      try {
        const forkedSession = await forkSessionMutation.mutateAsync(input);
        if (forkedSession) {
          onSelectSession(forkedSession.id);
          // Show toast for isolated worktree creation
          const isIsolated =
            input.worktreeSelection?.mode === "isolated" || input.useWorktree;
          if (isIsolated) {
            toast.success(`Created worktree for "${forkedSession.name}"`);
          }
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to fork session";
        toast.error(message);
        throw error;
      }
    },
    [forkSessionMutation, onSelectSession]
  );

  const handleSetStatus = useCallback(
    async (sessionId: string, status: "idle" | "running" | "waiting") => {
      try {
        await setSessionStatusMutation.mutateAsync({ sessionId, status });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to set status"
        );
      }
    },
    [setSessionStatusMutation]
  );

  const handleRebootSession = useCallback(
    async (sessionId: string) => {
      try {
        await rebootSessionMutation.mutateAsync(sessionId);
        toast.success("Session rebooted successfully");
        onSelectSession(sessionId);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to reboot session"
        );
      }
    },
    [rebootSessionMutation, onSelectSession]
  );

  // Project handlers
  const handleToggleProject = useCallback(
    async (projectId: string, expanded: boolean) => {
      await toggleProjectMutation.mutateAsync({ projectId, expanded });
    },
    [toggleProjectMutation]
  );

  const handleDeleteProject = useCallback(
    async (projectId: string) => {
      if (
        !confirm(
          "Delete this project? Sessions will be moved to Uncategorized."
        )
      )
        return;
      await deleteProjectMutation.mutateAsync(projectId);
    },
    [deleteProjectMutation]
  );

  const handleRenameProject = useCallback(
    async (projectId: string, newName: string) => {
      await renameProjectMutation.mutateAsync({ projectId, newName });
    },
    [renameProjectMutation]
  );

  // Group handlers
  const handleToggleGroup = useCallback(
    async (path: string, expanded: boolean) => {
      await toggleGroupMutation.mutateAsync({ path, expanded });
    },
    [toggleGroupMutation]
  );

  const handleCreateGroup = useCallback(
    async (name: string, parentPath?: string) => {
      await createGroupMutation.mutateAsync({ name, parentPath });
    },
    [createGroupMutation]
  );

  const handleDeleteGroup = useCallback(
    async (path: string) => {
      if (!confirm("Delete this group? Sessions will be moved to parent."))
        return;
      await deleteGroupMutation.mutateAsync(path);
    },
    [deleteGroupMutation]
  );

  // Bulk delete handler
  const handleBulkDelete = useCallback(
    async (sessionIds: string[]) => {
      const count = sessionIds.length;
      const hasWorktrees = sessionIds.length > 0; // Assume some might have worktrees

      // Show toast with progress
      const toastId = toast.loading(
        hasWorktrees
          ? `Deleting ${count} session${count > 1 ? "s" : ""}... cleaning up worktrees in background`
          : `Deleting ${count} session${count > 1 ? "s" : ""}...`
      );

      let succeeded = 0;
      let failed = 0;
      const deletedIds: string[] = [];

      // Delete all sessions in parallel for speed
      await Promise.allSettled(
        sessionIds.map(async (sessionId) => {
          try {
            const response = await fetch(`/api/sessions/${sessionId}`, {
              method: "DELETE",
            });
            if (response.ok) {
              succeeded++;
              deletedIds.push(sessionId);
            } else {
              failed++;
            }
          } catch (error) {
            console.error(`Failed to delete session ${sessionId}:`, error);
            failed++;
          }
        })
      );

      // Clear deleted sessions from tabs
      for (const sessionId of deletedIds) {
        onSessionDeleted?.(sessionId);
      }

      // Invalidate cache to refresh UI
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });

      // Update toast based on results
      if (failed === 0) {
        toast.success(
          `Deleted ${succeeded} session${succeeded > 1 ? "s" : ""}`,
          { id: toastId }
        );
      } else if (succeeded === 0) {
        toast.error(
          `Failed to delete ${failed} session${failed > 1 ? "s" : ""}`,
          {
            id: toastId,
          }
        );
      } else {
        toast.warning(
          `Deleted ${succeeded}, failed ${failed} session${failed > 1 ? "s" : ""}`,
          { id: toastId }
        );
      }
    },
    [queryClient, onSessionDeleted]
  );

  // Refresh handler
  const handleRefresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
  }, [queryClient]);

  return {
    // Derived state
    isForkingSession: forkSessionMutation.isPending,

    // Delete dialog state and handlers
    deleteDialogState,
    confirmDeleteSession,
    closeDeleteDialog,

    // Session handlers
    handleDeleteSession,
    handleRenameSession,
    handleForkSession,
    handleSetStatus,
    handleRebootSession,

    // Project handlers
    handleToggleProject,
    handleDeleteProject,
    handleRenameProject,

    // Group handlers
    handleToggleGroup,
    handleCreateGroup,
    handleDeleteGroup,

    // Bulk operations
    handleBulkDelete,
    handleRefresh,
  };
}
