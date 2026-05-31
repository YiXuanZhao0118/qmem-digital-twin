// Cross-component bridge for renderer-published state.
//
// `__rayTraceDebug`, `__beamGroup`, `__v3LabSegments`, `__sceneStore`
// were originally added as ad-hoc debug hooks but ended up backing
// real cross-component data flow:
//
//   - `OpticalLinkViewerPanel` reads `__rayTraceDebug` to render its
//      mini viewport without re-running the V3 solver.
//   - `BeamScopePanel` reads `__rayTraceDebug` to inspect a clicked
//      segment.
//   - `snap-to-beam` (placement gizmo) reads `__rayTraceDebug` to
//      find candidate snap targets.
//   - `AomAdjustControls` / `TaperedAmplifierAdjustControls` read it
//      to pick the upstream beam during Align.
//   - `sceneStore` reads it to expose lab segments to non-React
//      callers.
//
// Because consumers run in production, we cannot DEV-gate the globals.
// What we CAN do is consolidate the *type* and the *publisher* — one
// canonical type for every consumer to import, and one writer in
// DigitalTwinViewer that the rest of the codebase can grep for when
// the contract changes.
//
// The legacy `window.__*` names are preserved verbatim so existing
// readers keep working without changes; new readers should prefer
// `readQmemDebug()` for the typed view.

import type * as THREE from "three";

/** Loose shape of a single TraceSegment as adapted by
 *  `three/v3TraceAdapter.ts` and consumed by everyone reading
 *  `window.__rayTraceDebug`. Kept structural — full TraceSegment
 *  carries more fields that some consumers don't need. */
export type DebugTraceSegment = Record<string, unknown> & {
  emitterObjectId?: string;
  sourceObjectId?: string;
  hitObjectId?: string | null;
  startThree?: { x: number; y: number; z: number };
  endThree?: { x: number; y: number; z: number };
  wavelengthNm?: number;
  waistAtStartUm?: number;
  waistAtEndUm?: number;
  powerFactorAtStart?: number;
  nominalPowerMwAtSource?: number;
  polarizationAtStart?: number[];
};

/** Loose shape of a V3 lab segment as published by
 *  `solve_anchor_scene` (backend) then forwarded via the same
 *  renderer. */
export type DebugLabSegment = Record<string, unknown> & {
  start?: { x: number; y: number; z: number };
  end?: { x: number; y: number; z: number };
  wavelengthNm?: number;
  hitObjectId?: string | null;
};

/** The canonical bridge surface. Producers SHOULD set every field
 *  every tick (no partial updates) so consumers see consistent state.
 *  Reading any single field on its own is fine. */
export type QmemDebugGlobals = {
  __rayTraceDebug?: DebugTraceSegment[];
  __beamGroup?: THREE.Group;
  __v3LabSegments?: DebugLabSegment[];
  __laserSource0PropagationAudit?: unknown[];
};

type DebugWindow = Window & QmemDebugGlobals;

/** Single publisher used by `DigitalTwinViewer.renderRayTraces()`. Any
 *  future producer that wants to swap segments / beam group MUST go
 *  through here so the contract has one chokepoint. */
export function publishQmemDebug(payload: {
  rayTraceDebug?: DebugTraceSegment[];
  beamGroup?: THREE.Group;
  v3LabSegments?: DebugLabSegment[];
  laserSource0PropagationAudit?: unknown[];
}): void {
  if (typeof window === "undefined") return;
  const w = window as DebugWindow;
  if (payload.rayTraceDebug !== undefined) w.__rayTraceDebug = payload.rayTraceDebug;
  if (payload.beamGroup !== undefined) w.__beamGroup = payload.beamGroup;
  if (payload.v3LabSegments !== undefined) w.__v3LabSegments = payload.v3LabSegments;
  if (payload.laserSource0PropagationAudit !== undefined) {
    w.__laserSource0PropagationAudit = payload.laserSource0PropagationAudit;
  }
}

/** Typed read of the bridge. Prefer this over inline
 *  `(window as unknown as {...}).__rayTraceDebug` casts.
 *
 *  Returns `undefined` when called from a non-browser context
 *  (vitest's default jsdom-less runner). Callers should treat each
 *  field as optional — the producer may not have run yet on the
 *  current tick. */
export function readQmemDebug(): QmemDebugGlobals {
  if (typeof window === "undefined") return {};
  const w = window as DebugWindow;
  return {
    __rayTraceDebug: w.__rayTraceDebug,
    __beamGroup: w.__beamGroup,
    __v3LabSegments: w.__v3LabSegments,
    __laserSource0PropagationAudit: w.__laserSource0PropagationAudit,
  };
}
