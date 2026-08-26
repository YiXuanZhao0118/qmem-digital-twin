import { Crosshair, Eye, EyeOff, RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useSceneStore } from "../store/sceneStore";
import { OVERLAY_GROUPS, OVERLAY_LABELS } from "../types/visibility";
import { isBeamVisible, listSceneBeams } from "../utils/beamVisibility";
import { getEmissionVisual, setEmissionVisualPatch } from "../utils/emissionVisuals";

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

      <BeamVisibilityGroup />

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

// =============================================================================
// L1b — Per-beam show/hide
// =============================================================================

/** One row per emission in the scene (laser "Beam", TA "Output"/"Input"),
 *  with the two independent switches the two layers give us:
 *
 *    eye  — DRAW only. Hides that beam's segments in the 3D view (they also
 *           stop being pickable). Instant, physics untouched, persisted to
 *           localStorage. See utils/beamVisibility.ts.
 *    ⊹    — SOLO: show only this beam. An allow-list that overrides the eyes
 *           while it is on, so exiting solo restores exactly what was hidden
 *           before. Clicking solo on the only soloed beam exits (same
 *           semantics as the object-level S shortcut); while solo is on the
 *           eyes add/remove beams from the allow-list, which is what makes
 *           "solo this one, then also show that one" work.
 *    On   — the PHYSICAL emission gate
 *           (`SceneObject.properties.emissionVisuals[key].visible`): the
 *           backend skips the emission entirely, so downstream optics stop
 *           reflecting it too. Saved to the DB and re-solved.
 *
 *  Only emissions the backend actually gates get the "On" switch — a seeded
 *  TA's forward beam is a re-emission the tracer never checks, so a switch
 *  there would silently do nothing (see SceneBeam.physicsHint).
 */
function BeamVisibilityGroup() {
  const scene = useSceneStore((s) => s.scene);
  const hiddenBeamKeys = useSceneStore((s) => s.hiddenBeamKeys);
  const soloBeamKeys = useSceneStore((s) => s.soloBeamKeys);
  const setBeamHidden = useSceneStore((s) => s.setBeamHidden);
  const setBeamsHidden = useSceneStore((s) => s.setBeamsHidden);
  const toggleBeamSolo = useSceneStore((s) => s.toggleBeamSolo);
  const exitBeamSolo = useSceneStore((s) => s.exitBeamSolo);
  const updateSceneObject = useSceneStore((s) => s.updateSceneObject);
  const beamsOverlayOn = useSceneStore((s) => s.overlayFlags.beam_segments);

  const beams = listSceneBeams(scene);
  if (beams.length === 0) return null;

  const objectById = new Map(scene.objects.map((o) => [o.id, o]));

  return (
    <div className="display-group">
      <div className="display-group-title display-group-title-row">
        <span>Beams</span>
        <span className="beam-bulk">
          <button
            className="beam-bulk-button"
            onClick={() => {
              exitBeamSolo();
              setBeamsHidden(beams.map((b) => b.key), false);
            }}
          >All</button>
          <button
            className="beam-bulk-button"
            onClick={() => {
              exitBeamSolo();
              setBeamsHidden(beams.map((b) => b.key), true);
            }}
          >None</button>
        </span>
      </div>
      {!beamsOverlayOn && (
        <div className="beam-hint">All beams are off — turn “Beams” on above.</div>
      )}
      {soloBeamKeys && (
        <div className="beam-hint">
          Solo: showing {soloBeamKeys.size} beam{soloBeamKeys.size === 1 ? "" : "s"} ·{" "}
          <button className="beam-bulk-button" onClick={exitBeamSolo}>exit solo</button>
        </div>
      )}
      {beams.map((beam) => {
        const obj = objectById.get(beam.objectId);
        const soloed = soloBeamKeys?.has(beam.key) ?? false;
        const drawn = isBeamVisible(beam.key, hiddenBeamKeys, soloBeamKeys);
        const emitting = getEmissionVisual(obj, beam.emissionKey).visible;
        return (
          <div className="beam-row" key={beam.key}>
            <button
              className={`overlay-toggle beam-toggle${drawn ? " active" : ""}`}
              // While solo is on the allow-list decides what is drawn, so the
              // eye has to edit THAT set — writing hiddenBeamKeys instead would
              // look like a dead button until the user exits solo.
              onClick={() =>
                soloBeamKeys ? toggleBeamSolo(beam.key) : setBeamHidden(beam.key, drawn)
              }
              title={drawn ? "Hide this beam in the view" : "Show this beam in the view"}
            >
              {drawn ? <Eye size={14} /> : <EyeOff size={14} />}
              <span className="beam-name">
                {beam.objectName}
                <span className="beam-emission"> · {beam.emissionLabel}</span>
              </span>
            </button>
            <button
              className={`beam-solo${soloed ? " active" : ""}`}
              onClick={() => toggleBeamSolo(beam.key)}
              title={soloed ? "Exit solo for this beam" : "Solo — show only this beam"}
            >
              <Crosshair size={13} />
            </button>
            {beam.physicsHint && obj && (
              <label className="beam-emit" title={beam.physicsHint}>
                <input
                  type="checkbox"
                  checked={emitting}
                  onChange={(e) =>
                    void updateSceneObject(obj.id, {
                      properties: setEmissionVisualPatch(
                        obj, beam.emissionKey, { visible: e.target.checked },
                      ),
                    })
                  }
                />
                <span>On</span>
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}
