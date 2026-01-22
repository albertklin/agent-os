/**
 * Projects Module
 *
 * Projects are workspaces that contain sessions.
 * Sessions inherit settings from their parent project.
 */

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { db, queries, type Project, type Session } from "./db";

export interface CreateProjectOptions {
  name: string;
  workingDirectory: string;
}

// Generate project ID
function generateProjectId(): string {
  return `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Create a new project
 */
export function createProject(opts: CreateProjectOptions): Project {
  const id = generateProjectId();

  // Get next sort order
  const projects = queries.getAllProjects(db).all() as Project[];
  const maxOrder = projects.reduce((max, p) => Math.max(max, p.sort_order), 0);

  queries
    .createProject(db)
    .run(id, opts.name, opts.workingDirectory, maxOrder + 1);

  const project = queries.getProject(db).get(id) as Project;
  return {
    ...project,
    expanded: Boolean(project.expanded),
    is_uncategorized: Boolean(project.is_uncategorized),
  };
}

/**
 * Get a project by ID
 */
export function getProject(id: string): Project | undefined {
  const project = queries.getProject(db).get(id) as Project | undefined;
  if (!project) return undefined;
  return {
    ...project,
    expanded: Boolean(project.expanded),
    is_uncategorized: Boolean(project.is_uncategorized),
  };
}

/**
 * Get all projects (sorted by sort_order, with uncategorized last)
 */
export function getAllProjects(): Project[] {
  const projects = queries.getAllProjects(db).all() as Project[];
  return projects.map((p) => ({
    ...p,
    expanded: Boolean(p.expanded),
    is_uncategorized: Boolean(p.is_uncategorized),
  }));
}

/**
 * Update a project's settings
 */
export function updateProject(
  id: string,
  updates: Partial<Pick<Project, "name" | "working_directory">>
): Project | undefined {
  const project = getProject(id);
  if (!project || project.is_uncategorized) return undefined;

  queries
    .updateProject(db)
    .run(
      updates.name ?? project.name,
      updates.working_directory ?? project.working_directory,
      id
    );

  return getProject(id);
}

/**
 * Toggle project expanded state
 */
export function toggleProjectExpanded(id: string, expanded: boolean): void {
  queries.updateProjectExpanded(db).run(expanded ? 1 : 0, id);
}

/**
 * Update project session defaults (extra mounts and allowed domains)
 */
export function updateProjectDefaults(
  id: string,
  defaults: {
    default_extra_mounts?: string | null;
    default_allowed_domains?: string | null;
  }
): Project | undefined {
  const project = getProject(id);
  if (!project || project.is_uncategorized) return undefined;

  queries
    .updateProjectDefaults(db)
    .run(
      defaults.default_extra_mounts ?? project.default_extra_mounts,
      defaults.default_allowed_domains ?? project.default_allowed_domains,
      id
    );

  return getProject(id);
}

/**
 * Delete a project (moves sessions to Uncategorized)
 */
export function deleteProject(id: string): boolean {
  const project = getProject(id);
  if (!project || project.is_uncategorized) return false;

  // Move all sessions to Uncategorized (single batch query instead of N queries)
  queries.moveAllSessionsToProject(db).run("uncategorized", id);

  // Delete project
  queries.deleteProject(db).run(id);
  return true;
}

/**
 * Get sessions for a project
 */
export function getProjectSessions(projectId: string): Session[] {
  return queries.getSessionsByProject(db).all(projectId) as Session[];
}

/**
 * Validate a working directory exists
 */
export function validateWorkingDirectory(dir: string): boolean {
  const expandedDir = dir.replace(/^~/, process.env.HOME || "~");
  try {
    return fs.existsSync(expandedDir) && fs.statSync(expandedDir).isDirectory();
  } catch {
    return false;
  }
}

export interface ProjectOrderUpdate {
  projectId: string;
  sortOrder: number;
}

/**
 * Reorder projects by updating their sort_order values
 */
export function reorderProjects(updates: ProjectOrderUpdate[]): void {
  const updateStmt = queries.updateProjectOrder(db);
  for (const update of updates) {
    updateStmt.run(update.sortOrder, update.projectId);
  }
}
