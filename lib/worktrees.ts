/**
 * Git Worktree management for isolated feature development
 */

import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  isGitRepo,
  branchExists,
  getRepoName,
  slugify,
  generateBranchName,
} from "./git";

const execAsync = promisify(exec);

// Base directory for all worktrees
const WORKTREES_DIR = path.join(os.homedir(), ".agent-os", "worktrees");

// Maximum number of worktrees allowed to prevent disk exhaustion
// Each worktree can be large (full git repo + dependencies)
const MAX_WORKTREES = 50;

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  projectPath: string;
  projectName: string;
}

export interface CreateWorktreeOptions {
  projectPath: string;
  featureName: string;
  baseBranch: string; // Required - no default to "main"
}

/**
 * Ensure the worktrees directory exists
 */
async function ensureWorktreesDir(): Promise<void> {
  await fs.promises.mkdir(WORKTREES_DIR, { recursive: true });
}

/**
 * Resolve a path, expanding ~ to home directory
 */
function resolvePath(p: string): string {
  return p.replace(/^~/, os.homedir());
}

/**
 * Get the main repository path from a worktree path.
 * Uses `git rev-parse --git-common-dir` to find the main repo's .git directory,
 * then derives the repo path from that.
 * Returns null if the path is not a valid worktree or git repo.
 */
export async function getMainRepoFromWorktree(
  worktreePath: string
): Promise<string | null> {
  const resolved = resolvePath(worktreePath);
  if (!fs.existsSync(resolved)) {
    return null;
  }

  try {
    // Get the absolute path to the main repo's .git directory
    const { stdout } = await execAsync(
      `git -C "${resolved}" rev-parse --path-format=absolute --git-common-dir`,
      { timeout: 5000 }
    );
    const gitCommonDir = path.normalize(stdout.trim());

    // gitCommonDir is the .git directory of the main repo (e.g., /path/to/repo/.git)
    // The repo path is its parent directory
    if (gitCommonDir.endsWith(".git")) {
      return path.dirname(gitCommonDir);
    }

    // Handle edge case: if path contains .git as a directory component
    // (e.g., /path/to/repo/.git/worktrees/foo), find the .git directory
    const parts = gitCommonDir.split(path.sep);
    const gitIndex = parts.lastIndexOf(".git");
    if (gitIndex !== -1) {
      return parts.slice(0, gitIndex).join(path.sep);
    }

    return null;
  } catch (error) {
    // Log for debugging but don't throw - caller handles null
    console.debug(
      `[worktrees] Failed to get main repo from ${worktreePath}:`,
      error instanceof Error ? error.message : "Unknown error"
    );
    return null;
  }
}

/**
 * Generate a unique worktree directory name
 */
function generateWorktreeDirName(
  projectName: string,
  featureName: string
): string {
  const featureSlug = slugify(featureName);
  return `${projectName}-${featureSlug}`;
}

/**
 * Create a new worktree for a feature branch
 */
export async function createWorktree(
  options: CreateWorktreeOptions
): Promise<WorktreeInfo> {
  const { projectPath, featureName, baseBranch } = options;

  const resolvedProjectPath = resolvePath(projectPath);

  // Validate project is a git repo
  if (!(await isGitRepo(resolvedProjectPath))) {
    throw new Error(`Not a git repository: ${projectPath}`);
  }

  // Check worktree count limit to prevent disk exhaustion
  await ensureWorktreesDir();
  try {
    const existingWorktrees = await fs.promises.readdir(WORKTREES_DIR);
    if (existingWorktrees.length >= MAX_WORKTREES) {
      throw new Error(
        `Maximum worktree limit (${MAX_WORKTREES}) reached. Please delete some existing sessions to create new ones.`
      );
    }
  } catch (error) {
    // If it's our limit error, re-throw it
    if (error instanceof Error && error.message.includes("Maximum worktree")) {
      throw error;
    }
    // Otherwise ignore (directory might not exist yet)
  }

  // Generate branch name
  const branchName = generateBranchName(featureName);

  // Check if branch already exists
  if (await branchExists(resolvedProjectPath, branchName)) {
    throw new Error(`Branch already exists: ${branchName}`);
  }

  // Generate worktree path
  const projectName = getRepoName(resolvedProjectPath);
  const worktreeDirName = generateWorktreeDirName(projectName, featureName);
  const worktreePath = path.join(WORKTREES_DIR, worktreeDirName);

  // Check if worktree path already exists
  if (fs.existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }

  // Ensure worktrees directory exists
  await ensureWorktreesDir();

  // Create the worktree with a new branch
  // Use local branches only (for local development)
  const refFormats = [
    `refs/heads/${baseBranch}`, // Local branch (explicit)
    baseBranch, // Bare name as fallback
  ];

  let lastError: Error | null = null;
  for (const ref of refFormats) {
    try {
      await execAsync(
        `git -C "${resolvedProjectPath}" worktree add -b "${branchName}" "${worktreePath}" "${ref}"`,
        { timeout: 30000 }
      );
      lastError = null;
      break; // Success!
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Continue to next ref format
    }
  }

  if (lastError) {
    throw new Error(`Failed to create worktree: ${lastError.message}`);
  }

  // Add project entry to ~/.claude.json to skip trust dialog
  addWorktreeProjectEntry(worktreePath);

  // Note: Submodule initialization is now handled by session-setup.ts
  // to avoid blocking the API response

  return {
    worktreePath,
    branchName,
    baseBranch,
    projectPath: resolvedProjectPath,
    projectName,
  };
}

/**
 * Delete a worktree and optionally its branch
 */
export async function deleteWorktree(
  worktreePath: string,
  projectPath: string,
  deleteBranch = false
): Promise<void> {
  const resolvedProjectPath = resolvePath(projectPath);
  const resolvedWorktreePath = resolvePath(worktreePath);

  // Get the branch name before removing (for optional deletion)
  let branchName: string | null = null;
  if (deleteBranch) {
    try {
      const { stdout } = await execAsync(
        `git -C "${resolvedWorktreePath}" rev-parse --abbrev-ref HEAD`,
        { timeout: 5000 }
      );
      branchName = stdout.trim();
    } catch {
      // Ignore - worktree might already be gone
    }
  }

  // Remove the worktree
  try {
    await execAsync(
      `git -C "${resolvedProjectPath}" worktree remove "${resolvedWorktreePath}" --force`,
      { timeout: 30000 }
    );
  } catch (error) {
    // If git worktree remove fails, try manual cleanup
    console.warn(
      `[worktrees] git worktree remove failed, attempting manual cleanup:`,
      error instanceof Error ? error.message : "Unknown error"
    );
    if (fs.existsSync(resolvedWorktreePath)) {
      await fs.promises.rm(resolvedWorktreePath, {
        recursive: true,
        force: true,
      });
    }
    // Prune worktree references
    try {
      await execAsync(`git -C "${resolvedProjectPath}" worktree prune`, {
        timeout: 10000,
      });
    } catch (pruneError) {
      console.warn(
        `[worktrees] git worktree prune failed:`,
        pruneError instanceof Error ? pruneError.message : "Unknown error"
      );
    }
  }

  // Optionally delete the branch
  if (
    deleteBranch &&
    branchName &&
    branchName !== "main" &&
    branchName !== "master"
  ) {
    try {
      await execAsync(
        `git -C "${resolvedProjectPath}" branch -D "${branchName}"`,
        { timeout: 10000 }
      );
    } catch (error) {
      console.warn(
        `[worktrees] Branch deletion failed for ${branchName}:`,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }

  // Remove project entry from ~/.claude.json
  removeWorktreeProjectEntry(resolvedWorktreePath);
}

/**
 * Check if a branch has commits ahead of its base branch
 * Returns true if the branch has changes, false if it's empty
 * On error, returns true (safe default - don't delete the branch)
 */
export async function branchHasChanges(
  worktreePath: string,
  baseBranch: string
): Promise<boolean> {
  const resolvedWorktreePath = resolvePath(worktreePath);

  try {
    // Count commits ahead of the base branch (use local branch, not origin)
    const { stdout } = await execAsync(
      `git -C "${resolvedWorktreePath}" rev-list --count ${baseBranch}..HEAD`,
      { timeout: 5000 }
    );

    const count = parseInt(stdout.trim(), 10);
    return count > 0;
  } catch {
    // On error, assume there are changes (safe default)
    return true;
  }
}

/**
 * Check if a worktree has uncommitted changes (staged or unstaged)
 * Returns true if there are uncommitted changes, false if clean
 * On error, returns true (safe default - warn the user)
 */
export async function hasUncommittedChanges(
  worktreePath: string
): Promise<boolean> {
  const resolvedWorktreePath = resolvePath(worktreePath);

  try {
    // git status --porcelain returns nothing if clean, or lines for each changed file
    const { stdout } = await execAsync(
      `git -C "${resolvedWorktreePath}" status --porcelain`,
      { timeout: 5000 }
    );

    return stdout.trim().length > 0;
  } catch {
    // On error, assume there are changes (safe default)
    return true;
  }
}

/**
 * Discard all uncommitted changes in a worktree (both staged and unstaged)
 * This performs a hard reset and cleans untracked files
 */
export async function discardUncommittedChanges(
  worktreePath: string
): Promise<void> {
  const resolvedWorktreePath = resolvePath(worktreePath);

  // Reset staged and modified files to HEAD
  await execAsync(`git -C "${resolvedWorktreePath}" reset --hard HEAD`, {
    timeout: 10000,
  });

  // Remove untracked files and directories
  await execAsync(`git -C "${resolvedWorktreePath}" clean -fd`, {
    timeout: 10000,
  });
}

/**
 * List all worktrees for a project
 */
export async function listWorktrees(projectPath: string): Promise<
  Array<{
    path: string;
    branch: string;
    head: string;
  }>
> {
  const resolvedProjectPath = resolvePath(projectPath);

  try {
    const { stdout } = await execAsync(
      `git -C "${resolvedProjectPath}" worktree list --porcelain`,
      { timeout: 10000 }
    );

    const worktrees: Array<{ path: string; branch: string; head: string }> = [];
    const entries = stdout.split("\n\n").filter(Boolean);

    for (const entry of entries) {
      const lines = entry.split("\n");
      let worktreePath = "";
      let branch = "";
      let head = "";

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          worktreePath = line.slice(9);
        } else if (line.startsWith("branch ")) {
          branch = line.slice(7).replace("refs/heads/", "");
        } else if (line.startsWith("HEAD ")) {
          head = line.slice(5);
        }
      }

      if (worktreePath) {
        worktrees.push({ path: worktreePath, branch, head });
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}

/**
 * Check if a path is inside an AgentOS worktree
 */
export function isAgentOSWorktree(worktreePath: string): boolean {
  const resolvedPath = resolvePath(worktreePath);
  return resolvedPath.startsWith(WORKTREES_DIR);
}

/**
 * Get the worktrees base directory
 */
export function getWorktreesDir(): string {
  return WORKTREES_DIR;
}

// Path to ~/.claude.json
const CLAUDE_CONFIG_PATH = path.join(os.homedir(), ".claude.json");

/**
 * Default project entry structure for trusted worktrees
 */
function getDefaultProjectEntry() {
  return {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    hasTrustDialogAccepted: true,
    projectOnboardingSeenCount: 0,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
    exampleFiles: [],
    exampleFilesGeneratedAt: null,
    reactVulnerabilityCache: {
      detected: false,
      package: null,
      packageName: null,
      version: null,
      packageManager: null,
    },
    lastCost: 0,
    lastAPIDuration: 0,
    lastAPIDurationWithoutRetries: 0,
    lastToolDuration: 0,
    lastDuration: 0,
    lastLinesAdded: 0,
    lastLinesRemoved: 0,
    lastTotalInputTokens: 0,
    lastTotalOutputTokens: 0,
    lastTotalCacheCreationInputTokens: 0,
    lastTotalCacheReadInputTokens: 0,
    lastTotalWebSearchRequests: 0,
    lastModelUsage: {},
    lastSessionId: null,
    hasCompletedProjectOnboarding: false,
  };
}

/**
 * Add a project entry to ~/.claude.json for a worktree path.
 * This marks the worktree as trusted, preventing Claude from prompting
 * for permission when starting a session in that directory.
 */
export function addWorktreeProjectEntry(worktreePath: string): void {
  try {
    // Read existing config or create empty object
    let config: Record<string, unknown> = {};
    if (fs.existsSync(CLAUDE_CONFIG_PATH)) {
      const content = fs.readFileSync(CLAUDE_CONFIG_PATH, "utf-8");
      config = JSON.parse(content);
    }

    // Initialize projects object if it doesn't exist
    if (!config.projects || typeof config.projects !== "object") {
      config.projects = {};
    }

    const projects = config.projects as Record<string, unknown>;

    // Add entry for this worktree path if it doesn't exist
    if (!projects[worktreePath]) {
      projects[worktreePath] = getDefaultProjectEntry();
      fs.writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log(`[worktrees] Added project entry for ${worktreePath}`);
    }
  } catch (error) {
    console.warn(
      `[worktrees] Failed to add project entry for ${worktreePath}:`,
      error instanceof Error ? error.message : "Unknown error"
    );
  }
}

/**
 * Remove a project entry from ~/.claude.json for a worktree path.
 */
export function removeWorktreeProjectEntry(worktreePath: string): void {
  try {
    if (!fs.existsSync(CLAUDE_CONFIG_PATH)) {
      return;
    }

    const content = fs.readFileSync(CLAUDE_CONFIG_PATH, "utf-8");
    const config = JSON.parse(content) as Record<string, unknown>;

    if (!config.projects || typeof config.projects !== "object") {
      return;
    }

    const projects = config.projects as Record<string, unknown>;

    if (projects[worktreePath]) {
      delete projects[worktreePath];
      fs.writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log(`[worktrees] Removed project entry for ${worktreePath}`);
    }
  } catch (error) {
    console.warn(
      `[worktrees] Failed to remove project entry for ${worktreePath}:`,
      error instanceof Error ? error.message : "Unknown error"
    );
  }
}
