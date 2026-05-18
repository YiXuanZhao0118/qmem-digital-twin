import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../../types/digitalTwin";
import { getDimensionsMm, mmToThree } from "../../../transformUtils";
import {
  ddsBrassMat,
  ddsPsuLabelMat,
  ddsPsuShellMat,
} from "../../materials";

export function createMeanwellIrm30(component: ComponentItem, _state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  const [lenMm, widMm, heightMm] = getDimensionsMm(component.properties, [88, 52.4, 28.8]);
  const length = mmToThree(lenMm);
  const width = mmToThree(widMm);
  const height = mmToThree(heightMm);

  const shell = new THREE.Mesh(new THREE.BoxGeometry(length, height, width), ddsPsuShellMat);
  shell.position.y = height / 2;
  group.add(shell);

  const label = new THREE.Mesh(
    new THREE.BoxGeometry(length * 0.86, mmToThree(0.05), width * 0.78),
    ddsPsuLabelMat,
  );
  label.position.y = height + mmToThree(0.03);
  group.add(label);

  for (let pin = 0; pin < 4; pin += 1) {
    const pinMesh = new THREE.Mesh(
      new THREE.BoxGeometry(mmToThree(0.8), mmToThree(4), mmToThree(0.8)),
      ddsBrassMat,
    );
    pinMesh.position.set(-length * 0.4 + pin * mmToThree(5), -mmToThree(2), 0);
    group.add(pinMesh);
  }

  for (let pin = 0; pin < 2; pin += 1) {
    const pinMesh = new THREE.Mesh(
      new THREE.BoxGeometry(mmToThree(1), mmToThree(5), mmToThree(1)),
      ddsBrassMat,
    );
    pinMesh.position.set(length * 0.32 + pin * mmToThree(7), -mmToThree(2.5), 0);
    group.add(pinMesh);
  }
  return group;
}
