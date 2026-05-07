/**
 * FloatingPanel — Blender-style movable / resizable / collapsible window.
 *
 * Reads its layout from WorkspaceProvider, writes back drag/resize/collapse
 * actions. Whole header drags (PointerEvent + setPointerCapture, no global
 * listeners). SE-corner resize. Click anywhere on the panel raises z-index.
 */
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { useWorkspace, type PanelId } from "./WorkspaceProvider";

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
  const { layouts, movePanel, resizePanel, focusPanel, togglePanelVisible, togglePanelCollapsed } =
    useWorkspace();
  const layout = layouts[id];

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
