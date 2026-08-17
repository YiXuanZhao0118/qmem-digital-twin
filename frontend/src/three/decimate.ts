/**
 * Mesh decimation for the geometry construction page (Asset-layer M2 §B-2).
 * Wraps meshoptimizer's uniform quadric simplifier so an imported part can be
 * reduced to a target triangle budget with live preview, colour preserved.
 *
 * occt geometry is de-indexed (per-face vertex colours), which the simplifier
 * can't collapse. So we weld first (mergeVertices keeps colour/normal seams as
 * distinct vertices), simplify the index, then drop now-unused vertices and
 * re-weld to a compact *indexed* mesh — the compact form is what actually
 * shrinks the exported GLB.
 */

import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MeshoptSimplifier } from "meshoptimizer";

// Permissive error budget so the target triangle count is honoured (the user
// picks the budget via the slider; quality is theirs to trade off). LockBorder
// keeps open edges so flat parts don't lose their silhouette.
const TARGET_ERROR = 1.0;

export async function loadSimplifier() {
  await MeshoptSimplifier.ready;
  return MeshoptSimplifier;
}

/** Indexed, seam-preserving weld suitable for the simplifier. Cache the result
 *  and re-decimate from it rather than re-welding on every slider tick. */
export function weldForSimplify(source: THREE.BufferGeometry): THREE.BufferGeometry {
  return source.getIndex() ? source.clone() : mergeVertices(source);
}

/** Triangle count of a geometry (indexed or not). */
export function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return Math.floor(index.count / 3);
  const position = geometry.getAttribute("position");
  return position ? Math.floor(position.count / 3) : 0;
}

/** Rough uncompressed GLB byte size (Float32 attributes + index). Good enough
 *  for a live "~X MB" readout while dragging; the real size is known on save. */
export function estimateGlbBytes(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const color = geometry.getAttribute("color");
  const index = geometry.getIndex();
  const perVertex =
    (position ? 12 : 0) + (normal ? 12 : 0) + (color ? 12 : 0);
  const vertexCount = position ? position.count : 0;
  const indexBytes = index ? index.count * 4 : 0;
  return vertexCount * perVertex + indexBytes;
}

/** One decimated tier: the geometry plus how far it deviates from its source.
 *
 *  `errorMm` is meshoptimizer's simplification error converted to absolute
 *  units via `getScale()`. BUILD geometry is millimetres (uploads are treated
 *  as mm and the builder saves unit=mm scale=1), so the value is mm as-is; a
 *  caller working in other units must scale it. This number is what the
 *  renderer's screen-space-error LOD switch consumes — see objectives.md R-5. */
export interface DecimatedTier {
  geometry: THREE.BufferGeometry;
  triangles: number;
  errorMm: number;
}

/** Decimate an already-welded indexed geometry to ~`targetTriangles`. */
export async function decimateWelded(
  welded: THREE.BufferGeometry,
  targetTriangles: number,
): Promise<THREE.BufferGeometry> {
  return (await decimateWeldedTier(welded, targetTriangles)).geometry;
}

/** Decimate a set of triangle budgets off ONE welded source, returning each
 *  tier with its measured error. Every tier simplifies from the original
 *  rather than from the previous tier: chaining compounds quadric error and
 *  would make `errorMm` a lower bound instead of the deviation from LOD0.
 *
 *  Targets at or above the source triangle count yield the source unchanged
 *  (error 0) — a small asset legitimately has identical LOD1/LOD2. */
export async function decimateWeldedGraded(
  welded: THREE.BufferGeometry,
  targetTriangles: number[],
): Promise<DecimatedTier[]> {
  const tiers: DecimatedTier[] = [];
  for (const target of targetTriangles) {
    tiers.push(await decimateWeldedTier(welded, target));
  }
  return tiers;
}

/** Decimate an already-welded indexed geometry to ~`targetTriangles`,
 *  reporting the resulting absolute error. */
export async function decimateWeldedTier(
  welded: THREE.BufferGeometry,
  targetTriangles: number,
): Promise<DecimatedTier> {
  const simplifier = await loadSimplifier();
  const indexAttr = welded.getIndex();
  const positionAttr = welded.getAttribute("position");
  if (!indexAttr || !positionAttr) {
    const passthrough = welded.clone();
    return { geometry: passthrough, triangles: triangleCount(passthrough), errorMm: 0 };
  }

  const index =
    indexAttr.array instanceof Uint32Array
      ? indexAttr.array
      : new Uint32Array(indexAttr.array);
  const positions =
    positionAttr.array instanceof Float32Array
      ? positionAttr.array
      : new Float32Array(positionAttr.array as ArrayLike<number>);

  const targetIndexCount = Math.min(
    index.length,
    Math.max(3, Math.floor(targetTriangles) * 3),
  );
  if (targetIndexCount >= index.length) {
    const passthrough = welded.clone();
    return { geometry: passthrough, triangles: triangleCount(passthrough), errorMm: 0 };
  }

  // simplify() returns [index, error]; the error is RELATIVE to the mesh
  // extent, and getScale() converts it to absolute units. It used to be
  // discarded here — but it is exactly what the LOD switch needs (R-5), so
  // dropping it made the tiers unusable for anything but a size budget.
  const [newIndex, relativeError] = simplifier.simplify(
    index,
    positions,
    3,
    targetIndexCount,
    TARGET_ERROR,
    ["LockBorder"],
  );
  const errorMm = relativeError * simplifier.getScale(positions, 3);

  // Expand the simplified index into a de-indexed geometry (this drops the
  // vertices it no longer references), then mergeVertices welds it back into a
  // compact *indexed* mesh — the form that actually shrinks the GLB. Building
  // the arrays by hand avoids three's toNonIndexed, which warns (noisily, per
  // slider tick) when handed an already-non-indexed geometry.
  const normalAttr = welded.getAttribute("normal");
  const colorAttr = welded.getAttribute("color");
  const n = newIndex.length;
  const outPos = new Float32Array(n * 3);
  const outNormal = normalAttr ? new Float32Array(n * 3) : null;
  const outColor = colorAttr ? new Float32Array(n * 3) : null;
  for (let i = 0; i < n; i++) {
    const vi = newIndex[i];
    outPos[i * 3] = positionAttr.getX(vi);
    outPos[i * 3 + 1] = positionAttr.getY(vi);
    outPos[i * 3 + 2] = positionAttr.getZ(vi);
    if (outNormal && normalAttr) {
      outNormal[i * 3] = normalAttr.getX(vi);
      outNormal[i * 3 + 1] = normalAttr.getY(vi);
      outNormal[i * 3 + 2] = normalAttr.getZ(vi);
    }
    if (outColor && colorAttr) {
      outColor[i * 3] = colorAttr.getX(vi);
      outColor[i * 3 + 1] = colorAttr.getY(vi);
      outColor[i * 3 + 2] = colorAttr.getZ(vi);
    }
  }
  const expanded = new THREE.BufferGeometry();
  expanded.setAttribute("position", new THREE.BufferAttribute(outPos, 3));
  if (outNormal) expanded.setAttribute("normal", new THREE.BufferAttribute(outNormal, 3));
  if (outColor) expanded.setAttribute("color", new THREE.BufferAttribute(outColor, 3));
  const compact = mergeVertices(expanded);
  expanded.dispose();
  return { geometry: compact, triangles: triangleCount(compact), errorMm };
}

/** Convenience: weld + decimate in one call (used by tests / one-shot paths). */
export async function decimateGeometry(
  source: THREE.BufferGeometry,
  targetTriangles: number,
): Promise<THREE.BufferGeometry> {
  const welded = weldForSimplify(source);
  const out = await decimateWelded(welded, targetTriangles);
  if (welded !== source) welded.dispose();
  return out;
}
