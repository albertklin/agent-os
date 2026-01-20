"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GitBranch, Loader2 } from "lucide-react";
import { generateFeatureName } from "@/components/NewSessionDialog/NewSessionDialog.types";

export interface ForkOptions {
  useWorktree: boolean;
  featureName: string;
  baseBranch: string;
}

interface ForkSessionDialogProps {
  sessionId: string;
  sessionName: string;
  workingDirectory: string;
  currentBranch?: string | null;
  defaultBaseBranch?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFork: (options: ForkOptions | null) => Promise<void>;
  isPending?: boolean;
}

export function ForkSessionDialog({
  sessionId,
  sessionName,
  workingDirectory,
  currentBranch,
  defaultBaseBranch = "main",
  open,
  onOpenChange,
  onFork,
  isPending = false,
}: ForkSessionDialogProps) {
  const [useWorktree, setUseWorktree] = useState(false);
  const [featureName, setFeatureName] = useState("");
  const [baseBranch, setBaseBranch] = useState(
    currentBranch || defaultBaseBranch
  );
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);

  // Fetch branches when dialog opens
  useEffect(() => {
    if (open && workingDirectory) {
      setLoadingBranches(true);
      fetch("/api/git/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: workingDirectory }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.branches && data.branches.length > 0) {
            setBranches(data.branches);
          }
        })
        .catch(console.error)
        .finally(() => setLoadingBranches(false));
    }
  }, [open, workingDirectory]);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setUseWorktree(false);
      setFeatureName("");
      setBaseBranch(currentBranch || defaultBaseBranch);
    }
  }, [open, currentBranch, defaultBaseBranch]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (useWorktree) {
      if (!featureName.trim()) {
        return;
      }
      await onFork({
        useWorktree: true,
        featureName: featureName.trim(),
        baseBranch,
      });
    } else {
      // Simple fork without worktree
      await onFork(null);
    }

    onOpenChange(false);
  };

  const canSubmit = !useWorktree || featureName.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Fork Session</DialogTitle>
          <DialogDescription>
            Create a copy of &ldquo;{sessionName}&rdquo; to work on
            independently.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Worktree Toggle */}
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <label
                htmlFor="use-worktree"
                className="flex items-center gap-2 text-sm font-medium"
              >
                <GitBranch className="h-4 w-4" />
                Create isolated worktree
              </label>
              <p className="text-muted-foreground text-xs">
                Work on a separate git branch without file conflicts
              </p>
            </div>
            <Switch
              id="use-worktree"
              checked={useWorktree}
              onCheckedChange={(checked) => {
                setUseWorktree(checked);
                // Auto-populate feature name when enabling worktree
                if (checked && !featureName) {
                  setFeatureName(generateFeatureName());
                }
              }}
            />
          </div>

          {/* Worktree Options - shown when toggle is on */}
          {useWorktree && (
            <div className="space-y-4 border-t pt-4">
              {/* Feature Name */}
              <div className="space-y-2">
                <label htmlFor="feature-name" className="text-sm font-medium">
                  Feature name <span className="text-red-500">*</span>
                </label>
                <Input
                  id="feature-name"
                  value={featureName}
                  onChange={(e) => setFeatureName(e.target.value)}
                  placeholder="e.g., add-user-auth"
                  autoFocus
                />
                <p className="text-muted-foreground text-xs">
                  Creates branch: feature/
                  {featureName.toLowerCase().replace(/\s+/g, "-") || "..."}
                </p>
              </div>

              {/* Base Branch */}
              <div className="space-y-2">
                <label htmlFor="base-branch" className="text-sm font-medium">
                  Base branch
                </label>
                <Select value={baseBranch} onValueChange={setBaseBranch}>
                  <SelectTrigger id="base-branch">
                    <SelectValue placeholder="Select branch" />
                  </SelectTrigger>
                  <SelectContent>
                    {loadingBranches ? (
                      <SelectItem value="_loading" disabled>
                        Loading branches...
                      </SelectItem>
                    ) : branches.length > 0 ? (
                      branches.map((branch) => (
                        <SelectItem key={branch} value={branch}>
                          {branch}
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value={baseBranch}>{baseBranch}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  Branch to create the worktree from
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || isPending}>
              {isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Forking...
                </>
              ) : (
                "Fork"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
