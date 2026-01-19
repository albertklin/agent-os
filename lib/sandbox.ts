/**
 * Sandbox System
 *
 * Provides devcontainer-based isolation for auto-approve sessions.
 * When enabled, sessions run inside containers with:
 * - File isolation (only workspace accessible)
 * - Network isolation (firewall whitelist)
 * - Process isolation (unprivileged user)
 */

import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { db, queries } from "./db";

const execAsync = promisify(exec);

/**
 * Find the devcontainer template directory.
 * Checks repo's data/devcontainer first, then falls back to ~/.agent-os/devcontainer
 */
function getDevcontainerConfigDir(): string {
  // Try repo's data directory first (works in dev and when installed)
  const repoDataDir = path.join(process.cwd(), "data", "devcontainer");
  if (fs.existsSync(path.join(repoDataDir, "devcontainer.json"))) {
    return repoDataDir;
  }

  // Fall back to user's home directory
  return path.join(process.env.HOME || "~", ".agent-os", "devcontainer");
}

export interface SandboxOptions {
  sessionId: string;
  workingDirectory: string;
}

/**
 * Check if the devcontainer CLI is installed and available
 */
export async function isDevcontainerAvailable(): Promise<boolean> {
  try {
    await execAsync("devcontainer --version", { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Docker is installed and running
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execAsync("docker info", { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Install the devcontainer CLI globally via npm
 */
async function installDevcontainerCli(): Promise<boolean> {
  console.log("[sandbox] Installing devcontainer CLI...");
  try {
    await execAsync("npm install -g @devcontainers/cli", { timeout: 120000 });
    console.log("[sandbox] devcontainer CLI installed successfully");
    return true;
  } catch (error) {
    console.error("[sandbox] Failed to install devcontainer CLI:", error);
    return false;
  }
}

/**
 * Ensure devcontainer CLI is available, installing if necessary
 * Returns true if available (or successfully installed), false otherwise
 */
export async function ensureDevcontainerCli(): Promise<boolean> {
  // Check if already available
  if (await isDevcontainerAvailable()) {
    return true;
  }

  // Check if Docker is available first (required for devcontainer)
  if (!(await isDockerAvailable())) {
    console.warn(
      "[sandbox] Docker is not available - cannot use devcontainer sandbox"
    );
    return false;
  }

  // Try to install devcontainer CLI
  const installed = await installDevcontainerCli();
  if (!installed) {
    return false;
  }

  // Verify installation
  return await isDevcontainerAvailable();
}

/**
 * Ensure the .devcontainer config exists in the workspace.
 * If not present, copies from the template in data/devcontainer/
 */
export async function ensureDevcontainerConfig(
  workspaceFolder: string
): Promise<boolean> {
  const targetDir = path.join(workspaceFolder, ".devcontainer");
  const targetConfig = path.join(targetDir, "devcontainer.json");

  // Check if config already exists
  if (fs.existsSync(targetConfig)) {
    return true;
  }

  // Find the template config directory
  const configDir = getDevcontainerConfigDir();
  const sourceConfig = path.join(configDir, "devcontainer.json");
  if (!fs.existsSync(sourceConfig)) {
    console.warn(`[sandbox] Devcontainer template not found at ${configDir}`);
    return false;
  }

  try {
    // Create .devcontainer directory
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Copy all files from template config
    const files = fs.readdirSync(configDir);
    for (const file of files) {
      const sourcePath = path.join(configDir, file);
      const targetPath = path.join(targetDir, file);
      fs.copyFileSync(sourcePath, targetPath);

      // Make scripts executable
      if (file.endsWith(".sh")) {
        fs.chmodSync(targetPath, 0o755);
      }
    }

    console.log(`[sandbox] Copied devcontainer config to ${targetDir}`);
    return true;
  } catch (error) {
    console.error("[sandbox] Failed to copy devcontainer config:", error);
    return false;
  }
}

/**
 * Initialize a sandbox for a session by starting a devcontainer
 */
export async function initializeSandbox(
  options: SandboxOptions
): Promise<string | null> {
  const { sessionId, workingDirectory } = options;

  // Update status to initializing
  queries.updateSessionSandbox(db).run(null, "initializing", sessionId);

  try {
    // Ensure devcontainer config exists
    const hasConfig = await ensureDevcontainerConfig(workingDirectory);
    if (!hasConfig) {
      queries.updateSessionSandbox(db).run(null, "failed", sessionId);
      return null;
    }

    // Build and start the devcontainer
    console.log(`[sandbox] Starting devcontainer for session ${sessionId}...`);

    // Use devcontainer up to start the container
    const { stdout, stderr } = await execAsync(
      `devcontainer up --workspace-folder "${workingDirectory}" 2>&1`,
      { timeout: 300000 } // 5 minute timeout for container build
    );

    console.log(`[sandbox] Devcontainer output:`, stdout);
    if (stderr) {
      console.warn(`[sandbox] Devcontainer stderr:`, stderr);
    }

    // Parse container ID from output
    // devcontainer up outputs JSON with containerId
    let containerId: string | null = null;
    try {
      // Try to find JSON in output
      const jsonMatch = stdout.match(/\{[^{}]*"containerId"[^{}]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        containerId = result.containerId || null;
      }
    } catch {
      // JSON parsing failed, try to extract from docker ps
      try {
        const { stdout: dockerOut } = await execAsync(
          `docker ps --filter "label=devcontainer.local_folder=${workingDirectory}" --format "{{.ID}}" | head -1`,
          { timeout: 5000 }
        );
        containerId = dockerOut.trim() || null;
      } catch {
        // Ignore docker errors
      }
    }

    if (!containerId) {
      console.warn(
        "[sandbox] Could not determine container ID, but container may be running"
      );
      // Try one more approach - list running devcontainers
      try {
        const { stdout: psOut } = await execAsync(
          `docker ps --filter "label=devcontainer.config_file" --format "{{.ID}}" | head -1`,
          { timeout: 5000 }
        );
        containerId = psOut.trim() || "unknown";
      } catch {
        containerId = "unknown";
      }
    }

    // Update session with container info
    queries.updateSessionSandbox(db).run(containerId, "ready", sessionId);
    console.log(
      `[sandbox] Container ${containerId} ready for session ${sessionId}`
    );

    return containerId;
  } catch (error) {
    console.error(`[sandbox] Failed to initialize sandbox:`, error);
    queries.updateSessionSandbox(db).run(null, "failed", sessionId);
    return null;
  }
}

/**
 * Build a command that runs inside the devcontainer
 */
export function buildSandboxedCommand(
  workspaceFolder: string,
  command: string
): string {
  // Escape the command for shell
  const escapedCommand = command.replace(/"/g, '\\"');
  return `devcontainer exec --workspace-folder "${workspaceFolder}" ${escapedCommand}`;
}

/**
 * Build a complete sandboxed session command for tmux
 * This wraps the agent command to run inside the devcontainer
 */
export function buildSandboxedSessionCommand(
  workspaceFolder: string,
  agentCommand: string
): string {
  // The command needs to:
  // 1. Wait for container to be ready (in case initialization is still running)
  // 2. Execute the agent inside the container
  return `devcontainer exec --workspace-folder "${workspaceFolder}" ${agentCommand}`;
}

/**
 * Stop and remove a sandbox container
 */
export async function destroySandbox(sessionId: string): Promise<void> {
  try {
    const session = queries.getSession(db).get(sessionId) as {
      container_id?: string;
      working_directory?: string;
      worktree_path?: string;
    } | null;

    if (!session) {
      return;
    }

    const workspaceFolder =
      session.worktree_path || session.working_directory || "";

    if (session.container_id && session.container_id !== "unknown") {
      // Stop the container directly
      console.log(
        `[sandbox] Stopping container ${session.container_id} for session ${sessionId}`
      );
      try {
        await execAsync(`docker stop "${session.container_id}"`, {
          timeout: 30000,
        });
        await execAsync(`docker rm "${session.container_id}"`, {
          timeout: 10000,
        });
      } catch (error) {
        console.warn(`[sandbox] Error stopping container:`, error);
      }
    } else if (workspaceFolder) {
      // Try to stop via devcontainer CLI
      console.log(
        `[sandbox] Stopping devcontainer for workspace ${workspaceFolder}`
      );
      try {
        // Find containers by workspace label
        const { stdout } = await execAsync(
          `docker ps -q --filter "label=devcontainer.local_folder=${workspaceFolder}"`,
          { timeout: 5000 }
        );
        const containerIds = stdout.trim().split("\n").filter(Boolean);

        for (const id of containerIds) {
          try {
            await execAsync(`docker stop "${id}"`, { timeout: 30000 });
            await execAsync(`docker rm "${id}"`, { timeout: 10000 });
          } catch {
            // Ignore individual container errors
          }
        }
      } catch {
        // Ignore errors
      }
    }

    // Clear sandbox info from session
    queries.updateSessionSandbox(db).run(null, null, sessionId);
  } catch (error) {
    console.error(`[sandbox] Error destroying sandbox:`, error);
  }
}

/**
 * Get the status of a sandbox
 */
export function getSandboxStatus(
  sessionId: string
): "pending" | "initializing" | "ready" | "failed" | null {
  const session = queries.getSession(db).get(sessionId) as {
    sandbox_status?: string;
  } | null;
  return (
    (session?.sandbox_status as ReturnType<typeof getSandboxStatus>) ?? null
  );
}

/**
 * Check if a session should use sandbox (has auto_approve and is claude agent)
 */
export function shouldUseSandbox(session: {
  auto_approve: boolean;
  agent_type: string;
}): boolean {
  return session.auto_approve && session.agent_type === "claude";
}

/**
 * Wait for a sandbox to become ready, with timeout
 * Returns true if sandbox is ready, false if timed out or failed
 */
export async function waitForSandboxReady(
  sessionId: string,
  timeoutMs: number = 300000, // 5 minute default (container build can be slow)
  pollIntervalMs: number = 2000
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const status = getSandboxStatus(sessionId);

    if (status === "ready") {
      return true;
    }

    if (status === "failed") {
      console.warn(`[sandbox] Sandbox failed for session ${sessionId}`);
      return false;
    }

    // Status is pending or initializing, keep waiting
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  console.warn(
    `[sandbox] Timed out waiting for sandbox to be ready (session ${sessionId})`
  );
  return false;
}

/**
 * Initialize sandbox and wait for it to be ready
 * Combines initialization with waiting in one call for convenience
 */
export async function initializeSandboxAndWait(
  options: SandboxOptions,
  timeoutMs: number = 300000
): Promise<boolean> {
  const { sessionId } = options;

  // Start initialization
  const containerId = await initializeSandbox(options);

  if (!containerId) {
    return false;
  }

  // Wait for ready status (initializeSandbox sets it to ready on success)
  const status = getSandboxStatus(sessionId);
  return status === "ready";
}
