/**
 * Load an existing viewer-ready asset (GLB/GLTF/OBJ/STL) into a single coloured
 * BufferGeometry the Geometry Builder can treat as a "part" — mergeable with
 * occt-imported parts (same position/normal/colour, de-indexed). Lets the
 * builder use existing Asset3D rows as sources (Asset-layer §B-4 / the
 * "edit existing asset geometry" flow), not just freshly uploaded STEP files.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const DEFAULT_COLOR = new THREE.Color(0.8, 0.8, 0.8);

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

  if (existingColor && existingColor.count === count) {
    const c = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      c[i * 3] = existingColor.getX(i);
      c[i * 3 + 1] = existingColor.getY(i);
      c[i * 3 + 2] = existingColor.getZ(i);
    }
    out.setAttribute("color", new THREE.BufferAttribute(c, 3));
  } else {
    const c = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      c[i * 3] = fallback.r;
      c[i * 3 + 1] = fallback.g;
      c[i * 3 + 2] = fallback.b;
    }
    out.setAttribute("color", new THREE.BufferAttribute(c, 3));
  }
  return out;
}

function meshColor(mesh: THREE.Mesh): THREE.Color {
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const c = (mat as THREE.MeshStandardMaterial | undefined)?.color;
  return c ? c.clone() : DEFAULT_COLOR.clone();
}

function collectColoredFromObject(root: THREE.Object3D): THREE.BufferGeometry[] {
  root.updateMatrixWorld(true);
  const geoms: THREE.BufferGeometry[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    geoms.push(toMergeableColored(g, meshColor(mesh)));
    g.dispose();
  });
  return geoms;
}

function mergeOrSingle(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geoms.length === 0) {
    throw new Error("Asset contained no renderable meshes.");
  }
  if (geoms.length === 1) return geoms[0];
  const merged = mergeGeometries(geoms, false);
  if (!merged) throw new Error("Failed to merge the asset's meshes.");
  return merged;
}

/** Load a viewer-ready asset file into one coloured, mergeable geometry. */
export async function loadAssetGeometry(
  url: string,
  ext: string,
): Promise<THREE.BufferGeometry> {
  const e = ext.toLowerCase();
  if (e === "glb" || e === "gltf") {
    const gltf = await new GLTFLoader().loadAsync(url);
    return mergeOrSingle(collectColoredFromObject(gltf.scene));
  }
  if (e === "obj") {
    const obj = await new OBJLoader().loadAsync(url);
    return mergeOrSingle(collectColoredFromObject(obj));
  }
  if (e === "stl") {
    const geometry = await new STLLoader().loadAsync(url);
    geometry.computeVertexNormals();
    return toMergeableColored(geometry, DEFAULT_COLOR.clone());
  }
  throw new Error(`Cannot load .${ext} in the builder (need GLB/GLTF/OBJ/STL).`);
}
