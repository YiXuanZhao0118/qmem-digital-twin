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

const ALIGN_TOLERANCE_MM = 25;
// Preference order for the single-asset fallback's reference anchor.
const PRIMARY_ANCHOR_IDS = ["intercept_in", "intercept_face", "in", "seed", "tip", "intercept_out"];

type AlignSpecProps = { pointMm?: number[]; directionMm?: number[] };
type BeamCandidate = { key: string; sourceName: string; miss: number; dir: Vec3; ref: Vec3 };

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
    type TraceSeg = { sourceObjectId: string; startThree: Vec3; endThree: Vec3 };
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
        }
      } else {
        clusters.push({ key: `beam-${clusters.length}`, sourceName, miss, dir: bdir, ref: foot });
      }
    }
    return {
      candidates: clusters.slice().sort((x, y) => x.miss - y.miss),
      closestMiss: closest,
    };
  }, [scene, sceneObject, resolved]);

  const align = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      if ("error" in resolved) {
        setFeedback(resolved.error);
        return;
      }
      const chosen =
        (selectedKey && candidates.find((c) => c.key === selectedKey))
        || candidates[0];
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
