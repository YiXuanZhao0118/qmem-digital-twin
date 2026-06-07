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

/** Decimate an already-welded indexed geometry to ~`targetTriangles`. */
export async function decimateWelded(
  welded: THREE.BufferGeometry,
  targetTriangles: number,
): Promise<THREE.BufferGeometry> {
  const simplifier = await loadSimplifier();
  const indexAttr = welded.getIndex();
  const positionAttr = welded.getAttribute("position");
  if (!indexAttr || !positionAttr) return welded.clone();

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
  if (targetIndexCount >= index.length) return welded.clone();

  const [newIndex] = simplifier.simplify(
    index,
    positions,
    3,
    targetIndexCount,
    TARGET_ERROR,
    ["LockBorder"],
  );

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
  return compact;
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
