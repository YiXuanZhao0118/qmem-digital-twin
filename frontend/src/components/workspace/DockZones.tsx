/**
 * Dock zones — the three reserve-space containers (left / right / bottom) that
 * docked FloatingPanels portal into. This component owns the zone DOM nodes
 * (so `document.getElementById("dock-left")` resolves), drives the grid track
 * sizes via CSS custom properties on `.workspace-canvas` (collapsing a zone to
 * 0 when it holds no visible panel), and renders the inner-edge resize handles.
 *
 * Sizes persist separately from the per-panel layout (which only carries float
 * geometry). The grid itself lives in `.workspace-canvas.has-docks` (styles.css).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useWorkspace } from "./WorkspaceProvider";

type ZoneSizes = { left: number; right: number; bottom: number };

const SIZES_KEY = "qmem.workspaceDock.zones.v1";
const DEFAULT_SIZES: ZoneSizes = { left: 300, right: 344, bottom: 300 };
const MIN_SIDE = 220;
const MIN_BOTTOM = 140;
const MIN_CENTER = 360; // keep the viewer at least this wide/tall

function loadSizes(): ZoneSizes {
  if (typeof window === "undefined") return { ...DEFAULT_SIZES };
  try {
    const raw = window.localStorage.getItem(SIZES_KEY);
    if (!raw) return { ...DEFAULT_SIZES };
    const p = JSON.parse(raw);
    return {
      left: typeof p.left === "number" ? p.left : DEFAULT_SIZES.left,
      right: typeof p.right === "number" ? p.right : DEFAULT_SIZES.right,
      bottom: typeof p.bottom === "number" ? p.bottom : DEFAULT_SIZES.bottom,
    };
  } catch {
    return { ...DEFAULT_SIZES };
  }
}

export function DockZones() {
  const { layouts } = useWorkspace();
  const [sizes, setSizes] = useState<ZoneSizes>(loadSizes);

  // Which zones currently hold a visible docked panel.
  const occ = useMemo(() => {
    const has = { left: false, right: false, bottom: false };
    for (const l of Object.values(layouts)) {
      if (l.visible && (l.dock === "left" || l.dock === "right" || l.dock === "bottom")) {
        has[l.dock] = true;
      }
    }
    return has;
  }, [layouts]);

  // Drive the grid tracks: a zone with no visible panel collapses to 0.
  useLayoutEffect(() => {
    const canvas = document.querySelector(".workspace-canvas") as HTMLElement | null;
    if (!canvas) return;
    canvas.style.setProperty("--dock-left", occ.left ? `${sizes.left}px` : "0px");
    canvas.style.setProperty("--dock-right", occ.right ? `${sizes.right}px` : "0px");
    canvas.style.setProperty("--dock-bottom", occ.bottom ? `${sizes.bottom}px` : "0px");
  }, [occ, sizes]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIZES_KEY, JSON.stringify(sizes));
    } catch {
      /* ignore quota */
    }
  }, [sizes]);

  // Generic edge-drag: `zone` is the dock being resized, `sign` flips the delta
  // direction (left grows with +x, right grows with -x, bottom grows with -y).
  const startDrag = useCallback(
    (zone: keyof ZoneSizes, axis: "x" | "y", sign: 1 | -1) =>
      (event: React.PointerEvent) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const startPos = axis === "x" ? event.clientX : event.clientY;
        const startSize = sizes[zone];
        const canvas = document.querySelector(".workspace-canvas") as HTMLElement | null;
        const rect = canvas?.getBoundingClientRect();
        const limit = zone === "bottom"
          ? (rect ? rect.height - MIN_CENTER : 99999)
          : (rect ? rect.width - MIN_CENTER : 99999);
        const min = zone === "bottom" ? MIN_BOTTOM : MIN_SIDE;
        const target = event.currentTarget as HTMLElement;
        target.setPointerCapture(event.pointerId);
        document.body.classList.add("is-dock-resize");

        const onMove = (e: PointerEvent) => {
          const pos = axis === "x" ? e.clientX : e.clientY;
          const next = Math.max(min, Math.min(limit, startSize + sign * (pos - startPos)));
          setSizes((s) => ({ ...s, [zone]: next }));
        };
        const onUp = (e: PointerEvent) => {
          target.releasePointerCapture(e.pointerId);
          document.body.classList.remove("is-dock-resize");
          target.removeEventListener("pointermove", onMove);
          target.removeEventListener("pointerup", onUp);
          target.removeEventListener("pointercancel", onUp);
        };
        target.addEventListener("pointermove", onMove);
        target.addEventListener("pointerup", onUp);
        target.addEventListener("pointercancel", onUp);
      },
    [sizes],
  );

  return (
    <>
      <div id="dock-left" className="dock-zone dock-zone-side dock-zone-left" />
      <div id="dock-right" className="dock-zone dock-zone-side dock-zone-right" />
      <div id="dock-bottom" className="dock-zone dock-zone-bottom" />
      {/* Resize handles sit at the gridline boundaries (positioned via the
          --dock-* vars) so the zones can scroll without clipping them. */}
      {occ.left && (
        <div
          className="dock-resize dock-resize-left"
          aria-hidden
          onPointerDown={startDrag("left", "x", 1)}
        />
      )}
      {occ.right && (
        <div
          className="dock-resize dock-resize-right"
          aria-hidden
          onPointerDown={startDrag("right", "x", -1)}
        />
      )}
      {occ.bottom && (
        <div
          className="dock-resize dock-resize-bottom"
          aria-hidden
          onPointerDown={startDrag("bottom", "y", -1)}
        />
      )}
    </>
  );
}
