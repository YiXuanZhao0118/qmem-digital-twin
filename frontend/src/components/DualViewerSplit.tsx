// Dual-canvas wrapper around DigitalTwinViewer.
//
// Renders ONE DigitalTwinViewer when zustand `viewMode === "single"`, or
// TWO side-by-side instances with a draggable splitter when "dual". Each
// instance keeps its own camera + OrbitControls + display-mode (Render /
// Wireframe) — every other piece of scene state (selection, gizmo, beams,
// overlays …) stays shared via zustand because the viewer reads from there
// directly.
//
// Splitter drag is wired via refs + direct DOM mutation (no React state
// per pointermove) so 60fps drags don't churn React.

import { useCallback, useEffect, useRef } from "react";

import { useSceneStore } from "../store/sceneStore";
import { DigitalTwinViewer } from "./DigitalTwinViewer";

type RoomDimensions = {
  widthMm: number;
  depthMm: number;
  heightMm: number;
};

type DualViewerSplitProps = {
  roomDimensions: RoomDimensions;
};

const SPLIT_RATIO_KEY = "qmem-dual-view-split-ratio";
const DEFAULT_SPLIT = 0.5;
const MIN_SPLIT = 0.15;
const MAX_SPLIT = 0.85;

function loadSplitRatio(): number {
  try {
    const raw = window.localStorage.getItem(SPLIT_RATIO_KEY);
    if (!raw) return DEFAULT_SPLIT;
    const value = Number(raw);
    if (!Number.isFinite(value)) return DEFAULT_SPLIT;
    return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, value));
  } catch {
    return DEFAULT_SPLIT;
  }
}

export function DualViewerSplit({ roomDimensions }: DualViewerSplitProps) {
  const viewMode = useSceneStore((state) => state.viewMode);
  const displayMode = useSceneStore((state) => state.displayMode);
  const setDisplayMode = useSceneStore((state) => state.setDisplayMode);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const leftPaneRef = useRef<HTMLDivElement | null>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);
  const splitRatioRef = useRef<number>(loadSplitRatio());

  // Apply the persisted ratio on mount + whenever we re-enter dual mode.
  // We mutate flexBasis directly instead of using React state because the
  // ratio changes at pointer-move rate during a drag.
  const applySplit = useCallback((ratio: number) => {
    if (!leftPaneRef.current || !rightPaneRef.current) return;
    const clamped = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ratio));
    leftPaneRef.current.style.flexBasis = `${clamped * 100}%`;
    rightPaneRef.current.style.flexBasis = `${(1 - clamped) * 100}%`;
    splitRatioRef.current = clamped;
  }, []);

  useEffect(() => {
    if (viewMode === "dual") {
      applySplit(splitRatioRef.current);
    }
  }, [viewMode, applySplit]);

  const onSplitterPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const handleEl = event.currentTarget;
      handleEl.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        const ratio = (moveEvent.clientX - rect.left) / rect.width;
        applySplit(ratio);
      };
      const onUp = () => {
        handleEl.removeEventListener("pointermove", onMove);
        handleEl.removeEventListener("pointerup", onUp);
        handleEl.removeEventListener("pointercancel", onUp);
        try {
          window.localStorage.setItem(SPLIT_RATIO_KEY, splitRatioRef.current.toString());
        } catch {
          // ignore
        }
      };
      handleEl.addEventListener("pointermove", onMove);
      handleEl.addEventListener("pointerup", onUp);
      handleEl.addEventListener("pointercancel", onUp);
    },
    [applySplit],
  );

  if (viewMode === "single") {
    return (
      <DigitalTwinViewer
        roomDimensions={roomDimensions}
        panelKey="left"
        displayMode={displayMode.left}
        onDisplayModeChange={(mode) => setDisplayMode("left", mode)}
      />
    );
  }

  return (
    <div ref={containerRef} className="dual-viewer-split">
      <div ref={leftPaneRef} className="dual-viewer-pane" data-pane="left">
        <DigitalTwinViewer
          roomDimensions={roomDimensions}
          panelKey="left"
          displayMode={displayMode.left}
          onDisplayModeChange={(mode) => setDisplayMode("left", mode)}
        />
      </div>
      <div
        className="dual-viewer-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize viewers"
        onPointerDown={onSplitterPointerDown}
      />
      <div ref={rightPaneRef} className="dual-viewer-pane" data-pane="right">
        <DigitalTwinViewer
          roomDimensions={roomDimensions}
          panelKey="right"
          displayMode={displayMode.right}
          onDisplayModeChange={(mode) => setDisplayMode("right", mode)}
        />
      </div>
    </div>
  );
}
