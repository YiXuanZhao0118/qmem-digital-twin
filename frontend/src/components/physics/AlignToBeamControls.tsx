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
 *   - the per-object direction / roll choices (`alignReverse`,
 *     `alignRollDeg`) live on the SceneObject and are edited here, so each
 *     instance can sit at its own orientation on the beam.
 *
 * When several beams pass near the align point (AOM diffraction orders,
 * crossing paths, retro-reflections) a beam picker appears so the user can
 * choose WHICH beam to align to — parity with the legacy fiber / rf_cable
 * two-phase align. With a single nearby beam it auto-aligns to it.
 *
 * ── Where the maths lives ─────────────────────────────────────────────────
 *
 * Nowhere in this file. Both the (point, direction) resolution and the pose
 * come from `POST /api/v3/align/isolator` (`api/align.ts`), and the AOM's
 * Bragg frame / tilt / readout from `POST /api/v3/align/aom-bragg`. The
 * TypeScript copies (`utils/isolatorAlign.ts`, `utils/aomAlign.ts`) were
 * deleted once the backend port existed, so there is one implementation for
 * the web app and the qmem-blender add-on to share.
 *
 * What is still decided here, because it is the USER's choice and not
 * geometry: which beam (the clustering below), the diffraction order, the
 * fine-tune value, forward / reverse and roll. Those are sent with every
 * request, so what the panel shows and what the solver used never disagree.
 *
 * The one consequence to keep in mind: the solvers are now a round trip away,
 * so the align point arrives asynchronously. The panel renders its controls
 * immediately, shows the backend's own `detail` when a call fails, and never
 * parks in a "solving" state — every path clears `busy` in `finally`.
 *
 * AOMs get an extra Bragg section (`AomBraggSection`): a cell only diffracts
 * into the order you asked for if it is ROTATED to that order's Bragg angle,
 * so the plain "direction ∥ beam" align is not enough. It adds the ±θ_B tilt
 * for the selected diffraction order, a mrad fine-tune knob (the software
 * rotation stage), and a live measurement of where the cell actually sits.
 * Efficiency model: optical/kinds/aom/physics (mirrored by the backend).
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { useSceneStore } from "../../store/sceneStore";
import type { SceneObject } from "../../types/digitalTwin";
import { rotateLabDir, threeToLabPointMm } from "../../optical/frames";
import { primaryAssetForObject } from "../../utils/componentBindings";
import {
  alignAomBraggApi,
  alignPointDirApi,
  type AlignBeam,
  type AlignVec3,
  type AomBraggResult,
} from "../../api/align";

const ALIGN_TOLERANCE_MM = 25;

/** How long the panel waits for the scene to settle before re-asking the
 *  backend. Every store write replaces `scene`, and a drag writes often. */
const SOLVE_DEBOUNCE_MS = 200;

/** A stand-in beam for the calls that only read what does NOT depend on one:
 *  the align point / direction, the Bragg frame, θ_B and the drive frequency.
 *  Both endpoints require a non-zero beam direction (it is what they solve a
 *  pose against), and the pose / readout those calls come back with is simply
 *  ignored. */
const PROBE_BEAM: AlignBeam = { dir: { x: 1, y: 0, z: 0 }, ref: { x: 0, y: 0, z: 0 } };

type Vec3 = AlignVec3;
type BeamCandidate = {
  key: string;
  sourceName: string;
  miss: number;
  dir: Vec3;
  ref: Vec3;
  wavelengthNm?: number;
};

/** The align point / direction, in the Component CAD frame, as resolved by
 *  `POST /api/v3/align/isolator`. */
type AlignPointDir =
  | { status: "loading" }
  | { status: "ok"; point: Vec3; dir: Vec3 }
  | { status: "error"; message: string };

/** Component CAD frame (mm) → lab mm under a SceneObject pose — the same path
 *  the backend's `pose.point_body_to_lab` takes. Used only to put the align
 *  point where the beam picker can measure candidates against it. */
function cadToLab(cad: Vec3, sceneObject: SceneObject): Vec3 {
  const r = rotateLabDir(cad, sceneObject);
  return { x: sceneObject.xMm + r.x, y: sceneObject.yMm + r.y, z: sceneObject.zMm + r.z };
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

  /** (point, direction) in the Component CAD frame, from the backend: the
   *  Component's alignSpec, else the binding tree's front/back polariser
   *  centres (an isolator), else the primary asset's entry anchor. It does
   *  not depend on the object's POSE, so it is refetched when the catalog
   *  behind it could have moved — debounced, and only committed to state when
   *  the answer actually changed, so a dragging object does not re-render the
   *  beam picker on every frame. */
  const [resolved, setResolved] = useState<AlignPointDir>({ status: "loading" });
  const resolvedRef = useRef(false);
  // A different object is a different align point: drop the previous answer
  // rather than clustering beams against it for a round trip.
  useEffect(() => {
    resolvedRef.current = false;
    setResolved({ status: "loading" });
  }, [sceneObject.id]);
  useEffect(() => {
    let cancelled = false;
    // First fetch immediately, refreshes debounced — a scene that keeps
    // changing can delay an update but can never starve the panel of its
    // first answer by resetting the timer forever.
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const out = await alignPointDirApi({ objectId: sceneObject.id, beam: PROBE_BEAM });
          if (cancelled) return;
          resolvedRef.current = true;
          setResolved((prev) =>
            prev.status === "ok"
            && prev.point.x === out.pointCadMm.x
            && prev.point.y === out.pointCadMm.y
            && prev.point.z === out.pointCadMm.z
            && prev.dir.x === out.dirCadMm.x
            && prev.dir.y === out.dirCadMm.y
            && prev.dir.z === out.dirCadMm.z
              ? prev
              : { status: "ok", point: out.pointCadMm, dir: out.dirCadMm },
          );
        } catch (err) {
          if (!cancelled) setResolved({ status: "error", message: (err as Error).message });
        }
      })();
    }, resolvedRef.current ? SOLVE_DEBOUNCE_MS : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [sceneObject.id, scene]);

  // Candidate beams within tolerance of the align centre, one per source
  // object, nearest first. Reads the live V3 trace (window.__rayTraceDebug).
  const { candidates, closestMiss } = useMemo((): {
    candidates: BeamCandidate[];
    closestMiss: number;
  } => {
    if (resolved.status !== "ok") return { candidates: [], closestMiss: Number.POSITIVE_INFINITY };
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
    return component ? primaryAssetForObject(component, sceneObject, scene)?.kindId === "aom" : false;
  }, [scene, sceneObject]);

  const align = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      if (resolved.status === "error") {
        setFeedback(resolved.message);
        return;
      }
      if (resolved.status === "loading") {
        setFeedback("Still reading this object's align point — try again in a moment.");
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

      // reverse / rollDeg are sent explicitly: the panel persists them
      // fire-and-forget, so the row the backend would read may still be a
      // write behind what the user is looking at.
      const out = await alignPointDirApi({
        objectId: sceneObject.id,
        beam: { dir: chosen.dir, ref: chosen.ref },
        reverse,
        rollDeg,
      });
      if (!out.pose) {
        setFeedback(
          out.error ?? "Align direction is degenerate — check the Component's alignSpec / axis.",
        );
        return;
      }
      await updateSceneObject(sceneObject.id, out.pose);

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
 *
 * The geometry, θ_B, the drive frequency and the readout all come from
 * `POST /api/v3/align/aom-bragg` in one call, so "where it should sit" and
 * "where it sits now" are never measured by two different copies of the
 * maths. The order and the fine-tune value stay here — they are the panel's
 * controls — and are sent with every request.
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

  // The diffraction-order select's value. Resolved here rather than taken
  // from the response so the control answers the click immediately; it is
  // sent with every request, so the backend solves for what is on screen.
  const asset = useMemo(() => {
    const component = scene.components.find((c) => c.id === sceneObject.componentId);
    return component ? primaryAssetForObject(component, sceneObject, scene) : null;
  }, [scene, sceneObject]);
  const params = (asset?.defaultParams ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const order = Math.round(num(dyn.diffractionOrder, num(params.diffractionOrder, 1)));

  /** The beam sent with a request. Without one nearby, the readout is
   *  meaningless (and hidden) but θ_B / the drive frequency still are not, so
   *  the call goes out with the probe beam and the readout is ignored. */
  const requestBeam: AlignBeam = beam
    ? { dir: beam.dir, ref: beam.ref, wavelengthNm: beam.wavelengthNm ?? null }
    : PROBE_BEAM;

  const [solved, setSolved] = useState<
    { status: "loading" } | { status: "ok"; out: AomBraggResult } | { status: "error"; message: string }
  >({ status: "loading" });
  // Guards against an out-of-order response overwriting a newer one.
  const solveSeqRef = useRef(0);
  const solvedRef = useRef(false);
  useEffect(() => {
    solvedRef.current = false;
    setSolved({ status: "loading" });
  }, [sceneObject.id]);
  useEffect(() => {
    const seq = (solveSeqRef.current += 1);
    // First call immediate, refreshes debounced — see the note on the panel's
    // own resolve effect. The previous answer stays on screen meanwhile, so
    // the readout does not blank every time the cell is nudged.
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const out = await alignAomBraggApi({
            objectId: sceneObject.id,
            beam: requestBeam,
            order,
            fineTuneMrad: fineMrad,
          });
          if (solveSeqRef.current !== seq) return;
          solvedRef.current = true;
          setSolved({ status: "ok", out });
        } catch (err) {
          if (solveSeqRef.current === seq) {
            setSolved({ status: "error", message: (err as Error).message });
          }
        }
      })();
    }, solvedRef.current ? SOLVE_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(handle);
    // `sceneObject` covers the pose the readout is measured at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sceneObject, order, fineMrad,
    requestBeam.dir.x, requestBeam.dir.y, requestBeam.dir.z,
    requestBeam.ref.x, requestBeam.ref.y, requestBeam.ref.z,
    requestBeam.wavelengthNm,
  ]);

  if (solved.status === "error") {
    return (
      <div className="snap-to-beam-feedback" style={{ marginTop: 6 }}>
        {solved.message}
      </div>
    );
  }

  const out = solved.status === "ok" ? solved.out : null;
  const readout = out && beam ? out.readout : null;
  const selected = readout?.orders.find((o) => o.order === order) ?? null;

  const braggAlign = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      if (!beam) {
        setFeedback("No beam nearby to Bragg-align to.");
        return;
      }
      const res = await alignAomBraggApi({
        objectId: sceneObject.id,
        beam: { dir: beam.dir, ref: beam.ref, wavelengthNm: beam.wavelengthNm ?? null },
        order,
        fineTuneMrad: fineMrad,
        reverse: objProps.alignReverse === true,
        rollDeg: typeof objProps.alignRollDeg === "number" ? objProps.alignRollDeg : 0,
      });
      if (!res.pose) {
        setFeedback(res.error ?? "Bragg align failed — degenerate AOM geometry.");
        return;
      }
      await updateSceneObject(sceneObject.id, res.pose);
      setFeedback(
        `Tilted ${(res.order * res.thetaBRad * MRAD).toFixed(2)} mrad`
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
    try {
      const res = await alignAomBraggApi({
        objectId: sceneObject.id,
        beam: requestBeam,
        order,
        fineTuneMrad: fineMrad,
        nudgeMrad: next - fineMrad,
      });
      if (!res.nudgePose) {
        setFeedback(res.error ?? "Fine tune failed — degenerate AOM geometry.");
        setFineDraft(fineMrad.toString());
        return;
      }
      await updateSceneObject(sceneObject.id, {
        ...res.nudgePose,
        properties: { ...objProps, aomBraggFineTuneMrad: next } as SceneObject["properties"],
      });
    } catch (err) {
      setFeedback(`Fine tune failed: ${(err as Error).message}`);
      setFineDraft(fineMrad.toString());
    }
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
        {out ? (
          <div>
            θ_B {(out.thetaBRad * MRAD).toFixed(2)} mrad
            {" · "}λ {out.wavelengthNm.toFixed(0)} nm
            {" · "}f {out.freqMhz.toFixed(2)} MHz
            {out.freqSource === "rfLink" ? " (RF link)" : " (default)"}
          </div>
        ) : (
          <div>Reading the cell's Bragg geometry…</div>
        )}
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
          out && <div>No beam nearby — the incidence readout needs a beam through the cell.</div>
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

/** Optical ElementKinds that align to a beam — drives where the unified
 *  "Align to beam" control (Object panel) and the alignSpec editor (PHY
 *  Editor → Component) appear. Mirrors the per-kind `alignVariant !== "none"`
 *  set. Isolators (kindId "none") are detected separately via their
 *  binding-tree front/back composite roles. Fiber is excluded — it aligns
 *  per-end (Align A/B), which the single (point, direction) model doesn't
 *  fit. So is `eom`: a fibre-pigtailed modulator aligns per port connector
 *  (`PigtailEndAlignControls`) for the same reason.
 *
 *  It lives beside the control it gates (it used to sit in the deleted
 *  `utils/isolatorAlign.ts`); the backend's copy of the same gate is the
 *  align endpoints' own 422. */
export const OPTICAL_ALIGN_KINDS = new Set<string>([
  "mirror", "dichroic_mirror", "beam_splitter",
  "lens_biconvex", "lens_plano_convex", "lens_cylindrical",
  "fiber_coupler", "polarizer", "glan_polarizer", "waveplate",
  "beam_dump", "detector", "camera", "spectrometer", "wavemeter",
  "saturable_absorber", "nonlinear_crystal", "aom", "tapered_amplifier",
]);
