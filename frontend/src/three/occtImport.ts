/**
 * Browser-side STEP importer (Asset-layer M2 §B-1). Wraps `occt-import-js`
 * (OpenCASCADE compiled to WASM) so a STEP file can be parsed entirely in the
 * browser into three.js-ready geometry — colour included — with no server-side
 * FreeCAD step (which is retired for in-app use; see Asset-layer M1 §A-2).
 *
 * The WASM module is multiple MB, so it is loaded lazily on first use and
 * cached: importing this module is cheap; the WASM only downloads when
 * `importStep`/`loadOcct` is actually called.
 */

import * as THREE from "three";

/** One b-rep face's triangle range + its colour (null = inherit mesh colour). */
export interface OcctBrepFace {
  first: number;
  last: number;
  color: [number, number, number] | null;
}

/** A single mesh from the import — geometry layout matches three.js. */
export interface OcctMesh {
  name: string;
  /** Mesh-level colour, r/g/b in 0..1. Optional (some STEP files carry none). */
  color?: [number, number, number];
  brep_faces: OcctBrepFace[];
  attributes: {
    position: { array: number[] };
    normal?: { array: number[] };
  };
  index: { array: number[] };
}

/** Assembly-tree node; `meshes` are indices into `OcctImportResult.meshes`. */
export interface OcctNode {
  name: string;
  meshes: number[];
  children: OcctNode[];
}

export interface OcctImportResult {
  success: boolean;
  root: OcctNode;
  meshes: OcctMesh[];
}

/** Triangulation parameters accepted by `ReadStepFile` (all optional). */
export interface OcctReadParams {
  linearUnit?: "millimeter" | "centimeter" | "meter" | "inch" | "foot";
  linearDeflectionType?: "bounding_box_ratio" | "absolute_value";
  linearDeflection?: number;
  angularDeflection?: number;
}

interface OcctModule {
  ReadStepFile(content: Uint8Array, params: OcctReadParams | null): OcctImportResult;
}

/** Maps an emscripten asset path (e.g. `occt-import-js.wasm`) to a real URL.
 *  The browser build passes one pointing at the Vite-served wasm; node (tests)
 *  resolves the wasm via the filesystem and needs none. */
export type OcctLocateFile = (path: string) => string;

let occtPromise: Promise<OcctModule> | null = null;

/** Lazily instantiate (and cache) the OpenCASCADE WASM module. */
export async function loadOcct(locateFile?: OcctLocateFile): Promise<OcctModule> {
  if (!occtPromise) {
    occtPromise = import("occt-import-js").then(
      (mod) =>
        mod.default(locateFile ? { locateFile } : undefined) as Promise<OcctModule>,
    );
  }
  return occtPromise;
}

/**
 * Parse a STEP file into meshes + an assembly tree. Throws if OpenCASCADE
 * reports failure (malformed file, unsupported schema, …).
 */
export async function importStep(
  data: Uint8Array,
  params: OcctReadParams | null = null,
  locateFile?: OcctLocateFile,
): Promise<OcctImportResult> {
  const occt = await loadOcct(locateFile);
  const result = occt.ReadStepFile(data, params);
  if (!result.success) {
    throw new Error("occt-import-js failed to parse the STEP file.");
  }
  return result;
}

const DEFAULT_COLOR: [number, number, number] = [0.8, 0.8, 0.8];

/**
 * Convert one imported mesh into a three.js BufferGeometry, baking the b-rep
 * per-face colours into a vertex-colour attribute.
 *
 * CAD colour is defined per face, not per vertex, so shared vertices on a
 * colour boundary would clash. We de-index (expand each triangle to its own
 * three vertices) so every triangle carries its face colour independently —
 * which is also exactly what a single-material coloured GLB needs.
 */
export function occtMeshToGeometry(mesh: OcctMesh): THREE.BufferGeometry {
  const srcPos = mesh.attributes.position.array;
  const srcNormal = mesh.attributes.normal?.array ?? null;
  const idx = mesh.index.array;
  const triCount = Math.floor(idx.length / 3);
  const meshColor = mesh.color ?? DEFAULT_COLOR;

  // Per-triangle colour: start from the mesh fallback, then stamp each face's
  // triangle range. One pass over faces, not a lookup per triangle.
  const triColors: Array<[number, number, number]> = new Array(triCount).fill(meshColor);
  for (const face of mesh.brep_faces) {
    const color = face.color ?? meshColor;
    for (let t = face.first; t <= face.last && t < triCount; t++) {
      triColors[t] = color;
    }
  }

  const vertCount = triCount * 3;
  const positions = new Float32Array(vertCount * 3);
  const normals = srcNormal ? new Float32Array(vertCount * 3) : null;
  const colors = new Float32Array(vertCount * 3);

  for (let t = 0; t < triCount; t++) {
    const [r, g, b] = triColors[t];
    for (let k = 0; k < 3; k++) {
      const vi = idx[t * 3 + k];
      const o = (t * 3 + k) * 3;
      positions[o] = srcPos[vi * 3];
      positions[o + 1] = srcPos[vi * 3 + 1];
      positions[o + 2] = srcPos[vi * 3 + 2];
      if (normals && srcNormal) {
        normals[o] = srcNormal[vi * 3];
        normals[o + 1] = srcNormal[vi * 3 + 1];
        normals[o + 2] = srcNormal[vi * 3 + 2];
      }
      colors[o] = r;
      colors[o + 1] = g;
      colors[o + 2] = b;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (normals) {
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  } else {
    geometry.computeVertexNormals();
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Merge every mesh of an import into a single coloured BufferGeometry. */
export function occtResultToGeometry(result: OcctImportResult): THREE.BufferGeometry[] {
  return result.meshes.map(occtMeshToGeometry);
}
