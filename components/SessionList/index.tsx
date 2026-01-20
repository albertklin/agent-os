"use client";

import { useState, useMemo, useCallback } from "react";
import {
  ProjectsSection,
  NewProjectDialog,
  ProjectSettingsDialog,
} from "@/components/Projects";
import { FolderPicker } from "@/components/FolderPicker";
import { SelectionToolbar } from "./SelectionToolbar";
import { SessionListHeader } from "./SessionListHeader";
import { GroupSection } from "./GroupSection";
import { KillAllConfirm } from "./KillAllConfirm";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { useSessionListMutations } from "./hooks/useSessionListMutations";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { ProjectSectionSkeleton } from "@/components/ui/skeleton";
import { Plus, FolderPlus, AlertCircle } from "lucide-react";
import type { Project } from "@/lib/db";
import { usePanes } from "@/contexts/PaneContext";

// Data hooks
import { useSessionsQuery, useReorderSessions } from "@/data/sessions";
import { useProjectsQuery, useCreateProject } from "@/data/projects";

import type { SessionListProps } from "./SessionList.types";
import type { ForkOptions } from "@/components/ForkSessionDialog";

export type { SessionListProps } from "./SessionList.types";

export function SessionList({
  activeSessionId,
  sessionStatuses,
  connectionStatus,
  onSelect,
  onOpenInTab,
  onNewSessionInProject,
  onOpenTerminal,
}: SessionListProps) {
  const { clearSessionFromTabs } = usePanes();

  // Fetch data directly with loading states
  const {
    data: sessionsData,
    isPending: isSessionsPending,
    isError: isSessionsError,
    error: sessionsError,
  } = useSessionsQuery();
  const {
    data: projects = [],
    isPending: isProjectsPending,
    isError: isProjectsError,
  } = useProjectsQuery();

  // Combined loading state for initial load
  const isInitialLoading = isSessionsPending || isProjectsPending;
  const hasError = isSessionsError || isProjectsError;

  const sessions = sessionsData?.sessions ?? [];
  const groups = sessionsData?.groups ?? [];

  // All mutations via custom hook
  const mutations = useSessionListMutations({
    onSelectSession: onSelect,
    onSessionDeleted: clearSessionFromTabs,
  });

  // Wrapper to transform fork handler signature for child components
  const handleForkSession = useCallback(
    async (sessionId: string, options: ForkOptions | null) => {
      if (options) {
        await mutations.handleForkSession({
          sessionId,
          useWorktree: options.useWorktree,
          featureName: options.featureName,
          baseBranch: options.baseBranch,
        });
      } else {
        await mutations.handleForkSession({ sessionId });
      }
    },
    [mutations]
  );

  // Project creation mutation for folder picker
  const createProject = useCreateProject();

  // Session reorder mutation for drag and drop
  const reorderSessions = useReorderSessions();

  // Local UI state
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showKillAllConfirm, setShowKillAllConfirm] = useState(false);

  // Use projects if available
  const useProjectsView = projects.length > 0;

  // Flatten all session IDs for bulk operations
  const allSessionIds = useMemo(() => sessions.map((s) => s.id), [sessions]);

  // Create a map of session ID to name for delete confirmations
  const sessionNames = useMemo(
    () => new Map(sessions.map((s) => [s.id, s.name])),
    [sessions]
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <SessionListHeader
        onNewProject={() => setShowNewProjectDialog(true)}
        onOpenProject={() => setShowFolderPicker(true)}
        onKillAll={() => setShowKillAllConfirm(true)}
        connectionStatus={connectionStatus}
      />

      {/* Kill All Confirmation */}
      {showKillAllConfirm && (
        <KillAllConfirm
          onCancel={() => setShowKillAllConfirm(false)}
          onComplete={() => setShowKillAllConfirm(false)}
        />
      )}

      {/* Selection Toolbar */}
      <SelectionToolbar
        allSessionIds={allSessionIds}
        sessionNames={sessionNames}
        onDeleteSessions={mutations.handleBulkDelete}
      />

      {/* Session list */}
      <ScrollArea className="w-full flex-1">
        <div className="max-w-full space-y-0.5 px-1.5 py-1">
          {/* Loading state */}
          {isInitialLoading && <ProjectSectionSkeleton count={2} />}

          {/* Error state */}
          {hasError && !isInitialLoading && (
            <div className="flex flex-col items-center justify-center px-4 py-12">
              <AlertCircle className="text-destructive/50 mb-3 h-10 w-10" />
              <p className="text-destructive mb-2 text-sm">
                Failed to load sessions
              </p>
              <p className="text-muted-foreground mb-4 text-xs">
                {sessionsError?.message || "Unknown error"}
              </p>
              <Button
                variant="outline"
                onClick={mutations.handleRefresh}
                className="gap-2"
              >
                Retry
              </Button>
            </div>
          )}

          {/* Empty state */}
          {!isInitialLoading &&
            !hasError &&
            sessions.length === 0 &&
            projects.length <= 1 && (
              <div className="flex flex-col items-center justify-center px-4 py-12">
                <FolderPlus className="text-muted-foreground/50 mb-3 h-10 w-10" />
                <p className="text-muted-foreground mb-4 text-center text-sm">
                  Create a project to organize your sessions
                </p>
                <Button
                  onClick={() => setShowNewProjectDialog(true)}
                  className="gap-2"
                >
                  <Plus className="h-4 w-4" />
                  New Project
                </Button>
              </div>
            )}

          {/* Content - Projects view */}
          {!isInitialLoading && !hasError && useProjectsView && (
            <ProjectsSection
              projects={projects}
              sessions={sessions}
              groups={groups}
              activeSessionId={activeSessionId}
              sessionStatuses={sessionStatuses}
              isForkingSession={mutations.isForkingSession}
              onToggleProject={mutations.handleToggleProject}
              onEditProject={(projectId) => {
                const project = projects.find((p) => p.id === projectId);
                if (project) setEditingProject(project);
              }}
              onDeleteProject={mutations.handleDeleteProject}
              onRenameProject={mutations.handleRenameProject}
              onNewSession={onNewSessionInProject}
              onOpenTerminal={onOpenTerminal}
              onSelectSession={onSelect}
              onOpenSessionInTab={onOpenInTab}
              onReorderSessions={(updates) => reorderSessions.mutate(updates)}
              onForkSession={handleForkSession}
              onDeleteSession={mutations.handleDeleteSession}
              onRenameSession={mutations.handleRenameSession}
            />
          )}

          {/* Content - Group view (fallback when no projects) */}
          {!isInitialLoading &&
            !hasError &&
            !useProjectsView &&
            sessions.length > 0 && (
              <GroupSection
                groups={groups}
                sessions={sessions}
                activeSessionId={activeSessionId}
                sessionStatuses={sessionStatuses}
                isForkingSession={mutations.isForkingSession}
                onToggleGroup={mutations.handleToggleGroup}
                onCreateGroup={mutations.handleCreateGroup}
                onDeleteGroup={mutations.handleDeleteGroup}
                onSelectSession={onSelect}
                onForkSession={handleForkSession}
                onDeleteSession={mutations.handleDeleteSession}
                onRenameSession={mutations.handleRenameSession}
              />
            )}
        </div>
      </ScrollArea>

      {/* New Project Dialog */}
      <NewProjectDialog
        open={showNewProjectDialog}
        onClose={() => setShowNewProjectDialog(false)}
        onCreated={() => setShowNewProjectDialog(false)}
      />

      {/* Folder Picker for Open Project */}
      {showFolderPicker && (
        <FolderPicker
          initialPath="~"
          onClose={() => setShowFolderPicker(false)}
          onSelect={(path) => {
            // Derive project name from folder path
            const parts = path.split("/").filter(Boolean);
            const name = parts[parts.length - 1] || "project";

            createProject.mutate(
              {
                name,
                workingDirectory: path,
              },
              {
                onSuccess: () => setShowFolderPicker(false),
                onError: (err) => {
                  console.error("Failed to create project:", err);
                  setShowFolderPicker(false);
                },
              }
            );
          }}
        />
      )}

      {/* Project Settings Dialog */}
      <ProjectSettingsDialog
        project={editingProject}
        open={editingProject !== null}
        onClose={() => setEditingProject(null)}
        onSave={() => setEditingProject(null)}
      />

      {/* Delete Session Dialog */}
      <DeleteSessionDialog
        open={mutations.deleteDialogState.open}
        onOpenChange={(open) => {
          if (!open) mutations.closeDeleteDialog();
        }}
        sessionId={mutations.deleteDialogState.sessionId}
        sessionName={mutations.deleteDialogState.sessionName}
        onConfirm={mutations.confirmDeleteSession}
      />
    </div>
  );
}
