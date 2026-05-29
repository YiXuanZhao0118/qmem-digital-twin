// Centralised anchor reader. Anchors are stored directly in Asset/CAD-local
// coordinates, and these helpers return that same frame. Keeping reads here
// preserves one call site for dynamic anchors and future field renames.

import type { Anchor, Asset3D } from "../types/digitalTwin";

export type Vec3 = { x: number; y: number; z: number };

/** Asset/CAD-local position of the anchor. Combine with the ComponentBinding
 *  and SceneObject poses to get a lab-frame point. */
export function anchorObjectLocalPos(
  anchor: Anchor,
  asset: Asset3D | null | undefined,
): Vec3 {
  void asset;
  return { ...anchor.positionMmBodyLocal };
}

/** Asset/CAD-local direction = axisXBodyLocal. axisX is the
 *  Phase 9.1 primary direction (propagation / face normal). Returns
 *  `null` when the anchor pre-dates the tri-axis schema and only
 *  carries the legacy `directionBodyLocal` field; callers can then
 *  fall back to {@link anchorObjectLocalLegacyDir}. */
export function anchorObjectLocalAxisX(
  anchor: Anchor,
  asset: Asset3D | null | undefined,
): Vec3 | null {
  void asset;
  if (!anchor.axisXBodyLocal) return null;
  return { ...anchor.axisXBodyLocal };
}

/** Asset/CAD-local direction = axisYBodyLocal. axisY is the
 *  transverse reference (fast axis / s-polarization basis). Returns
 *  `null` when the anchor doesn't carry tri-axis data. */
export function anchorObjectLocalAxisY(
  anchor: Anchor,
  asset: Asset3D | null | undefined,
): Vec3 | null {
  void asset;
  if (!anchor.axisYBodyLocal) return null;
  return { ...anchor.axisYBodyLocal };
}

/** Asset/CAD-local direction = axisZBodyLocal. axisZ is the
 *  third axis (axisX ? axisY). Returns `null` when the anchor doesn't
 *  carry tri-axis data. */
export function anchorObjectLocalAxisZ(
  anchor: Anchor,
  asset: Asset3D | null | undefined,
): Vec3 | null {
  void asset;
  if (!anchor.axisZBodyLocal) return null;
  return { ...anchor.axisZBodyLocal };
}

/** Asset/CAD-local direction = directionBodyLocal. `directionBodyLocal`
 *  is the legacy (pre-Phase-9.1) primary direction field, still set on
 *  many catalog rows. Returns `null` when the anchor doesn't carry it.
 *
 *  Prefer {@link anchorObjectLocalAxisX} for new code ??fall back to
 *  this only when axisX is absent. {@link anchorObjectLocalPrimaryDir}
 *  encapsulates that fallback chain. */
export function anchorObjectLocalLegacyDir(
  anchor: Anchor,
  asset: Asset3D | null | undefined,
): Vec3 | null {
  void asset;
  if (!anchor.directionBodyLocal) return null;
  return { ...anchor.directionBodyLocal };
}

/** Primary direction in object-local frame:
 *    axisX (Phase 9.1) ??directionBodyLocal (legacy) ??`null`.
 *  This is the right call for "give me whichever propagation direction
 *  this anchor declares" ??beam emit, ray hit normal, etc. */
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
 *  (aperture, connector type, fast axis) are copied verbatim ??they
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
