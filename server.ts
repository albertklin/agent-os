import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
import { writeGlobalHooksConfig } from "./lib/hooks/generate-config";
import {
  ensureSandboxImage,
  isContainerRunning,
  logSecurityEvent,
} from "./lib/container";
import { getDb, queries } from "./lib/db";
import { statusBroadcaster } from "./lib/status-broadcaster";
import {
  validateDatabaseConstraints,
  fixOrphanedAutoApproveSessions,
} from "./lib/db/validation";

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = parseInt(process.env.PORT || "3011", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  // Configure global Claude hooks at startup (always regenerate to pick up new hook types)
  const result = writeGlobalHooksConfig(port);
  if (result.success) {
    console.log(`> Claude hooks configured at ${result.path}`);
  }

  // Sync session statuses from tmux
  const syncResult = statusBroadcaster.syncFromTmux();
  console.log(
    `> Session statuses synced: ${syncResult.synced} total (${syncResult.alive} alive, ${syncResult.dead} dead)`
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
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("Error occurred handling", req.url, err);
      res.statusCode = 500;
      res.end("internal server error");
    }
  });

  // Terminal WebSocket server
  const terminalWss = new WebSocketServer({ noServer: true });

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
      let ptyProcess: pty.IPty;
      try {
        // Parse sessionId from WebSocket URL query params
        const requestUrl = new URL(
          request.url || "",
          `http://${request.headers.host}`
        );
        const sessionId = requestUrl.searchParams.get("sessionId");

        // Fetch session details
        interface SessionData {
          container_id: string | null;
          sandbox_status: string | null;
          auto_approve: number;
          agent_type: string;
          worktree_path: string | null;
        }

        let session: SessionData | undefined;

        if (sessionId) {
          const db = getDb();
          session = queries.getSession(db).get(sessionId) as
            | SessionData
            | undefined;
        }

        // Debug logging for terminal connection
        console.log(
          `[terminal] Connection received: sessionId=${sessionId}, session=${session ? "found" : "not found"}, auto_approve=${session?.auto_approve}, agent_type=${session?.agent_type}, sandbox_status=${session?.sandbox_status}, container_id=${session?.container_id}`
        );

        // Check if this session requires a sandbox (auto-approve Claude sessions)
        const requiresSandbox =
          session && session.auto_approve && session.agent_type === "claude";

        console.log(`[terminal] requiresSandbox=${requiresSandbox}`);

        if (requiresSandbox && session) {
          // SECURITY: Fail-closed - refuse connection if sandbox not ready
          if (session.sandbox_status !== "ready") {
            console.error(
              `[terminal] SECURITY: Refusing connection for session ${sessionId} - sandbox_status=${session.sandbox_status}`
            );

            if (sessionId) {
              logSecurityEvent({
                type: "container_access_denied",
                sessionId,
                success: false,
                error: `Sandbox not ready: status=${session.sandbox_status}`,
              });
            }

            ws.send(
              JSON.stringify({
                type: "error",
                message:
                  "Container sandbox is not ready. Please wait for setup to complete or recreate the session.",
              })
            );
            ws.close();
            return;
          }

          // SECURITY: Validate container_id exists
          if (!session.container_id) {
            console.error(
              `[terminal] SECURITY: Refusing connection for session ${sessionId} - no container_id`
            );

            if (sessionId) {
              logSecurityEvent({
                type: "container_access_denied",
                sessionId,
                success: false,
                error: "Container configuration error: no container_id",
              });
            }

            ws.send(
              JSON.stringify({
                type: "error",
                message:
                  "Container configuration error. Please recreate the session.",
              })
            );
            ws.close();
            return;
          }

          // SECURITY: Check container is running before spawning PTY
          // (Full health check with firewall/mount validation happens at container creation)
          const containerId = session.container_id;
          const running = await isContainerRunning(containerId);

          if (!running) {
            console.error(
              `[terminal] SECURITY: Refusing connection for session ${sessionId} - container not running`
            );

            logSecurityEvent({
              type: "container_access_denied",
              sessionId: sessionId!,
              containerId,
              success: false,
              error: "Container not running",
            });

            // Update DB to reflect failure
            const db = getDb();
            queries
              .updateSessionSandboxWithHealth(db)
              .run(containerId, "failed", "unhealthy", sessionId);

            ws.send(
              JSON.stringify({
                type: "error",
                message: "Container has stopped. Please recreate the session.",
              })
            );
            ws.close();
            return;
          }

          // Health check passed - spawn shell inside container
          console.log(
            `[terminal] Spawning shell inside container ${containerId} for session ${sessionId}`
          );
          ptyProcess = pty.spawn(
            "docker",
            ["exec", "-it", containerId, "/bin/zsh", "-l"],
            {
              name: "xterm-256color",
              cols: 80,
              rows: 24,
              cwd: process.env.HOME || "/",
              env: {
                PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
                HOME: process.env.HOME || "/",
                TERM: "xterm-256color",
              },
            }
          );
        } else {
          // Non-sandboxed session: spawn on host
          const shell = process.env.SHELL || "/bin/zsh";
          // Use minimal env - only essentials for shell to work
          // This lets Next.js/Vite/etc load .env.local without interference from parent process env
          const minimalEnv: { [key: string]: string } = {
            PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
            HOME: process.env.HOME || "/",
            USER: process.env.USER || "",
            SHELL: shell,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            LANG: process.env.LANG || "en_US.UTF-8",
          };

          ptyProcess = pty.spawn(shell, [], {
            name: "xterm-256color",
            cols: 80,
            rows: 24,
            cwd: process.env.HOME || "/",
            env: minimalEnv,
          });
        }
      } catch (err) {
        console.error("Failed to spawn pty:", err);
        ws.send(
          JSON.stringify({ type: "error", message: "Failed to start terminal" })
        );
        ws.close();
        return;
      }

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

      ws.on("message", (message: Buffer) => {
        try {
          const msg = JSON.parse(message.toString());
          switch (msg.type) {
            case "input":
              ptyProcess.write(msg.data);
              break;
            case "resize":
              ptyProcess.resize(msg.cols, msg.rows);
              break;
            case "command":
              ptyProcess.write(msg.data + "\r");
              break;
          }
        } catch (err) {
          console.error("Error parsing message:", err);
        }
      });

      ws.on("close", () => {
        ptyProcess.kill();
      });

      ws.on("error", (err) => {
        console.error("WebSocket error:", err);
        ptyProcess.kill();
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

  server.listen(port, () => {
    console.log(`> Agent-OS ready on http://${hostname}:${port}`);
  });
});
