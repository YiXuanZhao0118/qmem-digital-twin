// Centralised anchor reader. The single sanctioned entry point for any
// code that needs an anchor's position / direction / tri-axis in
// **object-local (CAD) frame**.
//
// Why this exists
// ---------------
// `Anchor.positionMmBodyLocal` / `axisXBodyLocal` etc. are stored in
// BODY frame. To compose with the SceneObject's pose (which acts on
// object-local / CAD frame) every caller has to first apply
// `bodyFramePositionMm` + `bodyFrameRotation` to lift the value out of
// body frame. Forgetting that step is the recurring bug fixed on
// 2026-05-27 (see docs/frame-anchor-architecture.md §14).
//
// To stop this from happening again, downstream code MUST NOT touch
// the raw `*BodyLocal` fields. It calls one of these helpers and
// receives the value already in object-local frame, ready to compose
// with `SceneObject.{x,y,z}Mm` / Euler.
//
// Forbidden:  asset.anchors[0].positionMmBodyLocal
// Allowed:    anchorObjectLocalPos(asset.anchors[0], asset)
//
// A pre-commit grep guard (scripts/check-anchor-access.ts) enforces
// this on commit; the only files allowed to read the raw fields are
// this module, `utils/assetFrame.ts` (the underlying math),
// `types/digitalTwin.ts` (the schema), and tests.

import type { Anchor, Asset3D } from "../types/digitalTwin";
import {
  bodyFrameDirectionToObjectLocal,
  bodyFramePointToObjectLocalMm,
} from "./assetFrame";

export type Vec3 = { x: number; y: number; z: number };

/** Object-local position of the anchor (= body frame anchor transformed
 *  through the asset's body-frame origin). Combine with the
 *  SceneObject pose to get a lab-frame point. */
export function anchorObjectLocalPos(
  anchor: Anchor,
  asset: Asset3D | null | undefined,
): Vec3 {
  const p = bodyFramePointToObjectLocalMm(anchor.positionMmBodyLocal, asset);
  return { x: p.x, y: p.y, z: p.z };
}

/** Object-local direction = R_body × axisXBodyLocal. axisX is the
 *  Phase 9.1 primary direction (propagation / face normal). Returns
 *  `null` when the anchor pre-dates the tri-axis schema and only
 *  carries the legacy `directionBodyLocal` field; callers can then
 *  fall back to {@link anchorObjectLocalLegacyDir}. */
export function anchorObjectLocalAxisX(
  anchor: Anchor,
  asset: Asset3D | null | undefined,
): Vec3 | null {
  if (!anchor.axisXBodyLocal) return null;
  const d = bodyFrameDirectionToObjectLocal(anchor.axisXBodyLocal, asset);
  return { x: d.x, y: d.y, z: d.z };
}

/** Object-local direction = R_body × axisYBodyLocal. axisY is the
 *  transverse reference (fast axis / s-polarization basis). Returns
 *  `null` when the anchor doesn't carry tri-axis data. */
export function anchorObjectLocalAxisY(
  anchor: Anchor,
  asset: Asset3D | null | undefined,
): Vec3 | null {
  if (!anchor.axisYBodyLocal) return null;
  const d = bodyFrameDirectionToObjectLocal(anchor.axisYBodyLocal, asset);
  return { x: d.x, y: d.y, z: d.z };
}

/** Object-local direction = R_body × axisZBodyLocal. axisZ is the
 *  third axis (axisX × axisY). Returns `null` when the anchor doesn't
 *  carry tri-axis data. */
export function anchorObjectLocalAxisZ(
  anchor: Anchor,
  asset: Asset3D | null | undefined,
): Vec3 | null {
  if (!anchor.axisZBodyLocal) return null;
  const d = bodyFrameDirectionToObjectLocal(anchor.axisZBodyLocal, asset);
  return { x: d.x, y: d.y, z: d.z };
}

/** Object-local direction = R_body × directionBodyLocal. `directionBodyLocal`
 *  is the legacy (pre-Phase-9.1) primary direction field, still set on
 *  many catalog rows. Returns `null` when the anchor doesn't carry it.
 *
 *  Prefer {@link anchorObjectLocalAxisX} for new code — fall back to
 *  this only when axisX is absent. {@link anchorObjectLocalPrimaryDir}
 *  encapsulates that fallback chain. */
export function anchorObjectLocalLegacyDir(
  anchor: Anchor,
  asset: Asset3D | null | undefined,
): Vec3 | null {
  if (!anchor.directionBodyLocal) return null;
  const d = bodyFrameDirectionToObjectLocal(anchor.directionBodyLocal, asset);
  return { x: d.x, y: d.y, z: d.z };
}

/** Primary direction in object-local frame:
 *    axisX (Phase 9.1) → directionBodyLocal (legacy) → `null`.
 *  This is the right call for "give me whichever propagation direction
 *  this anchor declares" — beam emit, ray hit normal, etc. */
export function anchorObjectLocalPrimaryDir(
  anchor: Anchor,
  asset: Asset3D | null | undefined,
): Vec3 | null {
  return (
    anchorObjectLocalAxisX(anchor, asset)
    ?? anchorObjectLocalLegacyDir(anchor, asset)
  );
}

/** Fully resolved view of an anchor with every position / direction
 *  pre-transformed into object-local frame. Pass-through fields
 *  (aperture, connector type, fast axis) are copied verbatim — they
 *  don't depend on the body frame.
 *
 *  Use this when you need more than one field of the same anchor:
 *  calling `resolveAnchor` once is cheaper and harder to mis-pair than
 *  calling `anchorObjectLocalPos` + `anchorObjectLocalAxisX` + ...
 *  with the same arguments three times. */
export type ResolvedAnchor = {
  id: string;
  name?: string;
  positionLocal: Vec3;
  axisXLocal: Vec3 | null;
  axisYLocal: Vec3 | null;
  axisZLocal: Vec3 | null;
  legacyDirLocal: Vec3 | null;
  primaryDirLocal: Vec3 | null;
  apertureMm?: number;
  apertureWidthMm?: number;
  apertureHeightMm?: number;
  apertureShape?: Anchor["apertureShape"];
  connectorType?: Anchor["connectorType"];
  fastAxisDegBodyLocal?: number;
  derivedFromFiberEndpoint?: Anchor["derivedFromFiberEndpoint"];
  derivedFromRfCableEndpoint?: Anchor["derivedFromRfCableEndpoint"];
};

export function resolveAnchor(
  anchor: Anchor,
  asset: Asset3D | null | undefined,
): ResolvedAnchor {
  const axisX = anchorObjectLocalAxisX(anchor, asset);
  const legacyDir = anchorObjectLocalLegacyDir(anchor, asset);
  return {
    id: anchor.id,
    name: anchor.name,
    positionLocal: anchorObjectLocalPos(anchor, asset),
    axisXLocal: axisX,
    axisYLocal: anchorObjectLocalAxisY(anchor, asset),
    axisZLocal: anchorObjectLocalAxisZ(anchor, asset),
    legacyDirLocal: legacyDir,
    primaryDirLocal: axisX ?? legacyDir,
    apertureMm: anchor.apertureMm,
    apertureWidthMm: anchor.apertureWidthMm,
    apertureHeightMm: anchor.apertureHeightMm,
    apertureShape: anchor.apertureShape,
    connectorType: anchor.connectorType,
    fastAxisDegBodyLocal: anchor.fastAxisDegBodyLocal,
    derivedFromFiberEndpoint: anchor.derivedFromFiberEndpoint,
    derivedFromRfCableEndpoint: anchor.derivedFromRfCableEndpoint,
  };
}
