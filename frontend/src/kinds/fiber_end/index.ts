/**
 * Fiber End — per-end ferrule SceneObject for a fiber patch cable.
 *
 * Phase fiber-split: a fiber is now three SceneObjects — two `fiber_end`
 * ferrules + one hidden `fiber` body wrapper. Each fiber_end owns its
 * own lab pose, lock flag, collection (rigid-group) membership, and
 * align flow; the body wrapper holds shared params (length, fiberType,
 * etc.) and a derived spline between the two ends.
 *
 * The default capability profile already gives fiber_end everything a
 * normal SceneObject needs (Outliner row, Object panel pose, Lock,
 * rigid-group cascade, Viewer gizmo, AlignPanel, Remove button). The
 * matching OVERRIDES entry in `_capabilityProfile.ts` is intentionally
 * an empty object so the intent is documented.
 *
 * Anchors:
 *   - `tip` (bidirectional, optical) — external ferrule face; the beam
 *     enters / exits here. This is the anchor an AlignPanel snaps onto
 *     a target beam segment.
 *
 * The internal "into the fiber body" linkage isn't an anchor — it's
 * carried as `kindParams.fiberBodyObjectId` so the body's spline endpoint
 * can re-derive from this object's pose at draw time.
 */
import { definePhysicsPlugin } from "../_plugin";

export interface FiberEndParams extends Record<string, unknown> {
  /** e.g. "FC/PC", "FC/APC", "LC/PC". null = inherit catalog default. */
  connectorType: string | null;
  polish: "PC" | "APC" | "UPC" | null;
  /** PM only — slow-axis angle in body frame (deg). */
  slowAxisDegInBodyFrame: number | null;
  /** Back-reference to the paired fiber body. Null only during the
   *  half-built state between SceneObject create and the Phase B
   *  backfill / paired-end wiring. */
  fiberBodyObjectId: string | null;
  /** Which end of the body this represents. Aligns with the body's
   *  endAObjectId / endBObjectId fields. */
  endRole: "A" | "B";
  /** Operating wavelength window (nm). Defaults track the paired
   *  fiber body's wavelengthRangeNm. */
  wavelengthRangeNm: [number, number];
}

export const fiberEndPlugin = definePhysicsPlugin<FiberEndParams>({
  id: "fiber_end",
  displayName: "Fiber End",
  componentTypes: ["fiber_end"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "fiber_end",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    anchors: {
      required: ["tip"],
      optional: [],
      needsDirection: ["tip"],
      needsAperture: ["tip"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Per-end ferrule for a fiber. The `tip` anchor is the external optical face — Align End snaps it onto the closest beam-path segment within alignToleranceMm (≤25 mm). The paired hidden fiber body wrapper's spline endpoint re-derives from this object's pose at draw time, so moving / aligning a fiber_end automatically drags the cable spline.",
    defaultParams: {
      connectorType: null,
      polish: null,
      slowAxisDegInBodyFrame: null,
      fiberBodyObjectId: null,
      endRole: "A",
      wavelengthRangeNm: [770, 790],
    },
  },
});
