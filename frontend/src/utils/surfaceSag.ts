import type { V3Surface } from "../store/catalogStore";

/** Sag `w = s(u, v)` of a surface-model surface, in mm along its axisX, at
 *  `u` along axisY and `v` along axisZ from the vertex. A port of `sag` in
 *  backend/app/optical/surfaces/geometry.py (value only, no derivatives) so
 *  the PHY Editor draws a face where the tracer puts it. Null past a
 *  sphere's rim or a conic's turning point. */
export function surfaceSagMm(shape: V3Surface["shape"], u: number, v: number): number | null {
  if (shape.type === "plane" || !shape.radiusMm) return 0;
  const c = 1 / shape.radiusMm;
  if (shape.type === "cylinder") {
    const root = 1 - c * c * u * u;
    return root > 0 ? (c * u * u) / (1 + Math.sqrt(root)) : null;
  }
  const k = shape.type === "conic" ? (shape.conic ?? 0) : 0;
  const r2 = u * u + v * v;
  const root = 1 - (1 + k) * c * c * r2;
  if (root <= 0) return null;
  let w = (c * r2) / (1 + Math.sqrt(root));
  if (shape.type === "conic") {
    (shape.asphericCoeffs ?? []).forEach((a, j) => {
      w += a * r2 ** (j + 2); // A4·r², A6·r³, ... in r2 = u² + v²
    });
  }
  return w;
}
