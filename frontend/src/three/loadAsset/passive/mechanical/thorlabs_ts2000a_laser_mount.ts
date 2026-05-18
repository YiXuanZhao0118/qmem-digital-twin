import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../../types/digitalTwin";
import { getDimensionsMm, mmToThree } from "../../../transformUtils";
import { materialFor } from "../../materials";

export function createTs2000aLaserMount(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const [lengthMm, widthMm, heightMm] = getDimensionsMm(component.properties, [72.6, 50.8, 44.5]);
  const length = mmToThree(lengthMm);
  const width = mmToThree(widthMm);
  const height = mmToThree(heightMm);
  const group = new THREE.Group();

  const bodyMaterial = materialFor(component, state);
  const darkMaterial = new THREE.MeshStandardMaterial({ color: "#111827", metalness: 0.45, roughness: 0.34 });
  const blackInset = new THREE.MeshStandardMaterial({ color: "#020617", metalness: 0.25, roughness: 0.5 });
  const connectorMaterial = new THREE.MeshStandardMaterial({ color: "#d1d5db", metalness: 0.82, roughness: 0.18 });
  const pinMaterial = new THREE.MeshStandardMaterial({ color: "#f8fafc", metalness: 0.9, roughness: 0.2 });
  const goldMaterial = new THREE.MeshStandardMaterial({ color: "#b7791f", metalness: 0.7, roughness: 0.25 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(length, height, width), bodyMaterial);
  body.position.y = height / 2;
  group.add(body);

  const rearBlock = new THREE.Mesh(new THREE.BoxGeometry(length * 0.2, height * 1.02, width * 1.02), bodyMaterial);
  rearBlock.position.set(-length * 0.4, height * 0.51, 0);
  group.add(rearBlock);

  const coverHeight = mmToThree(2.6);
  const cover = new THREE.Mesh(new THREE.BoxGeometry(length * 0.56, coverHeight, width * 0.94), bodyMaterial);
  cover.position.set(length * 0.08, height + coverHeight / 2, 0);
  group.add(cover);

  const coverSeam = new THREE.Mesh(new THREE.BoxGeometry(mmToThree(1.2), mmToThree(1.2), width * 1.03), darkMaterial);
  coverSeam.position.set(-length * 0.28, height + mmToThree(0.7), 0);
  group.add(coverSeam);

  const zifSocket = new THREE.Mesh(
    new THREE.BoxGeometry(length * 0.18, mmToThree(3), width * 0.18),
    goldMaterial,
  );
  zifSocket.position.set(length * 0.43, height * 0.36, 0);
  group.add(zifSocket);

  const frontX = length / 2 + mmToThree(0.9);
  const apertureFrame = new THREE.Mesh(new THREE.BoxGeometry(mmToThree(2.2), height * 0.48, width * 0.58), darkMaterial);
  apertureFrame.position.set(frontX, height * 0.48, 0);
  group.add(apertureFrame);

  const apertureVoid = new THREE.Mesh(new THREE.BoxGeometry(mmToThree(2.6), height * 0.33, width * 0.42), blackInset);
  apertureVoid.position.set(frontX + mmToThree(0.45), height * 0.48, 0);
  group.add(apertureVoid);

  const opticalNose = new THREE.Mesh(new THREE.CylinderGeometry(mmToThree(2.2), mmToThree(2.2), mmToThree(5.5), 24), blackInset);
  opticalNose.rotation.z = Math.PI / 2;
  opticalNose.position.set(frontX + mmToThree(2), height * 0.34, 0);
  group.add(opticalNose);

  const clampPost = new THREE.Mesh(new THREE.CylinderGeometry(mmToThree(1.5), mmToThree(1.5), height * 0.56, 24), connectorMaterial);
  clampPost.position.set(length * 0.37, height + height * 0.24, 0);
  group.add(clampPost);

  const knob = new THREE.Mesh(new THREE.CylinderGeometry(mmToThree(6), mmToThree(6), mmToThree(4), 32), connectorMaterial);
  knob.position.set(length * 0.37, height + height * 0.56, 0);
  group.add(knob);

  const spring = new THREE.Mesh(new THREE.TorusGeometry(mmToThree(4.2), mmToThree(0.45), 8, 28), connectorMaterial);
  spring.rotation.x = Math.PI / 2;
  spring.position.set(length * 0.37, height + mmToThree(4), 0);
  group.add(spring);

  for (const z of [-1, 1]) {
    for (const y of [0.33, 0.67]) {
      const cageHole = new THREE.Mesh(new THREE.CylinderGeometry(mmToThree(2.0), mmToThree(2.0), mmToThree(1.5), 20), blackInset);
      cageHole.rotation.z = Math.PI / 2;
      cageHole.position.set(frontX + mmToThree(1), height * y, z * width * 0.3);
      group.add(cageHole);
    }
  }

  const rearX = -length / 2 - mmToThree(1.5);
  const connectorSpecs = [
    { y: height * 0.68, pinCount: 15, connectorWidth: width * 0.56 },
    { y: height * 0.28, pinCount: 9, connectorWidth: width * 0.4 },
  ];

  for (const spec of connectorSpecs) {
    const connector = new THREE.Mesh(new THREE.BoxGeometry(mmToThree(3), height * 0.2, spec.connectorWidth), connectorMaterial);
    connector.position.set(rearX, spec.y, 0);
    group.add(connector);

    for (let index = 0; index < spec.pinCount; index += 1) {
      const row = index % 2;
      const column = Math.floor(index / 2);
      const columns = Math.ceil(spec.pinCount / 2);
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(mmToThree(0.45), mmToThree(0.45), mmToThree(2.2), 12), pinMaterial);
      pin.rotation.z = Math.PI / 2;
      pin.position.set(
        rearX - mmToThree(2.3),
        spec.y + (row - 0.5) * height * 0.07,
        (column - (columns - 1) / 2) * (spec.connectorWidth / columns) * 0.72,
      );
      group.add(pin);
    }

    for (const z of [-1, 1]) {
      const jackScrew = new THREE.Mesh(new THREE.CylinderGeometry(mmToThree(1.8), mmToThree(1.8), mmToThree(2.2), 18), connectorMaterial);
      jackScrew.rotation.z = Math.PI / 2;
      jackScrew.position.set(rearX - mmToThree(1), spec.y, z * spec.connectorWidth * 0.68);
      group.add(jackScrew);
    }
  }

  const finCount = 6;
  for (let index = 0; index < finCount; index += 1) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(mmToThree(2.2), height * 0.5, mmToThree(2.6)), darkMaterial);
    fin.position.set(length * (-0.02 + index * 0.085), height * 0.25, -width / 2 - mmToThree(1.2));
    group.add(fin);
  }

  for (const x of [-0.28, 0.28]) {
    for (const z of [-0.28, 0.28]) {
      const topHole = new THREE.Mesh(new THREE.CylinderGeometry(mmToThree(1.7), mmToThree(1.7), mmToThree(1.1), 20), blackInset);
      topHole.position.set(x * length, height + coverHeight + mmToThree(0.65), z * width * 0.72);
      group.add(topHole);
    }
  }

  for (const x of [-0.25, 0.36]) {
    const quarterTwenty = new THREE.Mesh(new THREE.CylinderGeometry(mmToThree(3.3), mmToThree(3.3), mmToThree(1.4), 24), blackInset);
    quarterTwenty.position.set(x * length, height + coverHeight + mmToThree(0.9), 0);
    group.add(quarterTwenty);
  }

  return group;
}
