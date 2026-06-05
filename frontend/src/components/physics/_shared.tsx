/**
 * Shared helper components used by multiple physics inspectors.
 * Split out of PhysicsElementPanel.tsx (god-file) so the main file
 * stays small (~120 lines of dispatcher).
 *
 *   - wavelengthHex          (number -> color hex via three.js)
 *   - EmissionVisualRow      (color picker + visibility toggle)
 *   - AlignToBeamSection     (snap-to-beam UI for any SceneObject)
 *
 * Consumed by PhysicsElementPanel + the inspectors that need them.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import * as THREE from "three";

import { CollapsibleSection } from "../CollapsibleSection";
import { useSceneStore } from "../../store/sceneStore";
import type {
  ComponentItem,
  ElementKind,
  PhysicsElement,
  SceneObject,
} from "../../types/digitalTwin";
import {
  findFiberEndSnap,
  findSnapToBeam,
  perpendicularBasis,
} from "../../utils/beamPlacement";
import { anchorObjectLocalAxisX } from "../../utils/anchorAccess";
import {
  syncFiberNodesFromKindParams,
  type FiberEndKindParamsShape,
  type FiberNodePersistent,
} from "../../utils/fiberAnchorResolver";
import {
  type EmissionKey,
  getEmissionVisual,
  setEmissionVisualPatch,
} from "../../utils/emissionVisuals";
import { wavelengthToColor } from "../../three/opticalBeams";
import { sceneObjectEulerFromQuaternion } from "../../optical/frames";

/**
 * Collapsible "card" for a physics-inspector section. Replaces the duplicated
 * inline `sectionStyle`/`titleStyle` blocks — same cyan-card look (via the
 * `.physics-section` CSS), but the body collapses and the open state persists
 * (CollapsibleSection's localStorage). `id` is namespaced per-kind by callers
 * (`physics.<kind>.<slug>`) so every instance of a kind opens the same way.
 */
export function SectionCard({
  id,
  title,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <CollapsibleSection id={id} title={title} defaultOpen={defaultOpen} className="physics-section">
      {children}
    </CollapsibleSection>
  );
}
// The kind-specific Controls live in sibling files; AlignToBeamSection
// dispatches into them based on element.elementKind.
import {
  MirrorAdjustControls,
  WaveplateAdjustControls,
  BeamSplitterControls,
  LensControls,
} from "./SimpleAdjustControls";
import { LaserSourceControls } from "./LaserSourceControls";
import { AomAdjustControls } from "./AomAdjustControls";
import { TaperedAmplifierAdjustControls } from "./TaperedAmplifierAdjustControls";

export function wavelengthHex(wavelengthNm: number): string {
  return `#${wavelengthToColor(wavelengthNm).getHexString()}`;
}

export function EmissionVisualRow({
  sceneObject,
  emissionKey,
  label,
  fallbackColorHex,
  showVisibilityToggle,
}: {
  sceneObject: SceneObject;
  emissionKey: EmissionKey;
  label: string;
  fallbackColorHex: string;
  showVisibilityToggle: boolean;
}) {
  const updateSceneObject = useSceneStore((s) => s.updateSceneObject);
  const visual = getEmissionVisual(sceneObject, emissionKey);
  const hasOverride = visual.colorHex !== null;
  const displayHex = visual.colorHex ?? fallbackColorHex;

  const persist = (patch: Partial<{ colorHex: string | null; visible: boolean }>) => {
    void updateSceneObject(sceneObject.id, {
      properties: setEmissionVisualPatch(sceneObject, emissionKey, patch),
    });
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
      <span style={{ fontSize: 11, minWidth: 70 }}>{label}</span>
      <input
        type="color"
        value={displayHex}
        onChange={(e) => persist({ colorHex: e.target.value })}
        style={{ width: 32, height: 22, padding: 0, border: "1px solid rgba(255,255,255,0.2)", borderRadius: 3, cursor: "pointer" }}
        title="Beam colour for this emission"
      />
      <span style={{ fontSize: 10, opacity: 0.7, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>{displayHex}</span>
      {hasOverride ? (
        <button
          type="button"
          onClick={() => persist({ colorHex: null })}
          style={{ fontSize: 10, padding: "1px 6px" }}
          title="Reset to wavelength-derived colour"
        >Reset</button>
      ) : (
        <span style={{ fontSize: 10, opacity: 0.5 }}>(λ default)</span>
      )}
      {showVisibilityToggle && (
        <label style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: "auto", fontSize: 10 }}>
          <input
            type="checkbox"
            checked={visual.visible}
            onChange={(e) => persist({ visible: e.target.checked })}
          />
          <span>Show</span>
        </label>
      )}
    </div>
  );
}

type Props = {
  component: ComponentItem;
  /** The specific scene-object instance whose optical params are being
   *  edited. Per-object optical chain (alembic 0014). When omitted, the
   *  panel renders an empty-state hint asking to select an object. */
  sceneObject?: SceneObject;
};

function findElementForObject(elements: PhysicsElement[], objectId: string): PhysicsElement | undefined {
  return elements.find((item) => item.objectId === objectId);
}


/** Euler (deg) for a SceneObject so its anchor optical-axis (body-local axisX)
 *  points anti-parallel to the beam — i.e. the element faces the beam at normal
 *  incidence. The v3 tracer only strikes an element when
 *  `beamDir·anchorNormal ≠ 0` (anchor_tracer.intersect_anchor); a transmissive
 *  element whose optic axis is perpendicular to the beam is grazed and skipped.
 *
 *  Works entirely in lab Z-up coords. The backend pose rotation
 *  (`pose._rotation_of` = scipy YXZ [rz, rx, -ry]) equals THREE's
 *  Euler(rx, rz, -ry, "YXZ") as a rotation acting on Z-up vectors. So we build
 *  R from the raw Z-up axisX → -beamDir (NO Y-up swap — swapping first rotates
 *  the wrong physical axis) and decompose with the same convention
 *  rigidGroup.ts uses. The element is rotation-symmetric about its optic axis,
 *  so the residual spin setFromUnitVectors picks is physically irrelevant. */
function poseAligningAnchorAxisToDir(
  anchorAxisXBody: { x: number; y: number; z: number },
  targetDirLab: { x: number; y: number; z: number },
): { rxDeg: number; ryDeg: number; rzDeg: number } {
  const from = new THREE.Vector3(
    anchorAxisXBody.x, anchorAxisXBody.y, anchorAxisXBody.z,
  ).normalize();
  const to = new THREE.Vector3(
    targetDirLab.x, targetDirLab.y, targetDirLab.z,
  ).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(from, to);
  return sceneObjectEulerFromQuaternion(q);
}

/** Transmissive optic: anchor optic-axis anti-parallel to the beam (normal
 *  incidence) so the tracer strikes it (dir·normal ≠ 0). */
function faceAnchorToBeamPose(
  anchorAxisXBody: { x: number; y: number; z: number },
  beamDirLab: { x: number; y: number; z: number },
): { rxDeg: number; ryDeg: number; rzDeg: number } {
  return poseAligningAnchorAxisToDir(anchorAxisXBody, {
    x: -beamDirLab.x, y: -beamDirLab.y, z: -beamDirLab.z,
  });
}

/** Fold mirror: set the intercept_face normal to the bisector
 *  n̂ = normalize(d_out − d_in), so an incoming ray along d_in reflects to
 *  d_out (reflection law d_out = d_in − 2(d_in·n̂)n̂). d_in/d_out are unit
 *  propagation directions in lab. */
function foldMirrorPose(
  anchorAxisXBody: { x: number; y: number; z: number },
  inDirLab: { x: number; y: number; z: number },
  outDirLab: { x: number; y: number; z: number },
): { rxDeg: number; ryDeg: number; rzDeg: number } {
  const din = new THREE.Vector3(inDirLab.x, inDirLab.y, inDirLab.z).normalize();
  const dout = new THREE.Vector3(outDirLab.x, outDirLab.y, outDirLab.z).normalize();
  const n = dout.clone().sub(din).normalize(); // bisector normal
  return poseAligningAnchorAxisToDir(anchorAxisXBody, { x: n.x, y: n.y, z: n.z });
}

export function AlignToBeamSection({
  sceneObject,
  elementKind,
  element,
}: {
  sceneObject: SceneObject;
  elementKind: ElementKind;
  element: PhysicsElement;
}) {
  const scene = useSceneStore((state) => state.scene);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const candidate = useMemo(
    () => findSnapToBeam(sceneObject.id, scene),
    [scene, sceneObject.id],
  );

  const fromName = candidate
    ? scene.objects.find((o) => o.id === candidate.fromObjectId)?.name ?? candidate.fromObjectId.slice(0, 6)
    : null;

  const isMirror = elementKind === "mirror" || elementKind === "dichroic_mirror";
  const isEmitter = elementKind === "laser_source" || elementKind === "tapered_amplifier";
  const isWaveplate = elementKind === "waveplate";
  const isBeamSplitter = elementKind === "beam_splitter";
  const isLens = elementKind === "lens_biconvex"
    || elementKind === "lens_plano_convex"
    || elementKind === "lens_cylindrical";

  const onAlign = async () => {
    if (!candidate) return;
    setBusy(true);
    setFeedback(null);
    try {
      // Transmissive elements (lens, waveplate, polarizer, eom, …) must FACE
      // the beam (optic axis anti-parallel to it) or the tracer grazes their
      // anchor plane and never strikes them. Reflective elements (mirror /
      // dichroic / beam_splitter) keep their design-angle coating → translate
      // only. Emitters early-return above and never reach here.
      const facesBeam = !isMirror && !isBeamSplitter;
      const comp = scene.components.find((c) => c.id === sceneObject.componentId);
      const asset = comp?.asset3dId
        ? scene.assets.find((a) => a.id === comp.asset3dId)
        : undefined;
      const matchedAnchor = asset?.anchors?.find((a) => a.id === candidate.anchorId);
      const axisXBody = matchedAnchor ? anchorObjectLocalAxisX(matchedAnchor, asset) : null;

      if (facesBeam && axisXBody) {
        // 1) rotate to face the beam, then 2) re-snap translation at the new
        // rotation (rotating moves the anchor, so candidate.newBodyPos is now
        // stale). findSnapToBeam recomputes the anchor world pos.
        const pose = faceAnchorToBeamPose(axisXBody, candidate.axisDirection);
        await updateSceneObject(sceneObject.id, pose);
        const fresh = findSnapToBeam(sceneObject.id, useSceneStore.getState().scene);
        if (fresh) {
          await updateSceneObject(sceneObject.id, {
            xMm: fresh.newBodyPos.x,
            yMm: fresh.newBodyPos.y,
            zMm: fresh.newBodyPos.z,
          });
        }
        setFeedback(
          `${candidate.anchorId} faced + aligned to ${fromName} axis (was ${candidate.missMm.toFixed(1)} mm off).`,
        );
      } else {
        await updateSceneObject(sceneObject.id, {
          xMm: candidate.newBodyPos.x,
          yMm: candidate.newBodyPos.y,
          zMm: candidate.newBodyPos.z,
        });
        setFeedback(
          `${candidate.anchorId} aligned to ${fromName} axis (was ${candidate.missMm.toFixed(1)} mm off, now 0).`,
        );
      }
    } catch (err) {
      setFeedback(`Align failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (elementKind === "tapered_amplifier") {
    return <TaperedAmplifierAdjustControls sceneObject={sceneObject} element={element} />;
  }
  if (elementKind === "aom") {
    return <AomAdjustControls sceneObject={sceneObject} element={element} />;
  }
  if (elementKind === "laser_source") {
    return <LaserSourceControls sceneObject={sceneObject} element={element} />;
  }
  if (elementKind === "fiber") {
    // alembic 0056: a fiber is one SceneObject with End A / End B as
    // sub-objects in kindParams. Align happens per-end via these two
    // buttons; the body's own pose stays put.
    return <FiberEndAlignControls sceneObject={sceneObject} element={element} />;
  }
  if (isEmitter) {
    return (
      <div className="snap-to-beam snap-to-beam-empty">
        Emitters originate the beam — alignment is for downstream optics.
      </div>
    );
  }
  // RF kinds don't propagate as optical beams, so "Align intercept to beam"
  // (which projects onto the __rayTraceDebug trace segments) is meaningless
  // for rf_source / horn_antenna / rf_cable. Skip the snap-to-beam block
  // entirely for the RF domain — rf_cable has its own "Align RF" buttons
  // in ComponentPanel that snap to rf_in/rf_out anchors instead.
  if (
    elementKind === "rf_source"
    || elementKind === "horn_antenna"
    || elementKind === "rf_cable"
  ) {
    return null;
  }

  return (
    <div className="snap-to-beam">
      {candidate ? (
        <>
          <div className="snap-to-beam-info">
            <strong>Nearest beam:</strong>{" "}
            {fromName} ({candidate.fromPort}) —{" "}
            <code>{candidate.anchorId}</code> would shift{" "}
            <strong>{candidate.missMm.toFixed(2)} mm</strong> to land on axis.
          </div>
          <button
            type="button"
            className="primary-button"
            onClick={() => void onAlign()}
            disabled={busy}
          >
            {isMirror ? "Align face center to beam" : "Align intercept to beam"}
          </button>
          {/* Mirror-specific: after aligning, expose offset (on face) +
              rotation (controls reflection direction). */}
          {isMirror && <MirrorAdjustControls sceneObject={sceneObject} />}
          {/* Waveplate-specific: rotate the plate clockwise around the beam
              axis to set the fast-axis angle (Jones-matrix theta). */}
          {isWaveplate && (
            <WaveplateAdjustControls sceneObject={sceneObject} element={element} />
          )}
          {/* Beam-splitter / PBS-specific: split ratio, polarising flag,
              extinction ratio, and overall transmission. */}
          {isBeamSplitter && (
            <BeamSplitterControls sceneObject={sceneObject} element={element} />
          )}
          {/* Lens-specific (biconvex / plano-convex / cylindrical):
              focal length, NA or cylindrical axis, transmission,
              material, GVD. */}
          {isLens && (
            <LensControls sceneObject={sceneObject} element={element} />
          )}
        </>
      ) : (
        <div className="snap-to-beam-empty">
          No beam axis within 25 mm of any intercept anchor.
        </div>
      )}
      {feedback && <div className="snap-to-beam-feedback">{feedback}</div>}
    </div>
  );
}

/** Align End A / Align End B for a fiber SceneObject. Each button
 *  snaps the corresponding ferrule tip onto the nearest beam axis by
 *  translating the end's body-local posMm (kindParams.endA/endB.posMm)
 *  — the fiber body's lab pose and the other end stay put. End
 *  rotation is preserved so the user's manual rotDeg setting isn't
 *  clobbered by snap. */
function FiberEndAlignControls({
  sceneObject,
  element,
}: {
  sceneObject: SceneObject;
  element: PhysicsElement;
}) {
  const scene = useSceneStore((state) => state.scene);
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);
  const updateFiberNodes = useSceneStore((state) => state.updateFiberNodes);
  const [busyEnd, setBusyEnd] = useState<"A" | "B" | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const candidateA = useMemo(
    () => findFiberEndSnap(sceneObject.id, "A", scene),
    [scene, sceneObject.id],
  );
  const candidateB = useMemo(
    () => findFiberEndSnap(sceneObject.id, "B", scene),
    [scene, sceneObject.id],
  );

  const labelFromObjectId = (id: string) =>
    scene.objects.find((o) => o.id === id)?.name ?? id.slice(0, 6);

  const onAlignEnd = async (endRole: "A" | "B") => {
    const cand = endRole === "A" ? candidateA : candidateB;
    if (!cand) return;
    setBusyEnd(endRole);
    setFeedback(null);
    try {
      const kp = { ...(element.kindParams ?? {}) } as Record<string, unknown>;
      const endKey = endRole === "A" ? "endA" : "endB";
      const existing =
        kp[endKey] && typeof kp[endKey] === "object"
          ? (kp[endKey] as Record<string, unknown>)
          : {};
      kp[endKey] = {
        ...existing,
        posMm: [cand.newEndPosMmBody.x, cand.newEndPosMmBody.y, cand.newEndPosMmBody.z],
        // Wire-extension direction = beam direction (in end body-local
        // frame). Ferrule auto-orients so tip points OPPOSITE this
        // (faces the source) via applyFerruleOrientation.
        tensionHandleMm: [
          cand.newTensionHandleMmBody.x,
          cand.newTensionHandleMmBody.y,
          cand.newTensionHandleMmBody.z,
        ],
      };
      await upsertOpticalElement({
        objectId: sceneObject.id,
        elementKind: "fiber",
        kindParams: kp,
      });
      // Sync fiber.properties.fiberNodes from the new kindParams so
      // the ray tracer (rayTrace.ts reads fiberNodes) and the legacy
      // panel (getFiberPortLabPose reads fiberNodes) see the new tip
      // position. Without this, kindParams updates the renderer but
      // the BEAM math stays on the old node positions.
      const currentFiberObj = scene.objects.find((o) => o.id === sceneObject.id);
      if (currentFiberObj) {
        const existingNodes = (currentFiberObj.properties as { fiberNodes?: FiberNodePersistent[] } | null)?.fiberNodes;
        const nextNodes = syncFiberNodesFromKindParams(
          kp.endA as FiberEndKindParamsShape | null,
          kp.endB as FiberEndKindParamsShape | null,
          existingNodes ?? undefined,
        );
        await updateFiberNodes(sceneObject.componentId, nextNodes);
      }
      setFeedback(
        `End ${endRole} aligned to ${labelFromObjectId(cand.fromObjectId)} (${cand.fromPort}); shifted ${cand.missMm.toFixed(2)} mm onto axis.`,
      );
    } catch (err) {
      setFeedback(`Align End ${endRole} failed: ${(err as Error).message}`);
    } finally {
      setBusyEnd(null);
    }
  };

  return (
    <div className="snap-to-beam">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="primary-button"
          onClick={() => void onAlignEnd("A")}
          disabled={!candidateA || busyEnd !== null}
          title={
            candidateA
              ? `Snap End A tip onto ${labelFromObjectId(candidateA.fromObjectId)} (${candidateA.missMm.toFixed(2)} mm off)`
              : "No beam axis within 25 mm of End A tip"
          }
        >
          Align End A
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => void onAlignEnd("B")}
          disabled={!candidateB || busyEnd !== null}
          title={
            candidateB
              ? `Snap End B tip onto ${labelFromObjectId(candidateB.fromObjectId)} (${candidateB.missMm.toFixed(2)} mm off)`
              : "No beam axis within 25 mm of End B tip"
          }
        >
          Align End B
        </button>
      </div>
      {!candidateA && !candidateB && (
        <div className="snap-to-beam-empty" style={{ marginTop: 6 }}>
          Neither end tip is within 25 mm of a beam axis.
        </div>
      )}
      {feedback && (
        <div className="snap-to-beam-feedback" style={{ marginTop: 6 }}>
          {feedback}
        </div>
      )}
    </div>
  );
}

