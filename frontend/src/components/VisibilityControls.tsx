import { Eye, EyeOff, RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useSceneStore } from "../store/sceneStore";
import { OVERLAY_GROUPS, OVERLAY_LABELS } from "../types/visibility";

// =============================================================================
// L1 — Display popover
// =============================================================================

export function DisplayPopover({
  open,
  onClose,
  anchorRef,
}: {
  open: boolean;
  onClose: () => void;
  // Element the popover anchors to (the toolbar button wrapper). The popover
  // renders in a portal with fixed positioning so it escapes the top-bar's
  // overflow clip — see the redesign that made `.scene-toolbar` scroll.
  anchorRef?: RefObject<HTMLElement>;
}) {
  const overlayFlags = useSceneStore((s) => s.overlayFlags);
  const setOverlayFlag = useSceneStore((s) => s.setOverlayFlag);
  const resetOverlayFlags = useSceneStore((s) => s.resetOverlayFlags);
  const showAllHidden = useSceneStore((s) => s.showAllHidden);
  const session = useSceneStore((s) => s.session);

  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Position under the anchor in viewport coordinates. Recompute on open and
  // on resize; the popover lives in a body portal so it can't be clipped.
  useLayoutEffect(() => {
    if (!open) return;
    const compute = () => {
      const el = anchorRef?.current;
      if (!el) {
        setPos(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 288 - 8));
      setPos({ top: rect.bottom + 8, left });
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      // Clicks on the popover or its trigger are handled elsewhere (the
      // trigger toggles); only an outside click should dismiss.
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  const sessionHiddenCount =
    session.hiddenObjectIds.size +
    session.hiddenLinkIds.size +
    session.hiddenRelationIds.size +
    session.forceVisibleObjectIds.size +
    session.forceVisibleCollectionIds.size +
    (session.soloObjectIds?.size ?? 0);

  const popover = (
    <div
      className="display-popover"
      ref={popoverRef}
      style={{
        position: "fixed",
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {OVERLAY_GROUPS.map((group) => (
        <div className="display-group" key={group.label}>
          <div className="display-group-title">{group.label}</div>
          <div className="display-group-grid">
            {group.kinds.map((kind) => {
              const value = overlayFlags[kind];
              return (
                <button
                  key={kind}
                  className={`overlay-toggle${value ? " active" : ""}`}
                  onClick={() => setOverlayFlag(kind, !value)}
                  title={`Toggle ${OVERLAY_LABELS[kind]}`}
                >
                  {value ? <Eye size={14} /> : <EyeOff size={14} />}
                  <span>{OVERLAY_LABELS[kind]}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="display-actions">
        <button className="secondary-button" onClick={resetOverlayFlags}>
          <RotateCcw size={14} />
          Reset overlays
        </button>
        <button
          className="secondary-button"
          disabled={sessionHiddenCount === 0}
          onClick={showAllHidden}
        >
          <Eye size={14} />
          Show all hidden
        </button>
      </div>

      <div className="display-hint">
        Shortcuts: <kbd>1</kbd>–<kbd>4</kbd> toggle overlays · <kbd>0</kbd> reset · <kbd>Esc</kbd> show all
      </div>
    </div>
  );

  return createPortal(popover, document.body);
}
