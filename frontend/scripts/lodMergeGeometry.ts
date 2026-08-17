/**
 * Flatten a loaded GLB scene into ONE world-space geometry for decimation.
 *
 * The simplifier works on a single index/position pair, but a CAD-derived GLB
 * is typically hundreds of meshes under a transform hierarchy. Merging first
 * is therefore required, not an optimisation — and it has a second payoff: the
 * resulting tier is one draw call instead of hundreds, which is what actually
 * moves R-6's ≤ 2000 draw-call budget on a multi-part board. Triangle count
 * alone was never the whole story there.
 *
 * Attributes are reduced to position + normal + colour: those are what
 * `decimate.ts` carries through and what `geometryToColoredMesh` re-exports.
 * Per-mesh materials are collapsed into vertex colours, so a merged tier keeps
 * the part's colouring without needing the original material list.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export function mergeGeometriesForLod(root: THREE.Object3D): THREE.BufferGeometry | null {
  root.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!(mesh instanceof THREE.Mesh) || !mesh.geometry) return;
    const source = mesh.geometry;
    const position = source.getAttribute("position");
    if (!position) return;

    // Bake the world transform so merged parts keep their relative placement.
    const geometry = source.clone().applyMatrix4(mesh.matrixWorld);
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();

    // Fold the material colour into vertex colours so one merged mesh can
    // still show a multi-coloured assembly.
    if (!geometry.getAttribute("color")) {
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const colour = (material as THREE.MeshStandardMaterial | undefined)?.color
        ?? new THREE.Color(0.8, 0.8, 0.8);
      const count = geometry.getAttribute("position").count;
      const colours = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        colours[i * 3] = colour.r;
        colours[i * 3 + 1] = colour.g;
        colours[i * 3 + 2] = colour.b;
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    }

    // mergeGeometries requires identical attribute sets across inputs.
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== "position" && name !== "normal" && name !== "color") {
        geometry.deleteAttribute(name);
      }
    }
    geometry.morphAttributes = {};
    parts.push(geometry);
  });

  if (parts.length === 0) return null;
  const merged = parts.length === 1 ? parts[0].clone() : mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}
