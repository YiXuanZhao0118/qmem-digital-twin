import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../../types/digitalTwin";
import { mmToThree } from "../../../transformUtils";
import {
  ddsBlackInsetMat,
  ddsChromeMat,
  ddsTeflonWhiteMat,
} from "../../materials";

export function createUsbBJack(_component: ComponentItem, _state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(16), mmToThree(11), mmToThree(12)),
    ddsChromeMat,
  );
  shell.position.set(mmToThree(8), mmToThree(5.5), 0);
  group.add(shell);

  const cavity = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(0.5), mmToThree(8.5), mmToThree(8.5)),
    ddsBlackInsetMat,
  );
  cavity.position.set(mmToThree(1.6), mmToThree(5.5), 0);
  group.add(cavity);

  const tongue = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(0.6), mmToThree(1.2), mmToThree(6.5)),
    ddsTeflonWhiteMat,
  );
  tongue.position.set(mmToThree(1.4), mmToThree(5.5), 0);
  group.add(tongue);
  return group;
}
