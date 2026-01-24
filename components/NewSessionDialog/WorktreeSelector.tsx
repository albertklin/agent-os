"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { GitBranch, FolderGit, Loader2, AlertCircle } from "lucide-react";
import type { GitInfo } from "./NewSessionDialog.types";

export interface WorktreeSelection {
  branch: string; // branch name
  mode: "direct" | "isolated";
  featureName?: string; // required if mode="isolated"
}

interface BranchInfo {
  name: string;
  worktreePath: string | null;
  sessionCount: number;
  isCheckedOutInMain: boolean;
  hasUncommittedChanges?: boolean;
}

export interface WorktreeSelectorProps {
  projectId: string | null;
  workingDirectory: string; // Main worktree path
  gitInfo: GitInfo | null;
  value: WorktreeSelection;
  onChange: (selection: WorktreeSelection) => void;
  skipPermissions: boolean;
  defaultBranch?: string; // For fork: parent's branch name
  parentBranch?: string; // For fork: show "(parent)" indicator
  disabled?: boolean;
}

export function WorktreeSelector({
  projectId,
  workingDirectory,
  gitInfo,
  value,
  onChange,
  skipPermissions,
  defaultBranch,
  parentBranch,
  disabled = false,
}: WorktreeSelectorProps) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);

  // Use ref to avoid stale closure issues in effects
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;

  // Fetch branches when project changes
  useEffect(() => {
    if (!projectId || projectId === "uncategorized") {
      // For uncategorized project, only show the current branch
      setBranches([
        {
          name: gitInfo?.currentBranch || "unknown",
          worktreePath: workingDirectory,
          sessionCount: 0,
          isCheckedOutInMain: true,
        },
      ]);
      return;
    }

    setLoadingBranches(true);
    fetch(`/api/projects/${projectId}/worktrees`)
      .then((res) => res.json())
      .then((data) => {
        if (data.branches && Array.isArray(data.branches)) {
          setBranches(data.branches);
        }
      })
      .catch(console.error)
      .finally(() => setLoadingBranches(false));
  }, [projectId, workingDirectory, gitInfo?.currentBranch]);

  // Set selection when branches load and no branch is selected
  useEffect(() => {
    if (branches.length === 0 || value.branch) return;

    // Select defaultBranch (parent in fork, current in new) or fall back to project branch
    const target =
      (defaultBranch && branches.find((b) => b.name === defaultBranch)?.name) ||
      branches.find((b) => b.isCheckedOutInMain)?.name;

    if (target) {
      onChangeRef.current({ ...valueRef.current, branch: target });
    }
  }, [branches, defaultBranch, value.branch]);

  // Get selected branch info
  const selectedBranch = branches.find((b) => b.name === value.branch);
  const mainBranch = branches.find((b) => b.isCheckedOutInMain);

  // Check if direct mode is available for the selected branch
  const hasWorktree = selectedBranch?.worktreePath !== null;
  const isMainBranch = selectedBranch?.isCheckedOutInMain;

  // Direct mode is disabled if:
  // 1. No worktree exists for this branch, OR
  // 2. skipPermissions is true AND this is the main branch (container needs isolated worktree)
  const directModeDisabled = !hasWorktree || (skipPermissions && isMainBranch);

  // Auto-switch to isolated mode when direct becomes disabled
  useEffect(() => {
    if (directModeDisabled && valueRef.current.mode === "direct") {
      onChangeRef.current({ ...valueRef.current, mode: "isolated" });
    }
  }, [directModeDisabled]);

  // Handle branch change
  const handleBranchChange = useCallback(
    (newBranch: string) => {
      const branch = branches.find((b) => b.name === newBranch);
      const branchHasWorktree = branch?.worktreePath !== null;
      const branchIsMain = branch?.isCheckedOutInMain;

      // If the new branch doesn't have a worktree, or it's main with skipPermissions,
      // auto-switch to isolated mode
      const newDirectDisabled =
        !branchHasWorktree || (skipPermissions && branchIsMain);

      onChange({
        ...value,
        branch: newBranch,
        mode: newDirectDisabled ? "isolated" : value.mode,
      });
    },
    [branches, skipPermissions, onChange, value]
  );

  if (!gitInfo?.isGitRepo) {
    return null;
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label className="flex items-center gap-1.5 text-sm font-medium">
          <FolderGit className="h-4 w-4" />
          Branch
        </label>

        {/* Branch Selection */}
        <Select
          value={value.branch}
          onValueChange={handleBranchChange}
          disabled={disabled || loadingBranches}
        >
          <SelectTrigger className="h-8 text-sm">
            {loadingBranches ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading branches...
              </span>
            ) : (
              <SelectValue placeholder="Select branch" />
            )}
          </SelectTrigger>
          <SelectContent>
            {branches.map((branch) => (
              <SelectItem key={branch.name} value={branch.name}>
                <span className="flex items-center gap-2">
                  <GitBranch className="h-3.5 w-3.5" />
                  <span>{branch.name}</span>
                  {branch.isCheckedOutInMain && (
                    <span className="text-muted-foreground text-xs">
                      (project)
                    </span>
                  )}
                  {parentBranch && branch.name === parentBranch && (
                    <span className="text-muted-foreground text-xs">
                      (parent)
                    </span>
                  )}
                  {!branch.isCheckedOutInMain &&
                    branch.name !== parentBranch &&
                    branch.worktreePath &&
                    branch.sessionCount > 0 && (
                      <span className="text-muted-foreground text-xs">
                        ({branch.sessionCount} session
                        {branch.sessionCount !== 1 ? "s" : ""})
                      </span>
                    )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Mode Toggle */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <input
            type="radio"
            id="mode-direct"
            name="worktree-mode"
            checked={value.mode === "direct"}
            onChange={() =>
              onChange({ ...value, mode: "direct", featureName: undefined })
            }
            disabled={disabled || directModeDisabled}
            className="border-border bg-background accent-primary h-4 w-4"
          />
          <label
            htmlFor="mode-direct"
            className={`cursor-pointer text-sm ${
              directModeDisabled ? "text-muted-foreground" : ""
            }`}
          >
            Direct
          </label>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="radio"
            id="mode-isolated"
            name="worktree-mode"
            checked={value.mode === "isolated"}
            onChange={() => onChange({ ...value, mode: "isolated" })}
            disabled={disabled}
            className="border-border bg-background accent-primary h-4 w-4"
          />
          <label htmlFor="mode-isolated" className="cursor-pointer text-sm">
            Isolated
          </label>
        </div>
      </div>

      {/* Mode description / hints */}
      {!hasWorktree && value.mode === "isolated" && (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
          No worktree exists for this branch. A new one will be created.
        </p>
      )}
      {hasWorktree && (
        <p className="text-muted-foreground text-xs">
          {value.mode === "direct" ? (
            isMainBranch ? (
              "Work directly in the project directory"
            ) : (
              <>
                Share worktree with {selectedBranch?.sessionCount || 0} other
                session
                {selectedBranch?.sessionCount !== 1 ? "s" : ""}
              </>
            )
          ) : (
            <>
              Create a new branch from{" "}
              <span className="font-medium">
                {selectedBranch?.name || "selected branch"}
              </span>
            </>
          )}
        </p>
      )}

      {/* Disabled warning for skipPermissions */}
      {skipPermissions && isMainBranch && value.mode === "direct" && (
        <p className="text-xs text-amber-500">
          Auto-approve requires an isolated worktree for container mounting
        </p>
      )}

      {/* Warning for uncommitted changes when creating isolated branch */}
      {value.mode === "isolated" &&
        hasWorktree &&
        selectedBranch?.hasUncommittedChanges && (
          <p className="flex items-center gap-1.5 text-xs text-amber-500">
            <AlertCircle className="h-3.5 w-3.5" />
            This branch has uncommitted changes that won&apos;t be included in
            the new branch.
          </p>
        )}

      {/* Feature Name Input (for isolated mode) */}
      {value.mode === "isolated" && (
        <div className="bg-accent/40 space-y-2 rounded-lg p-3">
          <div className="space-y-1">
            <label className="text-muted-foreground text-xs">
              Feature Name <span className="text-red-500">*</span>
            </label>
            <Input
              value={value.featureName || ""}
              onChange={(e) =>
                onChange({ ...value, featureName: e.target.value })
              }
              placeholder="add-dark-mode"
              className="h-8 text-sm"
              disabled={disabled}
            />
          </div>
          {value.featureName && (
            <p className="text-muted-foreground text-xs">
              Branch: feature/
              {value.featureName
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 50)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
