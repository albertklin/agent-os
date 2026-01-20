import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Session, Group } from "@/lib/db";
import type { AgentType } from "@/lib/providers";
import { sessionKeys } from "./keys";

interface SessionsResponse {
  sessions: Session[];
  groups: Group[];
}

async function fetchSessions(): Promise<SessionsResponse> {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error("Failed to fetch sessions");
  return res.json();
}

export function useSessionsQuery() {
  return useQuery({
    queryKey: sessionKeys.list(),
    queryFn: fetchSessions,
    staleTime: 30000,
    refetchInterval: 30000,
  });
}

interface DeleteSessionResponse {
  success: boolean;
  branchDeleted?: boolean;
  branchName?: string;
}

export function useDeleteSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string): Promise<DeleteSessionResponse> => {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete session");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });

      // Show toast with branch outcome if this was a worktree session
      if (data.branchName) {
        if (data.branchDeleted) {
          toast.success(
            `Session deleted, branch "${data.branchName}" cleaned up (no changes)`
          );
        } else {
          toast.info(
            `Session deleted, branch "${data.branchName}" preserved (has commits)`
          );
        }
      }
    },
  });
}

export function useRenameSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionId,
      newName,
    }: {
      sessionId: string;
      newName: string;
    }) => {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) throw new Error("Failed to rename session");
      return res.json();
    },
    onMutate: async ({ sessionId, newName }) => {
      await queryClient.cancelQueries({ queryKey: sessionKeys.list() });
      const previous = queryClient.getQueryData<SessionsResponse>(
        sessionKeys.list()
      );
      queryClient.setQueryData<SessionsResponse>(sessionKeys.list(), (old) =>
        old
          ? {
              ...old,
              sessions: old.sessions.map((s) =>
                s.id === sessionId ? { ...s, name: newName } : s
              ),
            }
          : old
      );
      return { previous };
    },
    onError: (_, __, context) => {
      if (context?.previous) {
        queryClient.setQueryData(sessionKeys.list(), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

export interface ForkSessionInput {
  sessionId: string;
  useWorktree?: boolean;
  featureName?: string;
  baseBranch?: string;
}

export function useForkSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ForkSessionInput): Promise<Session | null> => {
      const { sessionId, ...options } = input;
      const res = await fetch(`/api/sessions/${sessionId}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
      });
      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }
      return data.session || null;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

export function useMoveSessionToGroup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionId,
      groupPath,
    }: {
      sessionId: string;
      groupPath: string;
    }) => {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupPath }),
      });
      if (!res.ok) throw new Error("Failed to move session");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

export interface CreateSessionInput {
  name?: string;
  workingDirectory: string;
  projectId: string | null;
  agentType: AgentType;
  model?: string;
  useWorktree: boolean;
  featureName: string | null;
  baseBranch: string | null;
  autoApprove: boolean;
  initialPrompt: string | null;
}

interface CreateSessionResponse {
  session: Session;
  initialPrompt?: string;
  error?: string;
}

export function useCreateSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      input: CreateSessionInput
    ): Promise<CreateSessionResponse> => {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

export interface SessionOrderUpdate {
  sessionId: string;
  projectId: string;
  sortOrder: number;
}

export function useReorderSessions() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessions: SessionOrderUpdate[]) => {
      const res = await fetch("/api/sessions/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessions }),
      });
      if (!res.ok) throw new Error("Failed to reorder sessions");
      return res.json();
    },
    onMutate: async (sessions) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: sessionKeys.list() });

      // Snapshot the previous value
      const previous = queryClient.getQueryData<SessionsResponse>(
        sessionKeys.list()
      );

      // Optimistically update to the new value
      queryClient.setQueryData<SessionsResponse>(sessionKeys.list(), (old) => {
        if (!old) return old;

        // Create a map for quick lookup
        const orderMap = new Map(
          sessions.map((s) => [
            s.sessionId,
            { projectId: s.projectId, sortOrder: s.sortOrder },
          ])
        );

        // Update sessions with new order and project assignments
        const updatedSessions = old.sessions.map((session) => {
          const update = orderMap.get(session.id);
          if (update) {
            return {
              ...session,
              project_id: update.projectId,
              sort_order: update.sortOrder,
            };
          }
          return session;
        });

        // Sort by sort_order
        updatedSessions.sort((a, b) => a.sort_order - b.sort_order);

        return { ...old, sessions: updatedSessions };
      });

      return { previous };
    },
    onError: (_, __, context) => {
      // Roll back on error
      if (context?.previous) {
        queryClient.setQueryData(sessionKeys.list(), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}
