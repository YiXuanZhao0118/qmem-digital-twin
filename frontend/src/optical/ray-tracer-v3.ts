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
 * Scope: SINGLE-ASSET tracing in asset body-local frame. This is the
 * face/transition engine exercised by the FE↔BE parity harness; scene-
 * level dispatch (object poses, lab↔body transforms) lives in the backend
 * solver (db_scene_loader + ray_tracer_v3), not here.
 *
 * Frame assumption:
 *   - BeamRay.direction is in the asset's body-local frame
 *   - Asset3D faces are in their natural body-local frame
 *   - No coordinate transforms are performed by the tracer (the op sees
 *     the ray directly)
 */

import {
  type BeamRay,
  type Vec3,
  vec3Add,
  vec3Dot,
  vec3Scale,
  vec3Sub,
} from "./beam-ray";
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
