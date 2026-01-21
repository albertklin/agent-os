/**
 * Container-based Sandbox System
 *
 * Provides true OS-level isolation for auto-approve sessions using Docker containers
 * based on Claude Code's official devcontainer.
 *
 * Security model:
 * - Filesystem: Only worktree mounted at /workspace; host filesystem inaccessible
 * - Network: iptables default-deny; allows only DNS, npm, GitHub, Anthropic API, local network
 * - Privileges: Runs as non-root `node` user
 * - Claude Config: Mounted read-only (API keys can't be modified)
 * - Resource Limits: Memory, CPU, PIDs, and file descriptors are capped
 *
 * Security features:
 * - Health validation before every operation
 * - Security event logging for audit trails
 * - Fail-closed design (refuse access if unhealthy)
 */

import { exec } from "child_process";
import { promisify } from "util";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ContainerError } from "./errors";

const execAsync = promisify(exec);

const SANDBOX_IMAGE = "agentos-sandbox:latest";
// Use __dirname to get path relative to this file, not cwd (which varies between dev/installed)
const DOCKER_DIR = path.join(__dirname, "..", "docker");
const AGENT_OS_DIR = path.join(os.homedir(), ".agent-os");
const IMAGE_HASH_FILE = path.join(AGENT_OS_DIR, "sandbox-image-hash");

/** Track if Docker is available on this system */
let dockerAvailable: boolean | null = null;

// ============================================================================
// Security Logging
// ============================================================================

export interface SecurityEvent {
  type:
    | "container_health_check"
    | "container_access_denied"
    | "container_created"
    | "container_destroyed"
    | "firewall_init";
  sessionId: string;
  containerId?: string;
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Log a security event to console.
 * Provides visibility into container security operations for debugging.
 */
export function logSecurityEvent(event: SecurityEvent): void {
  const prefix = event.success ? "[security]" : "[security] WARNING:";
  console.log(
    `${prefix} ${event.type} session=${event.sessionId}${event.containerId ? ` container=${event.containerId}` : ""}${event.error ? ` error=${event.error}` : ""}`
  );
}

// ============================================================================
// Container Health Checks
// ============================================================================

export interface ContainerHealthStatus {
  exists: boolean;
  running: boolean;
  firewallActive: boolean;
  mountsCorrect: boolean;
  healthy: boolean;
  error?: string;
}

/**
 * Check if a container is currently running.
 */
export async function isContainerRunning(
  containerId: string
): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `docker inspect -f '{{.State.Running}}' "${containerId}"`,
      { timeout: 5000 }
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Verify comprehensive container health.
 *
 * Checks:
 * 1. Container exists (docker inspect succeeds)
 * 2. Container is running (state is "running")
 * 3. Firewall rules are active (iptables output policy is REJECT)
 * 4. Mounts are correct (worktree path is mounted at /workspace)
 */
export async function verifyContainerHealth(
  containerId: string,
  expectedWorktreePath?: string
): Promise<ContainerHealthStatus> {
  const status: ContainerHealthStatus = {
    exists: false,
    running: false,
    firewallActive: false,
    mountsCorrect: false,
    healthy: false,
  };

  try {
    // Check 1: Container exists and get state
    const { stdout: inspectOut } = await execAsync(
      `docker inspect -f '{{.State.Status}}' "${containerId}"`,
      { timeout: 5000 }
    );
    status.exists = true;
    status.running = inspectOut.trim() === "running";

    if (!status.running) {
      status.error = `Container is not running (state: ${inspectOut.trim()})`;
      return status;
    }

    // Check 2: Verify firewall rules are active
    // Look for REJECT rule in OUTPUT chain which indicates firewall is initialized
    // Must use -u root since iptables requires privileges and no-new-privileges blocks sudo
    try {
      const { stdout: iptablesOut } = await execAsync(
        `docker exec -u root "${containerId}" iptables -L OUTPUT -n 2>/dev/null | grep -q REJECT && echo "active" || echo "inactive"`,
        { timeout: 10000 }
      );
      status.firewallActive = iptablesOut.trim() === "active";

      if (!status.firewallActive) {
        status.error = "Firewall rules are not active";
        return status;
      }
    } catch {
      // If iptables check fails, assume firewall is not properly configured
      status.error = "Failed to verify firewall status";
      return status;
    }

    // Check 3: Verify mounts if expected path is provided
    if (expectedWorktreePath) {
      try {
        const { stdout: mountOut } = await execAsync(
          `docker inspect -f '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}' "${containerId}"`,
          { timeout: 5000 }
        );
        const actualMount = mountOut.trim();

        // Normalize paths for comparison (resolve symlinks, etc.)
        const normalizedExpected = path.resolve(expectedWorktreePath);
        const normalizedActual = path.resolve(actualMount);

        status.mountsCorrect = normalizedExpected === normalizedActual;

        if (!status.mountsCorrect) {
          status.error = `Mount mismatch: expected ${normalizedExpected}, got ${normalizedActual}`;
          return status;
        }
      } catch {
        status.error = "Failed to verify mount configuration";
        return status;
      }
    } else {
      // No expected path to check, assume mounts are correct
      status.mountsCorrect = true;
    }

    // All checks passed
    status.healthy = true;
    return status;
  } catch (err) {
    // Container doesn't exist or docker command failed
    status.error =
      err instanceof Error ? err.message : "Failed to inspect container";
    return status;
  }
}

// ============================================================================
// Docker Availability
// ============================================================================

/**
 * Check if Docker is available on the system
 */
export async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailable !== null) {
    return dockerAvailable;
  }

  try {
    await execAsync("docker info", { timeout: 10000 });
    dockerAvailable = true;
    return true;
  } catch {
    dockerAvailable = false;
    return false;
  }
}

/**
 * Check if the sandbox image exists
 */
async function imageExists(): Promise<boolean> {
  try {
    await execAsync(`docker image inspect ${SANDBOX_IMAGE}`, {
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute a hash of the docker directory contents (Dockerfile + scripts).
 * Used to detect when the image needs to be rebuilt.
 */
function computeDockerConfigHash(): string {
  const hash = crypto.createHash("sha256");

  const files = [
    "Dockerfile",
    "init-firewall.sh",
    "tmux.conf",
    "git-wrapper.sh",
  ];
  for (const file of files) {
    const filePath = path.join(DOCKER_DIR, file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      hash.update(`${file}:${content}`);
    }
  }

  return hash.digest("hex").substring(0, 16);
}

/**
 * Get the stored hash of the last built image.
 */
function getStoredImageHash(): string | null {
  try {
    if (fs.existsSync(IMAGE_HASH_FILE)) {
      return fs.readFileSync(IMAGE_HASH_FILE, "utf-8").trim();
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

/**
 * Store the hash of the current docker config.
 */
function storeImageHash(hash: string): void {
  try {
    if (!fs.existsSync(AGENT_OS_DIR)) {
      fs.mkdirSync(AGENT_OS_DIR, { recursive: true });
    }
    fs.writeFileSync(IMAGE_HASH_FILE, hash);
  } catch (err) {
    console.warn("[container] Failed to store image hash:", err);
  }
}

/**
 * Build the sandbox Docker image.
 */
async function buildSandboxImage(): Promise<boolean> {
  console.log("[container] Building sandbox image...");
  try {
    await execAsync(`docker build -t ${SANDBOX_IMAGE} ${DOCKER_DIR}`, {
      timeout: 600000, // 10 minute timeout for build
    });
    console.log("[container] Sandbox image built successfully");
    return true;
  } catch (error) {
    console.error("[container] Failed to build sandbox image:", error);
    return false;
  }
}

/**
 * Ensure the sandbox Docker image is built and up-to-date.
 * Rebuilds automatically if Dockerfile or init-firewall.sh change.
 * Returns true if image is ready, false if Docker is not available.
 */
export async function ensureSandboxImage(): Promise<boolean> {
  if (!(await isDockerAvailable())) {
    console.warn(
      "[container] Docker not available - sandboxed sessions disabled"
    );
    return false;
  }

  const currentHash = computeDockerConfigHash();
  const storedHash = getStoredImageHash();
  const imageReady = await imageExists();

  // Rebuild if: image doesn't exist OR config has changed
  const needsRebuild = !imageReady || currentHash !== storedHash;

  if (!needsRebuild) {
    console.log("[container] Sandbox image up-to-date");
    return true;
  }

  if (imageReady && currentHash !== storedHash) {
    console.log(
      "[container] Docker config changed, rebuilding sandbox image..."
    );
  }

  const success = await buildSandboxImage();
  if (success) {
    storeImageHash(currentHash);
  }
  return success;
}

// ============================================================================
// Container Creation
// ============================================================================

export interface CreateContainerOptions {
  sessionId: string;
  worktreePath: string;
}

export interface CreateContainerResult {
  containerId: string;
}

// Overall timeout for container creation (3 minutes)
// This covers: docker run (60s) + firewall init (120s) + buffer
const CONTAINER_CREATION_TIMEOUT = 180000;

/**
 * Create and start a sandbox container for a session.
 *
 * The container:
 * - Mounts the worktree at /workspace (read-write)
 * - Mounts Claude config from host (read-only for API keys)
 * - Runs with NET_ADMIN capability for firewall setup
 * - Has resource limits (memory, CPU, PIDs, file descriptors)
 * - Initializes the firewall after start
 *
 * @throws ContainerError on failure (including timeout)
 */
export async function createContainer(
  opts: CreateContainerOptions
): Promise<CreateContainerResult> {
  const { sessionId, worktreePath } = opts;
  const containerName = `agentos-${sessionId}`;
  const claudeConfigDir = path.join(os.homedir(), ".claude");
  const sshAuthSock = process.env.SSH_AUTH_SOCK;

  console.log(
    `[container] Creating container ${containerName} for worktree ${worktreePath}`
  );

  // Wrap the entire creation process in a timeout with proper cleanup
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        ContainerError.createFailed(
          `Container creation timed out after ${CONTAINER_CREATION_TIMEOUT / 1000}s`
        )
      );
    }, CONTAINER_CREATION_TIMEOUT);
  });

  const createPromise = (async (): Promise<CreateContainerResult> => {
    try {
      // Start container with resource limits and security options
      // ~/.claude is mounted read-only at .claude-host, then symlinked to .claude
      // This keeps OAuth tokens fresh while allowing settings.json to be modified
      // SSH agent socket is mounted if available for git authentication
      const sshAgentMount = sshAuthSock
        ? `-v "${sshAuthSock}:/ssh-agent" -e SSH_AUTH_SOCK=/ssh-agent`
        : "";

      // For git worktrees, we need to mount the main repo's .git directory
      // The worktree's .git file contains "gitdir: /path/to/main/.git/worktrees/<name>"
      // We mount the main .git dir at the same host path so the gitdir reference works
      let gitDirMount = "";
      const gitFile = path.join(worktreePath, ".git");
      if (fs.existsSync(gitFile)) {
        const stat = fs.statSync(gitFile);
        // Only process if .git is a file (worktree), not a directory (regular repo)
        if (stat.isFile()) {
          const gitFileContent = fs.readFileSync(gitFile, "utf-8").trim();
          if (gitFileContent.startsWith("gitdir:")) {
            // Extract the gitdir path (e.g., /home/user/repo/.git/worktrees/branch)
            const gitdirPath = gitFileContent.replace("gitdir:", "").trim();
            // Find the main .git directory (parent of /worktrees/<name>)
            const worktreesIndex = gitdirPath.lastIndexOf("/worktrees/");
            if (worktreesIndex !== -1) {
              const mainGitDir = gitdirPath.substring(0, worktreesIndex);
              // Security: validate the path looks like a .git directory
              // This prevents path injection via malicious .git files
              if (mainGitDir.endsWith(".git") && fs.existsSync(mainGitDir)) {
                // Mount the main .git directory at the same path inside the container
                gitDirMount = `-v "${mainGitDir}:${mainGitDir}:rw"`;
                console.log(
                  `[container] Mounting git directory ${mainGitDir} for worktree support`
                );
              } else {
                console.warn(
                  `[container] Skipping suspicious gitdir path: ${mainGitDir}`
                );
              }
            }
          }
        }
      }

      // Create screenshots temp directory on host if it doesn't exist
      // This is where uploaded images are stored, and we need to mount it into the container
      const screenshotsTempDir = path.join(os.tmpdir(), "agent-os-screenshots");
      if (!fs.existsSync(screenshotsTempDir)) {
        fs.mkdirSync(screenshotsTempDir, { recursive: true });
      }

      // Mount ~/.claude read-only so OAuth token refreshes on host are visible in container
      const claudeConfigMount = fs.existsSync(claudeConfigDir)
        ? `-v "${claudeConfigDir}:/home/node/.claude-host:ro"`
        : "";

      const { stdout } = await execAsync(
        `docker run -d \
        --name "${containerName}" \
        --cap-add=NET_ADMIN --cap-add=NET_RAW \
        --add-host=host.docker.internal:host-gateway \
        --memory=4g \
        --memory-swap=4g \
        --cpus=2 \
        --pids-limit=512 \
        --ulimit nofile=1024:2048 \
        --security-opt=no-new-privileges \
        -v "${worktreePath}:/workspace:rw" \
        -v "${screenshotsTempDir}:${screenshotsTempDir}:ro" \
        ${gitDirMount} \
        ${sshAgentMount} \
        ${claudeConfigMount} \
        -e NODE_OPTIONS="--max-old-space-size=4096" \
        -e CLAUDE_CONFIG_DIR="/home/node/.claude" \
        ${SANDBOX_IMAGE} \
        sleep infinity`,
        { timeout: 60000 }
      );

      const containerId = stdout.trim().substring(0, 12);
      console.log(`[container] Container ${containerId} started`);

      // Set up ~/.claude directory with symlinks to the read-only host mount
      // This allows OAuth token refreshes on the host to be visible in the container
      // while still allowing settings.json to be modified for localhost→host.docker.internal
      if (fs.existsSync(claudeConfigDir)) {
        console.log(`[container] Setting up Claude config with symlinks...`);
        try {
          // Create .claude directory and symlink all files from the read-only mount
          // except settings.json which we copy so we can modify it
          await execAsync(
            `docker exec "${containerId}" sh -c '
              mkdir -p /home/node/.claude &&
              for f in /home/node/.claude-host/*; do
                [ -e "$f" ] || continue
                name=$(basename "$f")
                if [ "$name" = "settings.json" ]; then
                  cp "$f" /home/node/.claude/
                else
                  ln -sf "$f" /home/node/.claude/
                fi
              done
            '`,
            { timeout: 30000 }
          );
          // Replace localhost with host.docker.internal in settings.json so hooks can reach host
          await execAsync(
            `docker exec "${containerId}" sed -i 's/localhost:3011/host.docker.internal:3011/g' /home/node/.claude/settings.json`,
            { timeout: 5000 }
          ).catch(() => {
            // settings.json might not exist yet, that's okay
          });
          console.log(
            `[container] Claude config set up with symlinks successfully`
          );
        } catch (setupError) {
          const setupErrorMsg =
            setupError instanceof Error ? setupError.message : "Unknown error";
          console.warn(
            `[container] Failed to set up Claude config (continuing anyway): ${setupErrorMsg}`
          );
          // Don't fail the container creation - claude might still work with defaults
        }
      } else {
        console.log(
          `[container] No Claude config directory found at ${claudeConfigDir}, skipping setup`
        );
      }

      // Copy ~/.claude.json (onboarding state, theme, etc.) into the CLAUDE_CONFIG_DIR
      // Since CLAUDE_CONFIG_DIR=/home/node/.claude, Claude looks for .claude.json inside that directory
      const claudeJsonFile = path.join(os.homedir(), ".claude.json");
      if (fs.existsSync(claudeJsonFile)) {
        console.log(`[container] Copying .claude.json into container...`);
        try {
          await execAsync(
            `docker cp "${claudeJsonFile}" "${containerId}:/home/node/.claude/.claude.json"`,
            { timeout: 10000 }
          );
          await execAsync(
            `docker exec -u root "${containerId}" chown node:node /home/node/.claude/.claude.json`,
            { timeout: 5000 }
          );
          console.log(`[container] .claude.json copied successfully`);
        } catch (copyError) {
          const copyErrorMsg =
            copyError instanceof Error ? copyError.message : "Unknown error";
          console.warn(
            `[container] Failed to copy .claude.json (continuing anyway): ${copyErrorMsg}`
          );
        }
      }

      // Copy ~/.gitconfig for git user.name and user.email (required for commits)
      const gitconfigFile = path.join(os.homedir(), ".gitconfig");
      if (fs.existsSync(gitconfigFile)) {
        console.log(`[container] Copying .gitconfig into container...`);
        try {
          await execAsync(
            `docker cp "${gitconfigFile}" "${containerId}:/home/node/.gitconfig"`,
            { timeout: 10000 }
          );
          await execAsync(
            `docker exec -u root "${containerId}" chown node:node /home/node/.gitconfig`,
            { timeout: 5000 }
          );
          console.log(`[container] .gitconfig copied successfully`);
        } catch (copyError) {
          const copyErrorMsg =
            copyError instanceof Error ? copyError.message : "Unknown error";
          console.warn(
            `[container] Failed to copy .gitconfig (continuing anyway): ${copyErrorMsg}`
          );
        }
      }

      // Initialize firewall inside the container (run as root via -u flag)
      // This avoids needing sudo inside the container, so no-new-privileges can stay enabled
      console.log(`[container] Initializing firewall...`);
      try {
        await execAsync(
          `docker exec -u root ${containerId} /usr/local/bin/init-firewall.sh`,
          { timeout: 120000 } // 2 minute timeout for firewall init (needs to fetch GitHub IPs)
        );

        logSecurityEvent({
          type: "firewall_init",
          sessionId,
          containerId,
          success: true,
        });

        console.log(`[container] Firewall initialized`);
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : "Unknown error";

        logSecurityEvent({
          type: "firewall_init",
          sessionId,
          containerId,
          success: false,
          error: errorMsg,
        });

        // Firewall init failed - destroy the container and throw
        console.error(`[container] Firewall initialization failed:`, error);
        await destroyContainer(containerId).catch(() => {});
        throw ContainerError.firewallFailed(errorMsg);
      }

      return { containerId };
    } catch (error) {
      if (error instanceof ContainerError) {
        throw error;
      }
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      throw ContainerError.createFailed(errorMsg);
    }
  })();

  // Race between the creation and the timeout, then clear the timeout
  try {
    const result = await Promise.race([createPromise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);

    // If timeout or error occurred, try to clean up any partially-created container
    try {
      const { stdout } = await execAsync(
        `docker ps -aq --filter "name=${containerName}"`,
        { timeout: 5000 }
      );
      const containerId = stdout.trim();
      if (containerId) {
        console.log(
          `[container] Cleaning up partially-created container ${containerId}`
        );
        await execAsync(`docker rm -f ${containerId}`, {
          timeout: 10000,
        }).catch(() => {});
      }
    } catch {
      // Ignore cleanup errors
    }

    throw error;
  }
}

// ============================================================================
// Container Destruction
// ============================================================================

/**
 * Helper to sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stop and remove a container with retry logic.
 *
 * Attempts graceful stop first, then force removes if needed.
 * Retries up to 3 times with exponential backoff.
 */
export async function destroyContainer(containerId: string): Promise<void> {
  console.log(`[container] Destroying container ${containerId}`);

  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Try graceful stop first
      await execAsync(`docker stop "${containerId}" --time 5`, {
        timeout: 15000,
      });
      await execAsync(`docker rm "${containerId}"`, { timeout: 10000 });
      console.log(`[container] Container ${containerId} destroyed`);
      return;
    } catch (err) {
      if (attempt === maxRetries) {
        // Last attempt - force remove
        try {
          await execAsync(`docker rm -f "${containerId}"`, { timeout: 10000 });
          console.log(`[container] Container ${containerId} force removed`);
          return;
        } catch (forceErr) {
          console.error(
            `[container] Failed to destroy container ${containerId}:`,
            forceErr
          );
          throw forceErr;
        }
      }

      console.log(
        `[container] Retry ${attempt}/${maxRetries} for destroying ${containerId}`
      );
      await sleep(1000 * attempt); // Exponential backoff
    }
  }
}

// ============================================================================
// Container Status
// ============================================================================

/**
 * Get the status of a container.
 */
export async function getContainerStatus(
  containerId: string
): Promise<"running" | "stopped" | null> {
  try {
    const { stdout } = await execAsync(
      `docker inspect -f '{{.State.Status}}' "${containerId}"`,
      { timeout: 5000 }
    );
    const status = stdout.trim();
    if (status === "running") return "running";
    if (status === "exited" || status === "stopped") return "stopped";
    return null;
  } catch {
    return null;
  }
}

/**
 * Execute a command inside a running container.
 * Used by the terminal WebSocket to spawn shells inside the container.
 */
export function getContainerExecArgs(containerId: string): string[] {
  return ["exec", "-it", containerId, "/bin/zsh", "-l"];
}
