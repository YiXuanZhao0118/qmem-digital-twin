/**
 * AlignToBeamControls — generic per-object "Align to beam" for any optical
 * element that aligns to a beam (lens, waveplate, mirror, beam splitter,
 * EOM, AOM, TA, isolator, …).
 *
 * Align is a Component-layer (point, direction):
 *   - point + direction come from `component.properties.alignSpec`
 *     (pointMm / directionMm, body/CAD frame), edited in PHY Editor →
 *     Component. Fallbacks when absent: a composite's binding-tree
 *     front/back centres (isolator), else the asset's primary intercept
 *     anchor (point = anchor, direction = −axisX so the optic axis faces
 *     the beam — matches the legacy transmissive align).
 *   - the per-object beam↔direction angle (`alignBeamAngleDeg`) lives on
 *     the SceneObject and is edited here, so each instance can sit at its
 *     own angle to the beam (0 = direction on the beam).
 *
 * When several beams pass near the align point (AOM diffraction orders,
 * crossing paths, retro-reflections) a beam picker appears so the user can
 * choose WHICH beam to align to — parity with the legacy fiber / rf_cable
 * two-phase align. With a single nearby beam it auto-aligns to it.
 *
 * The action rotates + translates the SceneObject so the direction makes
 * the configured angle with the chosen beam and the point lands on the beam
 * line. Frame-sensitive maths lives in utils/isolatorAlign (unit-tested).
 *
 * AOMs get an extra Bragg section (`AomBraggSection`): a cell only diffracts
 * into the order you asked for if it is ROTATED to that order's Bragg angle,
 * so the plain "direction ∥ beam" align is not enough. It adds the ±θ_B tilt
 * for the selected diffraction order, a mrad fine-tune knob (the software
 * rotation stage), and a live measurement of where the cell actually sits.
 * Geometry in utils/aomAlign, efficiency model in optical/kinds/aom/physics.
 */
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";

import { useSceneStore } from "../../store/sceneStore";
import type { SceneObject } from "../../types/digitalTwin";
import { threeToLabPointMm } from "../../optical/frames";
import { primaryAsset, resolveBindingTree } from "../../utils/componentBindings";
import { anchorObjectLocalPos, anchorObjectLocalPrimaryDir } from "../../utils/anchorAccess";
import {
  cadToLab,
  collectRoleCentres,
  computePointDirAlignPose,
  pickPolariserCentre,
  type RoleCentre,
  type Vec3,
} from "../../utils/isolatorAlign";
import {
  aomBraggReadout,
  braggTiltRad,
  computeAomBraggAlignPose,
  computeAomTiltNudgePose,
  resolveAomBraggFrame,
} from "../../utils/aomAlign";
import { braggAngleRad } from "../../optical/kinds/aom/physics";
import { resolveAomRfDriveFromScene } from "../../utils/aomRfDrive";

const ALIGN_TOLERANCE_MM = 25;
// Preference order for the single-asset fallback's reference anchor.
const PRIMARY_ANCHOR_IDS = ["intercept_in", "intercept_face", "in", "seed", "tip", "intercept_out"];

type AlignSpecProps = { pointMm?: number[]; directionMm?: number[] };
type BeamCandidate = {
  key: string;
  sourceName: string;
  miss: number;
  dir: Vec3;
  ref: Vec3;
  wavelengthNm?: number;
};

function vec3FromArray(a: number[] | undefined): Vec3 | null {
  return a && a.length === 3 && a.every((n) => typeof n === "number" && Number.isFinite(n))
    ? { x: a[0], y: a[1], z: a[2] }
    : null;
}

export function AlignToBeamControls({
  sceneObject,
}: {
  sceneObject: SceneObject;
}) {
  const scene = useSceneStore((state) => state.scene);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  // Chosen beam (by candidate key). null = use the nearest.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const objProps = (sceneObject.properties ?? {}) as Record<string, unknown>;
  // Direction points along +beam (forward) or −beam (reverse); roll spins
  // the element clockwise about the beam axis. Both per-object.
  const reverse = objProps.alignReverse === true;
  const rollDeg = typeof objProps.alignRollDeg === "number" ? objProps.alignRollDeg : 0;

  const persistProp = (patch: Record<string, unknown>) => {
    void updateSceneObject(sceneObject.id, {
      properties: { ...objProps, ...patch } as SceneObject["properties"],
    });
  };

  // Roll input draft (commits on blur / Enter).
  const [rollDraft, setRollDraft] = useState(rollDeg.toString());
  useEffect(() => setRollDraft(rollDeg.toString()), [rollDeg]);
  const commitRoll = (raw: string) => {
    const v = Number(raw);
    if (!Number.isFinite(v) || v === rollDeg) return;
    persistProp({ alignRollDeg: v });
  };

  /** Resolve (point, direction) in the Component CAD frame:
   *    1. explicit alignSpec on the Component (non-zero direction),
   *    2. composite binding-tree front/back centres (isolator),
   *    3. single-asset primary intercept anchor (point = anchor,
   *       direction = −axisX so the optic axis faces the beam). */
  const resolved = useMemo((): { point: Vec3; dir: Vec3 } | { error: string } => {
    const component = scene.components.find((c) => c.id === sceneObject.componentId);
    if (!component) return { error: "Component row not found in scene store." };

    const spec = (component.properties as { alignSpec?: AlignSpecProps } | null)?.alignSpec;
    const specPoint = vec3FromArray(spec?.pointMm);
    const specDir = vec3FromArray(spec?.directionMm);
    if (specPoint && specDir && Math.hypot(specDir.x, specDir.y, specDir.z) > 1e-6) {
      return { point: specPoint, dir: specDir };
    }

    const tree = resolveBindingTree(component, sceneObject, scene);
    const centres: RoleCentre[] = [];
    collectRoleCentres(tree, new THREE.Vector3(), new THREE.Quaternion(), centres);
    const front = pickPolariserCentre(centres, "front");
    const back = pickPolariserCentre(centres, "back");
    if (front && back) {
      return {
        point: { x: front.x, y: front.y, z: front.z },
        dir: { x: back.x - front.x, y: back.y - front.y, z: back.z - front.z },
      };
    }

    const asset = primaryAsset(component, scene) ?? null;
    const anchors = asset?.anchors ?? [];
    const anchor =
      PRIMARY_ANCHOR_IDS.map((id) => anchors.find((x) => x.id === id)).find(Boolean) ?? null;
    if (anchor) {
      const pos = anchorObjectLocalPos(anchor, asset);
      const axis = anchorObjectLocalPrimaryDir(anchor, asset);
      if (axis) return { point: pos, dir: { x: -axis.x, y: -axis.y, z: -axis.z } };
    }
    return {
      error:
        "No align point/direction. Define point + direction in PHY Editor → Component (Align), " +
        "or check the asset's intercept anchor.",
    };
  }, [scene, sceneObject]);

  // Candidate beams within tolerance of the align centre, one per source
  // object, nearest first. Reads the live V3 trace (window.__rayTraceDebug).
  const { candidates, closestMiss } = useMemo((): {
    candidates: BeamCandidate[];
    closestMiss: number;
  } => {
    if ("error" in resolved) return { candidates: [], closestMiss: Number.POSITIVE_INFINITY };
    const { point, dir } = resolved;
    const midLab = cadToLab(
      { x: point.x + dir.x * 0.5, y: point.y + dir.y * 0.5, z: point.z + dir.z * 0.5 },
      sceneObject,
    );
    type TraceSeg = {
      sourceObjectId: string;
      startThree: Vec3;
      endThree: Vec3;
      wavelengthNm?: number;
    };
    const traces: TraceSeg[] = (typeof window !== "undefined"
      ? (window as unknown as { __rayTraceDebug?: TraceSeg[] }).__rayTraceDebug
      : undefined) ?? [];
    // Cluster trace segments into distinct beams. A straight path re-emits
    // a near-collinear segment from every upstream element — those are ONE
    // physical beam, so merge any segment whose direction is within ~1° of
    // an existing cluster AND whose line passes within ~3 mm of it (same
    // line through the align point). Genuinely different beams (PBS
    // transmit vs reflect, AOM 0/±1 orders) keep distinct directions and
    // stay separate.
    const clusters: BeamCandidate[] = [];
    let closest = Number.POSITIVE_INFINITY;
    const COS_TOL = Math.cos((1 * Math.PI) / 180);
    for (const seg of traces) {
      if (seg.sourceObjectId === sceneObject.id) continue;
      const a = threeToLabPointMm(seg.startThree);
      const b = threeToLabPointMm(seg.endThree);
      const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const len = Math.hypot(ab.x, ab.y, ab.z);
      if (len < 1e-6) continue;
      const bdir = { x: ab.x / len, y: ab.y / len, z: ab.z / len };
      const tt = (midLab.x - a.x) * bdir.x + (midLab.y - a.y) * bdir.y + (midLab.z - a.z) * bdir.z;
      const foot = { x: a.x + bdir.x * tt, y: a.y + bdir.y * tt, z: a.z + bdir.z * tt };
      const miss = Math.hypot(midLab.x - foot.x, midLab.y - foot.y, midLab.z - foot.z);
      if (miss < closest) closest = miss;
      if (miss > ALIGN_TOLERANCE_MM) continue;
      const sourceName =
        scene.objects.find((o) => o.id === seg.sourceObjectId)?.name
        ?? seg.sourceObjectId.slice(0, 6);
      const match = clusters.find((c) => {
        const dotp = Math.abs(c.dir.x * bdir.x + c.dir.y * bdir.y + c.dir.z * bdir.z);
        if (dotp < COS_TOL) return false;
        return Math.hypot(c.ref.x - foot.x, c.ref.y - foot.y, c.ref.z - foot.z) < 3;
      });
      if (match) {
        if (miss < match.miss) {
          match.miss = miss;
          match.dir = bdir;
          match.ref = foot;
          match.sourceName = sourceName;
          match.wavelengthNm = seg.wavelengthNm;
        }
      } else {
        clusters.push({
          key: `beam-${clusters.length}`,
          sourceName, miss, dir: bdir, ref: foot,
          wavelengthNm: seg.wavelengthNm,
        });
      }
    }
    return {
      candidates: clusters.slice().sort((x, y) => x.miss - y.miss),
      closestMiss: closest,
    };
  }, [scene, sceneObject, resolved]);

  const chosen =
    (selectedKey && candidates.find((c) => c.key === selectedKey))
    || candidates[0]
    || null;

  // AOMs need the extra Bragg tilt on top of the generic align.
  const isAom = useMemo(() => {
    const component = scene.components.find((c) => c.id === sceneObject.componentId);
    return component ? primaryAsset(component, scene)?.kindId === "aom" : false;
  }, [scene, sceneObject.componentId]);

  const align = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      if ("error" in resolved) {
        setFeedback(resolved.error);
        return;
      }
      if (!chosen) {
        setFeedback(
          `No beam within ${ALIGN_TOLERANCE_MM} mm of the align point` +
          (Number.isFinite(closestMiss) ? ` (closest ${closestMiss.toFixed(1)} mm)` : "") +
          ". Move the object nearer a beam, or check the upstream chain is emitting.",
        );
        return;
      }

      const pose = computePointDirAlignPose({
        pointCadMm: resolved.point,
        dirCadMm: resolved.dir,
        sceneObject,
        beamDir: chosen.dir,
        beamRef: chosen.ref,
        reverse,
        rollDeg,
      });
      if (!pose) {
        setFeedback("Align direction is degenerate — check the Component's alignSpec / axis.");
        return;
      }
      await updateSceneObject(sceneObject.id, pose);

      const note = `${reverse ? "reverse" : ""}${rollDeg !== 0 ? ` roll ${rollDeg}°` : ""}`.trim();
      const angleNote = note ? ` (${note})` : "";
      setFeedback(
        `Aligned to ${chosen.sourceName} beam${angleNote} (point was ${chosen.miss.toFixed(1)} mm off).`,
      );
    } catch (err) {
      setFeedback(`Align failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="snap-to-beam">
      <label className="component-editor-coord" style={{ marginBottom: 6 }}>
        <span style={{ fontSize: 11 }}>Direction</span>
        <select
          value={reverse ? "reverse" : "forward"}
          onChange={(e) => persistProp({ alignReverse: e.target.value === "reverse" })}
        >
          <option value="forward">Forward (+beam)</option>
          <option value="reverse">Reverse (−beam)</option>
        </select>
      </label>
      <label className="component-editor-coord" style={{ marginBottom: 6 }}>
        <span style={{ fontSize: 11 }}>Roll about beam (° CW)</span>
        <input
          type="number"
          step={0.5}
          value={rollDraft}
          title="Clockwise roll about the beam axis, looking along the direction."
          onChange={(e) => setRollDraft(e.target.value)}
          onBlur={(e) => commitRoll(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRoll((e.target as HTMLInputElement).value);
            }
          }}
        />
      </label>
      {/* Beam picker — only when several beams pass near the align point. */}
      {candidates.length > 1 && (
        <label className="component-editor-coord" style={{ marginBottom: 6 }}>
          <span style={{ fontSize: 11 }}>Beam</span>
          <select
            value={selectedKey ?? ""}
            onChange={(e) => setSelectedKey(e.target.value || null)}
          >
            <option value="">Nearest — {candidates[0].sourceName} ({candidates[0].miss.toFixed(1)} mm)</option>
            {candidates.map((c) => (
              <option key={c.key} value={c.key}>
                {c.sourceName} ({c.miss.toFixed(1)} mm)
              </option>
            ))}
          </select>
        </label>
      )}
      {isAom && <AomBraggSection sceneObject={sceneObject} beam={chosen} />}
      <button
        type="button"
        className="primary-button"
        onClick={() => void align()}
        disabled={busy}
        title="Rotate + translate the object so its align point lands on the chosen beam and its direction makes the configured angle with the beam (0 = optic axis on the beam). Point + direction come from PHY Editor → Component; the angle is per-object."
      >
        {busy ? "Aligning…" : "Align to beam"}
      </button>
      {feedback && (
        <div className="snap-to-beam-feedback" style={{ marginTop: 6 }}>
          {feedback}
        </div>
      )}
    </div>
  );
}

const MRAD = 1000;

/**
 * AOM-only Bragg positioning. A real AOM has to be ROTATED to the Bragg angle
 * of the order you want (±θ_B, opposite sides for +1 and −1); the solver
 * models exactly that (`aom_physics.bragg_order_detune`), so "direction ∥
 * beam" alone leaves the cell off-Bragg by θ_B.
 *
 * Sign convention CONV-2 (lab-fixed): "+1" always tilts the same way, so the
 * diffracted beam always leaves on the same side of the table. Running the
 * beam through backwards (Direction = Reverse) therefore Bragg-matches −m for
 * that same tilt — the readout says which order the pose actually matches.
 */
function AomBraggSection({
  sceneObject,
  beam,
}: {
  sceneObject: SceneObject;
  beam: BeamCandidate | null;
}) {
  const scene = useSceneStore((state) => state.scene);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const objProps = (sceneObject.properties ?? {}) as Record<string, unknown>;
  const dyn = (sceneObject.dynamicSources ?? {}) as Record<string, unknown>;
  const fineMrad = typeof objProps.aomBraggFineTuneMrad === "number"
    ? objProps.aomBraggFineTuneMrad : 0;
  const [fineDraft, setFineDraft] = useState(fineMrad.toString());
  useEffect(() => setFineDraft(fineMrad.toString()), [fineMrad]);

  const asset = useMemo(() => {
    const component = scene.components.find((c) => c.id === sceneObject.componentId);
    return component ? primaryAsset(component, scene) ?? null : null;
  }, [scene, sceneObject.componentId]);
  const frame = useMemo(() => resolveAomBraggFrame(asset), [asset]);

  const params = (asset?.defaultParams ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const order = Math.round(num(dyn.diffractionOrder, num(params.diffractionOrder, 1)));
  const vAcoustic = num(params.acousticVelocityMps, 4200);
  const refractiveIndex = num(params.refractiveIndex, 2.26);
  const crystalLengthMm = num(params.crystalLengthMm, 22.4);
  const wavelengthNm = num(beam?.wavelengthNm, 780);

  // Same resolution order the trace uses: the live RF chain wins, then the
  // per-instance override, then the asset's design centre.
  const rfDrive = useMemo(
    () => resolveAomRfDriveFromScene(
      sceneObject.id, scene.objects, scene.components, scene.assets, scene.physicsElements,
    ),
    [scene, sceneObject.id],
  );
  const freqMhz = rfDrive?.frequencyMhz
    ?? num(dyn.aomFreqMhz, num(params.centerFreqMhz, 80));
  const thetaB = braggAngleRad(
    { centerFreqMhz: freqMhz, acousticVelocityMps: vAcoustic }, wavelengthNm,
  );

  const readout = useMemo(() => {
    if (!frame || !beam) return null;
    return aomBraggReadout({
      frame, sceneObject, beamDir: beam.dir, thetaBRad: thetaB,
      wavelengthNm, freqMhz, acousticVelocityMps: vAcoustic,
      refractiveIndex, crystalLengthMm,
      orders: order === 0 ? [1, -1] : [order, -order],
    });
  }, [frame, beam, sceneObject, thetaB, wavelengthNm, freqMhz, vAcoustic,
    refractiveIndex, crystalLengthMm, order]);

  if (!frame) {
    return (
      <div className="snap-to-beam-feedback" style={{ marginTop: 6 }}>
        No Bragg geometry: the AOM asset needs intercept_in / intercept_out and an
        acoustic direction (acoustic_axis anchor or rfPropagationDirectionBodyLocal).
      </div>
    );
  }

  const tiltRad = braggTiltRad(order, thetaB) + fineMrad / MRAD;
  const selected = readout?.orders.find((o) => o.order === order) ?? null;

  const braggAlign = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      if (!beam) {
        setFeedback("No beam nearby to Bragg-align to.");
        return;
      }
      if (order === 0) {
        setFeedback("Order 0 is the undiffracted beam — nothing to Bragg-align. Pick ±1.");
        return;
      }
      const pose = computeAomBraggAlignPose({
        frame,
        sceneObject,
        beamDir: beam.dir,
        beamRef: beam.ref,
        reverse: objProps.alignReverse === true,
        rollDeg: typeof objProps.alignRollDeg === "number" ? objProps.alignRollDeg : 0,
        tiltRad,
      });
      if (!pose) {
        setFeedback("Bragg align failed — degenerate AOM geometry.");
        return;
      }
      await updateSceneObject(sceneObject.id, pose);
      setFeedback(
        `Tilted ${(braggTiltRad(order, thetaB) * MRAD).toFixed(2)} mrad`
        + (fineMrad !== 0 ? ` ${fineMrad > 0 ? "+" : ""}${fineMrad} mrad fine` : "")
        + ` for order ${order > 0 ? "+" : ""}${order} on the ${beam.sourceName} beam.`,
      );
    } catch (err) {
      setFeedback(`Bragg align failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** Fine-tune = walking the rotation stage: apply the CHANGE as a rotation
   *  about D3 around the interaction centre, so the cell stays on the beam. */
  const commitFine = async (raw: string) => {
    const next = Number(raw);
    if (!Number.isFinite(next) || next === fineMrad) return;
    const pose = computeAomTiltNudgePose({
      frame, sceneObject, deltaRad: (next - fineMrad) / MRAD,
    });
    await updateSceneObject(sceneObject.id, {
      ...pose,
      properties: { ...objProps, aomBraggFineTuneMrad: next } as SceneObject["properties"],
    });
  };

  const setOrder = (next: number) => {
    void updateSceneObject(sceneObject.id, {
      dynamicSources: { ...dyn, diffractionOrder: next },
    });
  };

  const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;

  return (
    <div style={{ borderTop: "1px solid var(--panel-border, #333)", paddingTop: 6, marginBottom: 6 }}>
      <label className="component-editor-coord" style={{ marginBottom: 6 }}>
        <span style={{ fontSize: 11 }}>Diffraction order</span>
        <select value={order} onChange={(e) => setOrder(Number(e.target.value))}>
          <option value={1}>+1</option>
          <option value={0}>0 (pass-through)</option>
          <option value={-1}>−1</option>
        </select>
      </label>
      <label className="component-editor-coord" style={{ marginBottom: 6 }}>
        <span style={{ fontSize: 11 }}>Fine tune (mrad)</span>
        <input
          type="number"
          step={0.1}
          value={fineDraft}
          title="Walk the AOM's rotation about the Bragg axis (D3), pivoting on the interaction centre — the beam stays through the cell."
          onChange={(e) => setFineDraft(e.target.value)}
          onBlur={(e) => void commitFine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commitFine((e.target as HTMLInputElement).value);
            }
          }}
        />
      </label>
      <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6, lineHeight: 1.5 }}>
        <div>
          θ_B {(thetaB * MRAD).toFixed(2)} mrad
          {" · "}λ {wavelengthNm.toFixed(0)} nm
          {" · "}f {freqMhz.toFixed(2)} MHz{rfDrive ? " (RF link)" : " (default)"}
        </div>
        {readout ? (
          <>
            <div>
              Incidence {(readout.thetaInRad * MRAD).toFixed(2)} mrad
              {selected && (
                <>
                  {" · Δ"}{order > 0 ? "+" : ""}{order}{" "}
                  {(selected.mismatchRad * MRAD).toFixed(2)} mrad → {pct(selected.phaseMatch)}
                </>
              )}
            </div>
            <div>
              {readout.orders
                .map((o) => `${o.order > 0 ? "+" : ""}${o.order}: ${pct(o.phaseMatch)}`)
                .join("  ")}
            </div>
            {order !== 0 && readout.matchedOrder !== order && (
              <div style={{ color: "var(--warning, #e0a800)" }}>
                This pose Bragg-matches order {readout.matchedOrder > 0 ? "+" : ""}
                {readout.matchedOrder}, not {order > 0 ? "+" : ""}{order}
                {objProps.alignReverse === true
                  ? " — the beam runs through the cell backwards (Direction = Reverse), which swaps the order for a lab-fixed tilt."
                  : " — press Bragg align."}
              </div>
            )}
          </>
        ) : (
          <div>No beam nearby — the incidence readout needs a beam through the cell.</div>
        )}
      </div>
      <button
        type="button"
        className="secondary-button"
        onClick={() => void braggAlign()}
        disabled={busy || !beam}
        title="Put the interaction centre on the beam, the optical axis along it, then tilt by the selected order's Bragg angle (+ fine tune) about the acoustic-perpendicular axis."
      >
        {busy ? "Aligning…" : `Bragg align (order ${order > 0 ? "+" : ""}${order})`}
      </button>
      {feedback && (
        <div className="snap-to-beam-feedback" style={{ marginTop: 6 }}>
          {feedback}
        </div>
      )}
    </div>
  );
}
