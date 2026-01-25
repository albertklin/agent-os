"use client";

import type { RefObject } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";

export interface TerminalScrollState {
  scrollTop: number;
  cursorY: number;
  baseY: number;
}

export interface UseTerminalConnectionProps {
  terminalRef: RefObject<HTMLDivElement | null>;
  sessionId?: string;
  /** If false, terminal won't connect to WebSocket (default: true) */
  enabled?: boolean;
  onConnected?: () => void;
  onDisconnected?: () => void;
  /** Called when kicked by another client taking over the session */
  onKicked?: (message: string) => void;
  /** Called when session is busy (another client connected) */
  onBusy?: (message: string) => void;
  /** Called when server reports session has failed (e.g., tmux crashed) */
  onSessionFailed?: () => void;
  onBeforeUnmount?: (scrollState: TerminalScrollState) => void;
  initialScrollState?: TerminalScrollState;
  isMobile?: boolean;
  theme?: string;
  selectMode?: boolean;
}

export interface UseTerminalConnectionReturn {
  connected: boolean;
  connectionState:
    | "connecting"
    | "connected"
    | "disconnected"
    | "reconnecting"
    | "kicked"
    | "busy";
  isAtBottom: boolean;
  xtermRef: RefObject<XTerm | null>;
  searchAddonRef: RefObject<SearchAddon | null>;
  scrollToBottom: () => void;
  copySelection: () => boolean;
  sendInput: (data: string) => void;
  focus: () => void;
  getScrollState: () => TerminalScrollState | null;
  restoreScrollState: (state: TerminalScrollState) => void;
  triggerResize: () => void;
  reconnect: () => void;
  /** Reconnect with takeover flag to kick existing client */
  takeover: () => void;
}
