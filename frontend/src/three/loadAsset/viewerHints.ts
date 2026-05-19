/**
 * Generic STL/GLB viewer-hint helpers (Stage A''.2).
 *
 * These take ``Asset3D.properties.viewerHints`` (alembic 0064) and
 * apply them to loaded geometry — STL triangle pruning, axis-radius
 * bulk filter, translucent housing material — so any catalog asset
 * with the same housing tricks gets one code path. Today's bespoke
 * isolator implementation in ``kinds/isolator/pbsOverlay.ts``
 * (``applyIsolatorDeletionFilter``, ``filterStlByAxisRadius``, the
 * inline translucent ``MeshStandardMaterial``) is the previous
 * one-off; once A''.4 migrates the existing isolator data into
 * ``Asset3D.properties.viewerHints``, the isolator path collapses
 * onto these helpers.
 *
 * The centroid-key rounding (0.5 mm grid) matches
 * ``pbsOverlay::isolatorCentroidKey`` exactly so previously saved
 * deletion sets keep working without re-keying.
 */
import * as THREE from "three";

import type { AssetViewerHints } from "../../types/digitalTwin";


/** 0.5 mm-grid rounding of a triangle centroid into a stable string
 *  key. Coarse enough to survive STL floating-point drift; fine
 *  enough that distinct triangles don't collide. */
export function centroidKey(cx: number, cy: number, cz: number): string {
  const r = (n: number) => Math.round(n * 2) / 2;
  return `${r(cx)},${r(cy)},${r(cz)}`;
}


/** Drop triangles whose centroid (via ``centroidKey``) is in the
 *  deletion set. Used by both the in-app PHY Editor "click to remove"
 *  flow (output saved to ``Asset3D.properties.viewerHints.deletedCentroids``)
 *  and the Lab viewer's render path. */
export function applyDeletionFilter(
  geometry: THREE.BufferGeometry,
  deletedCentroids: ReadonlyArray<string> | Set<string>,
): THREE.BufferGeometry {
  const set = deletedCentroids instanceof Set ? deletedCentroids : new Set(deletedCentroids);
  if (set.size === 0) return geometry;
  const positions = geometry.attributes.position.array as Float32Array;
  const triangleCount = Math.floor(positions.length / 9);
  const out: number[] = [];
  for (let t = 0; t < triangleCount; t += 1) {
    const o = t * 9;
    const cx = (positions[o + 0] + positions[o + 3] + positions[o + 6]) / 3;
    const cy = (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3;
    const cz = (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3;
    if (set.has(centroidKey(cx, cy, cz))) continue;
    for (let k = 0; k < 9; k += 1) out.push(positions[o + k]);
  }
  const newGeom = new THREE.BufferGeometry();
  newGeom.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  newGeom.computeVertexNormals();
  return newGeom;
}


/** Drop triangles whose centroid is within ``minRadiusMm`` of the
 *  given axis. Used to hide interior baffles + mounts that would
 *  otherwise show through a translucent housing — same effect as the
 *  isolator's ``filterStlByAxisRadius`` but exposed as a viewer hint
 *  any housing asset can opt into. */
export function applyAxisRadiusFilter(
  geometry: THREE.BufferGeometry,
  axisIdx: 0 | 1 | 2,
  minRadiusMm: number,
): THREE.BufferGeometry {
  if (minRadiusMm <= 0) return geometry;
  const positions = geometry.attributes.position.array as Float32Array;
  const triangleCount = Math.floor(positions.length / 9);
  const out: number[] = [];
  const minR2 = minRadiusMm * minRadiusMm;
  const p1 = ((axisIdx + 1) % 3) as 0 | 1 | 2;
  const p2 = ((axisIdx + 2) % 3) as 0 | 1 | 2;
  for (let t = 0; t < triangleCount; t += 1) {
    const o = t * 9;
    const c1 = (positions[o + p1] + positions[o + 3 + p1] + positions[o + 6 + p1]) / 3;
    const c2 = (positions[o + p2] + positions[o + 3 + p2] + positions[o + 6 + p2]) / 3;
    if (c1 * c1 + c2 * c2 < minR2) continue;
    for (let k = 0; k < 9; k += 1) out.push(positions[o + k]);
  }
  const newGeom = new THREE.BufferGeometry();
  newGeom.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  newGeom.computeVertexNormals();
  return newGeom;
}


/** Identify the longest bounding-box axis index (0 = X, 1 = Y, 2 = Z)
 *  of a geometry. Used as the default ``axisIdx`` for
 *  ``applyAxisRadiusFilter`` when a viewer hint doesn't specify one
 *  — interior baffles concentric with the optical bore typically
 *  align with the longest dimension. */
export function longestBboxAxis(geometry: THREE.BufferGeometry): 0 | 1 | 2 {
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox ?? new THREE.Box3();
  const sizeMm = new THREE.Vector3();
  bbox.getSize(sizeMm);
  if (sizeMm.y >= sizeMm.x && sizeMm.y >= sizeMm.z) return 1;
  if (sizeMm.z >= sizeMm.x && sizeMm.z > sizeMm.y) return 2;
  return 0;
}


/** Translucent metal housing material (alembic 0064
 *  ``viewerHints.material.translucent_housing``). The default 0.35
 *  opacity matches the bespoke isolator look in the WIP pbsOverlay so
 *  migrating an isolator to viewerHints lands visually identical.
 *  ``depthWrite: false`` keeps the internal sub-component bindings
 *  (PBS cubes, mounts) visible through the housing without z-fight. */
export function createTranslucentHousingMaterial(opacity = 0.35): THREE.Material {
  return new THREE.MeshStandardMaterial({
    color: "#1a1a1c",
    metalness: 0.55,
    roughness: 0.5,
    transparent: true,
    opacity,
    depthWrite: false,
  });
}


/** Top-level helper: run every viewer-hint geometry filter declared
 *  on an asset in canonical order (deletion → axis-radius), returning
 *  the resulting geometry. Material hints aren't included here — they
 *  apply to the Mesh, not the BufferGeometry — see ``materialForHints``
 *  for that path. */
export function applyViewerHintsToGeometry(
  geometry: THREE.BufferGeometry,
  hints: AssetViewerHints | undefined,
): THREE.BufferGeometry {
  if (!hints) return geometry;
  let out = geometry;
  if (hints.deletedCentroids && hints.deletedCentroids.length > 0) {
    out = applyDeletionFilter(out, hints.deletedCentroids);
  }
  if (typeof hints.axisRadiusFilterMm === "number" && hints.axisRadiusFilterMm > 0) {
    out = applyAxisRadiusFilter(out, longestBboxAxis(out), hints.axisRadiusFilterMm);
  }
  return out;
}


/** Material picker for viewer-hint-driven loads. Returns the requested
 *  material when the hint matches a known type, otherwise ``null`` —
 *  caller falls back to its default (``materialFor(component, state)``
 *  in the existing loader). */
export function materialForHints(hints: AssetViewerHints | undefined): THREE.Material | null {
  if (!hints?.material) return null;
  if (hints.material.type === "translucent_housing") {
    return createTranslucentHousingMaterial(hints.material.opacity);
  }
  return null;
}
