import * as THREE from "three";

import type { Asset3D, ComponentItem } from "../../../types/digitalTwin";

// Render the Thorlabs WPHSM05-850 mounted half-wave plate as black anodized
// SM05 mount + green-tinted glass waveplate disc in the centre. The STL
// already contains the disc as a separate body inside the mount; we
// partition triangles by (centroid radial distance from the optical axis)
// AND (normal alignment with the optical axis) to extract the disc faces.
export function isWphsm05Asset(asset: Asset3D): boolean {
  return asset.name === "thorlabs_wphsm05_850_stl"
    || /thorlabs_wphsm05_850\.stl$/i.test(asset.filePath);
}

export function buildWphsm05WaveplateObject(
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
  const radialAxes: [0 | 1 | 2, 0 | 1 | 2] = [
    [1, 2], [0, 2], [0, 1],
  ][axisIdx] as [0 | 1 | 2, 0 | 1 | 2];
  const radialCenters: [number, number] = [
    (bbox.min.getComponent(radialAxes[0]) + bbox.max.getComponent(radialAxes[0])) / 2,
    (bbox.min.getComponent(radialAxes[1]) + bbox.max.getComponent(radialAxes[1])) / 2,
  ];
  const outerRadius = Math.max(
    size.getComponent(radialAxes[0]),
    size.getComponent(radialAxes[1]),
  ) / 2;
  // Empirically the WPHSM05-850 STL has the glass disc as a clean 44-triangle
  // ring at radial distance < 5 mm; jumps to 2k+ triangles at >5 mm where the
  // mount's internal seating surface starts. 0.58 of the 8.89 mm outer radius
  // captures the disc cleanly without dragging in mount features.
  const apertureRadius = outerRadius * 0.58;
  const glassRadiusSq = apertureRadius * apertureRadius;

  const triangleCount = Math.floor(positionAttr.count / 3);
  const glassTris: number[] = [];
  const mountTris: number[] = [];
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

    const rA =
      (v1.getComponent(radialAxes[0]) + v2.getComponent(radialAxes[0]) + v3.getComponent(radialAxes[0])) / 3
      - radialCenters[0];
    const rB =
      (v1.getComponent(radialAxes[1]) + v2.getComponent(radialAxes[1]) + v3.getComponent(radialAxes[1])) / 3
      - radialCenters[1];
    const radialSq = rA * rA + rB * rB;
    const normalAxisAbs = Math.abs(normal.getComponent(axisIdx));
    const isGlass = radialSq < glassRadiusSq && normalAxisAbs > 0.85;
    (isGlass ? glassTris : mountTris).push(t);
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

  const blackMount = new THREE.MeshStandardMaterial({
    color: "#1a1a1c",
    metalness: 0.25,
    roughness: 0.55,
  });

  const waveplateGlass = new THREE.MeshPhysicalMaterial({
    color: "#dceee3",
    metalness: 0.0,
    roughness: 0.05,
    transmission: 1.0,
    thickness: 0.04,
    ior: 1.55,
    attenuationColor: new THREE.Color("#a8ccb9"),
    attenuationDistance: 0.6,
    transparent: false,
    opacity: 1,
    envMapIntensity: 1.3,
  });

  const group = new THREE.Group();
  group.name = component.name;

  const mountMesh = new THREE.Mesh(buildSubGeometry(mountTris), blackMount);
  mountMesh.renderOrder = 0;
  group.add(mountMesh);

  if (glassTris.length > 0) {
    const glassMesh = new THREE.Mesh(buildSubGeometry(glassTris), waveplateGlass);
    glassMesh.renderOrder = 1;
    group.add(glassMesh);
  }

  geometry.dispose();
  return group;
}
