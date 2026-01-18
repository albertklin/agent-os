import { useCallback } from "react";
import type { Session } from "@/lib/db";
import {
  useSessionsQuery,
  useDeleteSession,
  useRenameSession,
  useForkSession,
  useSummarizeSession,
  useMoveSessionToGroup,
  useMoveSessionToProject,
} from "@/data/sessions";

export function useSessions() {
  const { data, refetch } = useSessionsQuery();
  const sessions = data?.sessions ?? [];
  const groups = data?.groups ?? [];

  const deleteMutation = useDeleteSession();
  const renameMutation = useRenameSession();
  const forkMutation = useForkSession();
  const summarizeMutation = useSummarizeSession();
  const moveToGroupMutation = useMoveSessionToGroup();
  const moveToProjectMutation = useMoveSessionToProject();

  const fetchSessions = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const deleteSession = useCallback(
    async (sessionId: string) => {
      // Check worktree status to determine appropriate warning
      const messageParts: string[] = [];

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`/api/sessions/${sessionId}/worktree-status`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          const status = await res.json();

          // Add branch info
          if (status.hasWorktree && status.branchName) {
            if (status.branchWillBeDeleted) {
              messageParts.push(`Branch "${status.branchName}" will be deleted (no commits).`);
            } else {
              messageParts.push(`Branch "${status.branchName}" will be retained (has commits).`);
            }
          }

          // Add uncommitted changes warning
          if (status.hasUncommittedChanges) {
            messageParts.push("WARNING: This session has uncommitted changes that will be lost!");
          }
        }
      } catch {
        // If status check fails or times out, proceed with default warning
      }

      messageParts.push("Delete this session? This cannot be undone.");
      const warningMessage = messageParts.join("\n\n");

      if (!confirm(warningMessage)) return;
      await deleteMutation.mutateAsync(sessionId);
    },
    [deleteMutation]
  );

  const renameSession = useCallback(
    async (sessionId: string, newName: string) => {
      await renameMutation.mutateAsync({ sessionId, newName });
    },
    [renameMutation]
  );

  const forkSession = useCallback(
    async (sessionId: string): Promise<Session | null> => {
      return await forkMutation.mutateAsync(sessionId);
    },
    [forkMutation]
  );

  const summarizeSession = useCallback(
    async (sessionId: string): Promise<Session | null> => {
      return await summarizeMutation.mutateAsync(sessionId);
    },
    [summarizeMutation]
  );

  const moveSessionToGroup = useCallback(
    async (sessionId: string, groupPath: string) => {
      await moveToGroupMutation.mutateAsync({ sessionId, groupPath });
    },
    [moveToGroupMutation]
  );

  const moveSessionToProject = useCallback(
    async (sessionId: string, projectId: string) => {
      await moveToProjectMutation.mutateAsync({ sessionId, projectId });
    },
    [moveToProjectMutation]
  );

  return {
    sessions,
    groups,
    summarizingSessionId: summarizeMutation.isPending
      ? (summarizeMutation.variables as string)
      : null,
    fetchSessions,
    deleteSession,
    renameSession,
    forkSession,
    summarizeSession,
    moveSessionToGroup,
    moveSessionToProject,
  };
}
