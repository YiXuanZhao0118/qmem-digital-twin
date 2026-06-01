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
  const qxEnd = { re: qxStart.re + lengthMm, im: qxStart.im };
  const waistAtStartUm = waistAtZFromQ(qxStart.re, qxStart.im, seg.wavelengthNm);
  const waistAtEndUm = waistAtZFromQ(qxEnd.re, qxEnd.im, seg.wavelengthNm);

  const w0Um = waistFromQ(qxStart.im, seg.wavelengthNm);
  // Cumulative path-length at the waist (µm) relative to emitter.
  // q.re = (z − z_waist) → z_waist_um = (path_at_start − qx_re) × 1000.
  const waistZUm = (seg.pathLengthMmAtStart - qxStart.re) * 1000;
  const beamMode: BeamState = {
    x: { waist0Um: w0Um, waistZUm, mSquared: 1 },
    y: { waist0Um: w0Um, waistZUm, mSquared: 1 },
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
