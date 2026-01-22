"use client";

import type { Terminal as XTerm } from "@xterm/xterm";
import { WS_RECONNECT_BASE_DELAY, WS_RECONNECT_MAX_DELAY } from "../constants";

export interface WebSocketCallbacks {
  onConnected?: () => void;
  onDisconnected?: () => void;
  onConnectionStateChange: (
    state:
      | "connecting"
      | "connected"
      | "disconnected"
      | "reconnecting"
      | "kicked"
      | "busy"
  ) => void;
  onSetConnected: (connected: boolean) => void;
  /** Called when kicked by another client - provides message to display */
  onKicked?: (message: string) => void;
  /** Called when session is busy (another client connected) - provides message */
  onBusy?: (message: string) => void;
}

export interface WebSocketManager {
  ws: WebSocket;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  reconnect: () => void;
  /** Reconnect with takeover flag to kick existing client */
  takeover: () => void;
  cleanup: () => void;
}

export function createWebSocketConnection(
  term: XTerm,
  callbacks: WebSocketCallbacks,
  wsRef: React.MutableRefObject<WebSocket | null>,
  reconnectTimeoutRef: React.MutableRefObject<NodeJS.Timeout | null>,
  reconnectDelayRef: React.MutableRefObject<number>,
  intentionalCloseRef: React.MutableRefObject<boolean>,
  sessionId?: string,
  takeover?: boolean
): WebSocketManager {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

  // Build WebSocket URL with current terminal dimensions
  // (server uses these to spawn PTY at correct size, avoiding resize flash)
  const buildWsUrl = (forceTakeover?: boolean) => {
    const params = new URLSearchParams();
    if (sessionId) params.set("sessionId", sessionId);
    params.set("cols", String(term.cols));
    params.set("rows", String(term.rows));
    if (forceTakeover || takeover) params.set("takeover", "true");
    return `${protocol}//${window.location.host}/ws/terminal?${params.toString()}`;
  };

  const ws = new WebSocket(buildWsUrl());
  wsRef.current = ws;

  const sendResize = (cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  };

  const sendInput = (data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input", data }));
    }
  };

  // Track whether we've sent the initial resize after tmux attaches
  let hasSentInitialResize = false;

  // Force reconnect - kills any existing connection and creates fresh one
  // Note: savedHandlers is populated after handlers are defined below
  let savedHandlers: {
    onopen: typeof ws.onopen;
    onmessage: typeof ws.onmessage;
    onclose: typeof ws.onclose;
    onerror: typeof ws.onerror;
  };

  const forceReconnect = (forceTakeover?: boolean) => {
    // Reset intentional close flag to allow reconnection
    if (forceTakeover) {
      intentionalCloseRef.current = false;
    }
    if (intentionalCloseRef.current) return;

    // Reset initial resize flag for the new connection
    hasSentInitialResize = false;

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Force close existing socket regardless of state (handles hung sockets)
    const oldWs = wsRef.current;
    if (oldWs) {
      // Remove handlers to prevent callbacks
      oldWs.onopen = null;
      oldWs.onmessage = null;
      oldWs.onclose = null;
      oldWs.onerror = null;
      try {
        oldWs.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    }

    callbacks.onConnectionStateChange("reconnecting");
    reconnectDelayRef.current = WS_RECONNECT_BASE_DELAY;

    // Create fresh connection with saved handlers (use current terminal size)
    const newWs = new WebSocket(buildWsUrl(forceTakeover));
    wsRef.current = newWs;
    newWs.onopen = savedHandlers.onopen;
    newWs.onmessage = savedHandlers.onmessage;
    newWs.onclose = savedHandlers.onclose;
    newWs.onerror = savedHandlers.onerror;
  };

  // Takeover session - reconnect with takeover flag to kick existing client
  const takeoverSession = () => {
    forceReconnect(true);
  };

  // Soft reconnect - only if not already connected
  const attemptReconnect = () => {
    if (intentionalCloseRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    forceReconnect();
  };

  ws.onopen = () => {
    callbacks.onSetConnected(true);
    callbacks.onConnectionStateChange("connected");
    reconnectDelayRef.current = WS_RECONNECT_BASE_DELAY;
    callbacks.onConnected?.();
    // Don't send resize here - it's too early, PTY/tmux may not be attached yet.
    // We send resize on first output message when tmux is actually rendering.
    term.focus();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "output") {
        // Send resize on first output as a safety check (in case terminal was resized
        // between connection and first output). PTY already starts at correct size
        // since we send dimensions in the WebSocket URL.
        if (!hasSentInitialResize) {
          hasSentInitialResize = true;
          sendResize(term.cols, term.rows);
        }
        term.write(msg.data);
      } else if (msg.type === "exit") {
        term.write("\r\n\x1b[33m[Session ended]\x1b[0m\r\n");
        // Prevent auto-reconnection when session has ended
        intentionalCloseRef.current = true;
      } else if (msg.type === "kicked") {
        term.write(
          `\r\n\x1b[33m[${msg.message || "Disconnected by another client"}]\x1b[0m\r\n`
        );
        // Prevent auto-reconnection when kicked
        intentionalCloseRef.current = true;
        callbacks.onConnectionStateChange("kicked");
        callbacks.onKicked?.(msg.message || "Another client connected");
      } else if (msg.type === "busy") {
        term.write(
          `\r\n\x1b[33m[${msg.message || "Session is busy"}]\x1b[0m\r\n`
        );
        // Prevent auto-reconnection when busy
        intentionalCloseRef.current = true;
        callbacks.onConnectionStateChange("busy");
        callbacks.onBusy?.(msg.message || "Another client is connected");
      } else if (msg.type === "error") {
        term.write(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m\r\n`);
        // Prevent auto-reconnection on server errors (session not found, etc.)
        intentionalCloseRef.current = true;
      }
    } catch {
      term.write(event.data);
    }
  };

  ws.onclose = () => {
    callbacks.onSetConnected(false);
    callbacks.onDisconnected?.();

    if (intentionalCloseRef.current) {
      callbacks.onConnectionStateChange("disconnected");
      return;
    }

    callbacks.onConnectionStateChange("disconnected");

    const currentDelay = reconnectDelayRef.current;
    reconnectDelayRef.current = Math.min(
      currentDelay * 2,
      WS_RECONNECT_MAX_DELAY
    );
    reconnectTimeoutRef.current = setTimeout(attemptReconnect, currentDelay);
  };

  ws.onerror = () => {
    // Errors are handled by onclose
  };

  // Save handlers now that they're defined (for reconnection)
  savedHandlers = {
    onopen: ws.onopen,
    onmessage: ws.onmessage,
    onclose: ws.onclose,
    onerror: ws.onerror,
  };

  // Handle terminal input - store disposable for cleanup
  const dataDisposable = term.onData((data) => {
    sendInput(data);
  });

  // Handle Shift+Enter for multi-line input
  // Note: attachCustomKeyEventHandler doesn't return a disposable - it's cleaned up when terminal is disposed
  term.attachCustomKeyEventHandler((event) => {
    if (event.type === "keydown" && event.key === "Enter" && event.shiftKey) {
      sendInput("\n");
      return false;
    }
    return true;
  });

  // Track when page was last hidden (for detecting long sleeps)
  let hiddenAt: number | null = null;

  // Handle visibility change for reconnection
  const handleVisibilityChange = () => {
    if (intentionalCloseRef.current) return;

    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }

    // Page became visible
    if (document.visibilityState !== "visible") return;

    const wasHiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = null;

    // If hidden for more than 5 seconds, force reconnect (iOS Safari kills sockets)
    // This handles the "hung socket" problem where readyState says OPEN but it's dead
    if (wasHiddenFor > 5000) {
      forceReconnect();
      return;
    }

    // Otherwise only reconnect if actually disconnected
    const currentWs = wsRef.current;
    const isDisconnected =
      !currentWs ||
      currentWs.readyState === WebSocket.CLOSED ||
      currentWs.readyState === WebSocket.CLOSING;
    const isStaleConnection = currentWs?.readyState === WebSocket.CONNECTING;

    if (isDisconnected || isStaleConnection) {
      forceReconnect();
    }
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);

  const cleanup = () => {
    // Dispose xterm.js event handlers to prevent memory leaks
    dataDisposable.dispose();

    document.removeEventListener("visibilitychange", handleVisibilityChange);
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    const currentWs = wsRef.current;
    if (
      currentWs &&
      (currentWs.readyState === WebSocket.OPEN ||
        currentWs.readyState === WebSocket.CONNECTING)
    ) {
      currentWs.close(1000, "Component unmounting");
    }
  };

  return {
    ws,
    sendInput,
    sendResize,
    reconnect: forceReconnect,
    takeover: takeoverSession,
    cleanup,
  };
}
