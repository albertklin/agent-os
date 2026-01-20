"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DirectoryPicker } from "@/components/DirectoryPicker";

import { useNewSessionForm } from "./hooks/useNewSessionForm";
import { AgentSelector } from "./AgentSelector";
import { WorkingDirectoryInput } from "./WorkingDirectoryInput";
import { WorktreeSection } from "./WorktreeSection";
import { ProjectSelector } from "./ProjectSelector";
import { SessionOptions } from "./AdvancedSettings";
import { CreatingOverlay } from "./CreatingOverlay";
import type { NewSessionDialogProps } from "./NewSessionDialog.types";

export function NewSessionDialog({
  open,
  projects,
  selectedProjectId,
  onClose,
  onCreated,
}: NewSessionDialogProps) {
  const form = useNewSessionForm({
    open,
    projects,
    selectedProjectId,
    onCreated,
    onClose,
  });

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => !o && !form.isLoading && form.handleClose()}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          {/* Loading overlay */}
          {form.isLoading && (
            <CreatingOverlay
              isWorktree={form.useWorktree}
              step={form.creationStep}
            />
          )}
          <DialogHeader>
            <DialogTitle>New Session</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit} className="space-y-4">
            {/* 1. Project */}
            <ProjectSelector
              projects={projects}
              projectId={form.projectId}
              onProjectChange={form.handleProjectChange}
            />

            {/* 2. Directory */}
            <WorkingDirectoryInput
              value={form.workingDirectory}
              onChange={form.setWorkingDirectory}
              gitInfo={form.gitInfo}
              checkingGit={form.checkingGit}
              recentDirs={form.recentDirs}
              onBrowse={() => form.setShowDirectoryPicker(true)}
            />

            {/* 3. Name */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Name{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </label>
              <Input
                value={form.name}
                onChange={(e) => form.setName(e.target.value)}
                placeholder="Auto-generated if empty"
                className="h-8 text-sm"
              />
            </div>

            {/* 4. Agent + Model */}
            <AgentSelector
              agentType={form.agentType}
              onAgentChange={form.handleAgentTypeChange}
              model={form.model}
              onModelChange={form.handleModelChange}
            />

            {/* 5. Checkboxes row */}
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {form.gitInfo?.isGitRepo && (
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="useWorktree"
                    checked={form.useWorktree}
                    onChange={(e) =>
                      form.handleUseWorktreeChange(e.target.checked)
                    }
                    className="border-border bg-background accent-primary h-4 w-4 rounded"
                  />
                  <label
                    htmlFor="useWorktree"
                    className="cursor-pointer text-sm"
                  >
                    Isolated worktree
                  </label>
                </div>
              )}
              <SessionOptions
                agentType={form.agentType}
                skipPermissions={form.skipPermissions}
                onSkipPermissionsChange={form.handleSkipPermissionsChange}
              />
            </div>

            {/* 6. Worktree details (if enabled) */}
            {form.gitInfo?.isGitRepo && form.useWorktree && (
              <WorktreeSection
                gitInfo={form.gitInfo}
                featureName={form.featureName}
                onFeatureNameChange={form.setFeatureName}
                baseBranch={form.baseBranch}
                onBaseBranchChange={form.setBaseBranch}
              />
            )}

            {/* 7. Prompt (at bottom) */}
            <div className="space-y-1.5">
              <label htmlFor="initialPrompt" className="text-sm font-medium">
                Prompt{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </label>
              <Textarea
                id="initialPrompt"
                value={form.initialPrompt}
                onChange={(e) => form.setInitialPrompt(e.target.value)}
                placeholder="What would you like to work on?"
                className="min-h-[80px] resize-none text-sm"
                rows={3}
              />
            </div>

            {form.error && <p className="text-sm text-red-500">{form.error}</p>}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={form.handleClose}
                disabled={form.isLoading}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  form.isLoading ||
                  (form.useWorktree && !form.featureName.trim())
                }
              >
                {form.isLoading ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DirectoryPicker
        open={form.showDirectoryPicker}
        onClose={() => form.setShowDirectoryPicker(false)}
        onSelect={(path) => form.setWorkingDirectory(path)}
        initialPath={
          form.workingDirectory !== "~" ? form.workingDirectory : "~"
        }
      />
    </>
  );
}
