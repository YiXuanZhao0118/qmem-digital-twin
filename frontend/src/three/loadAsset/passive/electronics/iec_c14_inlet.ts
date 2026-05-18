import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../../types/digitalTwin";
import { mmToThree } from "../../../transformUtils";
import {
  ddsBlackInsetMat,
  ddsBrassMat,
} from "../../materials";

export function createIecC14Inlet(_component: ComponentItem, _state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  const length = mmToThree(30);
  const width = mmToThree(22.5);
  const depth = mmToThree(27);

  const body = new THREE.Mesh(new THREE.BoxGeometry(depth, width, length), ddsBlackInsetMat);
  body.position.set(depth / 2, width / 2, 0);
  group.add(body);

  for (const offset of [-1, 0, 1]) {
    const socket = new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(1.5), mmToThree(1.5), mmToThree(2), 14),
      ddsBrassMat,
    );
    socket.rotation.z = Math.PI / 2;
    socket.position.set(
      mmToThree(0.6),
      width / 2 + (offset === 0 ? mmToThree(4) : -mmToThree(2)),
      offset === 0 ? 0 : offset * mmToThree(7),
    );
    group.add(socket);
  }
  return group;
}
