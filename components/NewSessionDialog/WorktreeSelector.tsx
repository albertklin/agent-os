"use client";

import { useState, useEffect, useRef } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { GitBranch, FolderGit, Loader2 } from "lucide-react";
import type { GitInfo } from "./NewSessionDialog.types";

export interface WorktreeSelection {
  base: string; // worktree path (project dir = main worktree)
  mode: "direct" | "isolated";
  featureName?: string; // required if mode="isolated"
}

interface WorktreeInfo {
  path: string;
  branchName: string;
  sessionCount: number;
  isMain: boolean;
}

export interface WorktreeSelectorProps {
  projectId: string | null;
  workingDirectory: string; // Main worktree path
  gitInfo: GitInfo | null;
  value: WorktreeSelection;
  onChange: (selection: WorktreeSelection) => void;
  skipPermissions: boolean;
  defaultBase?: string; // For fork: parent's worktree path
  disabled?: boolean;
}

export function WorktreeSelector({
  projectId,
  workingDirectory,
  gitInfo,
  value,
  onChange,
  skipPermissions,
  defaultBase,
  disabled = false,
}: WorktreeSelectorProps) {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [loadingWorktrees, setLoadingWorktrees] = useState(false);

  // Use ref to avoid stale closure issues in effects
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;

  // Fetch worktrees when project changes
  useEffect(() => {
    if (!projectId || projectId === "uncategorized") {
      // For uncategorized project, only show the project directory worktree
      setWorktrees([
        {
          path: workingDirectory,
          branchName: gitInfo?.currentBranch || "unknown",
          sessionCount: 0,
          isMain: true,
        },
      ]);
      return;
    }

    setLoadingWorktrees(true);
    fetch(`/api/projects/${projectId}/worktrees`)
      .then((res) => res.json())
      .then((data) => {
        if (data.worktrees && Array.isArray(data.worktrees)) {
          setWorktrees(data.worktrees);
        }
      })
      .catch(console.error)
      .finally(() => setLoadingWorktrees(false));
  }, [projectId, workingDirectory, gitInfo?.currentBranch]);

  // Set default base when worktrees are loaded or defaultBase changes
  useEffect(() => {
    if (defaultBase && worktrees.length > 0) {
      // Find worktree matching defaultBase
      const matchingWorktree = worktrees.find((wt) => wt.path === defaultBase);
      if (matchingWorktree && valueRef.current.base !== defaultBase) {
        onChangeRef.current({ ...valueRef.current, base: defaultBase });
      }
    } else if (
      worktrees.length > 0 &&
      !worktrees.find((wt) => wt.path === valueRef.current.base)
    ) {
      // Default to main worktree if current base is not valid
      const mainWorktree = worktrees.find((wt) => wt.isMain);
      if (mainWorktree) {
        onChangeRef.current({ ...valueRef.current, base: mainWorktree.path });
      }
    }
  }, [worktrees, defaultBase]);

  // Check if main + direct is disabled (skipPermissions requires isolated worktree)
  const isMainDirect =
    value.mode === "direct" && value.base === workingDirectory;

  // Auto-switch to isolated mode when skipPermissions is enabled and main+direct is selected
  useEffect(() => {
    if (skipPermissions && isMainDirect) {
      onChangeRef.current({ ...valueRef.current, mode: "isolated" });
    }
  }, [skipPermissions, isMainDirect]);

  if (!gitInfo?.isGitRepo) {
    return null;
  }

  const selectedWorktree = worktrees.find((wt) => wt.path === value.base);
  const mainWorktree = worktrees.find((wt) => wt.isMain);

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label className="flex items-center gap-1.5 text-sm font-medium">
          <FolderGit className="h-4 w-4" />
          Worktree
        </label>

        {/* Base Worktree Selection */}
        <Select
          value={value.base}
          onValueChange={(newBase) => onChange({ ...value, base: newBase })}
          disabled={disabled || loadingWorktrees}
        >
          <SelectTrigger className="h-8 text-sm">
            {loadingWorktrees ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading worktrees...
              </span>
            ) : (
              <SelectValue placeholder="Select worktree" />
            )}
          </SelectTrigger>
          <SelectContent>
            {worktrees.map((wt) => (
              <SelectItem key={wt.path} value={wt.path}>
                <span className="flex items-center gap-2">
                  <GitBranch className="h-3.5 w-3.5" />
                  <span>{wt.branchName}</span>
                  {wt.isMain && (
                    <span className="text-muted-foreground text-xs">
                      (main)
                    </span>
                  )}
                  {!wt.isMain && wt.sessionCount > 0 && (
                    <span className="text-muted-foreground text-xs">
                      ({wt.sessionCount} session
                      {wt.sessionCount !== 1 ? "s" : ""})
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
            disabled={
              disabled || (skipPermissions && value.base === mainWorktree?.path)
            }
            className="border-border bg-background accent-primary h-4 w-4"
          />
          <label
            htmlFor="mode-direct"
            className={`cursor-pointer text-sm ${
              skipPermissions && value.base === mainWorktree?.path
                ? "text-muted-foreground"
                : ""
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

      {/* Mode description */}
      <p className="text-muted-foreground text-xs">
        {value.mode === "direct" ? (
          selectedWorktree?.isMain ? (
            "Work directly in the project directory"
          ) : (
            <>
              Share worktree with {selectedWorktree?.sessionCount || 0} other
              session
              {selectedWorktree?.sessionCount !== 1 ? "s" : ""}
            </>
          )
        ) : (
          <>
            Create a new branch from{" "}
            <span className="font-medium">
              {selectedWorktree?.branchName || "current branch"}
            </span>
          </>
        )}
      </p>

      {/* Disabled warning for skipPermissions */}
      {skipPermissions &&
        value.base === mainWorktree?.path &&
        value.mode === "direct" && (
          <p className="text-xs text-amber-500">
            Auto-approve requires an isolated worktree for container mounting
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
