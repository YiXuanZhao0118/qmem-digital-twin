/**
 * MirrorCouplingPanel — couple a beam into a port with two steering mirrors.
 *
 * Select two mirrors; the panel finds the seed beam arriving at the first one
 * and the destination port the chain ends at, then solves both mirrors'
 * positions and orientations so that
 *
 *   - the angle of incidence is exactly 45 deg on each mirror,
 *   - the spot sits on each mirror's centre, and
 *   - the outgoing beam is the destination port's own axis.
 *
 * The precondition, and the reason the panel leads with a 2x2 table: BOTH
 * mirrors must currently be touched by BOTH beams — the seed coming down from
 * upstream, and a reverse reference ray back-projected out of the destination
 * port. That is the bench procedure (send the TA's light backwards, overlap it
 * with the seed on both mirrors) written as a check. When it fails the answer
 * is "rough the mounts in by hand first", not a solve that would fling a mount
 * across the table, so the panel says which cell failed and by how much.
 *
 * ── Where the maths lives ─────────────────────────────────────────────────
 *
 * `POST /api/v3/align/mirror-coupling` (`api/align.ts`). The touch matrix, the
 * geometry, both mirror poses and the pass-through re-centring all come back
 * from one compute-only call; the TypeScript copy (`utils/mirrorCoupling.ts`)
 * was deleted once the backend port existed, so the web app and the
 * qmem-blender add-on run the same solver.
 *
 * This file is scene plumbing, and that is now the whole of it: which beam,
 * which port, what else is in the way, preview, and one batched write. The
 * picks are the USER's and stay here; everything the picks are fed INTO
 * crossed to the backend.
 *
 * The solve is a round trip, so: the first one fires immediately and refreshes
 * are debounced (a scene that keeps changing can delay an update but can never
 * starve the panel of its first answer); a sequence number keeps a slow answer
 * from landing on top of a newer one; the last result stays on screen while a
 * newer one is in flight, so the readouts do not blank on every keystroke in
 * the fold box, but Apply and Preview are disabled the whole time it is in
 * flight, so a stale plan can be read and never applied; a 4xx shows the
 * backend's own `detail`. Undo is untouched — Apply is still the same single
 * `updateSceneObjects` batch (rule R9), only the pose it writes arrives from
 * the wire.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Crosshair, RotateCcw, X } from "lucide-react";

import { useSceneStore } from "../../store/sceneStore";
import type { ComponentItem, SceneData, SceneObject } from "../../types/digitalTwin";
import { threeToLabPointMm } from "../../optical/frames";
import { FloatingPanel } from "../workspace/FloatingPanel";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { resolveAnchorPosesLab, type AnchorPoseLab } from "../../utils/anchorPose";
import {
  alignMirrorCouplingApi,
  type AlignRay,
  type AlignVec3,
  type MirrorCouplingResult,
  type MirrorSpotHit,
  type MirrorTouchMatrix,
} from "../../api/align";

/** Kinds this tool will steer with. */
const STEERING_KINDS = new Set(["mirror", "dichroic_mirror"]);

/** Anchors that can serve as a coupling destination — a face light goes INTO.
 *  `intercept_out` is deliberately absent: that is an emitter's exit face. */
const TARGET_ANCHOR_IDS = ["intercept_in", "fiber_in", "seed"];

/** The reflective-face anchor every `mirror` / `dichroic_mirror` asset
 *  carries. Only used here to sort the target list by distance from mirror B
 *  and to catch a mirror that has no usable face before a solve is attempted;
 *  the solver reads the same anchor on its own side. */
const MIRROR_FACE_ANCHOR_ID = "intercept_face";

/** Kinds whose optical power steers the chief ray once it stops being
 *  centred. Not a blocker (a centred lens bends nothing), but the reason the
 *  recentre checkbox exists. */
const FOCUSING_KINDS = new Set([
  "lens_biconvex",
  "lens_plano_convex",
  "lens_cylindrical",
]);

/** Direction change above this between mirror B and the destination means
 *  something in the span bends the beam, so "the target line" is not the
 *  destination anchor's axis and the solve would be wrong. */
const DEVIATION_TOL_DEG = 0.05;

/** How long the panel waits for the picks / the scene to settle before
 *  re-asking the backend. */
const SOLVE_DEBOUNCE_MS = 200;

type Vec3 = AlignVec3;

type TraceSeg = {
  hitObjectId?: string | null;
  sourceObjectId?: string;
  emitterObjectId?: string;
  startThree?: { x: number; y: number; z: number };
  endThree?: { x: number; y: number; z: number };
  wavelengthNm?: number;
};

type LabSeg = {
  hitObjectId: string | null;
  sourceObjectId: string;
  emitterObjectId: string;
  start: Vec3;
  end: Vec3;
  dir: Vec3;
  wavelengthNm?: number;
};

type SceneSlice = Pick<
  SceneData,
  "componentBindings" | "objectBindings" | "assets" | "components"
>;

/** One of the two steering mirrors, as far as the PANEL needs to know it.
 *  Everything geometric about it (centre, normal, aperture) is the solver's
 *  to report. */
type MirrorPick = {
  objectId: string;
  name: string;
  locked: boolean;
  /** Reflective-face centre in lab mm — the sort key for the target list. */
  faceLab: Vec3;
};

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const fmt = (n: number | null | undefined, d = 2): string =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "—";

/** Ideal reflection off a plane with unit normal `n` — the ghost polyline's
 *  last leg only. The solved geometry all comes from the endpoint. */
const reflect = (d: Vec3, n: Vec3): Vec3 => {
  const k = 2 * dot(d, n);
  return { x: d.x - n.x * k, y: d.y - n.y * k, z: d.z - n.z * k };
};

function readTrace(): LabSeg[] {
  const raw: TraceSeg[] =
    (typeof window !== "undefined"
      ? (window as unknown as { __rayTraceDebug?: TraceSeg[] }).__rayTraceDebug
      : undefined) ?? [];
  const out: LabSeg[] = [];
  for (const s of raw) {
    if (!s.startThree || !s.endThree) continue;
    const start = threeToLabPointMm(s.startThree);
    const end = threeToLabPointMm(s.endThree);
    const d = sub(end, start);
    const m = len(d);
    if (m < 1e-9) continue;
    out.push({
      hitObjectId: s.hitObjectId ?? null,
      sourceObjectId: s.sourceObjectId ?? "",
      emitterObjectId: s.emitterObjectId ?? "",
      start,
      end,
      dir: { x: d.x / m, y: d.y / m, z: d.z / m },
      wavelengthNm: s.wavelengthNm,
    });
  }
  return out;
}

/** Cheap signature of the published trace, so the panel re-reads only when
 *  the trace has actually changed. `__rayTraceDebug` is a plain global the
 *  viewer overwrites — there is no store revision to subscribe to. */
function traceSignature(segs: LabSeg[]): string {
  if (segs.length === 0) return "0";
  const f = segs[0];
  const l = segs[segs.length - 1];
  return `${segs.length}|${f.start.x.toFixed(3)},${f.start.y.toFixed(3)}|${l.end.x.toFixed(3)},${l.end.y.toFixed(3)}`;
}

/** The mirror's reflective face in lab mm, or the reason it cannot steer.
 *  Deliberately the same two sentences the solver answers 422 with — the
 *  panel has to know before it can even build the target list, which is
 *  sorted by distance from mirror B. */
function mirrorPickFromObject(
  sceneObject: SceneObject,
  scene: SceneSlice,
): MirrorPick | { error: string } {
  const component: ComponentItem | undefined = (scene.components ?? []).find(
    (c) => c.id === sceneObject.componentId,
  );
  if (!component) return { error: `${sceneObject.name}: Component row not in the scene store.` };

  const anchors = resolveAnchorPosesLab(component, sceneObject, scene);
  const face = anchors.find((a) => a.anchorId === MIRROR_FACE_ANCHOR_ID);
  if (!face) {
    return { error: `${sceneObject.name}: no \`${MIRROR_FACE_ANCHOR_ID}\` anchor in its binding tree.` };
  }
  if (!face.axisXLab || !face.axisXCad) {
    return {
      error:
        `${sceneObject.name}: \`${MIRROR_FACE_ANCHOR_ID}\` declares no direction. `
        + "Set the face normal (axisX) in PHY Editor -> Optical.",
    };
  }
  return {
    objectId: sceneObject.id,
    name: sceneObject.name,
    locked: !!sceneObject.locked,
    faceLab: face.posLab,
  };
}

/** One optic sitting between mirror B and the destination port. */
type PassThroughItem = {
  object: SceneObject;
  component: ComponentItem;
  /** Its power will steer the chief ray once it stops being centred. */
  focusing: boolean;
  /** How far its entry face currently sits off the destination axis (mm). */
  missMm: number | null;
};

type TargetOption = {
  key: string;
  label: string;
  objectId: string;
  anchorId: string;
  anchorName: string;
  ray: AlignRay;
  distanceMm: number;
};

type Resolution =
  | { kind: "hint"; message: string }
  | {
      kind: "ready";
      a: MirrorPick;
      b: MirrorPick;
      seedCandidates: { key: string; label: string; ray: AlignRay }[];
      seedKey: string;
      inRay: AlignRay;
      targetOptions: TargetOption[];
      targetKey: string;
      target: TargetOption;
      /** Objects between mirror B and the destination port, in path order. */
      passThrough: PassThroughItem[];
      /** A blocker found while walking B -> destination, if any. */
      spanBlocker: string | null;
    };

/** The last answer, plus whether a newer one is on the way. `result` is kept
 *  across a re-solve so the readouts do not blank on every keystroke in the
 *  fold box; `solving` is what blocks Apply, so a stale table can be looked at
 *  but never applied. */
type SolveState = {
  result: MirrorCouplingResult | null;
  error: string | null;
  solving: boolean;
};

export function MirrorCouplingPanel() {
  const scene = useSceneStore((s) => s.scene);
  const selectedObjectIds = useSceneStore((s) => s.selectedObjectIds);
  const updateSceneObjects = useSceneStore((s) => s.updateSceneObjects);
  const previewObjectTransform = useSceneStore((s) => s.previewObjectTransform);
  const clearPreviewObjectTransform = useSceneStore((s) => s.clearPreviewObjectTransform);
  const setMirrorCouplingGhost = useSceneStore((s) => s.setMirrorCouplingGhost);
  const { layouts } = useWorkspace();
  const visible = layouts["mirror-coupling"].visible;

  const [seedKeyPick, setSeedKeyPick] = useState<string | null>(null);
  const [targetKeyPick, setTargetKeyPick] = useState<string | null>(null);
  const [foldDraft, setFoldDraft] = useState<string>("");
  const [recentre, setRecentre] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [traceNonce, setTraceNonce] = useState(0);
  const traceSigRef = useRef("");
  const previewedIdsRef = useRef<string[]>([]);

  // `__rayTraceDebug` is a global the viewer republishes after every solve,
  // with no store revision to subscribe to. Poll its signature while the
  // panel is open and bump a nonce only when it actually changed, so the
  // readouts stay live without re-rendering on a timer.
  useEffect(() => {
    if (!visible) return;
    const tick = () => {
      const sig = traceSignature(readTrace());
      if (sig !== traceSigRef.current) {
        traceSigRef.current = sig;
        setTraceNonce((n) => n + 1);
      }
    };
    tick();
    const h = window.setInterval(tick, 500);
    return () => window.clearInterval(h);
  }, [visible]);

  const clearPreview = useCallback(() => {
    for (const id of previewedIdsRef.current) clearPreviewObjectTransform(id);
    previewedIdsRef.current = [];
    setPreviewing(false);
  }, [clearPreviewObjectTransform]);

  // Never leave ghost poses behind when the panel closes or unmounts.
  useEffect(() => {
    if (!visible) clearPreview();
  }, [visible, clearPreview]);
  useEffect(() => clearPreview, [clearPreview]);

  const resolution = useMemo((): Resolution => {
    void traceNonce;
    const picked = selectedObjectIds
      .map((id) => scene.objects.find((o) => o.id === id))
      .filter((o): o is SceneObject => !!o);
    if (picked.length !== 2) {
      return {
        kind: "hint",
        message:
          picked.length < 2
            ? "Select the TWO steering mirrors you want to couple with."
            : `${picked.length} objects selected — this tool steers with exactly two mirrors.`,
      };
    }
    const componentOf = (o: SceneObject): ComponentItem | undefined =>
      scene.components.find((c) => c.id === o.componentId);
    const nonMirror = picked.find((o) => !STEERING_KINDS.has(componentOf(o)?.kindId ?? ""));
    if (nonMirror) {
      return { kind: "hint", message: `${nonMirror.name} is not a mirror — select two mirrors.` };
    }

    const picks = picked.map((o) => mirrorPickFromObject(o, scene));
    const bad = picks.find((p): p is { error: string } => "error" in p);
    if (bad) return { kind: "hint", message: bad.error };
    const [f0, f1] = picks as MirrorPick[];

    const trace = readTrace();
    if (trace.length === 0) {
      return {
        kind: "hint",
        message: "No optical trace published yet. Let the scene solve, then reopen this panel.",
      };
    }

    // Order the pair by the beam, not by click order.
    let a: MirrorPick;
    let b: MirrorPick;
    if (trace.some((s) => s.hitObjectId === f1.objectId && s.sourceObjectId === f0.objectId)) {
      a = f0;
      b = f1;
    } else if (trace.some((s) => s.hitObjectId === f0.objectId && s.sourceObjectId === f1.objectId)) {
      a = f1;
      b = f0;
    } else {
      return {
        kind: "hint",
        message:
          `The traced beam does not run from ${f0.name} to ${f1.name} (or back). `
          + "Rough the pair in by hand until the beam actually bounces off both, then come back.",
      };
    }

    // Seed beam: the segments that terminate on A, minus anything coming
    // back from B (a retro-reflection is not the input).
    const seedCandidates = trace
      .filter((s) => s.hitObjectId === a.objectId && s.sourceObjectId !== b.objectId)
      .map((s, i) => ({
        key: `seed-${i}-${s.sourceObjectId}`,
        label:
          `${scene.objects.find((o) => o.id === s.sourceObjectId)?.name ?? "source"}`
          + (typeof s.wavelengthNm === "number" ? ` @ ${s.wavelengthNm.toFixed(0)} nm` : ""),
        ray: { origin: s.start, dir: s.dir } as AlignRay,
        seg: s,
      }));
    if (seedCandidates.length === 0) {
      return { kind: "hint", message: `No traced beam reaches ${a.name}.` };
    }
    const seed =
      seedCandidates.find((c) => c.key === seedKeyPick) ?? seedCandidates[0];
    const emitterId = seed.seg.emitterObjectId;

    // Walk forward from B along the same emission and note what is in the
    // way. A direction change in this span means the destination anchor's
    // axis is NOT the line the beam has to leave B on.
    const path: SceneObject[] = [];
    let spanBlocker: string | null = null;
    let cursor = b.objectId;
    let prevDir: Vec3 | null = null;
    let destinationId: string | null = null;
    for (let guard = 0; guard < 32; guard += 1) {
      const next = trace.find(
        (s) => s.sourceObjectId === cursor && s.emitterObjectId === emitterId,
      );
      if (!next || !next.hitObjectId) break;
      if (prevDir) {
        const cos = Math.min(1, Math.abs(dot(prevDir, next.dir)));
        const deg = (Math.acos(cos) * 180) / Math.PI;
        if (deg > DEVIATION_TOL_DEG) {
          const bender = scene.objects.find((o) => o.id === cursor);
          spanBlocker =
            `${bender?.name ?? "An element"} bends the beam ${deg.toFixed(1)} deg between `
            + `${b.name} and the destination, so the port's axis is not the line ${b.name} `
            + "must aim at. Couple to that element instead, or pick it as the target.";
          break;
        }
      }
      prevDir = next.dir;
      const hitObj = scene.objects.find((o) => o.id === next.hitObjectId);
      if (hitObj) path.push(hitObj);
      destinationId = next.hitObjectId;
      cursor = next.hitObjectId;
    }

    // Everything the beam already passed through on its way to A. Those are
    // not candidate destinations — you cannot couple forwards into an optic
    // the light has behind it — so they are dropped from the picker rather
    // than left to clutter it.
    const upstreamIds = new Set<string>();
    {
      let back: string | undefined = a.objectId;
      for (let guard = 0; guard < 64 && back; guard += 1) {
        const seg: LabSeg | undefined = trace.find((x) => x.hitObjectId === back);
        if (!seg || !seg.sourceObjectId || upstreamIds.has(seg.sourceObjectId)) break;
        upstreamIds.add(seg.sourceObjectId);
        back = seg.sourceObjectId;
      }
    }

    // Target ports: every "light goes in here" anchor downstream, nearest to
    // mirror B first, with the traced destination promoted to the top.
    const targetOptions: TargetOption[] = [];
    for (const obj of scene.objects) {
      if (obj.id === a.objectId || obj.id === b.objectId) continue;
      if (upstreamIds.has(obj.id)) continue;
      const comp = componentOf(obj);
      if (!comp) continue;
      let anchors: AnchorPoseLab[];
      try {
        anchors = resolveAnchorPosesLab(comp, obj, scene);
      } catch {
        continue;
      }
      for (const an of anchors) {
        if (!TARGET_ANCHOR_IDS.includes(an.anchorId) || !an.axisXLab) continue;
        targetOptions.push({
          key: `${obj.id}|${an.anchorId}`,
          label:
            `${obj.name} · ${an.anchorId}`
            + (obj.id === destinationId ? " — traced destination" : ""),
          objectId: obj.id,
          anchorId: an.anchorId,
          anchorName: an.anchorName,
          ray: {
            origin: an.posLab,
            // axisX on an entry face is the OUTWARD normal, so light travels
            // into the port along -axisX.
            dir: { x: -an.axisXLab.x, y: -an.axisXLab.y, z: -an.axisXLab.z },
          },
          distanceMm: len(sub(an.posLab, b.faceLab)),
        });
      }
    }
    targetOptions.sort((x, y) => {
      const xd = x.objectId === destinationId ? -1 : 0;
      const yd = y.objectId === destinationId ? -1 : 0;
      return xd - yd || x.distanceMm - y.distanceMm;
    });
    if (targetOptions.length === 0) {
      return { kind: "hint", message: "No destination port (intercept_in / fiber_in) in the scene." };
    }
    const target = targetOptions.find((t) => t.key === targetKeyPick) ?? targetOptions[0];

    // Everything between B and the chosen destination is a pass-through.
    // `findIndex` returning -1 (the chosen target is not on the traced path,
    // e.g. the user overrode it) yields an empty span, which is right: we
    // know nothing about what sits in front of a port the beam never reached.
    const between: PassThroughItem[] = [];
    const destIndex = path.findIndex((o) => o.id === target.objectId);
    const spanObjects = destIndex < 0 ? [] : path.slice(0, destIndex);
    for (const obj of spanObjects) {
      const comp = componentOf(obj);
      if (!comp) continue;
      const anchors = resolveAnchorPosesLab(comp, obj, scene);
      const entry = anchors.find((an) => an.anchorId === "intercept_in") ?? anchors[0];
      const off = entry
        ? (() => {
            const rel = sub(entry.posLab, target.ray.origin);
            const along = dot(rel, target.ray.dir);
            return len(sub(rel, {
              x: target.ray.dir.x * along,
              y: target.ray.dir.y * along,
              z: target.ray.dir.z * along,
            }));
          })()
        : null;
      between.push({
        object: obj,
        component: comp,
        focusing: FOCUSING_KINDS.has(comp.kindId ?? ""),
        missMm: off,
      });
    }

    return {
      kind: "ready",
      a,
      b,
      seedCandidates: seedCandidates.map(({ key, label, ray }) => ({ key, label, ray })),
      seedKey: seed.key,
      inRay: seed.ray,
      targetOptions,
      targetKey: target.key,
      target,
      passThrough: between,
      spanBlocker,
    };
  }, [scene, selectedObjectIds, seedKeyPick, targetKeyPick, traceNonce]);

  const ready = resolution.kind === "ready" ? resolution : null;

  // ── the solve ────────────────────────────────────────────────────────────
  //
  // One compute-only call answers the touch matrix, the plan and the
  // pass-through poses. The request is keyed on everything it contains, so a
  // re-render that changed nothing does not re-solve; a sequence number keeps
  // a slow answer from landing on top of a newer one.
  const [solve, setSolve] = useState<SolveState>({
    result: null, error: null, solving: false,
  });
  const solveSeqRef = useRef(0);
  // Every optic in the span is offered; the solver skips the locked ones and
  // says so in `passThroughSkipped`, which is the same decision the list above
  // renders as "locked, will not move".
  const passThroughIds = useMemo(
    () => (ready && recentre ? ready.passThrough.map((p) => p.object.id) : []),
    [ready, recentre],
  );
  const request = useMemo(() => {
    if (!ready) return null;
    const fold = foldDraft.trim() === "" ? null : Number(foldDraft);
    return {
      mirrorAId: ready.a.objectId,
      mirrorBId: ready.b.objectId,
      inRay: ready.inRay,
      target: {
        objectId: ready.target.objectId,
        anchorId: ready.target.anchorId,
        anchorName: ready.target.anchorName,
      },
      foldMm: Number.isFinite(fold as number) ? (fold as number) : null,
      passThroughObjectIds: passThroughIds,
    };
  }, [ready, foldDraft, passThroughIds]);
  const requestKey = request ? JSON.stringify(request) : null;

  const hasResultRef = useRef(false);
  useEffect(() => {
    if (!visible || !requestKey || !request) {
      hasResultRef.current = false;
      solveSeqRef.current += 1;
      setSolve({ result: null, error: null, solving: false });
      return;
    }
    const seq = (solveSeqRef.current += 1);
    setSolve((prev) => ({ ...prev, solving: true }));
    // The FIRST solve fires immediately. Only refreshes wait, so a scene that
    // keeps changing can delay an update but can never starve the panel of
    // its first answer by resetting the timer forever.
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await alignMirrorCouplingApi(request);
          if (solveSeqRef.current !== seq) return;
          hasResultRef.current = true;
          setSolve({ result, error: null, solving: false });
        } catch (err) {
          if (solveSeqRef.current !== seq) return;
          setSolve({ result: null, error: (err as Error).message, solving: false });
        }
      })();
    }, hasResultRef.current ? SOLVE_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(handle);
    // `requestKey` is the full request by value; `request` is only read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, requestKey]);

  const result = solve.result;
  const touch: MirrorTouchMatrix | null = result?.touch ?? null;
  const goodPlan = result?.plan ?? null;

  // Draw the reverse reference ray in the viewer while the panel is open:
  // destination port -> mirror B -> mirror A -> a stub beyond, using the
  // mirrors' CURRENT poses. It is the thing the touch table measures, so
  // seeing it next to the real beam is what tells the user whether "rough it
  // in by hand first" means nudge or shove.
  useEffect(() => {
    if (!visible || !result) {
      setMirrorCouplingGhost(null);
      return;
    }
    const reverse: AlignRay = {
      origin: result.targetRay.origin,
      dir: {
        x: -result.targetRay.dir.x,
        y: -result.targetRay.dir.y,
        z: -result.targetRay.dir.z,
      },
    };
    const pts: [number, number, number][] = [
      [reverse.origin.x, reverse.origin.y, reverse.origin.z],
    ];
    const hitB = result.touch.targetOnB;
    if (hitB && hitB.tMm > 0) {
      pts.push([hitB.pointLab.x, hitB.pointLab.y, hitB.pointLab.z]);
      const hitA = result.touch.targetOnA;
      if (hitA && hitA.tMm > 0) {
        pts.push([hitA.pointLab.x, hitA.pointLab.y, hitA.pointLab.z]);
        // A stub past mirror A so the ray reads as continuing upstream.
        const d = reflect(
          reflect(reverse.dir, result.mirrorB.normalLab),
          result.mirrorA.normalLab,
        );
        pts.push([
          hitA.pointLab.x + d.x * 60,
          hitA.pointLab.y + d.y * 60,
          hitA.pointLab.z + d.z * 60,
        ]);
      }
    } else {
      // Never reaches B: draw a fixed stub so the user can see WHERE it goes.
      pts.push([
        reverse.origin.x + reverse.dir.x * 250,
        reverse.origin.y + reverse.dir.y * 250,
        reverse.origin.z + reverse.dir.z * 250,
      ]);
    }
    setMirrorCouplingGhost({ pointsLabMm: pts });
  }, [visible, result, setMirrorCouplingGhost]);

  useEffect(() => () => setMirrorCouplingGhost(null), [setMirrorCouplingGhost]);

  const allMoves = useMemo(() => {
    if (!result || !goodPlan) return [];
    return [
      { objectId: goodPlan.moveA.objectId, name: goodPlan.moveA.name, pose: goodPlan.moveA.pose },
      { objectId: goodPlan.moveB.objectId, name: goodPlan.moveB.name, pose: goodPlan.moveB.pose },
      ...result.passThroughMoves,
    ];
  }, [result, goodPlan]);

  const blocked =
    !!ready?.spanBlocker || solve.solving || !!solve.error || !touch?.ok || !goodPlan;
  const lockedNames = ready ? [ready.a, ready.b].filter((m) => m.locked).map((m) => m.name) : [];

  const togglePreview = () => {
    if (previewing) {
      clearPreview();
      return;
    }
    for (const m of allMoves) previewObjectTransform(m.objectId, m.pose);
    previewedIdsRef.current = allMoves.map((m) => m.objectId);
    setPreviewing(true);
  };

  const apply = async () => {
    if (allMoves.length === 0) return;
    setBusy(true);
    setFeedback(null);
    try {
      clearPreview();
      // ONE commit / ONE undo entry for the whole coupling — the pair and
      // the pass-through optics move together or not at all.
      await updateSceneObjects(
        allMoves.map((m) => ({
          objectId: m.objectId,
          patch: {
            ...m.pose,
            properties: {
              ...((scene.objects.find((o) => o.id === m.objectId)?.properties ?? {}) as Record<
                string,
                unknown
              >),
              placedRelativeTo: {
                kind: "mirror_couple",
                refObjectId: ready?.target.objectId,
                refAnchorId: ready?.target.anchorId,
                recordedAt: new Date().toISOString(),
              },
            } as SceneObject["properties"],
          },
        })),
      );
      setFeedback(
        `Coupled into ${ready?.target.label}. `
        + `${allMoves.length} object${allMoves.length === 1 ? "" : "s"} moved in one step (undo restores all).`,
      );
    } catch (err) {
      setFeedback(`Apply failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <FloatingPanel
      id="mirror-coupling"
      title="Mirror coupling"
      icon={<Crosshair size={15} />}
      badge={ready ? `${ready.a.name} → ${ready.b.name}` : undefined}
    >
      <div className="mirror-coupling-body">
        {resolution.kind === "hint" && (
          <p className="mirror-coupling-hint">{resolution.message}</p>
        )}

        {ready && (
          <>
            <label className="mirror-coupling-row">
              <span>Seed beam</span>
              <select
                value={ready.seedKey}
                disabled={ready.seedCandidates.length < 2}
                onChange={(e) => setSeedKeyPick(e.target.value)}
              >
                {ready.seedCandidates.map((c) => (
                  <option key={c.key} value={c.key}>
                    from {c.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="mirror-coupling-row">
              <span>Target port</span>
              <select value={ready.targetKey} onChange={(e) => setTargetKeyPick(e.target.value)}>
                {ready.targetOptions.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label} ({t.distanceMm.toFixed(0)} mm)
                  </option>
                ))}
              </select>
            </label>

            {touch && <TouchTable touch={touch} aName={ready.a.name} bName={ready.b.name} />}
            {!touch && !solve.error && (
              <p className="mirror-coupling-hint">Solving…</p>
            )}

            {solve.error && <p className="mirror-coupling-error">{solve.error}</p>}

            {ready.spanBlocker && (
              <p className="mirror-coupling-error">{ready.spanBlocker}</p>
            )}
            {touch && !touch.ok && !ready.spanBlocker && (
              <div className="mirror-coupling-error">
                <strong>Both beams must touch both mirrors before this can solve.</strong>
                <ul>
                  {touch.failures.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
            )}

            {result?.error && (
              <p className="mirror-coupling-error">{result.error}</p>
            )}

            {goodPlan && goodPlan.geometry.freeDof && (
              <div className="mirror-coupling-dof">
                <label>
                  <span>Fold position along the seed (mm)</span>
                  <input
                    type="number"
                    step={1}
                    placeholder={goodPlan.geometry.foldMm.toFixed(2)}
                    value={foldDraft}
                    onChange={(e) => {
                      setFoldDraft(e.target.value);
                      if (previewing) clearPreview();
                    }}
                  />
                </label>
                <p className="mirror-coupling-hint">
                  The seed and the target axis are collinear, so the pair can slide
                  along the seed without breaking either 45°. Blank = least total
                  travel ({goodPlan.geometry.foldMm.toFixed(2)} mm).
                </p>
              </div>
            )}

            {goodPlan && touch && (
              <table className="mirror-coupling-readout">
                <tbody>
                  <tr>
                    <th>Spot decentre</th>
                    <td>
                      {fmt(goodPlan.beforeDecentreAMm)} / {fmt(goodPlan.beforeDecentreBMm)} mm
                    </td>
                    <td className="mc-after">→ 0.00 / 0.00 mm</td>
                  </tr>
                  <tr>
                    <th>Angle of incidence</th>
                    <td>
                      {fmt(touch.seedOnA?.aoiDeg)} / {fmt(touch.seedOnB?.aoiDeg)}°
                    </td>
                    <td className="mc-after">→ 45.00 / 45.00°</td>
                  </tr>
                  <tr>
                    <th>Target axis miss</th>
                    <td>{fmt(goodPlan.beforeTargetMissMm)} mm</td>
                    <td className="mc-after">→ 0.00 mm</td>
                  </tr>
                  <tr>
                    <th>{ready.a.name} move</th>
                    <td colSpan={2}>
                      {fmt(goodPlan.moveA.travelMm)} mm, rotate {fmt(goodPlan.moveA.rotationDeg)}°
                    </td>
                  </tr>
                  <tr>
                    <th>{ready.b.name} move</th>
                    <td colSpan={2}>
                      {fmt(goodPlan.moveB.travelMm)} mm, rotate {fmt(goodPlan.moveB.rotationDeg)}°
                    </td>
                  </tr>
                  <tr>
                    <th>Leg {ready.a.name}→{ready.b.name}</th>
                    <td colSpan={2}>{fmt(goodPlan.geometry.legLengthMm)} mm</td>
                  </tr>
                </tbody>
              </table>
            )}

            {ready.passThrough.length > 0 && (
              <div className="mirror-coupling-passthrough">
                <label className="mirror-coupling-check">
                  <input
                    type="checkbox"
                    checked={recentre}
                    onChange={(e) => {
                      setRecentre(e.target.checked);
                      if (previewing) clearPreview();
                    }}
                  />
                  <span>Also centre pass-through optics on the new axis</span>
                </label>
                <ul>
                  {ready.passThrough.map((p) => (
                    <li key={p.object.id}>
                      {p.object.name}
                      {p.object.locked && <em> — locked, will not move</em>}
                      {!p.object.locked && (
                        <>
                          {" "}
                          {fmt(p.missMm)} mm → {recentre ? "0.00 mm" : "unchanged"}
                        </>
                      )}
                      {p.focusing && <strong> · focusing: leaving it off-axis will steer the beam</strong>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {goodPlan && goodPlan.geometry.warnings.length > 0 && (
              <ul className="mirror-coupling-warn">
                {goodPlan.geometry.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {lockedNames.length > 0 && (
              <p className="mirror-coupling-warn">
                {lockedNames.join(" and ")} {lockedNames.length === 1 ? "is" : "are"} locked —
                unlock in the Object panel before applying.
              </p>
            )}
            <p className="mirror-coupling-hint">
              Mounts and posts follow a mirror only when they share a rigid group with
              it; anything outside one stays where it is. Check them after applying.
            </p>

            <div className="mirror-coupling-buttons">
              <button
                type="button"
                className="secondary-button"
                onClick={togglePreview}
                disabled={blocked || busy || allMoves.length === 0}
              >
                {previewing ? <><X size={14} /> Clear preview</> : <><RotateCcw size={14} /> Preview</>}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void apply()}
                disabled={blocked || busy || lockedNames.length > 0}
                title="Move both mirrors (and any ticked pass-through optics) in a single undoable step."
              >
                <Check size={14} /> {busy ? "Applying…" : solve.solving ? "Solving…" : "Apply"}
              </button>
            </div>
          </>
        )}

        {feedback && <p className="mirror-coupling-feedback">{feedback}</p>}
      </div>
    </FloatingPanel>
  );
}

/**
 * Entry point in the Object panel: appears only when the selection is exactly
 * two steering mirrors, and just opens the panel — the panel itself reads the
 * same selection, so there is nothing to hand over.
 */
export function MirrorCouplingLauncher() {
  const scene = useSceneStore((s) => s.scene);
  const selectedObjectIds = useSceneStore((s) => s.selectedObjectIds);
  const { togglePanelVisible, focusPanel } = useWorkspace();

  const pair = useMemo(() => {
    if (selectedObjectIds.length !== 2) return null;
    const objs = selectedObjectIds
      .map((id) => scene.objects.find((o) => o.id === id))
      .filter((o): o is SceneObject => !!o);
    if (objs.length !== 2) return null;
    const kinds = objs.map(
      (o) => scene.components.find((c) => c.id === o.componentId)?.kindId ?? "",
    );
    return kinds.every((k) => STEERING_KINDS.has(k)) ? objs : null;
  }, [scene.objects, scene.components, selectedObjectIds]);

  if (!pair) return null;
  return (
    <section className="edit-section">
      <h3>
        <Crosshair size={17} />
        Mirror coupling
      </h3>
      <button
        type="button"
        className="primary-button"
        title={
          `Solve ${pair[0].name} and ${pair[1].name} so the beam hits both at 45°, `
          + "centred, and lands on a destination port's axis."
        }
        onClick={() => {
          togglePanelVisible("mirror-coupling", true);
          focusPanel("mirror-coupling");
        }}
      >
        Couple with these two mirrors…
      </button>
    </section>
  );
}

function TouchTable({
  touch,
  aName,
  bName,
}: {
  touch: MirrorTouchMatrix;
  aName: string;
  bName: string;
}) {
  const cell = (hit: MirrorSpotHit | null) => {
    if (!hit) return <td className="mc-bad">—</td>;
    const ok = hit.tMm > 0 && hit.inAperture;
    return (
      <td className={ok ? "mc-ok" : "mc-bad"}>
        {ok ? "✓" : "✗"} {hit.decentreMm.toFixed(2)} mm
      </td>
    );
  };
  return (
    <table className="mirror-coupling-touch">
      <thead>
        <tr>
          <th />
          <th>{aName}</th>
          <th>{bName}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th>Seed beam</th>
          {cell(touch.seedOnA)}
          {cell(touch.seedOnB)}
        </tr>
        <tr>
          <th>Reverse ref.</th>
          {cell(touch.targetOnA)}
          {cell(touch.targetOnB)}
        </tr>
      </tbody>
    </table>
  );
}
