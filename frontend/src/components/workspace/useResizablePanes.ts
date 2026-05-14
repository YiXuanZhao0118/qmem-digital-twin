/**
 * Shared three-pane resize hook for the Electronics / Optics / EM workspaces.
 *
 * Each workspace renders the same shell (`.electronics-workspace` grid with
 * .electronics-sidebar + .electronics-editor + .electronics-results). This
 * hook drives the left/right column widths via two CSS custom properties
 * (`--ws-left`, `--ws-right`) on the container, and persists per-workspace
 * pixel widths to localStorage.
 *
 * Drag is implemented with refs + direct style mutation (same pattern as
 * DualViewerSplit) so pointermove doesn't churn React at 60 fps.
 */
import { useCallback, useEffect, useRef } from "react";

type Widths = { left: number; right: number };

const MIN_LEFT = 140;
const MIN_RIGHT = 200;
const MIN_CENTER = 260;

function storageKey(id: string) {
  return `qmem-ws-${id}-pane-widths`;
}

function loadWidths(id: string, fallback: Widths): Widths {
  try {
    const raw = window.localStorage.getItem(storageKey(id));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Widths>;
    if (typeof parsed.left === "number" && typeof parsed.right === "number") {
      return {
        left: Math.max(MIN_LEFT, parsed.left),
        right: Math.max(MIN_RIGHT, parsed.right),
      };
    }
  } catch {
    // ignore
  }
  return fallback;
}

function saveWidths(id: string, widths: Widths) {
  try {
    window.localStorage.setItem(storageKey(id), JSON.stringify(widths));
  } catch {
    // ignore
  }
}

export function useResizablePanes(opts: {
  id: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  defaultLeft?: number;
  defaultRight?: number;
}) {
  const { id, containerRef, defaultLeft = 220, defaultRight = 380 } = opts;
  const widthsRef = useRef<Widths>(
    loadWidths(id, { left: defaultLeft, right: defaultRight }),
  );

  const apply = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.style.setProperty("--ws-left", `${widthsRef.current.left}px`);
    el.style.setProperty("--ws-right", `${widthsRef.current.right}px`);
  }, [containerRef]);

  useEffect(() => {
    apply();
  }, [apply]);

  const startDrag = useCallback(
    (edge: "left" | "right") =>
      (event: React.PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        handle.dataset.dragging = "true";

        const onMove = (move: PointerEvent) => {
          const w = widthsRef.current;
          if (edge === "left") {
            const maxLeft = rect.width - w.right - MIN_CENTER;
            const next = Math.max(
              MIN_LEFT,
              Math.min(maxLeft, move.clientX - rect.left),
            );
            widthsRef.current = { ...w, left: next };
          } else {
            const maxRight = rect.width - w.left - MIN_CENTER;
            const next = Math.max(
              MIN_RIGHT,
              Math.min(maxRight, rect.right - move.clientX),
            );
            widthsRef.current = { ...w, right: next };
          }
          apply();
        };
        const onUp = () => {
          delete handle.dataset.dragging;
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);
          saveWidths(id, widthsRef.current);
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      },
    [apply, containerRef, id],
  );

  return { startDrag };
}
