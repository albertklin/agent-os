/**
 * Terminal constants and theme configuration
 */

import { getTerminalTheme, type TerminalTheme } from "@/lib/terminal-themes";

// Reconnection constants
export const WS_RECONNECT_BASE_DELAY = 1000; // 1 second
export const WS_RECONNECT_MAX_DELAY = 30000; // 30 seconds

// Get terminal theme for current app theme
export function getTerminalThemeForApp(theme: string): TerminalTheme {
  return getTerminalTheme(theme);
}
