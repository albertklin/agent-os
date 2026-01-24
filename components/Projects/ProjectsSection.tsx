"use client";

import React, { useMemo, useCallback, memo, useState, useEffect } from "react";
import { useSnapshot } from "valtio";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ProjectCard } from "./ProjectCard";
import { SessionCard } from "@/components/SessionCard";
import { type ForkOptions } from "@/components/ForkSessionDialog";
import { selectionStore, selectionActions } from "@/stores/sessionSelection";
import type { Session, Group, Project } from "@/lib/db";
import type { SessionOrderUpdate } from "@/data/sessions";
import type { ProjectOrderUpdate } from "@/data/projects/queries";
import type { SessionStatus } from "@/components/SessionList/SessionList.types";

interface ProjectsSectionProps {
  projects: Project[];
  sessions: Session[];
  groups: Group[]; // For backward compatibility with SessionCard move feature
  activeSessionId?: string;
  sessionStatuses?: Record<string, SessionStatus>;
  isForkingSession?: boolean;
  onToggleProject?: (projectId: string, expanded: boolean) => void;
  onEditProject?: (projectId: string) => void;
  onDeleteProject?: (projectId: string) => void;
  onRenameProject?: (projectId: string, newName: string) => void;
  onNewSession?: (projectId: string) => void;
  onOpenTerminal?: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onOpenSessionInTab?: (sessionId: string) => void;
  onReorderSessions?: (updates: SessionOrderUpdate[]) => void;
  onReorderProjects?: (updates: ProjectOrderUpdate[]) => void;
  onForkSession?: (sessionId: string, options: ForkOptions) => Promise<void>;
  onDeleteSession?: (sessionId: string, sessionName?: string) => void;
  onRenameSession?: (sessionId: string, newName: string) => void;
  onCreatePR?: (sessionId: string) => void;
  onSetStatus?: (
    sessionId: string,
    status: "idle" | "running" | "waiting"
  ) => void;
}

// Sortable wrapper for SessionCard
interface SortableSessionCardProps {
  session: Session;
  isActive: boolean;
  isForking?: boolean;
  tmuxStatus?: "idle" | "running" | "waiting" | "error" | "dead" | "unknown";
  setupStatus?: SessionStatus["setupStatus"];
  setupError?: string;
  lifecycleStatus?: SessionStatus["lifecycleStatus"];
  stale?: boolean;
  groups: Group[];
  isSelected: boolean;
  isInSelectMode: boolean;
  onToggleSelect: (shiftKey: boolean) => void;
  onClick: () => void;
  onOpenInTab?: () => void;
  onFork?: (options: ForkOptions) => Promise<void>;
  onDelete?: () => void;
  onRename?: (newName: string) => void;
  onCreatePR?: () => void;
  onSetStatus?: (status: "idle" | "running" | "waiting") => void;
}

function SortableSessionCard({
  session,
  isRecentlyDropped,
  ...props
}: SortableSessionCardProps & { isRecentlyDropped?: boolean }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: session.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    // Disable transition for recently dropped items to prevent animation glitch
    transition: isRecentlyDropped ? "none" : transition,
    // Hide while dragging OR just after drop (until re-render completes)
    opacity: isDragging || isRecentlyDropped ? 0 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <SessionCard session={session} {...props} />
    </div>
  );
}

// Sortable wrapper for entire project block (card + sessions)
interface SortableProjectBlockProps {
  project: Project;
  children: (isDragging: boolean) => React.ReactNode;
}

function SortableProjectBlock({
  project,
  children,
}: SortableProjectBlockProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `project-${project.id}`,
    disabled: project.is_uncategorized,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Hide while dragging - the DragOverlay shows the dragged item
    opacity: isDragging ? 0 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children(isDragging)}
    </div>
  );
}

// Drop zone for empty projects to allow dropping sessions into them
function ProjectDropZone({
  projectId,
  variant = "empty",
  isDraggingProject = false,
}: {
  projectId: string;
  variant?: "empty" | "end";
  isDraggingProject?: boolean;
}) {
  const { setNodeRef, isOver } = useSortable({
    id: `project-drop-${projectId}`,
  });

  // Only show hover effect when dragging a session, not a project
  const showHover = isOver && !isDraggingProject;

  if (variant === "end") {
    // Subtle drop zone at the end of a non-empty project
    return (
      <div
        ref={setNodeRef}
        className={`h-2 transition-colors ${showHover ? "bg-accent/50 rounded" : ""}`}
      />
    );
  }

  return (
    <div
      ref={setNodeRef}
      className={`text-muted-foreground px-2 py-2 text-xs transition-colors ${
        showHover ? "bg-accent/50 text-foreground rounded" : ""
      }`}
    >
      {showHover ? "Drop here" : "No sessions yet"}
    </div>
  );
}

// Droppable wrapper for collapsed project headers
function DroppableProjectHeader({
  projectId,
  children,
  isDraggingProject = false,
}: {
  projectId: string;
  children: React.ReactNode;
  isDraggingProject?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `project-header-${projectId}`,
  });

  // Only show hover effect when dragging a session, not a project
  const showHover = isOver && !isDraggingProject;

  return (
    <div
      ref={setNodeRef}
      className={showHover ? "ring-primary/50 rounded ring-2" : ""}
    >
      {children}
    </div>
  );
}

// Visual indicator for drop position during inter-project drags
function DropIndicator() {
  return (
    <div className="relative h-0.5 w-full">
      <div className="bg-primary absolute inset-x-0 top-0 h-0.5 rounded-full" />
      <div className="bg-primary absolute -top-1 -left-0.5 h-2.5 w-2.5 rounded-full" />
    </div>
  );
}

function ProjectsSectionComponent({
  projects,
  sessions,
  groups,
  activeSessionId,
  sessionStatuses,
  isForkingSession,
  onToggleProject,
  onEditProject,
  onDeleteProject,
  onRenameProject,
  onNewSession,
  onOpenTerminal,
  onSelectSession,
  onOpenSessionInTab,
  onReorderSessions,
  onReorderProjects,
  onForkSession,
  onDeleteSession,
  onRenameSession,
  onCreatePR,
  onSetStatus,
}: ProjectsSectionProps) {
  const { selectedIds } = useSnapshot(selectionStore);
  const isInSelectMode = selectedIds.size > 0;

  // Drag and drop state
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isDraggingProject, setIsDraggingProject] = useState(false);
  const [overId, setOverId] = useState<string | null>(null);
  const [overProjectId, setOverProjectId] = useState<string | null>(null);
  const [recentlyDroppedId, setRecentlyDroppedId] = useState<string | null>(
    null
  );

  // Clear recentlyDroppedId after the DOM has updated (prevents flash of item at old position)
  useEffect(() => {
    if (recentlyDroppedId) {
      const frame = requestAnimationFrame(() => {
        setRecentlyDroppedId(null);
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [recentlyDroppedId]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  // Flatten all session IDs for range selection (respecting render order)
  const allSessionIds = useMemo(() => {
    const ids: string[] = [];
    for (const project of projects) {
      const projectSessions = sessions.filter(
        (s) => (s.project_id || "uncategorized") === project.id
      );
      for (const session of projectSessions) {
        ids.push(session.id);
      }
    }
    return ids;
  }, [projects, sessions]);

  // Handler for toggling session selection
  const handleToggleSelect = useCallback(
    (sessionId: string, shiftKey: boolean) => {
      selectionActions.toggle(sessionId, shiftKey, allSessionIds);
    },
    [allSessionIds]
  );

  // Group sessions by project_id (memoized to prevent recalculation)
  const sessionsByProject = useMemo(
    () =>
      sessions.reduce(
        (acc, session) => {
          const projectId = session.project_id || "uncategorized";
          if (!acc[projectId]) acc[projectId] = [];
          acc[projectId].push(session);
          return acc;
        },
        {} as Record<string, Session[]>
      ),
    [sessions]
  );

  // Find the active dragged session
  const activeSession = useMemo(
    () => (activeId ? sessions.find((s) => s.id === activeId) : null),
    [activeId, sessions]
  );

  // Find the active dragged project (for drag overlay)
  const activeProject = useMemo(
    () =>
      activeId && isDraggingProject
        ? projects.find((p) => `project-${p.id}` === activeId)
        : null,
    [activeId, isDraggingProject, projects]
  );

  // Handle drag start
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = event.active.id as string;
    setActiveId(id);
    setIsDraggingProject(id.startsWith("project-"));
  }, []);

  // Handle drag over to track which project and item we're over
  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { over } = event;
      if (!over) {
        setOverId(null);
        setOverProjectId(null);
        return;
      }

      // Check if we're over a project drop zone, header, or a session
      const currentOverId = over.id as string;
      setOverId(currentOverId);

      if (currentOverId.startsWith("project-drop-")) {
        setOverProjectId(currentOverId.replace("project-drop-", ""));
      } else if (currentOverId.startsWith("project-header-")) {
        setOverProjectId(currentOverId.replace("project-header-", ""));
      } else if (currentOverId.startsWith("project-")) {
        // Over a project block (SortableProjectBlock) - check if it's a valid project
        const potentialProjectId = currentOverId.replace("project-", "");
        const targetProject = projects.find((p) => p.id === potentialProjectId);
        if (targetProject) {
          setOverProjectId(potentialProjectId);
        } else {
          // Not a valid project, might be a session
          const overSession = sessions.find((s) => s.id === currentOverId);
          if (overSession) {
            setOverProjectId(overSession.project_id || "uncategorized");
          }
        }
      } else {
        // We're over a session - find its project
        const overSession = sessions.find((s) => s.id === currentOverId);
        if (overSession) {
          setOverProjectId(overSession.project_id || "uncategorized");
        }
      }
    },
    [sessions, projects]
  );

  // Handle drag end - reorder sessions or projects
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const activeItemId = active.id as string;
      const wasDraggingProject = activeItemId.startsWith("project-");

      // Set recentlyDroppedId before clearing activeId to prevent flash
      setRecentlyDroppedId(activeItemId);
      setActiveId(null);
      setIsDraggingProject(false);
      setOverId(null);
      setOverProjectId(null);

      if (!over) return;
      const overId = over.id as string;

      // Handle project reordering
      if (wasDraggingProject) {
        if (!onReorderProjects) return;
        if (!overId.startsWith("project-")) return;

        const activeProjectId = activeItemId.replace("project-", "");
        const overProjectId = overId.replace("project-", "");

        if (activeProjectId === overProjectId) return;

        // Filter out uncategorized for reordering (it stays at the end)
        const reorderableProjects = projects.filter((p) => !p.is_uncategorized);
        const oldIndex = reorderableProjects.findIndex(
          (p) => p.id === activeProjectId
        );
        const newIndex = reorderableProjects.findIndex(
          (p) => p.id === overProjectId
        );

        if (oldIndex === -1 || newIndex === -1) return;

        const newOrder = arrayMove(reorderableProjects, oldIndex, newIndex);
        const updates: ProjectOrderUpdate[] = newOrder.map(
          (project, index) => ({
            projectId: project.id,
            sortOrder: index,
          })
        );

        onReorderProjects(updates);
        return;
      }

      // Handle session reordering
      if (!onReorderSessions) return;

      // Find the active session and its current project
      const draggedSession = sessions.find((s) => s.id === activeItemId);
      if (!draggedSession) return;

      const sourceProjectId = draggedSession.project_id || "uncategorized";
      const sourceSessions = sessionsByProject[sourceProjectId] || [];
      const sourceIndex = sourceSessions.findIndex(
        (s) => s.id === activeItemId
      );

      // Determine the target project and position
      let targetProjectId: string;
      let targetIndex: number;

      if (
        overId.startsWith("project-drop-") ||
        overId.startsWith("project-header-")
      ) {
        // Dropped on an empty project drop zone or collapsed project header
        targetProjectId = overId
          .replace("project-drop-", "")
          .replace("project-header-", "");
        const targetSessions = sessionsByProject[targetProjectId] || [];
        targetIndex = targetSessions.length; // Add to end of project
      } else if (overId.startsWith("project-")) {
        // Dropped on a project block (SortableProjectBlock) - treat like dropping on header
        // This can happen due to collision detection picking up the outer sortable wrapper
        targetProjectId = overId.replace("project-", "");
        // Verify it's a valid project (not a session with "project-" prefix)
        const targetProject = projects.find((p) => p.id === targetProjectId);
        if (!targetProject) {
          // Not a valid project, fall through to session handling
          const overSession = sessions.find((s) => s.id === overId);
          if (!overSession) return;
          targetProjectId = overSession.project_id || "uncategorized";
          const targetSessions = sessionsByProject[targetProjectId] || [];
          targetIndex = targetSessions.findIndex((s) => s.id === overId);
          if (targetIndex === -1) targetIndex = targetSessions.length;
        } else {
          const targetSessions = sessionsByProject[targetProjectId] || [];
          targetIndex = targetSessions.length; // Add to end of project
        }
      } else {
        // Dropped on or near a session
        const overSession = sessions.find((s) => s.id === overId);
        if (!overSession) return;

        targetProjectId = overSession.project_id || "uncategorized";
        const targetSessions = sessionsByProject[targetProjectId] || [];
        targetIndex = targetSessions.findIndex((s) => s.id === overId);
        if (targetIndex === -1) targetIndex = targetSessions.length;
      }

      // Build the updated order for all affected sessions
      const updates: SessionOrderUpdate[] = [];

      if (sourceProjectId === targetProjectId) {
        // Reordering within the same project - use arrayMove for correct positioning
        if (sourceIndex === targetIndex) return; // No change

        const newOrder = arrayMove(sourceSessions, sourceIndex, targetIndex);
        newOrder.forEach((session, index) => {
          updates.push({
            sessionId: session.id,
            projectId: targetProjectId,
            sortOrder: index,
          });
        });
      } else {
        // Moving to a different project
        // Update source project order (removing the session)
        const newSourceOrder = sourceSessions.filter(
          (s) => s.id !== activeItemId
        );
        newSourceOrder.forEach((session, index) => {
          updates.push({
            sessionId: session.id,
            projectId: sourceProjectId,
            sortOrder: index,
          });
        });

        // Update target project order (inserting the session)
        const targetSessions = sessionsByProject[targetProjectId] || [];
        const newTargetOrder = [...targetSessions];
        newTargetOrder.splice(targetIndex, 0, draggedSession);
        newTargetOrder.forEach((session, index) => {
          updates.push({
            sessionId: session.id,
            projectId: targetProjectId,
            sortOrder: index,
          });
        });
      }

      onReorderSessions(updates);
    },
    [
      sessions,
      sessionsByProject,
      projects,
      onReorderSessions,
      onReorderProjects,
    ]
  );

  // Project sortable IDs (exclude uncategorized as it always stays at the end)
  const projectSortableIds = useMemo(
    () =>
      projects.filter((p) => !p.is_uncategorized).map((p) => `project-${p.id}`),
    [projects]
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={projectSortableIds}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-1">
          {projects.map((project) => {
            const projectSessions = sessionsByProject[project.id] || [];
            // Only show as drop target for inter-project session drags (not project reordering)
            const activeSessionProjectId =
              activeSession?.project_id || "uncategorized";
            const isDropTarget = !!(
              overProjectId === project.id &&
              activeId &&
              !isDraggingProject &&
              activeSessionProjectId !== project.id
            );

            const projectCardProps = {
              project,
              sessionCount: projectSessions.length,
              isDropTarget,
              onToggleExpanded: (expanded: boolean) =>
                onToggleProject?.(project.id, expanded),
              onEdit:
                !project.is_uncategorized && onEditProject
                  ? () => onEditProject(project.id)
                  : undefined,
              onNewSession: onNewSession
                ? () => onNewSession(project.id)
                : undefined,
              onOpenTerminal: onOpenTerminal
                ? () => onOpenTerminal(project.id)
                : undefined,
              onDelete:
                !project.is_uncategorized && onDeleteProject
                  ? () => onDeleteProject(project.id)
                  : undefined,
              onRename: onRenameProject
                ? (newName: string) => onRenameProject(project.id, newName)
                : undefined,
            };

            // Render function for project contents (used by both sortable and non-sortable paths)
            const renderProjectContent = (isDraggingThis: boolean) => (
              <div className="space-y-0.5">
                {/* Project header - wrap with droppable when collapsed AND dragging a session */}
                {/* Don't use DroppableProjectHeader when dragging a project - it interferes with sortable */}
                {!project.expanded && !isDraggingProject ? (
                  <DroppableProjectHeader
                    projectId={project.id}
                    isDraggingProject={isDraggingProject}
                  >
                    <ProjectCard
                      {...projectCardProps}
                      isDragging={isDraggingThis}
                    />
                  </DroppableProjectHeader>
                ) : (
                  <ProjectCard
                    {...projectCardProps}
                    isDragging={isDraggingThis}
                  />
                )}

                {/* Project contents when expanded */}
                {project.expanded && (
                  <div
                    className={`border-border/30 ml-3 space-y-px border-l pl-1.5 ${
                      isDropTarget ? "bg-accent/30 rounded" : ""
                    }`}
                  >
                    {/* Project sessions with sortable context */}
                    {(() => {
                      // Calculate if this is an inter-project drag targeting this project
                      // Only applies when dragging a session (not a project)
                      const activeSessionProjectId =
                        activeSession?.project_id || "uncategorized";
                      const isInterProjectDrag =
                        activeId &&
                        !isDraggingProject &&
                        activeSessionProjectId !== project.id;
                      const isInterProjectDragToThisProject =
                        isInterProjectDrag && overProjectId === project.id;

                      // Only include end drop zone in sortable items during inter-project drags
                      // For intra-project reordering, the sortable strategy handles end positioning
                      const sortableItems = isInterProjectDrag
                        ? [
                            ...projectSessions.map((s) => s.id),
                            `project-drop-${project.id}`,
                          ]
                        : projectSessions.map((s) => s.id);

                      if (projectSessions.length === 0) {
                        return (
                          <SortableContext
                            items={[`project-drop-${project.id}`]}
                            strategy={verticalListSortingStrategy}
                          >
                            <ProjectDropZone
                              projectId={project.id}
                              isDraggingProject={isDraggingProject}
                            />
                          </SortableContext>
                        );
                      }

                      return (
                        <SortableContext
                          items={sortableItems}
                          strategy={verticalListSortingStrategy}
                        >
                          {projectSessions.map((session) => {
                            // Show drop indicator before this session when:
                            // 1. This is an inter-project drag
                            // 2. This session is being hovered over
                            const showDropIndicator =
                              isInterProjectDragToThisProject &&
                              overId === session.id;

                            return (
                              <React.Fragment key={session.id}>
                                {showDropIndicator && <DropIndicator />}
                                <SortableSessionCard
                                  session={session}
                                  isRecentlyDropped={
                                    session.id === recentlyDroppedId
                                  }
                                  isActive={session.id === activeSessionId}
                                  isForking={isForkingSession}
                                  tmuxStatus={
                                    sessionStatuses?.[session.id]?.status
                                  }
                                  setupStatus={
                                    sessionStatuses?.[session.id]?.setupStatus
                                  }
                                  setupError={
                                    sessionStatuses?.[session.id]?.setupError
                                  }
                                  lifecycleStatus={
                                    sessionStatuses?.[session.id]
                                      ?.lifecycleStatus
                                  }
                                  stale={sessionStatuses?.[session.id]?.stale}
                                  groups={groups}
                                  isSelected={selectedIds.has(session.id)}
                                  isInSelectMode={isInSelectMode}
                                  onToggleSelect={(shiftKey) =>
                                    handleToggleSelect(session.id, shiftKey)
                                  }
                                  onClick={() => onSelectSession(session.id)}
                                  onOpenInTab={
                                    onOpenSessionInTab
                                      ? () => onOpenSessionInTab(session.id)
                                      : undefined
                                  }
                                  onFork={
                                    onForkSession
                                      ? async (options) =>
                                          onForkSession(session.id, options)
                                      : undefined
                                  }
                                  onDelete={
                                    onDeleteSession
                                      ? () =>
                                          onDeleteSession(
                                            session.id,
                                            session.name
                                          )
                                      : undefined
                                  }
                                  onRename={
                                    onRenameSession
                                      ? (newName) =>
                                          onRenameSession(session.id, newName)
                                      : undefined
                                  }
                                  onCreatePR={
                                    onCreatePR
                                      ? () => onCreatePR(session.id)
                                      : undefined
                                  }
                                  onSetStatus={
                                    onSetStatus
                                      ? (status) =>
                                          onSetStatus(session.id, status)
                                      : undefined
                                  }
                                />
                              </React.Fragment>
                            );
                          })}
                          {/* Drop zone at end of list - only during inter-project drags */}
                          {isInterProjectDrag && (
                            <ProjectDropZone
                              projectId={project.id}
                              variant="end"
                              isDraggingProject={isDraggingProject}
                            />
                          )}
                          {/* Show indicator at the end when dropping on project drop zone */}
                          {isInterProjectDragToThisProject &&
                            overId === `project-drop-${project.id}` && (
                              <DropIndicator />
                            )}
                        </SortableContext>
                      );
                    })()}
                  </div>
                )}
              </div>
            );

            // Wrap non-uncategorized projects with SortableProjectBlock
            return project.is_uncategorized ? (
              <div key={project.id}>{renderProjectContent(false)}</div>
            ) : (
              <SortableProjectBlock key={project.id} project={project}>
                {renderProjectContent}
              </SortableProjectBlock>
            );
          })}
        </div>
      </SortableContext>

      {/* Drag overlay for visual feedback - disable drop animation to prevent snap-back */}
      <DragOverlay dropAnimation={null}>
        {activeProject ? (
          <div className="bg-background rounded border opacity-90 shadow-lg">
            <div className="space-y-0.5">
              <ProjectCard
                project={activeProject}
                sessionCount={sessionsByProject[activeProject.id]?.length || 0}
              />
              {activeProject.expanded && (
                <div className="border-border/30 ml-3 space-y-px border-l pl-1.5">
                  {(sessionsByProject[activeProject.id] || []).map(
                    (session) => (
                      <SessionCard
                        key={session.id}
                        session={session}
                        isActive={session.id === activeSessionId}
                        groups={groups}
                        isSelected={false}
                        isInSelectMode={false}
                        onToggleSelect={() => {}}
                        onClick={() => {}}
                      />
                    )
                  )}
                  {(sessionsByProject[activeProject.id] || []).length === 0 && (
                    <div className="text-muted-foreground px-2 py-2 text-xs">
                      No sessions yet
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : activeSession ? (
          <div className="bg-background rounded border opacity-90 shadow-lg">
            <SessionCard
              session={activeSession}
              isActive={false}
              groups={groups}
              isSelected={false}
              isInSelectMode={false}
              onToggleSelect={() => {}}
              onClick={() => {}}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * Memoized ProjectsSection to prevent unnecessary re-renders
 */
export const ProjectsSection = memo(ProjectsSectionComponent);
