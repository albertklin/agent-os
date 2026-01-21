import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
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
    `> Sessions recovered: ${recoveryResult.synced} total (${recoveryResult.alive} alive, ${recoveryResult.dead} dead)`
  );

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

  // Track active connections per session to limit concurrent connections
  const activeConnections = new Map<string, Set<WebSocket>>();
  const MAX_CONNECTIONS_PER_SESSION = 3;

  // Track active PTY processes for proper cleanup on shutdown
  const activePtyProcesses = new Map<WebSocket, pty.IPty>();

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

      // Parse sessionId early so it's available for cleanup in event handlers
      const requestUrl = new URL(
        request.url || "",
        `http://${request.headers.host}`
      );
      const sessionId = requestUrl.searchParams.get("sessionId");

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

        // 6. Check connection limit for this session
        const sessionConns = activeConnections.get(sessionId) || new Set();
        if (sessionConns.size >= MAX_CONNECTIONS_PER_SESSION) {
          console.warn(
            `[terminal] Session ${sessionId} has too many connections (${sessionConns.size})`
          );
          ws.send(
            JSON.stringify({
              type: "error",
              message: `Too many connections to this session. Maximum ${MAX_CONNECTIONS_PER_SESSION} allowed.`,
            })
          );
          ws.close();
          return;
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

        // 9. Track this connection
        if (!activeConnections.has(sessionId)) {
          activeConnections.set(sessionId, new Set());
        }
        activeConnections.get(sessionId)!.add(ws);

        // 9. Use sessionManager.getViewCommand(session) to get the attach command
        const { command, args } = sessionManager.getViewCommand(freshSession);

        // Store tmux session name for resize handling
        tmuxName = getTmuxSessionName(freshSession);
        containerId = isSandboxed
          ? (freshSession.container_id ?? undefined)
          : undefined;

        console.log(
          `[terminal] Attaching to session ${sessionId} with command: ${command} ${args.join(" ")} (connection ${activeConnections.get(sessionId)!.size}/${MAX_CONNECTIONS_PER_SESSION})`
        );

        // 10. Spawn PTY with the attach command (this attaches to the existing tmux session)
        ptyProcess = pty.spawn(command, args, {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
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
              ptyProcess?.resize(msg.cols, msg.rows);
              // Also refresh tmux client to ensure it adopts the new dimensions
              if (tmuxName) {
                refreshTmuxClient(tmuxName, msg.cols, msg.rows, containerId);
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
        // Clean up connection tracking on error
        if (sessionId) removeConnection(sessionId, ws);
      });
    }
  );

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
