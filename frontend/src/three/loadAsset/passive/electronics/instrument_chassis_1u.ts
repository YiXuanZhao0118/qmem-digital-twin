import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../../types/digitalTwin";
import { getDimensionsMm, mmToThree } from "../../../transformUtils";
import { materialFor } from "../../materials";

export function createInstrumentChassis1u(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  const [lenMm, depthMm, heightMm] = getDimensionsMm(component.properties, [482.6, 246, 44.45]);
  const length = mmToThree(lenMm);
  const depth = mmToThree(depthMm);
  const height = mmToThree(heightMm);
  const wall = mmToThree(1.5);

  const material = materialFor(component, state);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(length, wall, depth), material);
  floor.position.set(0, wall / 2, 0);
  group.add(floor);

  const ceiling = floor.clone();
  ceiling.position.y = height - wall / 2;
  group.add(ceiling);

  const frontPanel = new THREE.Mesh(new THREE.BoxGeometry(length, height, wall), material);
  frontPanel.position.set(0, height / 2, depth / 2 - wall / 2);
  group.add(frontPanel);

  const backPanel = frontPanel.clone();
  backPanel.position.z = -depth / 2 + wall / 2;
  group.add(backPanel);

  const sideGeometry = new THREE.BoxGeometry(wall, height, depth - 2 * wall);
  const left = new THREE.Mesh(sideGeometry, material);
  left.position.set(-length / 2 + wall / 2, height / 2, 0);
  group.add(left);

  const right = new THREE.Mesh(sideGeometry, material);
  right.position.set(length / 2 - wall / 2, height / 2, 0);
  group.add(right);
  return group;
}
