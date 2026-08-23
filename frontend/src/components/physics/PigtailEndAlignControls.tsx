/**
 * PigtailEndAlignControls — "Align End A / End B" for a fibre-pigtailed
 * instrument (the EOSpace EOM is the first).
 *
 * Deliberately the FIBER patch-cable UX, not the generic
 * `AlignToBeamControls` one: a pigtailed part has two independent ends that
 * get plugged into two different places, which a single (point, direction)
 * whole-object align cannot express — pointing End B at a coupler would drag
 * End A off whatever it was already aligned to.
 *
 * What moves is the port CONNECTOR, never the instrument. A pigtailed part's
 * optical port IS the `fiber_connector` bound at it (the backend re-seats
 * intercept_in / intercept_out onto its `connect_in`), the pigtail between
 * body and connector is flexible, and the box stays on the bench where the
 * user bolted it. The move persists as a per-instance `ObjectBinding` delta;
 * `sceneStore.applyPigtailAlignmentCandidate` has the details.
 *
 * Ends this component offers come from `pigtailPortBindings`, i.e. purely
 * from the Component's data (a `fiber_connector` binding tagged
 * `properties.portAnchor`) — no per-kind list to keep in sync.
 */
import { useState } from "react";

import { useSceneStore } from "../../store/sceneStore";
import type { SceneObject } from "../../types/digitalTwin";
import { pigtailPortBindings } from "../../utils/componentBindings";
import type { PigtailAlignmentCandidate } from "../../utils/pigtailAlignment";
import type { FiberPortLink } from "../../utils/fiberAlignment";

const TOLERANCE_MM = 25;

export function PigtailEndAlignControls({
  sceneObject,
}: {
  sceneObject: SceneObject;
}) {
  const scene = useSceneStore((state) => state.scene);
  const findCandidates = useSceneStore((state) => state.findPigtailAlignmentCandidates);
  const applyCandidate = useSceneStore((state) => state.applyPigtailAlignmentCandidate);
  const clearLink = useSceneStore((state) => state.clearPigtailEndpointLink);

  const [feedback, setFeedback] = useState<string | null>(null);
  const [picker, setPicker] = useState<{
    end: "A" | "B";
    candidates: PigtailAlignmentCandidate[];
  } | null>(null);

  const component = scene.components.find((c) => c.id === sceneObject.componentId);
  const ports = component ? pigtailPortBindings(component, sceneObject, scene) : [];
  if (ports.length === 0) return null;

  // Which ends are currently plugged into a receptacle. A linked end is not
  // just "where it was aligned once": it FOLLOWS that part, so it has to be
  // visible and unpluggable without going into node-edit mode.
  const links = ((sceneObject.properties as {
    pigtailEndpoints?: Record<string, FiberPortLink>;
  } | undefined)?.pigtailEndpoints) ?? {};
  const objectName = (id: string): string =>
    scene.objects.find((o) => o.id === id)?.name ?? id.slice(0, 6);

  const apply = async (end: "A" | "B", candidate: PigtailAlignmentCandidate) => {
    await applyCandidate(sceneObject.id, end, candidate);
    const label = candidate.displayLabel ?? candidate.key;
    setFeedback(
      candidate.port
        ? `End ${end} plugged into ${label} (was ${candidate.distMm.toFixed(2)} mm off). It now follows that part.`
        : `End ${end} → ${label} (was ${candidate.distMm.toFixed(2)} mm off, now 0).`,
    );
    setPicker(null);
  };

  const onAlign = async (end: "A" | "B") => {
    setFeedback(null);
    try {
      const list = await findCandidates(sceneObject.id, end, TOLERANCE_MM);
      if (list.length === 0) {
        setFeedback(
          `End ${end}: no beam or fibre port within ${TOLERANCE_MM} mm — alignment skipped.`,
        );
        setPicker(null);
        return;
      }
      // One target auto-applies; several (AOM 0/±1 orders, beam-splitter
      // R+T branches, a receptacle sitting on the same beam) go to a picker
      // so the user says which, instead of a closest-wins coin toss.
      if (list.length === 1) {
        await apply(end, list[0]);
        return;
      }
      setPicker({ end, candidates: list });
    } catch (err) {
      setFeedback(`Align failed: ${(err as Error).message}`);
    }
  };

  return (
    <>
      <p style={{ fontSize: 11, opacity: 0.7, margin: "0 0 6px", lineHeight: 1.5 }}>
        Each end is a fibre pigtail — aligning one moves that connector onto
        the beam (or into a receptacle). The instrument itself does not move.
      </p>
      <div style={{ display: "flex", gap: 6 }}>
        {ports.map((port) => (
          <button
            key={port.binding.id}
            type="button"
            className="secondary-button"
            onClick={() => void onAlign(port.end)}
            style={{ flex: 1 }}
            title={`Snap the ${port.portAnchor} pigtail's connector to a beam or fibre port within ${TOLERANCE_MM} mm.`}
          >
            Align End {port.end}
          </button>
        ))}
      </div>
      {ports
        .filter((port) => links[port.portAnchor])
        .map((port) => (
          <div
            key={`link-${port.binding.id}`}
            style={{
              marginTop: 6,
              fontSize: 11,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ opacity: 0.85 }}>
              🔌 End {port.end} → {objectName(links[port.portAnchor].targetObjectId)} ·{" "}
              {links[port.portAnchor].targetAnchorName}
            </span>
            <button
              type="button"
              className="secondary-button"
              style={{ fontSize: 10, padding: "1px 6px" }}
              onClick={() => void clearLink(sceneObject.id, port.end)}
            >
              Unplug
            </button>
          </div>
        ))}
      {picker && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            background: "rgba(255,255,255,0.04)",
            borderRadius: 4,
          }}
        >
          <div style={{ fontSize: 12, marginBottom: 6 }}>
            <strong>
              End {picker.end}: {picker.candidates.length} targets within {TOLERANCE_MM} mm
            </strong>
            <button
              type="button"
              onClick={() => setPicker(null)}
              style={{
                float: "right",
                background: "transparent",
                border: "none",
                color: "#aaa",
                cursor: "pointer",
                fontSize: 14,
                padding: "0 4px",
              }}
              aria-label="Cancel picker"
            >
              ✕
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {picker.candidates.map((c, i) => (
              <button
                key={`${c.key}/${i}`}
                type="button"
                className="secondary-button"
                onClick={() => void apply(picker.end, c)}
                style={{
                  textAlign: "left",
                  fontSize: 11,
                  padding: "4px 8px",
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                }}
              >
                {i === 0 ? "★ " : "  "}
                {c.displayLabel ?? c.key}{" "}
                <span style={{ opacity: 0.6 }}>· {c.distMm.toFixed(2)} mm</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {feedback && (
        <p style={{ fontSize: 11, opacity: 0.85, marginTop: 6 }}>{feedback}</p>
      )}
    </>
  );
}
