"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, GitBranch } from "lucide-react";
import { useCreateProject } from "@/data/projects";

const RECENT_DIRS_KEY = "agentOS:recentDirectories";
const MAX_RECENT_DIRS = 5;

interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (projectId: string) => void;
}

export function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: NewProjectDialogProps) {
  const [name, setName] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState("~");
  const [error, setError] = useState<string | null>(null);
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [checkingDir, setCheckingDir] = useState(false);

  const createProject = useCreateProject();

  // Load recent directories
  useEffect(() => {
    try {
      const saved = localStorage.getItem(RECENT_DIRS_KEY);
      if (saved) {
        setRecentDirs(JSON.parse(saved));
      }
    } catch {
      // Ignore
    }
  }, []);

  // Check if directory exists and is a git repo
  const checkDirectory = useCallback(async (path: string) => {
    if (!path || path === "~") {
      setIsGitRepo(false);
      return;
    }

    setCheckingDir(true);
    try {
      const res = await fetch("/api/git/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = await res.json();
      setIsGitRepo(data.isGitRepo);
    } catch {
      setIsGitRepo(false);
    } finally {
      setCheckingDir(false);
    }
  }, []);

  // Debounce directory check
  useEffect(() => {
    const timer = setTimeout(() => {
      checkDirectory(workingDirectory);
    }, 500);
    return () => clearTimeout(timer);
  }, [workingDirectory, checkDirectory]);

  // Save recent directory
  const addRecentDirectory = useCallback((dir: string) => {
    if (!dir || dir === "~") return;
    setRecentDirs((prev) => {
      const filtered = prev.filter((d) => d !== dir);
      const updated = [dir, ...filtered].slice(0, MAX_RECENT_DIRS);
      localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Project name is required");
      return;
    }

    if (!workingDirectory || workingDirectory === "~") {
      setError("Working directory is required");
      return;
    }

    createProject.mutate(
      {
        name: name.trim(),
        workingDirectory,
      },
      {
        onSuccess: (data) => {
          addRecentDirectory(workingDirectory);
          handleClose();
          onCreated(data.project.id);
        },
        onError: (err) => {
          setError(err.message || "Failed to create project");
        },
      }
    );
  };

  const handleClose = () => {
    setName("");
    setWorkingDirectory("~");
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Project Name */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Project Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-awesome-project"
              autoFocus
            />
          </div>

          {/* Working Directory */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Working Directory</label>
            <div className="relative">
              <Input
                value={workingDirectory}
                onChange={(e) => setWorkingDirectory(e.target.value)}
                placeholder="~/projects/my-app"
              />
              {checkingDir && (
                <div className="absolute top-1/2 right-3 -translate-y-1/2">
                  <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
                </div>
              )}
            </div>
            {isGitRepo && (
              <p className="text-muted-foreground flex items-center gap-1 text-xs">
                <GitBranch className="h-3 w-3" />
                Git repository
              </p>
            )}
            {recentDirs.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {recentDirs.map((dir) => (
                  <button
                    key={dir}
                    type="button"
                    onClick={() => setWorkingDirectory(dir)}
                    className="bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground max-w-[200px] truncate rounded-full px-2 py-0.5 text-xs transition-colors"
                    title={dir}
                  >
                    {dir.replace(/^~\//, "").split("/").pop() || dir}
                  </button>
                ))}
              </div>
            )}
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={createProject.isPending}>
              {createProject.isPending ? "Creating..." : "Create Project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
