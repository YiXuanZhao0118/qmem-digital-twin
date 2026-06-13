/**
 * Cable visual appearance — jacket colour + tube radius — as an explicit
 * override layer on top of each cable kind's defaults (fibre: fiberType
 * colour table + 1.0 mm; rf_cable: RG-316 brown + 1.6 mm).
 *
 * `radiusMm` is the VISUAL jacket radius only — decoupled from the physical
 * fibre/core dimensions (claddingDiameterUm, bend-loss coreRadiusUm). It
 * just sweeps the TubeGeometry; it does not feed any physics.
 *
 * Stored under `properties.cableAppearance` on the Component (catalog
 * default) and, later, the SceneObject (per-instance override). The
 * connector shell colour is NOT touched — jacket colour only dyes the tube.
 */
export interface CableAppearance {
  jacketColorHex?: string;
  radiusMm?: number;
}

/** Read + validate a `cableAppearance` blob off a properties bag. Only
 *  returns keys that are actually set so callers can apply their own kind
 *  default for anything missing. */
export function readCableAppearance(props: unknown): CableAppearance {
  const ca = (props as { cableAppearance?: unknown } | undefined)?.cableAppearance;
  if (!ca || typeof ca !== "object") return {};
  const { jacketColorHex, radiusMm } = ca as CableAppearance;
  const out: CableAppearance = {};
  if (typeof jacketColorHex === "string" && jacketColorHex) out.jacketColorHex = jacketColorHex;
  if (typeof radiusMm === "number" && radiusMm > 0) out.radiusMm = radiusMm;
  return out;
}

/** Jacket colour swatches surfaced by the appearance editor. */
export const CABLE_JACKET_SWATCHES: ReadonlyArray<{ hex: string; label: string }> = [
  { hex: "#1d4ed8", label: "PM blue" },
  { hex: "#facc15", label: "SM yellow" },
  { hex: "#fb923c", label: "MM orange" },
  { hex: "#c4a884", label: "RG-316 tan" },
  { hex: "#f5f5f5", label: "white" },
];

export const CABLE_RADIUS_MIN_MM = 0.5;
export const CABLE_RADIUS_MAX_MM = 6.0;
