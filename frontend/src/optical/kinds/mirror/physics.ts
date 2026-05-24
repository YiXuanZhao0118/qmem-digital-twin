/**
 * Mirror PhysicsOp — specular reflection.
 *
 * Op name: `reflect_specular`
 * Kind:    `mirror`
 *
 * Behavior:
 *   - Direction reflects:  d' = d - 2 (d·n) n     (n = face normal, in same frame as d)
 *   - Power × reflectivity (default 1.0)
 *   - Jones basis rotates from old s/p frame into new (post-reflection) s/p frame
 *   - q-parameter unchanged (flat mirror, ideal)
 *   - Origin unchanged (ray stays at face position; next propagation step moves it)
 *
 * Required face: `faceIn.normalBodyLocal` (outward normal, pointing AWAY from
 * the reflective surface — incoming ray has d · n < 0).
 *
 * For Phase 1 the op assumes `faceIn.normalBodyLocal` is expressed in the
 * same frame as `rayIn.direction`. The ray tracer wraps the body↔lab
 * transform later.
 */

import {
  type BeamRay,
  type Vec3,
  vec3Dot,
  vec3Scale,
  vec3Sub,
} from "../../beam-ray";
import { rotateJonesIntoNewFrame } from "../../jones";
import {
  type PhysicsOp,
  type PhysicsOpContext,
  registerKind,
} from "../../registry";

export function reflectDirection(d: Vec3, n: Vec3): Vec3 {
  const dotDN = vec3Dot(d, n);
  return vec3Sub(d, vec3Scale(n, 2 * dotDN));
}

export const reflectSpecularOp: PhysicsOp = (
  rayIn: BeamRay,
  ctx: PhysicsOpContext,
): BeamRay[] => {
  const n = ctx.faceIn.normalBodyLocal;
  if (!n) {
    throw new Error("reflect_specular: faceIn.normalBodyLocal is required");
  }

  const dNew = reflectDirection(rayIn.direction, n);
  const reflectivity = (ctx.params.reflectivity as number | undefined) ?? 1.0;
  const newJones = rotateJonesIntoNewFrame(rayIn.jones, rayIn.direction, dNew);

  return [{
    ...rayIn,
    direction: dNew,
    jones: newJones,
    powerMw: rayIn.powerMw * reflectivity,
    // origin, qx, qy, wavelength, pathLengthMm: unchanged at the reflection point
  }];
};

registerKind("mirror", {
  ops: {
    reflect_specular: reflectSpecularOp,
  },
  needsAperture: true,
});
