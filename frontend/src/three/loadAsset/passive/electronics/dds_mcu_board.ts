import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../../types/digitalTwin";
import { getDimensionsMm, mmToThree } from "../../../transformUtils";
import {
  ddsBlackInsetMat,
  ddsBrassMat,
  ddsChromeMat,
  ddsPcbDarkBlueMat,
  ddsSilkscreenMat,
} from "../../materials";

export function createDdsMcuBoard(component: ComponentItem, _state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  const [lenMm, widMm] = getDimensionsMm(component.properties, [90, 70, 18]);
  const length = mmToThree(lenMm);
  const width = mmToThree(widMm);
  const pcbThickness = mmToThree(1.6);

  const pcb = new THREE.Mesh(new THREE.BoxGeometry(length, pcbThickness, width), ddsPcbDarkBlueMat);
  pcb.position.y = pcbThickness / 2;
  group.add(pcb);

  const mcu = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(12), mmToThree(1.4), mmToThree(12)),
    ddsBlackInsetMat,
  );
  mcu.position.set(0, pcbThickness + mmToThree(0.7), 0);
  group.add(mcu);

  const usbShell = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(11), mmToThree(11), mmToThree(15)),
    ddsChromeMat,
  );
  usbShell.position.set(-length / 2 + mmToThree(7), pcbThickness + mmToThree(5.5), -width * 0.3);
  group.add(usbShell);

  const usbCavity = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(0.6), mmToThree(7.8), mmToThree(8.5)),
    ddsBlackInsetMat,
  );
  usbCavity.position.set(-length / 2 + mmToThree(0.8), pcbThickness + mmToThree(5.5), -width * 0.3);
  group.add(usbCavity);

  for (let port = 0; port < 5; port += 1) {
    const headerBody = new THREE.Mesh(
      new THREE.BoxGeometry(mmToThree(2.54 * 6), mmToThree(8), mmToThree(2.54)),
      ddsBlackInsetMat,
    );
    const x = length * 0.45 - port * mmToThree(15);
    headerBody.position.set(x, pcbThickness + mmToThree(4), width * 0.32);
    group.add(headerBody);
    for (let col = 0; col < 6; col += 1) {
      const pin = new THREE.Mesh(
        new THREE.BoxGeometry(mmToThree(0.5), mmToThree(7), mmToThree(0.5)),
        ddsBrassMat,
      );
      pin.position.set(x + (col - 2.5) * mmToThree(2.54), pcbThickness + mmToThree(4), width * 0.32);
      group.add(pin);
    }
    const silkLabel = new THREE.Mesh(
      new THREE.BoxGeometry(mmToThree(2.54 * 6), mmToThree(0.05), mmToThree(2)),
      ddsSilkscreenMat,
    );
    silkLabel.position.set(x, pcbThickness + mmToThree(0.05), width * 0.18);
    group.add(silkLabel);
  }

  const button = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(6), mmToThree(3.2), mmToThree(6)),
    ddsChromeMat,
  );
  button.position.set(length * 0.42, pcbThickness + mmToThree(1.6), -width * 0.28);
  group.add(button);

  const xtal = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(7), mmToThree(2.5), mmToThree(5)),
    ddsChromeMat,
  );
  xtal.position.set(length * 0.18, pcbThickness + mmToThree(1.25), -width * 0.18);
  group.add(xtal);
  return group;
}
