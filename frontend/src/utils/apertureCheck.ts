// Aperture check: does the beam spot fit through the target component's
// clear aperture at the proposed placement position?
//
// For non-mirror elements (lenses, AOMs, beam dumps, etc.): spot is
// circular; just compare radius to aperture radius.
//
// For mirrors at angle θ between incoming beam and face normal: the spot
// projected onto the mirror surface is an ELLIPSE, with
//   - short axis = w  (perpendicular to plane of incidence)
//   - long axis  = w / cos(θ)  (in plane of incidence — stretches as θ → 90°)
// For 45° fold mirrors that's `w · √2 ≈ 1.414·w`.
//
// Beam radius `w` is read from the solver's BeamSegment row associated with
// the same optical_link the placement targets; if the solver hasn't run we
// degrade to "info" status (no warning, no green check, just a hint).

import type { PhysicsElement, BeamSegment, SceneData } from "../types/digitalTwin";
import { mirrorNormalLab } from "./beamAnchor";
import type { Vec3 } from "./beamPlacement";

const v3dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const v3len = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
const v3norm = (v: Vec3): Vec3 => {
  const l = v3len(v);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l, z: v.z / l } : { x: 0, y: 0, z: 1 };
};

export type ApertureResult = {
  status: "ok" | "warn" | "info";
  /** Short text for the panel — already includes ✓/⚠/ℹ glyph. */
  text: string;
  /** Available when status is ok or warn. */
  spotShortMm?: number;
  spotLongMm?: number;
  /** Available when target is a mirror — for tooltip/debug. */
  angleOfIncidenceDeg?: number;
};

/** Read clear aperture diameter from kindParams.
 *  Backend convention: `clearApertureMm` (mirror, lens_spherical,
 *  lens_cylindrical, polarizer, etc. all carry this optional field). We
 *  also accept `apertureDiameterMm` for forward-compat with future kinds. */
function getApertureDiameterMm(el: PhysicsElement | undefined): number | null {
  if (!el) return null;
  const params = el.kindParams as Record<string, unknown>;
  const candidates = ["clearApertureMm", "apertureDiameterMm"];
  for (const key of candidates) {
    const v = params[key];
    if (typeof v === "number" && v > 0) return v;
  }
  return null;
}

/** Pick the BeamSegment whose optical_link matches the segment the
 *  placement is on. Returns null if there's no closed link (open segment)
 *  or no solver run yet. */
function beamSegmentForLink(
  fromObjectId: string,
  fromPort: string,
  scene: SceneData,
): BeamSegment | null {
  const link = scene.opticalLinks.find(
    (l) => l.fromObjectId === fromObjectId && l.fromPort === fromPort,
  );
  if (!link) return null;
  const segs = scene.beamSegments.filter((s) => s.opticalLinkId === link.id);
  if (segs.length === 0) return null;
  return segs[0];
}

/** Extract the beam radius (1/e²) at the END of the segment from the
 *  solver's q-parameter output. The `wAtZUm` field is in micrometers; we
 *  convert to mm. Returns null if missing. */
function beamRadiusMmAtSegmentEnd(seg: BeamSegment): number | null {
  // We don't yet have spot vs. position interpolation along the segment
  // (would need full Gaussian propagation from qReal/qImag). Use the END
  // value as the worst-case spot for the segment. Phase 2: real q-param
  // propagation for spot at arbitrary position.
  const sx = seg.spatialX as Record<string, unknown>;
  const sy = seg.spatialY as Record<string, unknown>;
  const wx = typeof sx.wAtZUm === "number" ? sx.wAtZUm : null;
  const wy = typeof sy.wAtZUm === "number" ? sy.wAtZUm : null;
  if (wx === null && wy === null) return null;
  // Take max so the worst axis drives the check.
  const maxUm = Math.max(wx ?? 0, wy ?? 0);
  return maxUm / 1000;
}

/** Compute aperture status for placing object `targetObjectId` at the
 *  resolved beam position with given incoming direction. */
export function checkAperture(
  targetObjectId: string,
  incomingDir: Vec3 | null,
  segmentMeta: { fromObjectId: string; fromPort: string },
  scene: SceneData,
): ApertureResult | null {
  const el = scene.physicsElements.find((e) => e.objectId === targetObjectId);
  if (!el) return null;
  const apMm = getApertureDiameterMm(el);
  if (apMm === null) return null;

  const seg = beamSegmentForLink(segmentMeta.fromObjectId, segmentMeta.fromPort, scene);
  if (!seg) {
    return {
      status: "info",
      text: `ℹ Aperture Ø ${apMm.toFixed(1)} mm — run solver to compute beam spot.`,
    };
  }
  const wMm = beamRadiusMmAtSegmentEnd(seg);
  if (wMm === null) {
    return {
      status: "info",
      text: `ℹ Aperture Ø ${apMm.toFixed(1)} mm — solver output missing beam radius.`,
    };
  }

  // Compute spot ellipse axes.
  let spotShort = wMm;
  let spotLong = wMm;
  let angleDeg: number | undefined;
  if (el.elementKind === "mirror" && incomingDir) {
    const nLab = mirrorNormalLab(targetObjectId, scene);
    if (nLab) {
      const cosTheta = Math.max(0.01, Math.abs(v3dot(v3norm(incomingDir), v3norm(nLab))));
      angleDeg = (Math.acos(Math.min(1, cosTheta)) * 180) / Math.PI;
      spotLong = wMm / cosTheta;
      // spotShort stays at wMm (perpendicular to plane of incidence).
    }
  }

  const r = apMm / 2;
  const fits = spotLong <= r;
  const angleNote = angleDeg !== undefined ? ` at ${angleDeg.toFixed(0)}° tilt` : "";
  if (fits) {
    return {
      status: "ok",
      text: `✓ Spot ${(spotShort * 2).toFixed(2)} × ${(spotLong * 2).toFixed(2)} mm fits Ø ${apMm.toFixed(1)} mm${angleNote}`,
      spotShortMm: spotShort,
      spotLongMm: spotLong,
      angleOfIncidenceDeg: angleDeg,
    };
  }
  return {
    status: "warn",
    text: `⚠ Spot ${(spotShort * 2).toFixed(2)} × ${(spotLong * 2).toFixed(2)} mm > Ø ${apMm.toFixed(1)} mm aperture — beam clipped on long axis${angleNote}`,
    spotShortMm: spotShort,
    spotLongMm: spotLong,
    angleOfIncidenceDeg: angleDeg,
  };
}
