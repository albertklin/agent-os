"use client";

import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

interface ResizeHandlersConfig {
  term: XTerm;
  fitAddon: FitAddon;
  containerRef: React.RefObject<HTMLDivElement | null>;
  isMobile: boolean;
  sendResize: (cols: number, rows: number) => void;
}

export function setupResizeHandlers(config: ResizeHandlersConfig): () => void {
  const { term, fitAddon, containerRef, isMobile, sendResize } = config;

  let resizeObserver: ResizeObserver | null = null;

  // Workaround for FitAddon bug: it reserves 14px for scrollbar even when hidden
  // FitAddon uses `overviewRuler?.width || 14` which doesn't work with 0 (falsy)
  // On mobile we hide the scrollbar via CSS, so manually expand xterm-screen to full width
  const fixMobileScrollbarWidth = () => {
    if (!isMobile || !containerRef.current) return;

    const xtermScreen = containerRef.current.querySelector(
      ".xterm-screen"
    ) as HTMLElement | null;
    if (xtermScreen) {
      const containerWidth = containerRef.current.clientWidth;
      xtermScreen.style.width = `${containerWidth}px`;
    }
  };

  const doFit = () => {
    // On mobile, save scroll position before fit to prevent keyboard open/close scroll jump
    const savedScrollLine = isMobile ? term.buffer.active.viewportY : null;

    requestAnimationFrame(() => {
      fitAddon.fit();
      fixMobileScrollbarWidth();
      if (savedScrollLine !== null) {
        term.scrollToLine(savedScrollLine);
      }
      sendResize(term.cols, term.rows);
    });
  };

  // ResizeObserver catches all container size changes (window resize, DevTools, orientation, etc.)
  if (containerRef.current) {
    resizeObserver = new ResizeObserver(() => doFit());
    resizeObserver.observe(containerRef.current);
  }

  // Visual viewport changes for mobile keyboard (may not trigger container resize immediately)
  if (isMobile && window.visualViewport) {
    window.visualViewport.addEventListener("resize", doFit);
  }

  // Return cleanup function
  return () => {
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
    if (isMobile && window.visualViewport) {
      window.visualViewport.removeEventListener("resize", doFit);
    }
  };
}
