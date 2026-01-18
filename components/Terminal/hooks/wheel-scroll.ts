"use client";

import type { Terminal as XTerm } from "@xterm/xterm";
import type { RefObject } from "react";

interface WheelScrollConfig {
  term: XTerm;
  selectModeRef: RefObject<boolean>;
}

export function setupWheelScroll(config: WheelScrollConfig): () => void {
  const { term, selectModeRef } = config;

  if (!term.element) return () => {};

  let wheelElement: HTMLElement | null = null;
  let handleWheel: ((e: WheelEvent) => void) | null = null;
  let setupTimeout: NodeJS.Timeout | null = null;

  const setupWheelScrollInner = () => {
    const xtermScreen = term.element?.querySelector(
      ".xterm-screen"
    ) as HTMLElement | null;
    if (!xtermScreen) {
      setupTimeout = setTimeout(setupWheelScrollInner, 50);
      return;
    }

    handleWheel = (e: WheelEvent) => {
      // Skip scrolling in select mode to allow normal text selection behavior
      if (selectModeRef.current) return;

      // Prevent xterm from sending wheel events as escape sequences to shell
      e.preventDefault();
      e.stopPropagation();

      // deltaY positive = scroll down (see newer/bottom content)
      // deltaY negative = scroll up (see older/top content)
      // term.scrollLines matches this convention
      const scrollLines = Math.round(e.deltaY / 30);

      if (scrollLines !== 0) {
        term.scrollLines(scrollLines);
      }
    };

    // Use capture phase to intercept before xterm's own handler
    xtermScreen.addEventListener("wheel", handleWheel, {
      passive: false,
      capture: true,
    });
    wheelElement = xtermScreen;
  };

  setupWheelScrollInner();

  return () => {
    if (setupTimeout) clearTimeout(setupTimeout);
    if (wheelElement && handleWheel) {
      wheelElement.removeEventListener("wheel", handleWheel, { capture: true });
    }
  };
}
