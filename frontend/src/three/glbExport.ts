/**
 * GLB export for the geometry construction page (Asset-layer M2 §B-1). Takes
 * the coloured, de-indexed geometries produced by `occtImport` and bakes them
 * into a single-material binary GLB whose vertex colours survive the round-trip
 * — so a freshly imported STEP can be saved as a viewer-ready, coloured asset
 * via the existing upload route, with no server-side conversion.
 */

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Merge several de-indexed coloured geometries into one. They must share the
 * same attribute set (position/normal/colour) — which `occtMeshToGeometry`
 * guarantees — otherwise the merge is rejected.
 */
export function mergeColoredGeometries(
  geometries: THREE.BufferGeometry[],
): THREE.BufferGeometry {
  if (geometries.length === 0) {
    throw new Error("No geometries to merge.");
  }
  if (geometries.length === 1) {
    return geometries[0];
  }
  const merged = mergeGeometries(geometries, false);
  if (!merged) {
    throw new Error(
      "Failed to merge geometries — mismatched attributes (position/normal/color).",
    );
  }
  return merged;
}

/** A coloured Mesh ready for preview or export from a baked geometry. */
export function geometryToColoredMesh(geometry: THREE.BufferGeometry): THREE.Mesh {
  return new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.1,
      roughness: 0.7,
    }),
  );
}

/**
 * Export a geometry (or pre-built object) to a binary GLB ArrayBuffer with
 * vertex colours preserved.
 */
export async function exportGlb(
  source: THREE.BufferGeometry | THREE.Object3D,
): Promise<ArrayBuffer> {
  const object =
    source instanceof THREE.BufferGeometry ? geometryToColoredMesh(source) : source;
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(object, { binary: true });
  if (!(result instanceof ArrayBuffer)) {
    throw new Error("GLTFExporter did not return a binary GLB.");
  }
  return result;
}

/** Wrap exported GLB bytes as a File for the existing multipart upload route. */
export function glbToFile(buffer: ArrayBuffer, catalogId: string): File {
  return new File([buffer], `${catalogId}.glb`, { type: "model/gltf-binary" });
}
