import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { writeGlobalHooksConfig } from "./lib/hooks/generate-config";
import { ensureSandboxImage, isContainerRunning } from "./lib/container";
import { getDb } from "./lib/db";
import { getTmuxSessionName } from "./lib/sessions";
import { refreshTmuxClient } from "./lib/tmux";
import {
  validateDatabaseConstraints,
  fixOrphanedAutoApproveSessions,
} from "./lib/db/validation";
import { sessionManager } from "./lib/session-manager";
import { getTailscaleIP } from "./lib/tailscale";
import {
  createIpFilterMiddleware,
  describeTrustedNetworks,
} from "./lib/ip-filter";

// Temp file cleanup configuration
const SCREENSHOT_TEMP_DIR = path.join(os.tmpdir(), "agent-os-screenshots");
const TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const TEMP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Clean up old temporary files (screenshots, etc.)
 * Removes files older than TEMP_FILE_MAX_AGE_MS
 */
async function cleanupTempFiles(): Promise<{
  checked: number;
  removed: number;
}> {
  let checked = 0;
  let removed = 0;

  try {
    if (!fs.existsSync(SCREENSHOT_TEMP_DIR)) {
      return { checked, removed };
    }

    const files = await fs.promises.readdir(SCREENSHOT_TEMP_DIR);
    const now = Date.now();

    for (const file of files) {
      checked++;
      const filePath = path.join(SCREENSHOT_TEMP_DIR, file);
      try {
        const stats = await fs.promises.stat(filePath);
        if (now - stats.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
          await fs.promises.unlink(filePath);
          removed++;
        }
      } catch {
        // Ignore errors for individual files (may have been deleted already)
      }
    }
  } catch (err) {
    console.error("[cleanup] Error cleaning temp files:", err);
  }

  return { checked, removed };
}

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT || "3011", 10);

// Require Tailscale for remote access (but bind to all interfaces with IP filtering)
const tailscaleIP = getTailscaleIP();
if (!tailscaleIP) {
  console.error("");
  console.error("ERROR: Tailscale is required but not available.");
  console.error("");
  console.error("Agent-OS requires Tailscale for secure remote access.");
  console.error("Please ensure Tailscale is installed and connected:");
  console.error("  - Install Tailscale: https://tailscale.com/download");
  console.error("  - Run: tailscale up");
  console.error("  - Verify with: tailscale ip -4");
  console.error("");
  process.exit(1);
}

// Bind to all interfaces, but use IP filtering middleware for security
// This allows hooks from localhost and Docker containers while still
// requiring Tailscale for remote web UI access
const hostname = "0.0.0.0";
const ipFilter = createIpFilterMiddleware();

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  // Configure global Claude hooks at startup (always regenerate to pick up new hook types)
  const result = writeGlobalHooksConfig(port);
  if (result.success) {
    console.log(`> Claude hooks configured at ${result.path}`);
  }

  // Recover sessions from previous server run
  const recoveryResult = await sessionManager.recoverSessions();
  console.log(
    `> Sessions recovered: ${recoveryResult.synced} total (${recoveryResult.alive} alive, ${recoveryResult.dead} dead)` +
      (recoveryResult.orphanContainersRemoved > 0
        ? `, ${recoveryResult.orphanContainersRemoved} orphan container(s) cleaned`
        : "")
  );

  // Clean up old temp files on startup
  const tempCleanup = await cleanupTempFiles();
  if (tempCleanup.removed > 0) {
    console.log(
      `> Temp files cleaned: ${tempCleanup.removed} old file(s) removed`
    );
  }

  // Build sandbox container image - Docker is required
  const imageReady = await ensureSandboxImage();
  if (imageReady) {
    console.log("> Sandbox container image ready");
  } else {
    console.error("");
    console.error("ERROR: Docker is required but not available.");
    console.error("");
    console.error("Please ensure Docker is installed and running:");
    console.error("  - Install Docker: https://docs.docker.com/get-docker/");
    console.error("  - Start Docker daemon");
    console.error(
      "  - Add your user to the 'docker' group (Linux): sudo usermod -aG docker $USER"
    );
    console.error("  - Log out and back in for group changes to take effect");
    console.error("");
    console.error("Then run 'agent-os install' to set up the sandbox image.");
    console.error("");
    process.exit(1);
  }
  const server = createServer(async (req, res) => {
    // Apply IP filtering - only allow trusted sources
    ipFilter(req, res, async () => {
      try {
        const parsedUrl = parse(req.url!, true);
        await handle(req, res, parsedUrl);
      } catch (err) {
        console.error("Error occurred handling", req.url, err);
        res.statusCode = 500;
        res.end("internal server error");
      }
    });
  });

  // Terminal WebSocket server
  const terminalWss = new WebSocketServer({ noServer: true });

  // Track active connections per session (exclusive - only one client at a time)
  const activeConnections = new Map<string, Set<WebSocket>>();
  const MAX_CONNECTIONS_PER_SESSION = 1;
  // Global limit on total WebSocket connections to prevent resource exhaustion
  // For personal network use, 50 is generous (allows many browser tabs)
  const MAX_TOTAL_CONNECTIONS = 50;

  // Track active PTY processes for proper cleanup on shutdown
  const activePtyProcesses = new Map<WebSocket, pty.IPty>();

  // Track pending resize operations per connection for debouncing
  // This prevents race conditions when multiple resize events fire rapidly
  const pendingResizes = new Map<
    WebSocket,
    { timeout: NodeJS.Timeout; cols: number; rows: number }
  >();
  const RESIZE_DEBOUNCE_MS = 100; // Coalesce resize events within this window

  // Helper to clean up connection tracking
  function removeConnection(sessionId: string, ws: WebSocket): void {
    const conns = activeConnections.get(sessionId);
    if (conns) {
      conns.delete(ws);
      if (conns.size === 0) {
        activeConnections.delete(sessionId);
      }
    }
  }

  // Handle WebSocket upgrades
  server.on("upgrade", (request, socket, head) => {
    const { pathname } = parse(request.url || "");

    if (pathname === "/ws/terminal") {
      terminalWss.handleUpgrade(request, socket, head, (ws) => {
        terminalWss.emit("connection", ws, request);
      });
    }
    // Let HMR and other WebSocket connections pass through to Next.js
  });

  // Terminal connections
  terminalWss.on(
    "connection",
    async (ws: WebSocket, request: import("http").IncomingMessage) => {
      let ptyProcess: pty.IPty | null = null;
      // Tmux session info for resize handling (populated after session validation)
      let tmuxName: string | null = null;
      let containerId: string | undefined = undefined;

      // Parse sessionId and terminal dimensions from URL params
      const requestUrl = new URL(
        request.url || "",
        `http://${request.headers.host}`
      );
      const sessionId = requestUrl.searchParams.get("sessionId");
      // Parse takeover flag (kicks existing client if true)
      const takeover = requestUrl.searchParams.get("takeover") === "true";
      // Parse initial terminal dimensions (to avoid resize flash on connect)
      const initialCols = Math.max(
        1,
        parseInt(requestUrl.searchParams.get("cols") || "80", 10) || 80
      );
      const initialRows = Math.max(
        1,
        parseInt(requestUrl.searchParams.get("rows") || "24", 10) || 24
      );

      try {
        // 1. If no sessionId provided, send error and close
        if (!sessionId) {
          console.error("[terminal] No sessionId provided in WebSocket URL");
          ws.send(
            JSON.stringify({
              type: "error",
              message: "No session ID provided",
            })
          );
          ws.close();
          return;
        }

        // 3. Use sessionManager.getSession(sessionId) to get the session
        const session = await sessionManager.getSession(sessionId);

        // 4. If session not found, send error and close
        if (!session) {
          console.error(`[terminal] Session ${sessionId} not found`);
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Session not found",
            })
          );
          ws.close();
          return;
        }

        // 5. Check lifecycle_status === 'ready' - if not, send error and close
        if (session.lifecycle_status !== "ready") {
          console.error(
            `[terminal] Session ${sessionId} not ready: lifecycle_status=${session.lifecycle_status}`
          );
          ws.send(
            JSON.stringify({
              type: "error",
              message: `Session is not ready (status: ${session.lifecycle_status}). Please wait for setup to complete or recreate the session.`,
            })
          );
          ws.close();
          return;
        }

        // 6. Check global connection limit to prevent resource exhaustion
        const totalConnections = Array.from(activeConnections.values()).reduce(
          (sum, conns) => sum + conns.size,
          0
        );
        if (totalConnections >= MAX_TOTAL_CONNECTIONS) {
          console.warn(
            `[terminal] Global connection limit reached (${MAX_TOTAL_CONNECTIONS}), rejecting new connection`
          );
          ws.send(
            JSON.stringify({
              type: "error",
              message: `Server connection limit reached (${MAX_TOTAL_CONNECTIONS}). Please close some terminal tabs and try again.`,
            })
          );
          ws.close();
          return;
        }

        // 7. Check connection limit for this session (exclusive - only one client at a time)
        const sessionConns = activeConnections.get(sessionId) || new Set();
        if (sessionConns.size >= MAX_CONNECTIONS_PER_SESSION) {
          if (takeover) {
            // Kick existing client(s) to allow this connection
            console.log(
              `[terminal] Session ${sessionId}: takeover requested, kicking ${sessionConns.size} existing connection(s)`
            );
            for (const existingWs of sessionConns) {
              try {
                existingWs.send(
                  JSON.stringify({
                    type: "kicked",
                    message: "Another client connected to this session",
                  })
                );
                existingWs.close(1000, "Kicked by new connection");
              } catch {
                // Ignore errors when closing existing connections
              }
            }
            // Clear the connections (they'll be cleaned up by their close handlers)
            sessionConns.clear();
          } else {
            // Reject new connection - another client is already connected
            console.warn(
              `[terminal] Session ${sessionId} already has a connection, rejecting new client`
            );
            ws.send(
              JSON.stringify({
                type: "busy",
                message:
                  "Another client is already connected to this session. Close that tab or click 'Take over' to disconnect them.",
              })
            );
            ws.close();
            return;
          }
        }

        // 7. Re-fetch session to prevent TOCTOU race (session could be deleted between check and use)
        const freshSession = await sessionManager.getSession(sessionId);
        if (!freshSession || freshSession.lifecycle_status !== "ready") {
          console.error(
            `[terminal] Session ${sessionId} no longer ready (race condition detected)`
          );
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Session is no longer available. Please try again.",
            })
          );
          ws.close();
          return;
        }

        // 8. For sandboxed sessions, verify container is still running
        const isSandboxed =
          freshSession.container_id &&
          freshSession.container_status === "ready";
        if (isSandboxed) {
          const containerRunning = await isContainerRunning(
            freshSession.container_id!
          );
          if (!containerRunning) {
            console.error(
              `[terminal] Container ${freshSession.container_id} for session ${sessionId} is not running`
            );
            ws.send(
              JSON.stringify({
                type: "error",
                message:
                  "Session container is not running. The session may have crashed or been stopped. Please recreate the session.",
              })
            );
            ws.close();
            return;
          }
        }

        // 9. Verify tmux session is actually alive (handles both sandboxed and non-sandboxed)
        // This catches cases where the tmux died but the DB still shows lifecycle_status='ready'
        const tmuxAlive = await sessionManager.isSessionAlive(sessionId);
        if (!tmuxAlive) {
          console.error(
            `[terminal] Tmux session for ${sessionId} is not running, marking as failed`
          );
          // Mark session as failed so user can reboot it
          await sessionManager.markSessionAsFailed(
            sessionId,
            "tmux session not running"
          );
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                "Session has crashed. Click 'Reboot session' to recover.",
              lifecycle_status: "failed",
            })
          );
          ws.close();
          return;
        }

        // 10. Track this connection
        if (!activeConnections.has(sessionId)) {
          activeConnections.set(sessionId, new Set());
        }
        activeConnections.get(sessionId)!.add(ws);

        // 11. Use sessionManager.getViewCommand(session) to get the attach command
        const { command, args } = sessionManager.getViewCommand(freshSession);

        // Store tmux session name for resize handling
        tmuxName = getTmuxSessionName(freshSession);
        containerId = isSandboxed
          ? (freshSession.container_id ?? undefined)
          : undefined;

        console.log(
          `[terminal] Attaching to session ${sessionId} with command: ${command} ${args.join(" ")}`
        );

        // 12. Spawn PTY with the attach command (this attaches to the existing tmux session)
        // Use client-provided dimensions to avoid resize flash on initial connect
        ptyProcess = pty.spawn(command, args, {
          name: "xterm-256color",
          cols: initialCols,
          rows: initialRows,
          cwd: process.env.HOME || "/",
          env: {
            PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
            HOME: process.env.HOME || "/",
            TERM: "xterm-256color",
            LANG: process.env.LANG || "en_US.UTF-8",
          },
        });

        // Register PTY process for tracking (for cleanup on shutdown)
        activePtyProcesses.set(ws, ptyProcess);
      } catch (err) {
        console.error("[terminal] Failed to spawn pty:", err);
        // Clean up PTY process if it was partially created
        if (ptyProcess) {
          try {
            ptyProcess.kill();
          } catch {
            // Ignore kill errors
          }
        }
        // Clean up connection tracking on PTY spawn failure
        if (sessionId) removeConnection(sessionId, ws);
        ws.send(
          JSON.stringify({ type: "error", message: "Failed to start terminal" })
        );
        ws.close();
        return;
      }

      // Relay I/O between WebSocket and PTY
      ptyProcess.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "output", data }));
        }
      });

      ptyProcess.onExit(({ exitCode }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "exit", code: exitCode }));
          ws.close();
        }
      });

      // Handle input (send to PTY), resize (resize PTY), close (kill PTY)
      ws.on("message", (message: Buffer) => {
        try {
          const msg = JSON.parse(message.toString());
          switch (msg.type) {
            case "input":
              ptyProcess?.write(msg.data);
              break;
            case "resize":
              // Resize the PTY immediately (synchronous, sends SIGWINCH)
              ptyProcess?.resize(msg.cols, msg.rows);

              // Debounce the tmux refresh-client call to prevent race conditions
              // when multiple resize events fire rapidly (e.g., during window drag)
              if (tmuxName) {
                // Clear any pending resize for this connection
                const pending = pendingResizes.get(ws);
                if (pending) {
                  clearTimeout(pending.timeout);
                }

                // Schedule a new debounced resize
                const timeout = setTimeout(async () => {
                  pendingResizes.delete(ws);
                  // Only refresh if connection is still open
                  if (ws.readyState === WebSocket.OPEN) {
                    await refreshTmuxClient(
                      tmuxName!,
                      msg.cols,
                      msg.rows,
                      containerId
                    );
                  }
                }, RESIZE_DEBOUNCE_MS);

                pendingResizes.set(ws, {
                  timeout,
                  cols: msg.cols,
                  rows: msg.rows,
                });
              }
              break;
            // Note: "command" message type removed - client no longer sends commands
          }
        } catch (err) {
          console.error("[terminal] Error parsing message:", err);
        }
      });

      ws.on("close", () => {
        try {
          ptyProcess?.kill();
        } catch (err) {
          console.error("[terminal] Failed to kill PTY on close:", err);
        }
        // Remove from PTY tracking map
        activePtyProcesses.delete(ws);
        // Clean up pending resize timeout
        const pendingResize = pendingResizes.get(ws);
        if (pendingResize) {
          clearTimeout(pendingResize.timeout);
          pendingResizes.delete(ws);
        }
        // Use captured sessionId instead of re-parsing URL
        if (sessionId) removeConnection(sessionId, ws);
      });

      ws.on("error", (err) => {
        console.error("[terminal] WebSocket error:", err);
        try {
          ptyProcess?.kill();
        } catch (killErr) {
          console.error("[terminal] Failed to kill PTY on error:", killErr);
        }
        // Remove from PTY tracking map
        activePtyProcesses.delete(ws);
        // Clean up pending resize timeout
        const pendingResize = pendingResizes.get(ws);
        if (pendingResize) {
          clearTimeout(pendingResize.timeout);
          pendingResizes.delete(ws);
        }
        // Clean up connection tracking on error
        if (sessionId) removeConnection(sessionId, ws);
      });
    }
  );

  // Periodic cleanup of orphaned PTY processes (every 60 seconds)
  // This catches any PTY processes whose WebSocket closed without proper cleanup
  const ptyCleanupInterval = setInterval(() => {
    let orphanedCount = 0;
    for (const [ws, ptyProcess] of activePtyProcesses) {
      // Check if WebSocket is no longer open
      if (
        ws.readyState !== WebSocket.OPEN &&
        ws.readyState !== WebSocket.CONNECTING
      ) {
        try {
          ptyProcess.kill();
          orphanedCount++;
        } catch {
          // Ignore kill errors (process may already be dead)
        }
        activePtyProcesses.delete(ws);

        // Also clean up any pending resize timeout
        const pendingResize = pendingResizes.get(ws);
        if (pendingResize) {
          clearTimeout(pendingResize.timeout);
          pendingResizes.delete(ws);
        }
      }
    }
    if (orphanedCount > 0) {
      console.log(
        `[terminal] Cleaned up ${orphanedCount} orphaned PTY process(es)`
      );
    }
  }, 60000);

  // Periodic cleanup of old temp files (every hour)
  const tempCleanupInterval = setInterval(async () => {
    const result = await cleanupTempFiles();
    if (result.removed > 0) {
      console.log(
        `[cleanup] Removed ${result.removed} old temp file(s) out of ${result.checked} checked`
      );
    }
  }, TEMP_CLEANUP_INTERVAL_MS);

  // Fix orphaned auto-approve sessions (mark as failed if no container)
  const db = getDb();
  const fixedCount = fixOrphanedAutoApproveSessions(db);
  if (fixedCount > 0) {
    console.log(`> Fixed ${fixedCount} orphaned auto-approve sessions`);
  }

  // Validate database constraints
  const validation = validateDatabaseConstraints(db);
  if (!validation.valid) {
    console.warn("> Database constraint violations found:");
    for (const violation of validation.violations) {
      console.warn(`  - ${violation}`);
    }
  }

  server.listen(port, hostname, () => {
    console.log(`> Agent-OS ready on http://localhost:${port}`);
    console.log(`> Remote access via Tailscale: http://${tailscaleIP}:${port}`);
    console.log(`> Accepting connections from: ${describeTrustedNetworks()}`);
  });

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`\n> Received ${signal}, shutting down gracefully...`);

    // Stop periodic cleanup intervals
    clearInterval(ptyCleanupInterval);
    clearInterval(tempCleanupInterval);

    // Close WebSocket server (stops accepting new connections)
    terminalWss.close();

    // Kill all PTY processes explicitly (don't rely on ws.on("close") handlers)
    console.log(`> Killing ${activePtyProcesses.size} PTY processes...`);
    for (const [ws, ptyProcess] of activePtyProcesses) {
      try {
        ptyProcess.kill();
      } catch (err) {
        console.error("[shutdown] Failed to kill PTY:", err);
      }
    }
    activePtyProcesses.clear();

    // Close all active WebSocket connections
    for (const [sessionId, connections] of activeConnections) {
      for (const ws of connections) {
        try {
          ws.close(1001, "Server shutting down");
        } catch {
          // Ignore close errors
        }
      }
    }
    activeConnections.clear();

    // Stop status broadcaster intervals
    const { statusBroadcaster } = await import("./lib/status-broadcaster");
    statusBroadcaster.shutdown();

    // Remove Claude hooks so they don't fire when server is down
    const { removeGlobalAgentOsHooks } =
      await import("./lib/hooks/generate-config");
    removeGlobalAgentOsHooks();

    // Close database connection (ensures WAL checkpoint)
    const { closeDb } = await import("./lib/db");
    closeDb();

    // Close HTTP server
    server.close(() => {
      console.log("> Server closed");
      process.exit(0);
    });

    // Force exit after 10s if graceful shutdown hangs
    setTimeout(() => {
      console.error("> Forced shutdown after timeout");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
});
