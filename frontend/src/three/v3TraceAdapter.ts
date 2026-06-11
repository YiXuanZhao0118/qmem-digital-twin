/**
 * v3 → legacy TraceSegment adapter (Phase 7.2).
 *
 * The v3 ray tracer is the sole physics source now (Phase 6.x), but
 * several downstream consumers still read `window.__rayTraceDebug` for
 * its legacy `TraceSegment` shape — OpticalLinkViewerPanel uses
 * `seg.emitterObjectId` to filter chains, beam-scope reads
 * `polarizationAtStart` + `beamMode`, snap-to-beam uses
 * `startThree`/`endThree`, etc.
 *
 * This module converts a `V3SolverResult.labSegments[]` snapshot into
 * TraceSegment-compatible objects, filling in defaults for fields the
 * v3 tracer doesn't yet track (e.g. `taSeedCoupling`, `aomSideband`,
 * `fiberCoupling` stay undefined; `branch` defaults to "main";
 * `depth = 0`). Power factor + nominal power are best-effort: powerMw
 * on each segment is treated as absolute; `nominalPowerMwAtSource` is
 * carried from the originating segment in the chain.
 *
 * Waist computation uses the segment's q-parameter:
 *   q(z) = (z − z_waist) + i·zR
 *   w₀  = √(zR · λ / π)        (M² = 1 assumption)
 *   w(z) = w₀ · √(1 + (Δz/zR)²)
 * If the backend ever emits an explicit BeamMode, replace these
 * heuristics with the tracked value.
 */
import * as THREE from "three";

import type { V3LabSegment, V3SolverResult } from "../api/client";
import { labMmToThree } from "../optical/frames";
import type { BeamState } from "./rayTrace";
import type { SceneData } from "../types/digitalTwin";

export type V3TraceSegment = {
  startThree: THREE.Vector3;
  endThree: THREE.Vector3;
  componentIdHit: string | null;
  hitObjectId: string | null;
  sourceObjectId: string;
  branch: "main" | "transmitted" | "reflected";
  depth: number;
  lengthMm: number;
  wavelengthNm: number;
  waistAtStartUm: number;
  waistAtEndUm: number;
  sourceComponentId: string;
  pathLengthFromSourceMmAtStart: number;
  powerFactorAtStart: number;
  nominalPowerMwAtSource: number;
  polarizationAtStart: [number, number, number, number];
  beamMode: BeamState;
  emissionKey: "main" | "forward" | "backward";
  emitterObjectId: string;
  /** Optical-frequency offset (Hz) at segment start, relative to the nominal
   *  wavelengthNm carrier. Nonzero downstream of an AOM (order·f_RF). */
  freqOffsetHz: number;
  /** Clear-aperture clipping at this segment's END optic (lens kinds). Null
   *  when the end optic doesn't clip. This segment's power is PRE-truncation;
   *  downstream segments carry the reduced power. */
  apertureTruncation: V3LabSegment["apertureTruncation"];
};

function waistFromQ(qImMm: number, wavelengthNm: number): number {
  // zR = π·w₀²/λ  →  w₀ = √(zR·λ/π).  Units: zR µm, λ µm → w₀ µm.
  // [zR_um] = qImMm × 1000;  [λ_um] = wavelengthNm × 1e-3.
  // → w₀_um² = qImMm · wavelengthNm / π
  const w0Sq = Math.abs(qImMm) * wavelengthNm / Math.PI;
  return Math.sqrt(Math.max(0, w0Sq));
}

function waistAtZFromQ(
  qReMm: number, qImMm: number, wavelengthNm: number,
): number {
  const w0 = waistFromQ(qImMm, wavelengthNm);
  const zRum = Math.abs(qImMm) * 1000;
  if (zRum < 1e-9) return w0;
  const dzUm = qReMm * 1000;
  return w0 * Math.sqrt(1 + (dzUm / zRum) ** 2);
}

/** Non-paraxial FUNDAMENTAL (mode-factor-excluded) real beam radius (µm) at
 *  the q point. Mirror of backend `nonparaxial_fundamental_waist_mm`: keep q
 *  paraxial (propagation), correct only the far-field WIDTH so a high-NA waist
 *  (w₀→λ) diverges with the bounded non-paraxial angle instead of overshooting.
 *    s = M²λ/(πw₀);  z_R_eff = z_R·√(1−min(s,1)²).  Low NA → paraxial. */
function nonparaxialFundamentalWaistUm(
  qReMm: number, qImMm: number, m2: number, wavelengthNm: number,
): number {
  const zRum = Math.abs(qImMm) * 1000;
  if (zRum < 1e-9) return 0;
  const m2eff = m2 > 0 ? m2 : 1;
  const w0RealUm = waistFromQ(qImMm, wavelengthNm) * Math.sqrt(m2eff);
  const lamUm = wavelengthNm * 1e-3;
  const s = w0RealUm > 0 ? (m2eff * lamUm) / (Math.PI * w0RealUm) : 1;
  const sEff = Math.min(s, 0.999);
  const zReffUm = zRum * Math.sqrt(1 - sEff * sEff);
  if (zReffUm <= 0) return w0RealUm;
  const dzUm = qReMm * 1000;
  return w0RealUm * Math.sqrt(1 + (dzUm / zReffUm) ** 2);
}

/** Convert one V3 lab segment to a TraceSegment-compatible object. */
function adaptOne(seg: V3LabSegment, sourceComponentId: string): V3TraceSegment {
  const startThree = labMmToThree({
    xMm: seg.start.x, yMm: seg.start.y, zMm: seg.start.z,
  });
  const endThree = labMmToThree({
    xMm: seg.end.x, yMm: seg.end.y, zMm: seg.end.z,
  });
  const lengthMm = Math.hypot(
    seg.end.x - seg.start.x,
    seg.end.y - seg.start.y,
    seg.end.z - seg.start.z,
  );

  const qxStart = seg.qxAtStart ?? { re: 0, im: 0 };
  // qy is tracked independently by the backend (astigmatism). Fall back to qx
  // for legacy/circular payloads that don't carry it.
  const qyStart = seg.qyAtStart ?? qxStart;
  const qxEnd = { re: qxStart.re + lengthMm, im: qxStart.im };
  // q carries the EMBEDDED fundamental Gaussian (M²-reduced z_R → correct
  // divergence; Re(q) → waist offset). The REAL transverse width is the
  // embedded width × widthMult, which folds √(M²) and the high-order
  // transverse-mode factor. Absent (legacy payload) → 1.0. The 3D taper cone
  // is axisymmetric so it uses the x-axis only; the 2D beam-scope profile
  // reads beamMode.x/.y, so those are kept per-axis (astigmatism shows there).
  const widthMultX = seg.widthMultAtStart?.x ?? 1;
  const widthMultY = seg.widthMultAtStart?.y ?? widthMultX;
  const m2x = seg.m2AtStart?.x ?? 1;
  // Transverse-mode width factor only (M² lives in the non-paraxial helper).
  const modeFacX = m2x > 0 ? widthMultX / Math.sqrt(m2x) : widthMultX;
  const waistAtStartUm = nonparaxialFundamentalWaistUm(qxStart.re, qxStart.im, m2x, seg.wavelengthNm) * modeFacX;
  const waistAtEndUm = nonparaxialFundamentalWaistUm(qxEnd.re, qxEnd.im, m2x, seg.wavelengthNm) * modeFacX;

  // Minimum waist (z=0): non-paraxiality doesn't change the waist itself,
  // only the far-field, so the simple paraxial readout × width_mult holds.
  // Per-axis from qx/qy so an astigmatic beam renders an elliptical profile.
  const w0xUm = waistFromQ(qxStart.im, seg.wavelengthNm) * widthMultX;
  const w0yUm = waistFromQ(qyStart.im, seg.wavelengthNm) * widthMultY;
  // Cumulative path-length at the waist (µm) relative to emitter, per axis.
  // q.re = (z − z_waist) → z_waist_um = (path_at_start − q_re) × 1000.
  const waistZxUm = (seg.pathLengthMmAtStart - qxStart.re) * 1000;
  const waistZyUm = (seg.pathLengthMmAtStart - qyStart.re) * 1000;
  const beamMode: BeamState = {
    x: { waist0Um: w0xUm, waistZUm: waistZxUm, mSquared: 1 },
    y: { waist0Um: w0yUm, waistZUm: waistZyUm, mSquared: 1 },
    wavelengthNm: seg.wavelengthNm,
  };

  const jonesArr = seg.jones ?? [{ re: 1, im: 0 }, { re: 0, im: 0 }];
  return {
    startThree,
    endThree,
    componentIdHit: null,
    hitObjectId: seg.sceneObjectId,
    sourceObjectId: seg.sourceSceneObjectId ?? seg.emitterSceneObjectId ?? "",
    branch: "main",
    depth: 0,
    lengthMm,
    wavelengthNm: seg.wavelengthNm,
    waistAtStartUm,
    waistAtEndUm,
    sourceComponentId,
    pathLengthFromSourceMmAtStart: seg.pathLengthMmAtStart,
    powerFactorAtStart: 1.0,
    nominalPowerMwAtSource: seg.powerMw,
    polarizationAtStart: [
      jonesArr[0].re, jonesArr[0].im,
      jonesArr[1].re, jonesArr[1].im,
    ],
    beamMode,
    emissionKey: "main",
    emitterObjectId: seg.emitterSceneObjectId ?? "",
    freqOffsetHz: seg.freqOffsetHz ?? 0,
    apertureTruncation: seg.apertureTruncation ?? null,
  };
}

/** Convert a complete v3 solver result's lab segments into the legacy
 *  TraceSegment shape so consumers reading `window.__rayTraceDebug`
 *  keep working without per-consumer rewrites. */
export function adaptV3LabSegmentsToTraceSegments(
  result: V3SolverResult,
  scene: SceneData,
): V3TraceSegment[] {
  const componentByObjectId = new Map<string, string>();
  for (const o of scene.objects) {
    componentByObjectId.set(o.id, o.componentId);
  }
  return result.labSegments.map((seg) => {
    const sourceObjId = seg.sourceSceneObjectId ?? seg.emitterSceneObjectId ?? "";
    const sourceComponentId = componentByObjectId.get(sourceObjId) ?? "";
    return adaptOne(seg, sourceComponentId);
  });
}
