import { useQuery } from "@tanstack/react-query";

export interface WorktreeInfo {
  path: string;
  branchName: string;
  sessionCount: number;
  isMain: boolean;
}

interface WorktreesResponse {
  worktrees: WorktreeInfo[];
  error?: string;
}

async function fetchWorktrees(projectId: string): Promise<WorktreesResponse> {
  const res = await fetch(`/api/projects/${projectId}/worktrees`);
  if (!res.ok) {
    throw new Error("Failed to fetch worktrees");
  }
  return res.json();
}

export function useWorktreesQuery(projectId: string | null) {
  return useQuery({
    queryKey: ["worktrees", projectId],
    queryFn: () => fetchWorktrees(projectId!),
    enabled: !!projectId && projectId !== "uncategorized",
    staleTime: 10000, // 10 seconds
    refetchOnWindowFocus: false,
  });
}
