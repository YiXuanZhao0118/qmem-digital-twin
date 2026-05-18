import * as THREE from "three";

import type { Asset3D, ComponentItem } from "../../../types/digitalTwin";

// Render the Thorlabs BB1-E03 broadband dielectric mirror as glass body +
// pink iridescent reflective coating, instead of the default flat-grey STL
// look. Front face = the optical/coated face (bears the BB1-E03 THORLABS
// engraving in the photo); body = green-tinted glass substrate.
//
// The STEP→STL export from FreeCAD produces a non-indexed mesh oriented
// along whichever axis the original Thorlabs CAD used. We auto-detect the
// disc axis (= smallest bbox dimension) and partition triangles by face
// normal × axial position into two sub-meshes. The "+axis" flat face is
// designated as the optical face; if the user later finds the wrong face
// is coated, we expose a `frontFaceAxisSign` property override.
export function isBB1E03Asset(asset: Asset3D): boolean {
  return asset.name === "thorlabs_bb1_e03_stl"
    || /thorlabs_bb1_e03\.stl$/i.test(asset.filePath);
}

export function buildBB1E03MirrorObject(
  geometry: THREE.BufferGeometry,
  component: ComponentItem,
): THREE.Object3D {
  const positionAttr = geometry.attributes.position as THREE.BufferAttribute;
  const oldPositions = positionAttr.array as Float32Array;

  const bbox = new THREE.Box3().setFromBufferAttribute(positionAttr);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  let axisIdx: 0 | 1 | 2 = 0;
  if (size.y < size.x && size.y < size.z) axisIdx = 1;
  else if (size.z < size.x && size.z < size.y) axisIdx = 2;
  const axisCenter =
    (bbox.min.getComponent(axisIdx) + bbox.max.getComponent(axisIdx)) / 2;

  const frontSign = (() => {
    const raw = (component.properties as { frontFaceAxisSign?: number } | undefined)
      ?.frontFaceAxisSign;
    return raw === -1 ? -1 : 1;
  })();

  const triangleCount = Math.floor(positionAttr.count / 3);
  const frontTris: number[] = [];
  const bodyTris: number[] = [];
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

    const normalAxisComp = normal.getComponent(axisIdx) * frontSign;
    const centroidAxis =
      (v1.getComponent(axisIdx) + v2.getComponent(axisIdx) + v3.getComponent(axisIdx)) / 3;
    const centroidSide = (centroidAxis - axisCenter) * frontSign;
    const isFrontFace = normalAxisComp > 0.85 && centroidSide > 0;
    (isFrontFace ? frontTris : bodyTris).push(t);
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

  const opticalCoating = new THREE.MeshPhysicalMaterial({
    color: "#ec9fb6",
    metalness: 0.25,
    roughness: 0.12,
    iridescence: 1.0,
    iridescenceIOR: 1.45,
    iridescenceThicknessRange: [180, 540],
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
    sheen: 0.4,
    sheenColor: new THREE.Color("#7ab8ff"),
    envMapIntensity: 1.4,
  });

  const glassBody = new THREE.MeshPhysicalMaterial({
    color: "#e3f1ea",
    metalness: 0.0,
    roughness: 0.04,
    transmission: 1.0,
    thickness: 0.06,
    ior: 1.52,
    attenuationColor: new THREE.Color("#bedacd"),
    attenuationDistance: 0.6,
    transparent: false,
    opacity: 1,
    envMapIntensity: 1.4,
  });

  const group = new THREE.Group();
  group.name = component.name;

  const bodyMesh = new THREE.Mesh(buildSubGeometry(bodyTris), glassBody);
  bodyMesh.renderOrder = 0;
  group.add(bodyMesh);

  const frontMesh = new THREE.Mesh(buildSubGeometry(frontTris), opticalCoating);
  frontMesh.renderOrder = 1;
  group.add(frontMesh);

  geometry.dispose();
  return group;
}
