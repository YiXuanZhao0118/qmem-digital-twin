/**
 * AOM (Acousto-Optic Modulator) PhysicsOp — v3.
 *
 * Op name: `diffract_aom`
 * Kind:    `aom`
 *
 * Bidirectional diffraction faces:
 *   - Canonical v3 two-port layout is physical faces A/B.
 *   - Directed transitions A -> B and B -> A encode opposite
 *     frequency/side branches unless transition.params.order explicitly
 *     overrides them.
 *   - Older A1/B1/A2/B2 catalog rows are still accepted.
 *   - Legacy B0/B+1/B-1 out faces are still accepted for old catalog rows.
 *
 * Geometry (asset body convention):
 *   - Body +z = optical axis (input direction)
 *   - Body +x = acoustic propagation direction (RF traveling wave)
 *   - rfPropagationDirectionBodyLocal is a vector, not an optical face.
 *   - RF/acoustic vector must be perpendicular to the transition A->B axis.
 *
 * Bragg angle:
 *   Current convention: theta_B = asin(lambda * f / (2 * v_acoustic)).
 *   This is the external half-angle; n is used for slab/q propagation.
 *   theta_B = asin(lambda * f / (2 * v_acoustic))
 *
 * Order efficiency (simple model; refine in Phase 6 with a Bragg efficiency curve):
 *   - +1:    eta = baseEfficiency
 *   -  0:    1 - eta  (undiffracted leftover)
 *   - -1:    eta * suppressedFraction  (wrong-sign diffraction, usually < 1%)
 *   - other: 0 (clip)
 *
 * Frequency source priority:
 *   Dynamic RF values should be resolved from the actual RF object chain.
 *   RF amplifier gain belongs upstream; AOM consumes post-chain RF vector signal.
 *   ctx.dynamic.aomFreqMhz -> ctx.params.aomFreqMhz -> ctx.params.centerFreqMhz
 *
 * Polarization & q-parameter:
 *   - Jones unchanged (simple model: AOMs are weakly birefringent)
 *   - q propagates through crystal slab: B = L / n
 */

import {
  type BeamRay,
  type Vec3,
  vec3Distance,
} from "../../beam-ray";
import { type Complex, cAdd, cDiv } from "../../fiber/gaussian";
import {
  type PhysicsOp,
  type PhysicsOpContext,
  registerKind,
} from "../../registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyAbcdToQ(A: number, B: number, C: number, D: number, q: Complex): Complex {
  const Aq: Complex = { re: A * q.re, im: A * q.im };
  const Bc: Complex = { re: B, im: 0 };
  const Cq: Complex = { re: C * q.re, im: C * q.im };
  const Dc: Complex = { re: D, im: 0 };
  return cDiv(cAdd(Aq, Bc), cAdd(Cq, Dc));
}

const RF_LOAD_Z_OHM = 50.0;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function positiveFiniteNumber(v: unknown): number | undefined {
  const n = finiteNumber(v);
  return n !== undefined && n > 0 ? n : undefined;
}

function vppToPowerW(vpp: number, zOhm: number = RF_LOAD_Z_OHM): number {
  return (vpp * vpp) / (8 * zOhm);
}

function dbmToW(dbm: number): number {
  return Math.pow(10, (dbm - 30) / 10);
}

function readRfFrequencyMhz(ctx: PhysicsOpContext): number {
  return (
    positiveFiniteNumber(ctx.dynamic?.aomFreqMhz)
    ?? positiveFiniteNumber(ctx.dynamic?.rfFrequencyMhz)
    ?? positiveFiniteNumber(ctx.dynamic?.aomRfFreqMhz)
    ?? positiveFiniteNumber(ctx.params.aomFreqMhz)
    ?? positiveFiniteNumber(ctx.params.centerFreqMhz)
    ?? 80
  );
}

function readRfDrivePowerW(ctx: PhysicsOpContext): number | undefined {
  let p =
    finiteNumber(ctx.dynamic?.rfDrivePowerW)
    ?? finiteNumber(ctx.dynamic?.aomRfPowerW)
    ?? finiteNumber(ctx.params.rfDrivePowerW)
    ?? finiteNumber(ctx.params.aomRfPowerW);

  const vpp =
    positiveFiniteNumber(ctx.dynamic?.aomRfVpp)
    ?? positiveFiniteNumber(ctx.dynamic?.rfVpp)
    ?? positiveFiniteNumber(ctx.params.aomRfVpp)
    ?? positiveFiniteNumber(ctx.params.rfVpp);
  if (p === undefined && vpp !== undefined) {
    p = vppToPowerW(vpp);
  }

  const dbm =
    finiteNumber(ctx.dynamic?.aomRfPowerDbm)
    ?? finiteNumber(ctx.dynamic?.rfPowerDbm)
    ?? finiteNumber(ctx.params.aomRfPowerDbm)
    ?? finiteNumber(ctx.params.rfPowerDbm);
  if (p === undefined && dbm !== undefined) {
    p = dbmToW(dbm);
  }

  if (p === undefined || !Number.isFinite(p) || p < 0) return undefined;
  const maxW = positiveFiniteNumber(ctx.params.rfPowerMaxW);
  return maxW !== undefined ? Math.min(p, maxW) : p;
}

function vecDot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function vecLength(a: Vec3): number {
  return Math.sqrt(vecDot(a, a));
}

function vecScale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function vecSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function vecNormalize(a: Vec3): Vec3 {
  const len = vecLength(a);
  if (len < 1e-15) return { x: 1, y: 0, z: 0 };
  return vecScale(a, 1 / len);
}

function readVec3(v: unknown): Vec3 | undefined {
  let x: unknown;
  let y: unknown;
  let z: unknown;
  if (Array.isArray(v) && v.length >= 3) {
    [x, y, z] = v;
  } else if (v && typeof v === "object") {
    ({ x, y, z } = v as { x?: unknown; y?: unknown; z?: unknown });
  } else {
    return undefined;
  }
  if (
    typeof x !== "number" || !Number.isFinite(x)
    || typeof y !== "number" || !Number.isFinite(y)
    || typeof z !== "number" || !Number.isFinite(z)
  ) {
    return undefined;
  }
  return { x, y, z };
}

function transitionOpticalAxis(ctx: PhysicsOpContext): Vec3 {
  return vecNormalize(
    ctx.faceOut.normalBodyLocal
    ?? vecSub(ctx.faceOut.positionMmBodyLocal, ctx.faceIn.positionMmBodyLocal),
  );
}

function readRfDirectionBodyLocal(ctx: PhysicsOpContext): Vec3 {
  const rawRfDir =
    readVec3(ctx.dynamic?.rfPropagationDirectionBodyLocal)
    ?? readVec3(ctx.dynamic?.acousticAxisBodyLocal)
    ?? readVec3(ctx.params.rfPropagationDirectionBodyLocal)
    ?? readVec3(ctx.params.acousticAxisBodyLocal)
    ?? { x: 1, y: 0, z: 0 };
  const rfLen = vecLength(rawRfDir);
  if (rfLen < 1e-15) {
    throw new Error("AOM rfPropagationDirectionBodyLocal must be a non-zero vector");
  }
  const rfDir = vecScale(rawRfDir, 1 / rfLen);
  const opticalAxis = transitionOpticalAxis(ctx);
  const dot = vecDot(rfDir, opticalAxis);
  if (Math.abs(dot) > 1e-6) {
    throw new Error(
      `AOM rfPropagationDirectionBodyLocal must be perpendicular to the A->B optical axis; dot=${dot}`,
    );
  }
  return rfDir;
}

/** Parse legacy order m from a face id matching `B<signed_int>`. */
export function parseOrderFromFaceId(faceId: string): number {
  const m = /^B([+-]?\d+)$/.exec(faceId);
  if (!m) {
    throw new Error(
      `AOM diffract_aom: faceOut.id must match B[+/-n], got "${faceId}"`,
    );
  }
  return parseInt(m[1]!, 10);
}

export function orderFromContext(ctx: PhysicsOpContext): number {
  const explicit =
    finiteNumber(ctx.params.order)
    ?? finiteNumber(ctx.params.diffractionOrder);
  if (explicit !== undefined) return Math.trunc(explicit);

  if (ctx.faceIn.id === "A" && ctx.faceOut.id === "B") return 1;
  if (ctx.faceIn.id === "B" && ctx.faceOut.id === "A") return -1;
  if (ctx.faceIn.id === "A1" && ctx.faceOut.id === "B1") return 1;
  if (ctx.faceIn.id === "A2" && ctx.faceOut.id === "B2") return -1;
  return parseOrderFromFaceId(ctx.faceOut.id);
}

/** Bragg angle in radians.
 *  theta_B = asin(lambda * f / (2 * v)) with lambda in nm -> m and f in MHz -> Hz. */
export function braggAngleRad(
  wavelengthNm: number,
  freqMhz: number,
  acousticVelocityMps: number,
  _refractiveIndex?: number,
): number {
  const lambdaM = wavelengthNm * 1e-9;
  const fHz = freqMhz * 1e6;
  const arg = (lambdaM * fHz) / (2 * acousticVelocityMps);
  // Clamp to [-1, 1] to avoid asin overflow when params push beyond Bragg.
  return Math.asin(Math.max(-1, Math.min(1, arg)));
}

function deflectAlongRfSide(inputDir: Vec3, rfDir: Vec3, deflectRad: number): Vec3 {
  const inDir = vecNormalize(inputDir);
  const rfTransverse = vecSub(rfDir, vecScale(inDir, vecDot(rfDir, inDir)));
  const side = vecNormalize(rfTransverse);
  return vecNormalize(vecAdd(
    vecScale(inDir, Math.cos(deflectRad)),
    vecScale(side, Math.sin(deflectRad)),
  ));
}

/** Order efficiency split. Refined Phase 6+ with a Bragg efficiency curve. */
export function orderEfficiency(order: number, baseEfficiency: number): number {
  const eta = clamp01(baseEfficiency);
  if (order === 1) return eta;
  if (order === 0) return Math.max(0, 1 - eta);
  if (order === -1) return eta * 0.01;       // ~1% wrong-sign suppression
  return 0;
}

export function firstOrderEfficiencyFromContext(
  rayIn: BeamRay,
  ctx: PhysicsOpContext,
  thetaBRad: number,
): number {
  const rfPowerW = readRfDrivePowerW(ctx);
  const requiresRfDrive = ctx.params.requiresRfDrive === true;
  if (requiresRfDrive && rfPowerW === undefined) return 0;

  const m2 = positiveFiniteNumber(ctx.params.figureOfMeritM2);
  const Lmm = positiveFiniteNumber(ctx.params.crystalLengthMm);
  const Wmm = positiveFiniteNumber(ctx.params.acousticBeamWidthMm);
  if (rfPowerW !== undefined && m2 !== undefined && Lmm !== undefined && Wmm !== undefined) {
    const lambdaM = rayIn.wavelengthNm * 1e-9;
    const Lm = Lmm * 1e-3;
    const Wm = Wmm * 1e-3;
    const inner = Math.sqrt((2 * m2 * rfPowerW) / Wm);
    const arg = ((Math.PI * Lm) / (2 * lambdaM * Math.cos(thetaBRad))) * inner;
    return clamp01(Math.sin(arg) ** 2);
  }

  return clamp01(finiteNumber(ctx.params.baseEfficiency) ?? 0.85);
}

/** Unsigned angle between a ray direction and the optical axis. */
function angleToAxisRad(direction: Vec3, axis: Vec3): number {
  const d = vecNormalize(direction);
  const a = vecNormalize(axis);
  return Math.acos(Math.max(-1, Math.min(1, vecDot(d, a))));
}

/**
 * sinc^2 Bragg phase-matching factor for off-axis incidence.
 *
 * Thick-grating coupled-wave theory: efficiency scales as sinc^2(dk·L/2),
 * where dk is the longitudinal wave-vector mismatch produced by deviating
 * from the matched incidence angle. The canonical on-axis input (ray along
 * the A->B optical axis) is treated as perfectly matched, so a ray arriving
 * at external angle dthetaExt sees:
 *   K       = 2π·f / v               (acoustic grating vector, 1/m)
 *   thetaB  = asin(λ·f / (2·n·v))    (internal Bragg angle)
 *   dk      = K·cos(thetaB)·(dthetaExt / n)
 *   xi      = dk·L / 2
 *   factor  = (sin xi / xi)^2        (→ 1 as xi → 0)
 */
export function braggDetuningFactor(
  rayIn: BeamRay,
  ctx: PhysicsOpContext,
  freqMhz: number,
  vAcoustic: number,
  n: number,
  Lmm: number,
): number {
  const dthetaExt = angleToAxisRad(rayIn.direction, transitionOpticalAxis(ctx));
  if (dthetaExt === 0) return 1;
  const lambdaM = rayIn.wavelengthNm * 1e-9;
  const fHz = freqMhz * 1e6;
  const Lm = Lmm * 1e-3;
  const kAcoustic = (2 * Math.PI * fHz) / vAcoustic;
  const thetaBInt = Math.asin(
    Math.max(-1, Math.min(1, (lambdaM * fHz) / (2 * n * vAcoustic))),
  );
  const dthetaInt = dthetaExt / n;
  const dk = kAcoustic * Math.cos(thetaBInt) * dthetaInt;
  const xi = (dk * Lm) / 2;
  if (xi === 0) return 1;
  return clamp01((Math.sin(xi) / xi) ** 2);
}

/** External half-width to the first sinc^2 null (xi = π), in mrad:
 *  dthetaExt = n·v / (f·L). */
export function braggAcceptanceMrad(
  freqMhz: number,
  vAcoustic: number,
  n: number,
  Lmm: number,
): number {
  const fHz = freqMhz * 1e6;
  const Lm = Lmm * 1e-3;
  return ((n * vAcoustic) / (fHz * Lm)) * 1e3;
}

// ---------------------------------------------------------------------------
// diffract_aom op
// ---------------------------------------------------------------------------

export const diffractAomOp: PhysicsOp = (
  rayIn: BeamRay,
  ctx: PhysicsOpContext,
): BeamRay[] => {
  const order = orderFromContext(ctx);

  const freqMhz = readRfFrequencyMhz(ctx);
  const vAcoustic =
    positiveFiniteNumber(ctx.params.acousticVelocityMps)
    ?? positiveFiniteNumber(ctx.params.acousticVelocityMPerS)
    ?? 4200;
  const n = positiveFiniteNumber(ctx.params.refractiveIndex) ?? 2.26;
  const L = positiveFiniteNumber(ctx.params.crystalLengthMm)
    ?? vec3Distance(ctx.faceIn.positionMmBodyLocal, ctx.faceOut.positionMmBodyLocal);

  const theta_B = braggAngleRad(rayIn.wavelengthNm, freqMhz, vAcoustic, n);
  const deflectRad = order * 2 * theta_B;

  const dirOut = deflectAlongRfSide(
    rayIn.direction,
    readRfDirectionBodyLocal(ctx),
    deflectRad,
  );

  const detune = braggDetuningFactor(rayIn, ctx, freqMhz, vAcoustic, n, L);
  const firstOrderEfficiency = firstOrderEfficiencyFromContext(rayIn, ctx, theta_B) * detune;
  const eff = orderEfficiency(order, firstOrderEfficiency);
  const newPower = rayIn.powerMw * eff;

  // Doppler shift: order m diffracts off the f_RF acoustic wave, shifting the
  // optical frequency by m·f_RF. Tracked as an offset on the nominal carrier.
  const newFreqOffsetHz = (rayIn.freqOffsetHz ?? 0) + order * freqMhz * 1e6;

  // q-parameter slab propagation (B = L/n inside the crystal).
  const Bslab = L / n;
  const qxOut = applyAbcdToQ(1, Bslab, 0, 1, rayIn.qx);
  const qyOut = applyAbcdToQ(1, Bslab, 0, 1, rayIn.qy);

  // Chief ray exits at faceOut position (or its projection along the
  // deflected direction).
  const newOrigin = ctx.faceOut.positionMmBodyLocal;
  const thickness = vec3Distance(
    ctx.faceIn.positionMmBodyLocal, ctx.faceOut.positionMmBodyLocal,
  );

  return [{
    ...rayIn,
    origin: newOrigin,
    direction: dirOut,
    qx: qxOut,
    qy: qyOut,
    powerMw: newPower,
    pathLengthMm: rayIn.pathLengthMm + thickness,
    freqOffsetHz: newFreqOffsetHz,
    // jones unchanged (simple polarization-preserving model)
  }];
};

registerKind("aom", {
  ops: {
    diffract_aom: diffractAomOp,
  },
  needsAperture: true,
});
