/**
 * Reflection / refraction helpers shared by reflect_specular,
 * glan_reject_s, pbs_reflect_s, dichroic_reflect, etc.
 *
 * All helpers operate on unit vectors in body frame. See
 * asset-physics-model.md §3.3 for face normal conventions.
 */

import type { Vec3 } from "./beam-ray";

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

/** Mirror reflection: d_out = d_in − 2(d_in · n̂) n̂. */
export function reflect(dIn: Vec3, n: Vec3): Vec3 {
  const dot_dn = dot(dIn, n);
  return {
    x: dIn.x - 2 * dot_dn * n.x,
    y: dIn.y - 2 * dot_dn * n.y,
    z: dIn.z - 2 * dot_dn * n.z,
  };
}

/**
 * Snell refraction across a planar interface.
 *
 * `nFace` is the face outward normal pointing back toward the incoming
 * medium. Sign-tolerant — flips automatically if caller passed inward
 * normal. Throws on total internal reflection (use `reflect` instead).
 */
export function refract(dIn: Vec3, nFace: Vec3, nFrom: number, nTo: number): Vec3 {
  let n = nFace;
  let cos_i = -dot(dIn, n);
  if (cos_i < 0) {
    n = { x: -n.x, y: -n.y, z: -n.z };
    cos_i = -cos_i;
  }
  const eta = nFrom / nTo;
  const sin2_t = eta * eta * (1.0 - cos_i * cos_i);
  if (sin2_t > 1.0) {
    throw new Error(
      `total internal reflection (sin²θ_t=${sin2_t.toFixed(4)} > 1) — `
      + `use reflect() instead at this interface`,
    );
  }
  const cos_t = Math.sqrt(1.0 - sin2_t);
  return add(scale(dIn, eta), scale(n, eta * cos_i - cos_t));
}
