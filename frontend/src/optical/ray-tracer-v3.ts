/**
 * Ray Tracer v3 — face-based dispatch (Phase 3a skeleton).
 *
 * Replaces the kindString-switch ray tracer with a generic face/transition
 * loop. Per asset-physics-model.md §7:
 *
 *   loop until ray escapes / absorbed / power < threshold:
 *     1. find nearest face hit across all scene objects
 *     2. for each matching transition (in == faceHit):
 *        - merge params (asset.defaultParams + paramOverrides + transition.params)
 *        - call op(ray, ctx) → out_rays
 *     3. push out_rays to queue
 *
 * Phase 3a scope: SINGLE-ASSET tracing in asset body-local frame. Full
 * scene-level dispatch (multi-object, multi-binding, lab↔body transforms)
 * comes in Phase 3b once the body-local case is verified to mirror v2.
 *
 * Frame assumption (Phase 3a):
 *   - BeamRay.direction is in the asset's body-local frame
 *   - Asset3D faces are in their natural body-local frame
 *   - No coordinate transforms are performed by the tracer (the op sees
 *     the ray directly)
 */

import {
  type BeamRay,
  type Vec3,
  makeBeamRay,
  vec3Add,
  vec3Dot,
  vec3Scale,
  vec3Sub,
} from "./beam-ray";
import { jonesBodyToLab, jonesLabToBody } from "./jones";
import { calculateProfileClipping } from "./profileUtils";
import {
  type V3Pose,
  type V3Transform,
  composeTransforms,
  dirBodyToLab,
  dirBodyToLabT,
  dirLabToBody,
  dirLabToBodyT,
  identityTransform,
  pointBodyToLab,
  pointBodyToLabT,
  pointLabToBody,
  pointLabToBodyT,
  poseToTransform,
} from "./pose";
import {
  type Face,
  type PhysicsOp,
  type PhysicsOpContext,
  getOp,
} from "./registry";

// ---------------------------------------------------------------------------
// Asset3D (minimal subset for the tracer)
// ---------------------------------------------------------------------------

export type V3TransitionDescriptor = {
  in: string;
  /** Internal face chain (see asset-physics-model.md §3.3). Empty/undefined
   *  = 2-port slab; non-empty = multi-hop reflective element. */
  via?: string[] | null;
  out: string | string[];
  op: string;
  params?: Record<string, unknown> | null;
  matrix5x5?: number[][] | null;
  abcd?: number[][] | null;
};

export type V3AssetSnapshot = {
  catalogId: string;
  kind: string;
  faces: Face[];
  transitions: V3TransitionDescriptor[];
  defaultParams: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Face hit detection
// ---------------------------------------------------------------------------

export type FaceHit = {
  face: Face;
  t: number;                  // ray-parameter at hit (along ray.direction)
  point: Vec3;                // hit position in same frame as ray
  offsetFromCenterMm: number; // chief-ray distance from the face centre, in
                              // the face plane — feeds aperture clipping
};

/** Ray-plane intersection. Returns null if the ray is parallel to the
 *  face, hits behind the origin (t < epsilon), or lands outside aperture.
 *
 *  Face normal points outward (away from material). For Phase 3a we accept
 *  hits from EITHER side — the op decides what to do based on transition. */
export function intersectFace(
  ray: { origin: Vec3; direction: Vec3 },
  face: Face,
  options: { tMin?: number; excludeFaceId?: string } = {},
): FaceHit | null {
  if (options.excludeFaceId === face.id) return null;
  const tMin = options.tMin ?? 1e-9;

  const n = face.normalBodyLocal ?? { x: 0, y: 0, z: 1 };
  const denom = vec3Dot(ray.direction, n);
  if (Math.abs(denom) < 1e-12) return null;        // parallel — no hit

  // Plane: (p - face.position) · n = 0
  const diff = vec3Sub(face.positionMmBodyLocal, ray.origin);
  const t = vec3Dot(diff, n) / denom;
  if (t < tMin) return null;                       // behind ray origin

  const hit = vec3Add(ray.origin, vec3Scale(ray.direction, t));

  // Aperture check: distance from face center, in the plane perpendicular
  // to the face normal. For Phase 3a we use the inscribed-radius `apertureMm`
  // — i.e. distance from center must be ≤ apertureMm (good for circle /
  // rectangular bbox proxy).
  const offset = vec3Sub(hit, face.positionMmBodyLocal);
  // Project off-normal: offset_perp = offset - (offset·n)·n
  const offDot = vec3Dot(offset, n);
  const offPerp = vec3Sub(offset, vec3Scale(n, offDot));
  const r = Math.sqrt(vec3Dot(offPerp, offPerp));
  if (r > face.apertureMm + 1e-9) return null;

  return { face, t, point: hit, offsetFromCenterMm: r };
}

/** Find the nearest face hit across an asset's faces, optionally excluding
 *  the face we just exited (so we don't immediately re-hit it). */
export function nearestFaceHit(
  ray: BeamRay,
  asset: V3AssetSnapshot,
  excludeFaceId?: string,
): FaceHit | null {
  let best: FaceHit | null = null;
  for (const face of asset.faces) {
    const hit = intersectFace(ray, face, { excludeFaceId });
    if (hit && (!best || hit.t < best.t)) {
      best = hit;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Transition dispatch
// ---------------------------------------------------------------------------

/** Build the PhysicsOpContext from asset data + the hit face + the
 *  transition out face. Looks up faceOut by id. */
function buildContext(
  asset: V3AssetSnapshot,
  transition: V3TransitionDescriptor,
  faceIn: Face,
): PhysicsOpContext[] {
  const outIds = Array.isArray(transition.out) ? transition.out : [transition.out];
  const merged = { ...asset.defaultParams, ...(transition.params ?? {}) };
  const viaFaces: Face[] = (transition.via ?? []).map((viaId) => {
    const f = asset.faces.find((face) => face.id === viaId);
    if (!f) {
      throw new Error(
        `transition references unknown via face id "${viaId}" on asset "${asset.catalogId}"`,
      );
    }
    return f;
  });
  return outIds.map((outId) => {
    const faceOut = asset.faces.find((f) => f.id === outId);
    if (!faceOut) {
      throw new Error(
        `transition references unknown face id "${outId}" on asset "${asset.catalogId}"`,
      );
    }
    return {
      faceIn,
      faceOut,
      params: merged,
      faceVia: viaFaces,
      transferMatrix: transition.matrix5x5
        ? { kind: "matrix5x5", M: transition.matrix5x5.flat() }
        : transition.abcd
        ? { kind: "abcd", M: transition.abcd as [[number, number], [number, number]] }
        : undefined,
    };
  });
}

/** Find all transitions that match the hit face id. Each match may
 *  contribute multiple ctx records (one per face_out in `out` array). */
function findTransitionContexts(
  asset: V3AssetSnapshot,
  faceIn: Face,
): Array<{ op: string; ctx: PhysicsOpContext }> {
  const matches: Array<{ op: string; ctx: PhysicsOpContext }> = [];
  for (const t of asset.transitions) {
    if (t.in !== faceIn.id) continue;
    for (const ctx of buildContext(asset, t, faceIn)) {
      matches.push({ op: t.op, ctx });
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Trace loop (single-asset, Phase 3a)
// ---------------------------------------------------------------------------

export type TraceOptions = {
  maxSteps?: number;          // default 32 — guard against infinite loops
  powerThresholdMw?: number;  // default 1e-9 — drop rays below
};

export type TraceStep = {
  asset: V3AssetSnapshot;
  faceIn: Face;
  rayIn: BeamRay;
  outRays: BeamRay[];
  op: string;
};

export type TraceResult = {
  finalRays: BeamRay[];       // rays that escaped / hit nothing further
  steps: TraceStep[];         // per-hit log (for debugging / visualization)
  terminated: "escaped" | "max_steps" | "power_threshold";
};

/** Trace a single ray through a single asset. Multi-asset scene-level
 *  tracing comes in Phase 3b. */
export function traceRayThroughAsset(
  initialRay: BeamRay,
  asset: V3AssetSnapshot,
  options: TraceOptions = {},
): TraceResult {
  const maxSteps = options.maxSteps ?? 32;
  const powerThreshold = options.powerThresholdMw ?? 1e-9;

  const finalRays: BeamRay[] = [];
  const steps: TraceStep[] = [];
  const queue: BeamRay[] = [initialRay];
  let totalSteps = 0;
  let terminated: TraceResult["terminated"] = "escaped";

  while (queue.length > 0) {
    if (totalSteps >= maxSteps) {
      terminated = "max_steps";
      finalRays.push(...queue);
      break;
    }
    const ray = queue.shift()!;
    if (ray.powerMw < powerThreshold) {
      terminated = "power_threshold";
      continue;
    }

    const hit = nearestFaceHit(ray, asset, ray.excludeFaceKey);
    if (!hit) {
      // Ray escapes the asset
      finalRays.push(ray);
      continue;
    }

    const matches = findTransitionContexts(asset, hit.face);
    if (matches.length === 0) {
      // Face hit but no transition declared — treat as absorbing edge.
      // Stop the ray here.
      finalRays.push({ ...ray, powerMw: 0 });
      continue;
    }

    // Move ray origin to hit point before invoking op.
    // Free-space q propagation: q' = q + L (where L is the path length).
    // This is the [[1, L], [0, 1]] free-space ABCD applied to the q parameter.
    const rayAtFace: BeamRay = {
      ...ray,
      origin: hit.point,
      qx: { re: ray.qx.re + hit.t, im: ray.qx.im },
      qy: { re: ray.qy.re + hit.t, im: ray.qy.im },
      pathLengthMm: ray.pathLengthMm + hit.t,
    };

    let stepOutRays: BeamRay[] = [];
    for (const { op: opName, ctx } of matches) {
      const op: PhysicsOp = getOp(asset.kind as never, opName);
      const out = op(rayAtFace, ctx);
      for (const outRay of out) {
        // Mark the exit face so we don't immediately re-hit it.
        const outFaceId = ctx.faceOut.id;
        const tagged = { ...outRay, excludeFaceKey: outFaceId };
        stepOutRays.push(outRay);
        // Absorbed rays (power below threshold) go straight to finalRays so
        // the caller can see WHERE the ray died, not just that it vanished.
        if (tagged.powerMw < powerThreshold) {
          finalRays.push(tagged);
        } else {
          queue.push(tagged);
        }
      }
    }

    steps.push({
      asset,
      faceIn: hit.face,
      rayIn: rayAtFace,
      outRays: stepOutRays,
      op: matches[0]!.op,
    });
    totalSteps += 1;
  }

  return { finalRays, steps, terminated };
}

// ---------------------------------------------------------------------------
// Scene-level tracer (Phase 3b)
// ---------------------------------------------------------------------------

/** One ComponentBinding in a Component (Phase 3c). Each binding wraps
 *  an Asset3D with a component-local pose (relative to the parent
 *  Component's origin). */
export type V3ComponentBinding = {
  bindingId: string;
  asset: V3AssetSnapshot;
  localPose: V3Pose;
};

/** A Component snapshot — pure spatial composition of bindings. Has no
 *  kind / physics of its own; physics lives on the bound Asset3Ds. */
export type V3ComponentSnapshot = {
  catalogId: string;
  bindings: V3ComponentBinding[];
};

/** A SceneObject in v3. Phase 3b form (single asset) and Phase 3c form
 *  (component with bindings) are both supported — set exactly ONE of
 *  `asset` or `component`. */
export type V3SceneObject = {
  id: string;                       // unique scene-object id
  asset?: V3AssetSnapshot;          // Phase 3b single-asset
  component?: V3ComponentSnapshot;  // Phase 3c component with bindings
  pose: V3Pose;                     // lab-frame placement
  dynamicSources?: Record<string, unknown>;
};

export type V3Scene = {
  objects: V3SceneObject[];
};

/** Internal: flattened (scene-object × binding) pair with precomputed
 *  effective transform. The scene tracer iterates these per ray step. */
type V3BindingSlot = {
  sceneObjectId: string;
  bindingId: string;                // "" for single-asset scene objects
  asset: V3AssetSnapshot;
  effectiveTransform: V3Transform;  // lab ↔ asset-body
  dynamicSources?: Record<string, unknown>;
};

/** Pre-flatten a scene into slots ready for per-ray hit testing. */
export function flattenScene(scene: V3Scene): V3BindingSlot[] {
  const slots: V3BindingSlot[] = [];
  for (const so of scene.objects) {
    const tSo = poseToTransform(so.pose);
    if (so.asset) {
      slots.push({
        sceneObjectId: so.id,
        bindingId: "",
        asset: so.asset,
        effectiveTransform: tSo,
        dynamicSources: so.dynamicSources,
      });
    }
    if (so.component) {
      for (const b of so.component.bindings) {
        const tBinding = poseToTransform(b.localPose);
        slots.push({
          sceneObjectId: so.id,
          bindingId: b.bindingId,
          asset: b.asset,
          effectiveTransform: composeTransforms(tSo, tBinding),
          dynamicSources: so.dynamicSources,
        });
      }
    }
  }
  return slots;
}

/** Internal: per-slot hit record, normalised to lab-frame distance. */
type SceneHit = {
  slot: V3BindingSlot;
  face: Face;
  /** ray parameter t such that lab_hit = ray.origin + t * ray.direction.
   *  Since pose is a rigid transform (rotation + translation), the body-
   *  frame t equals the lab-frame t for a unit-direction ray. */
  tLab: number;
  /** Hit point in body-local frame (op consumes this). */
  hitBody: Vec3;
  /** Chief-ray distance from the face centre (face plane) — aperture clip. */
  offsetFromCenterMm: number;
};

/** Find the nearest face hit across all flattened (scene × binding)
 *  slots. */
function nearestSceneHit(
  rayLab: BeamRay,
  slots: V3BindingSlot[],
): SceneHit | null {
  let best: SceneHit | null = null;
  for (const slot of slots) {
    const originBody = pointLabToBodyT(rayLab.origin, slot.effectiveTransform);
    const dirBody = dirLabToBodyT(rayLab.direction, slot.effectiveTransform);
    const rayBody = { origin: originBody, direction: dirBody };

    // Decode the slot-scoped excludeFaceKey: keys are formatted
    // "<sceneObjectId>/<bindingId>/<faceId>" so a face exclusion only
    // applies to the binding we just exited.
    const excludeFaceId = decodeExcludeForSlot(
      rayLab.excludeFaceKey, slot.sceneObjectId, slot.bindingId,
    );

    for (const face of slot.asset.faces) {
      const hit = intersectFace(rayBody, face, { excludeFaceId });
      if (!hit) continue;
      if (best === null || hit.t < best.tLab) {
        best = { slot, face, tLab: hit.t, hitBody: hit.point, offsetFromCenterMm: hit.offsetFromCenterMm };
      }
    }
  }
  return best;
}

function encodeExcludeSlot(
  sceneObjectId: string, bindingId: string, faceId: string,
): string {
  return `${sceneObjectId}/${bindingId}/${faceId}`;
}

function decodeExcludeForSlot(
  key: string | undefined,
  sceneObjectId: string,
  bindingId: string,
): string | undefined {
  if (!key) return undefined;
  const prefix = `${sceneObjectId}/${bindingId}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}

function sourceDummyRay(ctx: PhysicsOpContext): BeamRay {
  const dynamicWavelength = ctx.dynamic?.centerWavelengthNm;
  const paramWavelength = ctx.params.centerWavelengthNm;
  const wavelengthNm =
    (typeof dynamicWavelength === "number" ? dynamicWavelength : undefined)
    ?? (typeof paramWavelength === "number" ? paramWavelength : undefined)
    ?? 780.241;
  return makeBeamRay({
    origin: ctx.faceIn.positionMmBodyLocal,
    direction: ctx.faceOut.normalBodyLocal ?? { x: 0, y: 0, z: 1 },
    wavelengthNm,
    powerMw: 0,
  });
}

/** Emit source rays from all laser_source scene objects. Source assets are
 * emitters, so they do not wait for an incoming ray to hit a face. */
export function emitSceneSourceRays(scene: V3Scene): BeamRay[] {
  const rays: BeamRay[] = [];
  for (const slot of flattenScene(scene)) {
    if (slot.asset.kind !== "laser_source") continue;
    for (const face of slot.asset.faces) {
      const matches = findTransitionContexts(slot.asset, face)
        .filter((m) => m.op === "emit_laser_source");
      for (const { op: opName, ctx } of matches) {
        const op: PhysicsOp = getOp(slot.asset.kind as never, opName);
        const ctxWithDynamic: PhysicsOpContext = slot.dynamicSources
          ? { ...ctx, dynamic: { ...(ctx.dynamic ?? {}), ...slot.dynamicSources } }
          : ctx;
        const emitted = op(sourceDummyRay(ctxWithDynamic), ctxWithDynamic);
        for (const rayBody of emitted) {
          const dirLab = dirBodyToLabT(rayBody.direction, slot.effectiveTransform);
          const jonesLab = jonesBodyToLab(
            rayBody.jones, rayBody.direction, dirLab,
            (v) => dirBodyToLabT(v, slot.effectiveTransform),
          );
          rays.push({
            ...rayBody,
            origin: pointBodyToLabT(rayBody.origin, slot.effectiveTransform),
            direction: dirLab,
            jones: jonesLab,
            excludeFaceKey: encodeExcludeSlot(slot.sceneObjectId, slot.bindingId, ctx.faceOut.id),
          });
        }
      }
    }
  }
  return rays;
}

/** Trace a single ray through a multi-asset scene in lab frame.
 *  Supports both single-asset SceneObjects (Phase 3b) and ComponentBinding
 *  trees (Phase 3c) — internally flattened to a uniform list of slots.
 *  Each step:
 *    1. Find nearest face hit across all (scene × binding) slots.
 *    2. Transform ray into the hit slot's body frame, run op.
 *    3. Transform out-rays back to lab, push to queue with
 *       excludeFaceKey scoped to (sceneObject/binding/face) so other
 *       assets remain hittable. */
export function traceRayScene(
  initialRay: BeamRay,
  scene: V3Scene,
  options: TraceOptions = {},
): TraceResult {
  const maxSteps = options.maxSteps ?? 32;
  const powerThreshold = options.powerThresholdMw ?? 1e-9;
  const slots = flattenScene(scene);

  const finalRays: BeamRay[] = [];
  const steps: TraceStep[] = [];
  const queue: BeamRay[] = [initialRay];
  let totalSteps = 0;
  let terminated: TraceResult["terminated"] = "escaped";

  while (queue.length > 0) {
    if (totalSteps >= maxSteps) {
      terminated = "max_steps";
      finalRays.push(...queue);
      break;
    }
    const ray = queue.shift()!;
    if (ray.powerMw < powerThreshold) {
      terminated = "power_threshold";
      continue;
    }

    const sceneHit = nearestSceneHit(ray, slots);
    if (!sceneHit) {
      finalRays.push(ray);
      continue;
    }

    const { slot, face: hitFace, tLab, hitBody } = sceneHit;

    // Build the ray in slot body frame at the hit point.
    // Free-space q propagation: q' = q + L (lab distance == body distance
    // under rigid transforms).
    // Jones basis: lab beam-local s/p → body beam-local s/p (Phase 4c).
    const dirBody = dirLabToBodyT(ray.direction, slot.effectiveTransform);
    const jonesBody = jonesLabToBody(
      ray.jones, ray.direction, dirBody,
      (v) => dirLabToBodyT(v, slot.effectiveTransform),
    );
    // Propagate the Gaussian q to the face, then apply aperture clipping:
    // a wide beam whose footprint overruns the clear aperture loses energy
    // (vignetting). Profile-aware (ray / top-hat / gaussian) and ≈1 for a
    // small beam well inside the aperture, so it's a no-op for the usual
    // chief-ray setups. See profileUtils.calculateProfileClipping.
    const qxAtFace = { re: ray.qx.re + tLab, im: ray.qx.im };
    const qyAtFace = { re: ray.qy.re + tLab, im: ray.qy.im };
    const apertureTransmission = calculateProfileClipping(
      sceneHit.offsetFromCenterMm,
      hitFace.apertureMm,
      ray.profile,
      qxAtFace,
      qyAtFace,
      ray.wavelengthNm,
    );
    const rayAtFaceBody: BeamRay = {
      ...ray,
      origin: hitBody,
      direction: dirBody,
      jones: jonesBody,
      qx: qxAtFace,
      qy: qyAtFace,
      powerMw: ray.powerMw * apertureTransmission,
      pathLengthMm: ray.pathLengthMm + tLab,
    };

    // Find matching transitions (reuse the single-asset helper).
    const matches = findTransitionContexts(slot.asset, hitFace);
    if (matches.length === 0) {
      finalRays.push({ ...ray, powerMw: 0 });
      continue;
    }

    const stepOutRays: BeamRay[] = [];
    for (const { op: opName, ctx } of matches) {
      const op: PhysicsOp = getOp(slot.asset.kind as never, opName);
      const ctxWithDynamic: PhysicsOpContext = slot.dynamicSources
        ? { ...ctx, dynamic: { ...(ctx.dynamic ?? {}), ...slot.dynamicSources } }
        : ctx;
      const out = op(rayAtFaceBody, ctxWithDynamic);
      for (const outRayBody of out) {
        // Transform output ray back to lab frame. The output direction
        // may differ from input (e.g. mirror reflection), so Jones must
        // be re-expressed in the post-op lab beam-local s/p frame.
        const outDirLab = dirBodyToLabT(outRayBody.direction, slot.effectiveTransform);
        const jonesLab = jonesBodyToLab(
          outRayBody.jones, outRayBody.direction, outDirLab,
          (v) => dirBodyToLabT(v, slot.effectiveTransform),
        );
        const outRayLab: BeamRay = {
          ...outRayBody,
          origin: pointBodyToLabT(outRayBody.origin, slot.effectiveTransform),
          direction: outDirLab,
          jones: jonesLab,
          excludeFaceKey: encodeExcludeSlot(
            slot.sceneObjectId, slot.bindingId, ctx.faceOut.id,
          ),
        };
        stepOutRays.push(outRayLab);
        if (outRayLab.powerMw < powerThreshold) {
          finalRays.push(outRayLab);
        } else {
          queue.push(outRayLab);
        }
      }
    }

    steps.push({
      asset: slot.asset,
      faceIn: hitFace,
      rayIn: rayAtFaceBody,
      outRays: stepOutRays,
      op: matches[0]!.op,
    });
    totalSteps += 1;
  }

  return { finalRays, steps, terminated };
}
