import * as THREE from "three";

import type { Asset3D, ComponentItem } from "../../../types/digitalTwin";

// Render the Thorlabs PBS252 polarising beam splitter cube as clear glass
// with frosted top/bottom faces. The STEP→STL export already contains the
// engraved "PBS252" text + arrows on the +Y face as fine triangle detail
// (see top-face triangle count vs flat bottom), so we don't need to add a
// sprite — making the top frosted naturally lets the engravings catch
// light. Iridescence on the body fakes the diagonal coating's pink/purple
// sheen visible in the product photo.
export function isPbs252Asset(asset: Asset3D): boolean {
  return asset.name === "thorlabs_pbs252_stl"
    || /thorlabs_pbs252\.stl$/i.test(asset.filePath);
}

export function buildPbs252BeamSplitterObject(
  geometry: THREE.BufferGeometry,
  component: ComponentItem,
): THREE.Object3D {
  const positionAttr = geometry.attributes.position as THREE.BufferAttribute;
  const oldPositions = positionAttr.array as Float32Array;

  const topAxisStr = (component.properties as { topAxis?: string } | undefined)?.topAxis;
  const topAxisIdx: 0 | 1 | 2 =
    topAxisStr === "x" ? 0 : topAxisStr === "z" ? 2 : 1;

  const triangleCount = Math.floor(positionAttr.count / 3);
  const frostedTris: number[] = [];
  const clearTris: number[] = [];
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let t = 0; t < triangleCount; t += 1) {
    const o = t * 9;
    v1.set(oldPositions[o + 0], oldPositions[o + 1], oldPositions[o + 2]);
    v2.set(oldPositions[o + 3], oldPositions[o + 4], oldPositions[o + 5]);
    v3.set(oldPositions[o + 6], oldPositions[o + 7], oldPositions[o + 8]);
    e1.subVectors(v2, v1);
    e2.subVectors(v3, v1);
    normal.crossVectors(e1, e2).normalize();

    const isFrostedFace = Math.abs(normal.getComponent(topAxisIdx)) > 0.85;
    (isFrostedFace ? frostedTris : clearTris).push(t);
  }

  const buildSubGeometry = (triangleIndices: number[]): THREE.BufferGeometry => {
    const sub = new THREE.BufferGeometry();
    const buf = new Float32Array(triangleIndices.length * 9);
    for (let i = 0; i < triangleIndices.length; i += 1) {
      const srcOff = triangleIndices[i] * 9;
      const dstOff = i * 9;
      for (let k = 0; k < 9; k += 1) buf[dstOff + k] = oldPositions[srcOff + k];
    }
    sub.setAttribute("position", new THREE.BufferAttribute(buf, 3));
    sub.computeVertexNormals();
    return sub;
  };

  // Three.js docs: "When using transmission, set transparent to false." The
  // transmission render pass already provides the see-through effect; layering
  // it under transparent: true causes double-sorting and a milky look.
  const clearGlass = new THREE.MeshPhysicalMaterial({
    color: "#f4faf6",
    metalness: 0.0,
    roughness: 0.04,
    transmission: 1.0,
    thickness: 0.25,
    ior: 1.52,
    attenuationColor: new THREE.Color("#d0e7dc"),
    attenuationDistance: 1.2,
    iridescence: 0.55,
    iridescenceIOR: 1.4,
    iridescenceThicknessRange: [220, 580],
    transparent: false,
    opacity: 1,
    envMapIntensity: 1.5,
  });

  const frostedGlass = new THREE.MeshPhysicalMaterial({
    color: "#eef3ee",
    metalness: 0.0,
    roughness: 0.7,
    transmission: 0.6,
    thickness: 0.18,
    ior: 1.5,
    transparent: false,
    opacity: 1,
    envMapIntensity: 0.9,
  });

  const group = new THREE.Group();
  group.name = component.name;

  const clearMesh = new THREE.Mesh(buildSubGeometry(clearTris), clearGlass);
  clearMesh.renderOrder = 0;
  group.add(clearMesh);

  const frostedMesh = new THREE.Mesh(buildSubGeometry(frostedTris), frostedGlass);
  frostedMesh.renderOrder = 1;
  group.add(frostedMesh);

  geometry.dispose();
  return group;
}
