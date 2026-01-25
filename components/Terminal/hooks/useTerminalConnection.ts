"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import { WS_RECONNECT_BASE_DELAY } from "../constants";
import type {
  TerminalScrollState,
  UseTerminalConnectionProps,
  UseTerminalConnectionReturn,
} from "./useTerminalConnection.types";
import {
  createTerminal,
  updateTerminalForMobile,
  updateTerminalTheme,
} from "./terminal-init";
import { setupTouchScroll } from "./touch-scroll";
import { createWebSocketConnection } from "./websocket-connection";
import { setupResizeHandlers } from "./resize-handlers";

export type { TerminalScrollState } from "./useTerminalConnection.types";

export function useTerminalConnection({
  terminalRef,
  sessionId,
  enabled = true,
  onConnected,
  onDisconnected,
  onKicked,
  onBusy,
  onSessionFailed,
  onBeforeUnmount,
  initialScrollState,
  isMobile = false,
  theme = "dark",
  selectMode = false,
}: UseTerminalConnectionProps): UseTerminalConnectionReturn {
  const [connected, setConnected] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [connectionState, setConnectionState] = useState<
    | "connecting"
    | "connected"
    | "disconnected"
    | "reconnecting"
    | "kicked"
    | "busy"
  >("connecting");

  const wsRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const reconnectFnRef = useRef<(() => void) | null>(null);
  const takeoverFnRef = useRef<(() => void) | null>(null);

  // Reconnection tracking
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectDelayRef = useRef<number>(WS_RECONNECT_BASE_DELAY);
  const intentionalCloseRef = useRef<boolean>(false);

  // Store callbacks and state in refs
  const callbacksRef = useRef({
    onConnected,
    onDisconnected,
    onKicked,
    onBusy,
    onSessionFailed,
    onBeforeUnmount,
  });
  callbacksRef.current = {
    onConnected,
    onDisconnected,
    onKicked,
    onBusy,
    onSessionFailed,
    onBeforeUnmount,
  };
  const initialScrollStateRef = useRef(initialScrollState);
  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;

  // Simple callbacks
  const scrollToBottom = useCallback(
    () => xtermRef.current?.scrollToBottom(),
    []
  );

  const copySelection = useCallback(() => {
    const selection = xtermRef.current?.getSelection();
    if (selection) {
      navigator.clipboard.writeText(selection);
      return true;
    }
    return false;
  }, []);

  const sendInput = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input", data }));
    }
  }, []);

  const focus = useCallback(() => xtermRef.current?.focus(), []);

  const getScrollState = useCallback((): TerminalScrollState | null => {
    if (!xtermRef.current || !terminalRef.current) return null;
    const buffer = xtermRef.current.buffer.active;
    const viewport = terminalRef.current.querySelector(
      ".xterm-viewport"
    ) as HTMLElement;
    return {
      scrollTop: viewport?.scrollTop ?? 0,
      cursorY: buffer.cursorY,
      baseY: buffer.baseY,
    };
  }, [terminalRef]);

  const restoreScrollState = useCallback(
    (state: TerminalScrollState) => {
      const viewport = terminalRef.current?.querySelector(
        ".xterm-viewport"
      ) as HTMLElement;
      if (viewport) {
        requestAnimationFrame(() => {
          viewport.scrollTop = state.scrollTop;
        });
      }
    },
    [terminalRef]
  );

  const triggerResize = useCallback(() => {
    const fitAddon = fitAddonRef.current;
    const term = xtermRef.current;
    if (!fitAddon || !term) return;
    fitAddon.fit();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
      );
    }
  }, []);

  const reconnect = useCallback(() => {
    reconnectFnRef.current?.();
  }, []);

  const takeover = useCallback(() => {
    takeoverFnRef.current?.();
  }, []);

  // Main setup effect
  useEffect(() => {
    if (!terminalRef.current) return;
    // Don't connect if not enabled (session not ready)
    if (!enabled) {
      setConnectionState("disconnected");
      return;
    }

    // Reset intentional close flag (may be true from previous cleanup)
    intentionalCloseRef.current = false;
    let cleanupTouchScroll: (() => void) | null = null;
    let cleanupResizeHandlers: (() => void) | null = null;
    let cleanupWebSocket: (() => void) | null = null;
    let cleanupTerminal: (() => void) | null = null;
    let cleanupScrollHandler: (() => void) | null = null;

    // Initialize terminal
    const { term, fitAddon, searchAddon, cleanup } = createTerminal(
      terminalRef.current,
      isMobile,
      theme
    );
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    cleanupTerminal = cleanup;

    // Scroll tracking - store disposable for cleanup
    const scrollDisposable = term.onScroll(() => {
      const buffer = term.buffer.active;
      setIsAtBottom(buffer.viewportY >= buffer.baseY);
    });
    cleanupScrollHandler = () => scrollDisposable.dispose();

    // Setup touch scroll (mobile)
    cleanupTouchScroll = setupTouchScroll({ term, selectModeRef, wsRef });

    // Setup WebSocket
    const wsManager = createWebSocketConnection(
      term,
      {
        onConnected: () => {
          callbacksRef.current.onConnected?.();
          // Restore scroll state after connection
          if (initialScrollStateRef.current && terminalRef.current) {
            setTimeout(() => {
              const viewport = terminalRef.current?.querySelector(
                ".xterm-viewport"
              ) as HTMLElement;
              if (viewport)
                viewport.scrollTop = initialScrollStateRef.current!.scrollTop;
            }, 200);
          }
        },
        onDisconnected: () => callbacksRef.current.onDisconnected?.(),
        onKicked: (message) => callbacksRef.current.onKicked?.(message),
        onBusy: (message) => callbacksRef.current.onBusy?.(message),
        onSessionFailed: () => callbacksRef.current.onSessionFailed?.(),
        onConnectionStateChange: setConnectionState,
        onSetConnected: setConnected,
      },
      wsRef,
      reconnectTimeoutRef,
      reconnectDelayRef,
      intentionalCloseRef,
      sessionId
    );
    cleanupWebSocket = wsManager.cleanup;
    reconnectFnRef.current = wsManager.reconnect;
    takeoverFnRef.current = wsManager.takeover;

    // Setup resize handlers
    cleanupResizeHandlers = setupResizeHandlers({
      term,
      fitAddon,
      containerRef: terminalRef,
      isMobile,
      sendResize: wsManager.sendResize,
    });

    return () => {
      intentionalCloseRef.current = true;

      // Save scroll state before unmount
      const term = xtermRef.current;
      if (term && callbacksRef.current.onBeforeUnmount && terminalRef.current) {
        const buffer = term.buffer.active;
        const viewport = terminalRef.current.querySelector(
          ".xterm-viewport"
        ) as HTMLElement;
        callbacksRef.current.onBeforeUnmount({
          scrollTop: viewport?.scrollTop ?? 0,
          cursorY: buffer.cursorY,
          baseY: buffer.baseY,
        });
      }

      // Cleanup in reverse order
      cleanupResizeHandlers?.();
      cleanupWebSocket?.();
      cleanupTouchScroll?.();
      cleanupScrollHandler?.();
      cleanupTerminal?.();

      // Reset refs
      reconnectDelayRef.current = WS_RECONNECT_BASE_DELAY;

      if (wsRef.current) wsRef.current = null;
      if (xtermRef.current) {
        try {
          xtermRef.current.dispose();
        } catch {
          /* ignore */
        }
        xtermRef.current = null;
      }
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [isMobile, terminalRef, theme, sessionId, enabled]);

  // Handle isMobile changes dynamically
  useEffect(() => {
    const term = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    updateTerminalForMobile(term, fitAddon, isMobile, (cols, rows) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });
  }, [isMobile]);

  // Handle theme changes dynamically
  useEffect(() => {
    if (xtermRef.current) {
      updateTerminalTheme(xtermRef.current, theme);
    }
  }, [theme]);

  return {
    connected,
    connectionState,
    isAtBottom,
    xtermRef,
    searchAddonRef,
    scrollToBottom,
    copySelection,
    sendInput,
    focus,
    getScrollState,
    restoreScrollState,
    triggerResize,
    reconnect,
    takeover,
  };
}
