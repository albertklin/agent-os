import { useEffect, useCallback, useRef } from "react";

/**
 * Checks if an element should receive keyboard input (inputs, textareas, etc.)
 */
function isInteractiveElement(element: Element | null): boolean {
  if (!element) return false;

  const tagName = element.tagName.toLowerCase();

  // Standard input elements
  if (tagName === "input" || tagName === "textarea" || tagName === "select") {
    return true;
  }

  // Contenteditable elements
  if (element.getAttribute("contenteditable") === "true") {
    return true;
  }

  // Elements with specific roles that accept input
  const role = element.getAttribute("role");
  if (role === "textbox" || role === "searchbox" || role === "combobox") {
    return true;
  }

  return false;
}

/**
 * Hook that redirects keyboard input to the terminal when no interactive element is focused.
 *
 * This ensures that keyboard input always goes to the terminal unless the user
 * has explicitly focused an input field, search box, or other interactive element.
 *
 * @param focusTerminal - Function to focus the terminal
 * @param enabled - Whether the redirect is enabled (e.g., when terminal is visible)
 */
export function useTerminalFocusRedirect(
  focusTerminal: (() => void) | null,
  enabled: boolean = true
) {
  const focusTerminalRef = useRef(focusTerminal);

  // Keep ref updated to avoid stale closures
  useEffect(() => {
    focusTerminalRef.current = focusTerminal;
  }, [focusTerminal]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled || !focusTerminalRef.current) return;

      // Don't intercept if an interactive element is focused
      if (isInteractiveElement(document.activeElement)) return;

      // Don't intercept modifier-only keypresses (let hotkeys work)
      if (
        e.key === "Control" ||
        e.key === "Meta" ||
        e.key === "Alt" ||
        e.key === "Shift"
      ) {
        return;
      }

      // Don't intercept keyboard shortcuts with modifiers (except Shift for capitals)
      // This allows Cmd+K, Ctrl+C, etc. to work normally
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }

      // Focus the terminal - it will receive this and subsequent keypresses
      focusTerminalRef.current();
    },
    [enabled]
  );

  useEffect(() => {
    if (!enabled) return;

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled, handleKeyDown]);
}
