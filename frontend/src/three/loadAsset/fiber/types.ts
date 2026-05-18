// Fiber patch cable types. Pure TS types — no runtime code, so importing
// this module is free of side effects and safe to use anywhere (including
// from within other fiber sub-modules that don't want a circular).

/** Bezier-spline node along the procedural fiber tube. Each node carries
 *  its anchor position (lab mm) plus optional tangent-handle offsets:
 *  - handleInMm  — vector toward the previous node (controls incoming tangent)
 *  - handleOutMm — vector toward the next node (controls outgoing tangent)
 *
 *  For a segment between nodes[i]/[i+1] the CubicBezier control points are:
 *    P0 = nodes[i].posMm
 *    P1 = P0 + nodes[i].handleOutMm
 *    P2 = P3 + nodes[i+1].handleInMm
 *    P3 = nodes[i+1].posMm
 *
 *  Lab → three axis convention: lab (x, y, z) → three (x, z, -y); mm → three
 *  units divides by 100 (matches applyAssetScale's mm fallback). */
export type FiberNode = {
  posMm: [number, number, number];
  handleInMm?: [number, number, number];
  handleOutMm?: [number, number, number];
};

/** Per-instance End A / End B pose passed in from the SceneObject's
 *  PE.kindParams. Body-local frame; ferrule extends from posMm along
 *  rotDeg(0, +1, 0) (= +Y in the end's own frame after rotation). When
 *  null / undefined the renderer falls back to the legacy "derive from
 *  spline tangent" placement (catalog preview, very old scenes). */
export type FiberEndPlacement = {
  posMm: [number, number, number];
  rotDeg: [number, number, number];
  /** Wire-extension direction in the fiber BODY-local frame. The
   *  ferrule mesh auto-orients so its tip (= +Y local) points OPPOSITE
   *  this direction. `rotDeg[1]` is then applied as axial roll only. */
  tensionHandleMm: [number, number, number];
  polish?: "PC" | "APC" | "UPC";
};

export type FiberType = "single_mode" | "polarization_maintaining" | "multi_mode";
export type Polish = "PC" | "UPC" | "APC" | "AR";
