import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../../types/digitalTwin";
import { getDimensionsMm, mmToThree } from "../../../transformUtils";
import {
  ddsBlackInsetMat,
  ddsChromeMat,
  ddsPcbTanGreenMat,
} from "../../materials";
import { createSmaBulkheadJack } from "./sma_bulkhead_jack";

export function createDdsTcxoModule(component: ComponentItem, _state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  const [lenMm, widMm] = getDimensionsMm(component.properties, [50, 35, 12]);
  const length = mmToThree(lenMm);
  const width = mmToThree(widMm);
  const pcbThickness = mmToThree(1.6);

  const pcb = new THREE.Mesh(new THREE.BoxGeometry(length, pcbThickness, width), ddsPcbTanGreenMat);
  pcb.position.y = pcbThickness / 2;
  group.add(pcb);

  const tcxoCan = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(8.4), mmToThree(3.2), mmToThree(8.4)),
    ddsChromeMat,
  );
  tcxoCan.position.set(-length * 0.3, pcbThickness + mmToThree(1.6), 0);
  group.add(tcxoCan);

  const fanout = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(6), mmToThree(1.2), mmToThree(4)),
    ddsBlackInsetMat,
  );
  fanout.position.set(length * 0.05, pcbThickness + mmToThree(0.6), 0);
  group.add(fanout);

  for (let index = 0; index < 5; index += 1) {
    const jack = createSmaBulkheadJack();
    jack.position.set(
      length / 2,
      pcbThickness + mmToThree(5),
      (index - 2) * mmToThree(6),
    );
    jack.scale.setScalar(0.7);
    group.add(jack);
  }
  return group;
}
