/**
 * Load an existing viewer-ready asset (GLB/GLTF/OBJ/STL) into its individual
 * sub-meshes — each a coloured BufferGeometry mergeable with occt-imported
 * parts. Returning the sub-meshes (rather than one merged blob) lets the
 * Geometry Builder remove unwanted regions of an existing asset, the same way a
 * multi-body STEP can be trimmed (Asset-layer §B-3 / III-4 remove-regions).
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

const DEFAULT_COLOR = new THREE.Color(0.8, 0.8, 0.8);

export type LoadedSubMesh = { geometry: THREE.BufferGeometry; label: string };

/** Normalise any geometry to a de-indexed mesh carrying exactly
 *  position + normal + colour, so it merges with occt/other parts. */
function toMergeableColored(
  geometry: THREE.BufferGeometry,
  fallback: THREE.Color,
): THREE.BufferGeometry {
  const src = geometry.index ? geometry.toNonIndexed() : geometry;
  if (!src.getAttribute("normal")) src.computeVertexNormals();

  const position = src.getAttribute("position");
  const normal = src.getAttribute("normal");
  const existingColor = src.getAttribute("color");
  const count = position.count;

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(position.array), 3));
  out.setAttribute("normal", new THREE.BufferAttribute(Float32Array.from(normal.array), 3));

  const colors = new Float32Array(count * 3);
  if (existingColor && existingColor.count === count) {
    for (let i = 0; i < count; i++) {
      colors[i * 3] = existingColor.getX(i);
      colors[i * 3 + 1] = existingColor.getY(i);
      colors[i * 3 + 2] = existingColor.getZ(i);
    }
  } else {
    for (let i = 0; i < count; i++) {
      colors[i * 3] = fallback.r;
      colors[i * 3 + 1] = fallback.g;
      colors[i * 3 + 2] = fallback.b;
    }
  }
  out.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return out;
}

function meshColor(mesh: THREE.Mesh): THREE.Color {
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const c = (mat as THREE.MeshStandardMaterial | undefined)?.color;
  return c ? c.clone() : DEFAULT_COLOR.clone();
}

export function collectSubMeshes(root: THREE.Object3D): LoadedSubMesh[] {
  root.updateMatrixWorld(true);
  const out: LoadedSubMesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    out.push({
      geometry: toMergeableColored(g, meshColor(mesh)),
      label: mesh.name && mesh.name.trim() ? mesh.name : `mesh ${out.length + 1}`,
    });
    g.dispose();
  });
  return out;
}

/** Load a viewer-ready asset file into its sub-meshes (each coloured + in mm). */
export async function loadAssetGeometry(
  url: string,
  ext: string,
  opts?: { unit?: string; scaleFactor?: number },
): Promise<LoadedSubMesh[]> {
  const e = ext.toLowerCase();
  let subs: LoadedSubMesh[];
  if (e === "glb" || e === "gltf") {
    const gltf = await new GLTFLoader().loadAsync(url);
    subs = collectSubMeshes(gltf.scene);
  } else if (e === "obj") {
    const obj = await new OBJLoader().loadAsync(url);
    subs = collectSubMeshes(obj);
  } else if (e === "stl") {
    const stl = await new STLLoader().loadAsync(url);
    stl.computeVertexNormals();
    subs = [{ geometry: toMergeableColored(stl, DEFAULT_COLOR.clone()), label: "mesh" }];
  } else {
    throw new Error(`Cannot load .${ext} in the builder (need GLB/GLTF/OBJ/STL).`);
  }
  if (subs.length === 0) throw new Error("Asset contained no renderable meshes.");

  // Normalise to millimetres — occt STEP parts are mm, but assets stored in
  // metres would otherwise load 1000x too small and vanish next to mm parts.
  const factor = (opts?.scaleFactor ?? 1) * (opts?.unit === "m" ? 1000 : 1);
  if (factor !== 1) {
    const m = new THREE.Matrix4().makeScale(factor, factor, factor);
    for (const s of subs) s.geometry.applyMatrix4(m);
  }
  return subs;
}
