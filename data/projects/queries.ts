import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@/lib/db";
import { projectKeys } from "./keys";
import { sessionKeys } from "../sessions/keys";

async function fetchProjects(): Promise<Project[]> {
  const res = await fetch("/api/projects");
  if (!res.ok) throw new Error("Failed to fetch projects");
  const data = await res.json();
  return data.projects || [];
}

export function useProjectsQuery() {
  return useQuery({
    queryKey: projectKeys.list(),
    queryFn: fetchProjects,
    staleTime: 30000,
  });
}

export function useToggleProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      projectId,
      expanded,
    }: {
      projectId: string;
      expanded: boolean;
    }) => {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expanded }),
      });
      if (!res.ok) throw new Error("Failed to toggle project");
      return res.json();
    },
    onMutate: async ({ projectId, expanded }) => {
      await queryClient.cancelQueries({ queryKey: projectKeys.list() });
      const previous = queryClient.getQueryData<Project[]>(projectKeys.list());
      queryClient.setQueryData<Project[]>(projectKeys.list(), (old) =>
        old?.map((p) => (p.id === projectId ? { ...p, expanded } : p))
      );
      return { previous };
    },
    onError: (_, __, context) => {
      if (context?.previous) {
        queryClient.setQueryData(projectKeys.list(), context.previous);
      }
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (projectId: string) => {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete project");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.list() });
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

export function useRenameProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      projectId,
      newName,
    }: {
      projectId: string;
      newName: string;
    }) => {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) throw new Error("Failed to rename project");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.list() });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      projectId,
      name,
      workingDirectory,
    }: {
      projectId: string;
      name?: string;
      workingDirectory?: string;
    }) => {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          workingDirectory,
        }),
      });
      if (!res.ok) throw new Error("Failed to update project");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.list() });
    },
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: { name: string; workingDirectory: string }) => {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create project");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.list() });
    },
  });
}

export interface ProjectOrderUpdate {
  projectId: string;
  sortOrder: number;
}

export function useReorderProjects() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (updates: ProjectOrderUpdate[]) => {
      const res = await fetch("/api/projects/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projects: updates }),
      });
      if (!res.ok) throw new Error("Failed to reorder projects");
      return res.json();
    },
    onMutate: async (updates) => {
      await queryClient.cancelQueries({ queryKey: projectKeys.list() });
      const previous = queryClient.getQueryData<Project[]>(projectKeys.list());

      // Optimistically update the order
      queryClient.setQueryData<Project[]>(projectKeys.list(), (old) => {
        if (!old) return old;
        const orderMap = new Map(
          updates.map((u) => [u.projectId, u.sortOrder])
        );
        return [...old]
          .map((p) => ({
            ...p,
            sort_order: orderMap.get(p.id) ?? p.sort_order,
          }))
          .sort((a, b) => {
            // Uncategorized always last
            if (a.is_uncategorized !== b.is_uncategorized) {
              return a.is_uncategorized ? 1 : -1;
            }
            return a.sort_order - b.sort_order;
          });
      });

      return { previous };
    },
    onError: (_, __, context) => {
      if (context?.previous) {
        queryClient.setQueryData(projectKeys.list(), context.previous);
      }
    },
  });
}
