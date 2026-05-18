import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../../types/digitalTwin";
import { mmToThree } from "../../../transformUtils";
import { materialFor } from "../../materials";

export function createThorlabsClampingFork(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  const material = materialFor(component, state);
  const plateHeight = mmToThree(7);
  const armLength = mmToThree(58);
  const armWidth = mmToThree(13);
  const gap = mmToThree(18);
  const crossbar = new THREE.Mesh(new THREE.BoxGeometry(mmToThree(24), plateHeight, mmToThree(48)), material);
  crossbar.position.set(-mmToThree(24), plateHeight / 2, 0);
  group.add(crossbar);

  for (const z of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(armLength, plateHeight, armWidth), material);
    arm.position.set(mmToThree(11), plateHeight / 2, z * (gap / 2 + armWidth / 2));
    group.add(arm);
  }

  const screw = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(5.1), mmToThree(5.1), plateHeight + mmToThree(3), 28),
    new THREE.MeshStandardMaterial({ color: "#e5e7eb", metalness: 0.85, roughness: 0.18 }),
  );
  screw.position.set(mmToThree(8), plateHeight, 0);
  group.add(screw);
  return group;
}
