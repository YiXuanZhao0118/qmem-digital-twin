/**
 * FloatingPanel — Blender-style movable / resizable / collapsible window.
 *
 * Reads its layout from WorkspaceProvider, writes back drag/resize/collapse
 * actions. Whole header drags (PointerEvent + setPointerCapture, no global
 * listeners). SE-corner resize. Click anywhere on the panel raises z-index.
 */
import { ChevronDown, ChevronUp, Maximize2, PanelRightClose, X } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  PANEL_DEFAULT_DOCKS,
  useWorkspace,
  type DockZone,
  type PanelId,
} from "./WorkspaceProvider";

const MIN_W = 220;
const MIN_H_COLLAPSED = 32;
const MIN_H_EXPANDED = 120;

type Props = {
  id: PanelId;
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  /** Optional subtitle / breadcrumb shown to the right of title. */
  badge?: ReactNode;
};

export function FloatingPanel({ id, title, icon, children, badge }: Props) {
  const {
    layouts,
    movePanel,
    resizePanel,
    focusPanel,
    togglePanelVisible,
    togglePanelCollapsed,
    setPanelDock,
    setPanelLayout,
  } = useWorkspace();
  const layout = layouts[id];
  const isDocked = layout.dock !== "float";

  // Docked panels split their zone by flex-grow weight over a 0 basis — but
  // flex only fills the container when the weights SUM to at least 1. The
  // splitter hands out fractional weights (0.45 / 0.55), so as soon as the
  // partner collapses or closes, the survivor kept its 0.45 and the bottom
  // half of the dock rendered as dead space. Normalizing the weight against
  // the expanded panels currently sharing the zone keeps the ratio the
  // splitter set while always summing to exactly 1.
  const dockGrow = (() => {
    if (!isDocked || layout.collapsed) return undefined;
    let total = 0;
    for (const other of Object.values(layouts)) {
      if (other.visible && !other.collapsed && other.dock === layout.dock) {
        total += other.dockWeight ?? 1;
      }
    }
    const own = layout.dockWeight ?? 1;
    return total > 0 ? own / total : 1;
  })();

  // Resolve the dock-zone DOM node to portal into. Runs after every render
  // (no deps) so a panel that mounted before its zone existed — e.g. a panel
  // renders before roomDimensions loads the dock grid — picks the
  // zone up once it appears. The prev-equality guard makes the no-dep effect
  // loop-safe (no state change when the resolved node is unchanged).
  const [dockNode, setDockNode] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const next =
      layout.dock === "float" ? null : document.getElementById(`dock-${layout.dock}`);
    setDockNode((prev) => (prev === next ? prev : next));
  });

  // Splitter on the bottom edge of a docked panel: drags the boundary between
  // this panel and the next expanded one in the same zone. Docked heights are
  // flex-grow weights, so the pixel delta is converted back into a re-split of
  // the pair's combined weight — the other panels in the zone don't move.
  const onSplitterPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      const self = (event.currentTarget as HTMLElement).parentElement;
      if (!self) return;
      let next = self.nextElementSibling as HTMLElement | null;
      while (next && next.classList.contains("collapsed")) {
        next = next.nextElementSibling as HTMLElement | null;
      }
      const nextId = next?.dataset.panelId as PanelId | undefined;
      if (!next || !nextId) return; // nothing resizable below — ignore the drag
      event.preventDefault();
      const startY = event.clientY;
      const h1 = self.offsetHeight;
      const h2 = next.offsetHeight;
      const total = (layouts[id].dockWeight ?? 1) + (layouts[nextId].dockWeight ?? 1);
      const grip = event.currentTarget as HTMLElement;
      grip.setPointerCapture(event.pointerId);
      document.body.classList.add("is-dock-resize");

      const onMove = (e: PointerEvent) => {
        const dy = Math.max(
          MIN_H_EXPANDED - h1,
          Math.min(h2 - MIN_H_EXPANDED, e.clientY - startY),
        );
        const share = (h1 + dy) / (h1 + h2);
        setPanelLayout(id, { dockWeight: total * share });
        setPanelLayout(nextId, { dockWeight: total * (1 - share) });
      };
      const onUp = (e: PointerEvent) => {
        grip.releasePointerCapture(e.pointerId);
        document.body.classList.remove("is-dock-resize");
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
    },
    [id, layouts, setPanelLayout],
  );

  // Re-dock target for a floating panel: its home dock, unless that's "float"
  // (transient panels), in which case wide ones go bottom, the rest right.
  const reDockTarget: DockZone = (() => {
    const home = PANEL_DEFAULT_DOCKS[id];
    if (home !== "float") return home;
    return layout.w > 500 ? "bottom" : "right";
  })();

  const dragStartRef = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(
    null,
  );
  const resizeStartRef = useRef<{ pointerX: number; pointerY: number; w: number; h: number } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);

  const onHeaderPointerDown = useCallback(
    (event: React.PointerEvent) => {
      // Only respond to plain left-button on the header itself, not on the buttons.
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest("button")) return;
      event.preventDefault();
      focusPanel(id);
      dragStartRef.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        x: layout.x,
        y: layout.y,
      };
      setDragging(true);
      document.body.classList.add("is-floating-panel-drag");
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    },
    [focusPanel, id, layout.x, layout.y],
  );

  const onHeaderPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const dx = event.clientX - start.pointerX;
      const dy = event.clientY - start.pointerY;
      const ws = (document.querySelector(".workspace-canvas") as HTMLElement | null);
      const wsRect = ws?.getBoundingClientRect();
      const maxX = wsRect ? wsRect.width - 60 : 99999;
      const maxY = wsRect ? wsRect.height - 24 : 99999;
      const minX = -layout.w + 60; // keep at least 60px on screen
      const x = Math.max(minX, Math.min(maxX, start.x + dx));
      const y = Math.max(0, Math.min(maxY, start.y + dy));
      movePanel(id, x, y);
    },
    [id, layout.w, movePanel],
  );

  const finishDrag = useCallback((event: React.PointerEvent) => {
    if (!dragStartRef.current) return;
    dragStartRef.current = null;
    setDragging(false);
    document.body.classList.remove("is-floating-panel-drag");
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  }, []);

  const onResizePointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      focusPanel(id);
      resizeStartRef.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        w: layout.w,
        h: layout.h,
      };
      setResizing(true);
      document.body.classList.add("is-floating-panel-resize");
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    },
    [focusPanel, id, layout.h, layout.w],
  );

  const onResizePointerMove = useCallback(
    (event: React.PointerEvent) => {
      const start = resizeStartRef.current;
      if (!start) return;
      const dw = event.clientX - start.pointerX;
      const dh = event.clientY - start.pointerY;
      const ws = (document.querySelector(".workspace-canvas") as HTMLElement | null);
      const wsRect = ws?.getBoundingClientRect();
      const maxW = wsRect ? wsRect.width - layout.x - 4 : 99999;
      const maxH = wsRect ? wsRect.height - layout.y - 4 : 99999;
      const w = Math.max(MIN_W, Math.min(maxW, start.w + dw));
      const h = Math.max(MIN_H_EXPANDED, Math.min(maxH, start.h + dh));
      resizePanel(id, w, h);
    },
    [id, layout.x, layout.y, resizePanel],
  );

  const finishResize = useCallback((event: React.PointerEvent) => {
    if (!resizeStartRef.current) return;
    resizeStartRef.current = null;
    setResizing(false);
    document.body.classList.remove("is-floating-panel-resize");
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  }, []);

  if (!layout.visible) return null;

  const collapseButton = (
    <button
      type="button"
      className="floating-panel-button"
      title={layout.collapsed ? "Expand" : "Collapse"}
      aria-label={layout.collapsed ? "Expand panel" : "Collapse panel"}
      onClick={(event) => {
        event.stopPropagation();
        togglePanelCollapsed(id);
      }}
    >
      {layout.collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
    </button>
  );
  const closeButton = (
    <button
      type="button"
      className="floating-panel-button"
      title="Close"
      aria-label="Close panel"
      onClick={(event) => {
        event.stopPropagation();
        togglePanelVisible(id, false);
      }}
    >
      <X size={14} />
    </button>
  );
  // Docked panels can pop out to float; floating panels can dock back home.
  const dockToggleButton = isDocked ? (
    <button
      type="button"
      className="floating-panel-button"
      title="Pop out to a floating window"
      aria-label="Pop panel out to a floating window"
      onClick={(event) => {
        event.stopPropagation();
        setPanelDock(id, "float");
      }}
    >
      <Maximize2 size={13} />
    </button>
  ) : (
    <button
      type="button"
      className="floating-panel-button"
      title="Dock"
      aria-label="Dock panel"
      onClick={(event) => {
        event.stopPropagation();
        setPanelDock(id, reDockTarget);
      }}
    >
      <PanelRightClose size={14} />
    </button>
  );

  // Docked: portal into the zone container, stacked + collapsible (accordion),
  // no drag/resize. Clicking the header toggles collapse. If the target zone
  // isn't mounted (e.g. a docked panel mounts before its dock zone exists),
  // fall through to the float render so the panel never vanishes.
  if (isDocked && dockNode) {
    return createPortal(
      <section
        className={`docked-panel${layout.collapsed ? " collapsed" : ""}`}
        data-panel-id={id}
        style={layout.collapsed ? undefined : { flexGrow: dockGrow }}
      >
        <header
          className="docked-panel-header"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            togglePanelCollapsed(id);
          }}
        >
          <span className="floating-panel-title">
            {icon}
            <span>{title}</span>
            {badge ? <span className="floating-panel-badge">{badge}</span> : null}
          </span>
          <span className="floating-panel-actions">
            {collapseButton}
            {dockToggleButton}
            {closeButton}
          </span>
        </header>
        {!layout.collapsed && <div className="docked-panel-body">{children}</div>}
        {!layout.collapsed && (
          <div
            className="docked-panel-resize"
            aria-hidden
            title="Drag to resize"
            onPointerDown={onSplitterPointerDown}
          />
        )}
      </section>,
      dockNode,
    );
  }

  // Float: legacy movable / resizable window.
  const renderHeight = layout.collapsed ? MIN_H_COLLAPSED : layout.h;

  return (
    <section
      className={`floating-panel${dragging ? " dragging" : ""}${resizing ? " resizing" : ""}${layout.collapsed ? " collapsed" : ""}`}
      data-panel-id={id}
      style={{
        left: `${layout.x}px`,
        top: `${layout.y}px`,
        width: `${layout.w}px`,
        height: `${renderHeight}px`,
        zIndex: layout.z,
      }}
      onPointerDown={() => focusPanel(id)}
    >
      <header
        className="floating-panel-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        <span className="floating-panel-title">
          {icon}
          <span>{title}</span>
          {badge ? <span className="floating-panel-badge">{badge}</span> : null}
        </span>
        <span className="floating-panel-actions">
          {collapseButton}
          {dockToggleButton}
          {closeButton}
        </span>
      </header>
      {!layout.collapsed && <div className="floating-panel-body">{children}</div>}
      {!layout.collapsed && (
        <div
          className="floating-panel-resize-handle"
          aria-hidden
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
        />
      )}
    </section>
  );
}
