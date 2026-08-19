import { Columns2, Eye, Move, Play, Redo2, RotateCw, Square, SquareDashed, Type, Undo2, Wifi, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useSceneStore, TOUCH_OPS } from "../store/sceneStore";
import { DisplayPopover } from "./VisibilityControls";

type RoomDimensions = {
  widthMm: number;
  depthMm: number;
  heightMm: number;
};

type SceneToolbarProps = {
  roomDimensions: RoomDimensions;
  onRoomDimensionsChange: (dimensions: RoomDimensions) => void;
};

/** Inline SVG icons for the 6 touch ops. Each one shows two primitives
 *  side-by-side: filled dot = vertex, horizontal line = edge, square
 *  outline = face. ViewBox 28×16, currentColor so the active state inherits
 *  white-on-accent from the .touch-op-button.active rule. */
const TOUCH_OP_ICON_GLYPHS: Record<"vertex" | "edge" | "face", (cx: number) => JSX.Element> = {
  vertex: (cx) => <circle cx={cx} cy={8} r={2.5} fill="currentColor" />,
  edge: (cx) => (
    <line
      x1={cx - 5}
      y1={8}
      x2={cx + 5}
      y2={8}
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
    />
  ),
  face: (cx) => (
    <rect
      x={cx - 4.5}
      y={3.5}
      width={9}
      height={9}
      rx={1}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
    />
  ),
};

function TouchOpIcon({
  firstKind,
  secondKind,
}: {
  firstKind: "vertex" | "edge" | "face";
  secondKind: "vertex" | "edge" | "face";
}) {
  return (
    <svg width={26} height={16} viewBox="0 0 28 16" aria-hidden="true">
      {TOUCH_OP_ICON_GLYPHS[firstKind](7)}
      {TOUCH_OP_ICON_GLYPHS[secondKind](21)}
    </svg>
  );
}

export function SceneToolbar({ roomDimensions, onRoomDimensionsChange }: SceneToolbarProps) {
  const setupOpen = useSceneStore((state) => state.initialSetupOpen);
  const setSetupOpen = useSceneStore((state) => state.setInitialSetupOpen);
  const [draftDimensions, setDraftDimensions] = useState(roomDimensions);
  const [displayOpen, setDisplayOpen] = useState(false);
  const displayAnchorRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // The setup popover is portaled to <body> because `.top-bar-toolbar` clips
  // overflow — same reason DisplayPopover portals. Anchor it just under the
  // top bar, whose bottom edge we measure when the panel opens.
  const [setupPanelTop, setSetupPanelTop] = useState(64);
  const loadScene = useSceneStore((state) => state.loadScene);
  const runOpticalSimulation = useSceneStore((state) => state.runOpticalSimulation);
  const socketStatus = useSceneStore((state) => state.socketStatus);
  const gizmoMode = useSceneStore((state) => state.gizmoMode);
  const setGizmoMode = useSceneStore((state) => state.setGizmoMode);
  const selectedObjectIds = useSceneStore((state) => state.selectedObjectIds);
  // viewMode read here too so the auto-switch effect knows whether to also
  // sync the right panel (it's omitted on purpose in single-view).
  const viewMode = useSceneStore((state) => state.viewMode);
  const setViewMode = useSceneStore((state) => state.setViewMode);
  const activeTool = useSceneStore((state) => state.activeTool);
  const setActiveTool = useSceneStore((state) => state.setActiveTool);
  const faceTouchOp = useSceneStore((state) => state.faceTouchOp);
  const setFaceTouchOp = useSceneStore((state) => state.setFaceTouchOp);
  const addTextAnnotation = useSceneStore((state) => state.addTextAnnotation);
  const addRectAnnotation = useSceneStore((state) => state.addRectAnnotation);
  // Undo / Redo. The history itself has existed since the placement work
  // (sceneStore.undoStack); until now Ctrl+Z was its only affordance, so
  // users had no way to discover that a gizmo drag is reversible.
  const undoStack = useSceneStore((state) => state.undoStack);
  const redoStack = useSceneStore((state) => state.redoStack);
  const undoRedoBusy = useSceneStore((state) => state.undoRedoBusy);
  const undo = useSceneStore((state) => state.undo);
  const redo = useSceneStore((state) => state.redo);

  // Auto-switch to Translate gizmo mode on every selection action.
  // We watch `selectedObjectIds` (the array reference) — Zustand returns a
  // fresh array on every selectObject() call, so this fires even when the
  // user re-clicks the same object. Without this, after switching to
  // Rotate the user would have to click Translate again every time they
  // re-select; the report on 2026-05-02 flagged exactly this.
  const lastSelectionRef = useRef(selectedObjectIds);
  useEffect(() => {
    if (selectedObjectIds === lastSelectionRef.current) return;
    lastSelectionRef.current = selectedObjectIds;
    if (selectedObjectIds.length === 0) return;
    if (gizmoMode.left !== "translate") setGizmoMode("left", "translate");
    if (viewMode === "dual" && gizmoMode.right !== "translate") setGizmoMode("right", "translate");
  }, [selectedObjectIds, gizmoMode, setGizmoMode, viewMode]);

  useEffect(() => {
    if (!setupOpen) return;
    const bar = rootRef.current?.closest(".top-bar") ?? rootRef.current;
    if (bar) setSetupPanelTop(bar.getBoundingClientRect().bottom + 8);
  }, [setupOpen]);

  const nextUndo = undoStack.length > 0 ? undoStack[undoStack.length - 1] : null;
  const nextRedo = redoStack.length > 0 ? redoStack[redoStack.length - 1] : null;

  const [simBusy, setSimBusy] = useState(false);
  const [simStatus, setSimStatus] = useState<string>("");
  const connected = socketStatus === "connected";

  const updateDraft = (key: keyof RoomDimensions, value: string) => {
    const nextValue = Math.max(100, Number(value) || 0);
    setDraftDimensions((current) => ({ ...current, [key]: nextValue }));
  };

  const applyRoomDimensions = () => {
    onRoomDimensionsChange(draftDimensions);
    setSetupOpen(false);
  };

  const onRunSolver = async () => {
    setSimBusy(true);
    setSimStatus("");
    let hadError = false;
    try {
      const result = await runOpticalSimulation();
      if (result.errors.length) {
        // Surface the actual error text — "0 segments · 1 errors" alone is
        // useless when the user wants to know WHAT went wrong. Take the
        // first error verbatim and show it; collapse if there are several.
        const first = result.errors[0];
        const more = result.errors.length > 1 ? ` (+${result.errors.length - 1} more)` : "";
        setSimStatus(`✗ ${first}${more}`);
        hadError = true;
      } else if (result.warnings.length) {
        const first = result.warnings[0];
        const more = result.warnings.length > 1 ? ` (+${result.warnings.length - 1} more)` : "";
        setSimStatus(`✓ ${result.segmentCount} segments · ⚠ ${first}${more}`);
        await loadScene();
      } else {
        setSimStatus(`✓ ${result.segmentCount} segments`);
        await loadScene();
      }
    } catch (e) {
      setSimStatus(`✗ ${(e as Error).message}`);
      hadError = true;
    } finally {
      setSimBusy(false);
      // Errors / warnings stick longer so the user has time to read them.
      window.setTimeout(() => setSimStatus(""), hadError ? 15000 : 6000);
    }
  };

  return (
    <div className="scene-toolbar" ref={rootRef}>
      {/* The Scene group (Initial Setup / PHY Editor) now lives in the Lab tab
          menu — see workspace/ModuleSwitcher.tsx. The initial-setup popover
          still renders here (bottom of this file); the menu item just flips
          `sceneStore.initialSetupOpen`. "Add text annotation" came back out of
          that menu into the View group below. */}

      <div className="toolbar-group" data-group-label="Edit">
        <button
          className="icon-button"
          title={
            nextUndo
              ? `Undo: ${nextUndo.description} (Ctrl+Z)`
              : "Nothing to undo (Ctrl+Z)"
          }
          aria-label="Undo"
          disabled={!nextUndo || undoRedoBusy}
          onClick={() => void undo()}
        >
          <Undo2 size={17} />
        </button>
        <button
          className="icon-button"
          title={
            nextRedo
              ? `Redo: ${nextRedo.description} (Ctrl+Shift+Z)`
              : "Nothing to redo (Ctrl+Shift+Z)"
          }
          aria-label="Redo"
          disabled={!nextRedo || undoRedoBusy}
          onClick={() => void redo()}
        >
          <Redo2 size={17} />
        </button>
      </div>

      <div className="toolbar-divider" aria-hidden="true" />

      <div className="toolbar-group" data-group-label="View">
        <button
          className="icon-button"
          title="Add a text label to the scene at the cursor"
          aria-label="Add text annotation"
          onClick={() => void addTextAnnotation()}
        >
          <Type size={17} />
        </button>
        <button
          className="icon-button"
          title="Add a rectangular marking to the table at the cursor"
          aria-label="Add rect annotation"
          onClick={() => void addRectAnnotation()}
        >
          <SquareDashed size={17} />
        </button>
        <div className="display-anchor" ref={displayAnchorRef}>
          <button
            className={`icon-button${displayOpen ? " active" : ""}`}
            title="Display overlays"
            aria-label="Display overlays"
            onClick={() => setDisplayOpen((v) => !v)}
          >
            <Eye size={17} />
          </button>
          <DisplayPopover
            open={displayOpen}
            onClose={() => setDisplayOpen(false)}
            anchorRef={displayAnchorRef}
          />
        </div>
        <button
          className={`icon-button${viewMode === "dual" ? " active" : ""}`}
          title={viewMode === "dual" ? "Switch to single viewport" : "Switch to dual viewport"}
          aria-label="Toggle dual viewport"
          aria-pressed={viewMode === "dual"}
          onClick={() => setViewMode(viewMode === "dual" ? "single" : "dual")}
        >
          {viewMode === "dual" ? <Square size={17} /> : <Columns2 size={17} />}
        </button>
      </div>

      {/* Transform (Translate / Rotate) and Tools (face-touch ops) groups
          relocated into the 3D viewport overlay alongside the Wireframe /
          Rendered display-mode buttons — see DigitalTwinViewer's
          `viewer-transform-modes` and `viewer-tools-pie` overlays. */}

      <div className="toolbar-divider" aria-hidden="true" />

      <div className="toolbar-group" data-group-label="Status">
        {/* Run Solver button removed per UX request — the visual ray-tracer
            already shows live power / polarisation per segment, so the
            user no longer needs an explicit Run-Solver step for the
            common case. The store still exposes runOpticalSimulation()
            for programmatic / scheduled triggers. */}
        <span className={connected ? "socket-pill connected" : "socket-pill"}>
          {connected ? <Wifi size={16} /> : <WifiOff size={16} />}
          {socketStatus}
        </span>
      </div>

      {setupOpen && createPortal(
        <div className="initial-setup-panel" style={{ top: setupPanelTop }}>
          <label>
            Length (mm)
            <input
              type="number"
              min="100"
              step="100"
              value={draftDimensions.widthMm}
              onChange={(event) => updateDraft("widthMm", event.target.value)}
            />
          </label>
          <label>
            Width (mm)
            <input
              type="number"
              min="100"
              step="100"
              value={draftDimensions.depthMm}
              onChange={(event) => updateDraft("depthMm", event.target.value)}
            />
          </label>
          <label>
            Height (mm)
            <input
              type="number"
              min="100"
              step="100"
              value={draftDimensions.heightMm}
              onChange={(event) => updateDraft("heightMm", event.target.value)}
            />
          </label>
          <button className="primary-button" onClick={applyRoomDimensions}>
            Apply
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
