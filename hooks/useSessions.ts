import { useCallback } from "react";
import type { Session } from "@/lib/db";
import {
  useSessionsQuery,
  useRenameSession,
  useForkSession,
  useMoveSessionToGroup,
  type ForkSessionInput,
} from "@/data/sessions";

export function useSessions() {
  const { data, refetch } = useSessionsQuery();
  const sessions = data?.sessions ?? [];
  const groups = data?.groups ?? [];

  const renameMutation = useRenameSession();
  const forkMutation = useForkSession();
  const moveToGroupMutation = useMoveSessionToGroup();

  const fetchSessions = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const renameSession = useCallback(
    async (sessionId: string, newName: string) => {
      await renameMutation.mutateAsync({ sessionId, newName });
    },
    [renameMutation]
  );

  const forkSession = useCallback(
    async (input: ForkSessionInput): Promise<Session | null> => {
      return await forkMutation.mutateAsync(input);
    },
    [forkMutation]
  );

  const moveSessionToGroup = useCallback(
    async (sessionId: string, groupPath: string) => {
      await moveToGroupMutation.mutateAsync({ sessionId, groupPath });
    },
    [moveToGroupMutation]
  );

  return {
    sessions,
    groups,
    fetchSessions,
    renameSession,
    forkSession,
    moveSessionToGroup,
  };
}
