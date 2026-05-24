/**
 * Laser source PhysicsOp -- v3.
 *
 * Op name: `emit_laser_source`
 * Kind:    `laser_source`
 *
 * A laser source is a scene emitter, not a passive element. Its Asset3D
 * should expose one optical face, normally `out`; the face normal is the
 * emitted chief-ray direction in the asset body frame.
 */

import {
  type BeamRay,
  type Vec3,
  normalize,
} from "../../beam-ray";
import { type Complex, qAtWaist } from "../../fiber/gaussian";
import {
  type PhysicsOp,
  type PhysicsOpContext,
  registerKind,
} from "../../registry";

const ZERO_C: Complex = { re: 0, im: 0 };
const ONE_C: Complex = { re: 1, im: 0 };

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function positiveFiniteNumber(v: unknown): number | undefined {
  const n = finiteNumber(v);
  return n !== undefined && n > 0 ? n : undefined;
}

function readPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function firstPositive(ctx: PhysicsOpContext, paths: string[][], fallback: number): number {
  for (const path of paths) {
    const d = positiveFiniteNumber(readPath(ctx.dynamic, path));
    if (d !== undefined) return d;
  }
  for (const path of paths) {
    const p = positiveFiniteNumber(readPath(ctx.params, path));
    if (p !== undefined) return p;
  }
  return fallback;
}

function firstFinite(ctx: PhysicsOpContext, paths: string[][], fallback: number): number {
  for (const path of paths) {
    const d = finiteNumber(readPath(ctx.dynamic, path));
    if (d !== undefined) return d;
  }
  for (const path of paths) {
    const p = finiteNumber(readPath(ctx.params, path));
    if (p !== undefined) return p;
  }
  return fallback;
}

function complexFromUnknown(v: unknown): Complex | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const re = finiteNumber(r.re);
  const im = finiteNumber(r.im) ?? 0;
  return re !== undefined ? { re, im } : undefined;
}

function jonesFromUnknown(v: unknown): [Complex, Complex] | undefined {
  if (Array.isArray(v) && v.length >= 2) {
    const a = complexFromUnknown(v[0]);
    const b = complexFromUnknown(v[1]);
    if (a && b) return [a, b];
  }
  if (v && typeof v === "object") {
    const r = v as Record<string, unknown>;
    const nested = jonesFromUnknown(r.jones);
    if (nested) return nested;
    const exRe = finiteNumber(r.exRe);
    const eyRe = finiteNumber(r.eyRe);
    if (exRe !== undefined && eyRe !== undefined) {
      return [
        { re: exRe, im: finiteNumber(r.exIm) ?? 0 },
        { re: eyRe, im: finiteNumber(r.eyIm) ?? 0 },
      ];
    }
  }
  return undefined;
}

function readJones(ctx: PhysicsOpContext): [Complex, Complex] {
  const candidates = [
    ctx.dynamic?.jones,
    ctx.dynamic?.polarization,
    readPath(ctx.dynamic, ["beam", "jones"]),
    readPath(ctx.dynamic, ["beam", "polarization"]),
    ctx.params.jones,
    ctx.params.polarization,
  ];
  for (const c of candidates) {
    const parsed = jonesFromUnknown(c);
    if (parsed) return parsed;
  }
  return [ONE_C, ZERO_C];
}

function qFromMode(
  waistUm: number,
  waistZOffsetMm: number,
  wavelengthNm: number,
): Complex {
  const waistMm = waistUm / 1000;
  const lambdaMm = wavelengthNm * 1e-6;
  const q = qAtWaist(waistMm, lambdaMm);
  return { re: -waistZOffsetMm, im: q.im };
}

export function emitLaserSourceRay(ctx: PhysicsOpContext): BeamRay {
  const wavelengthNm = firstPositive(ctx, [
    ["centerWavelengthNm"],
    ["spectrum", "centerWavelengthNm"],
    ["beam", "centerWavelengthNm"],
    ["beam", "spectrum", "centerWavelengthNm"],
  ], 780.241);
  const powerMw = firstFinite(ctx, [
    ["laserPowerMw"],
    ["powerMw"],
    ["nominalPowerMw"],
    ["beam", "laserPowerMw"],
    ["beam", "powerMw"],
    ["beam", "nominalPowerMw"],
  ], 1.0);

  const waistXUm = firstPositive(ctx, [
    ["spatialModeX", "waistUm"],
    ["spatialEnvelope", "waistXUm"],
    ["spatialEnvelope", "waistUm"],
    ["spatialEnvelope", "transverseProfile", "x", "waistRadiusUm"],
    ["waistUm"],
    ["beam", "spatialModeX", "waistUm"],
    ["beam", "spatialEnvelope", "waistXUm"],
    ["beam", "spatialEnvelope", "waistUm"],
    ["beam", "spatialEnvelope", "transverseProfile", "x", "waistRadiusUm"],
    ["beam", "waistUm"],
  ], 250);
  const waistYUm = firstPositive(ctx, [
    ["spatialModeY", "waistUm"],
    ["spatialEnvelope", "waistYUm"],
    ["spatialEnvelope", "waistUm"],
    ["spatialEnvelope", "transverseProfile", "y", "waistRadiusUm"],
    ["waistUm"],
    ["beam", "spatialModeY", "waistUm"],
    ["beam", "spatialEnvelope", "waistYUm"],
    ["beam", "spatialEnvelope", "waistUm"],
    ["beam", "spatialEnvelope", "transverseProfile", "y", "waistRadiusUm"],
    ["beam", "waistUm"],
  ], waistXUm);
  const waistXOffsetMm = firstFinite(ctx, [
    ["spatialModeX", "waistZOffsetMm"],
    ["spatialEnvelope", "waistXOffsetMm"],
    ["spatialEnvelope", "waistZOffsetMm"],
    ["spatialEnvelope", "propagation", "x", "waistZOffsetMm"],
    ["beam", "spatialModeX", "waistZOffsetMm"],
    ["beam", "spatialEnvelope", "waistXOffsetMm"],
    ["beam", "spatialEnvelope", "waistZOffsetMm"],
    ["beam", "spatialEnvelope", "propagation", "x", "waistZOffsetMm"],
  ], 0);
  const waistYOffsetMm = firstFinite(ctx, [
    ["spatialModeY", "waistZOffsetMm"],
    ["spatialEnvelope", "waistYOffsetMm"],
    ["spatialEnvelope", "waistZOffsetMm"],
    ["spatialEnvelope", "propagation", "y", "waistZOffsetMm"],
    ["beam", "spatialModeY", "waistZOffsetMm"],
    ["beam", "spatialEnvelope", "waistYOffsetMm"],
    ["beam", "spatialEnvelope", "waistZOffsetMm"],
    ["beam", "spatialEnvelope", "propagation", "y", "waistZOffsetMm"],
  ], waistXOffsetMm);

  const direction: Vec3 = normalize(ctx.faceOut.normalBodyLocal ?? { x: 0, y: 0, z: 1 });
  return {
    origin: ctx.faceOut.positionMmBodyLocal,
    direction,
    qx: qFromMode(waistXUm, waistXOffsetMm, wavelengthNm),
    qy: qFromMode(waistYUm, waistYOffsetMm, wavelengthNm),
    wavelengthNm,
    powerMw: Math.max(0, powerMw),
    jones: readJones(ctx),
    pathLengthMm: 0,
    phaseAccumRad: 0,
  };
}

export const emitLaserSourceOp: PhysicsOp = (
  _rayIn: BeamRay,
  ctx: PhysicsOpContext,
): BeamRay[] => [emitLaserSourceRay(ctx)];

registerKind("laser_source", {
  ops: {
    emit_laser_source: emitLaserSourceOp,
  },
  needsAperture: false,
});
