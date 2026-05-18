import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../types/digitalTwin";
import { getDimensionsMm, mmToThree } from "../../../three/transformUtils";
import {
  ddsBlackInsetMat,
  ddsBrassMat,
  ddsChromeMat,
  ddsPcbGreenMat,
  ddsSilkscreenMat,
} from "../../../three/loadAsset/materials";
import { createSmaBulkheadJack } from "../../../three/loadAsset/passive/electronics";

/** Procedural Analog Devices AD9959/PCBZ evaluation board — PCB substrate
 *  with the AD9959 BGA in the centre, regulator + crystal accents, 4× SMA
 *  outputs on the +X edge, a 20-pin SPI header on the -X edge, and four
 *  mounting holes. Used as the fallback render when no STL is available
 *  on disk for an AD9959 board; the STL path in `stl_builders/
 *  analog_devices_ad9959_pcbz.ts` takes over when the asset's filePath
 *  matches `*ad9959_pcbz.stl`. */
export function createAnalogDevicesAd9959Pcbz(component: ComponentItem, _state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  const [lenMm, widMm] = getDimensionsMm(component.properties, [100, 80, 16]);
  const length = mmToThree(lenMm);
  const width = mmToThree(widMm);
  const pcbThickness = mmToThree(1.6);

  const pcb = new THREE.Mesh(new THREE.BoxGeometry(length, pcbThickness, width), ddsPcbGreenMat);
  pcb.position.y = pcbThickness / 2;
  group.add(pcb);

  const chip = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(16), mmToThree(2.4), mmToThree(16)),
    ddsBlackInsetMat,
  );
  chip.position.set(-length * 0.05, pcbThickness + mmToThree(1.2), 0);
  group.add(chip);

  const chipLabel = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(13), mmToThree(0.05), mmToThree(13)),
    ddsSilkscreenMat,
  );
  chipLabel.position.set(-length * 0.05, pcbThickness + mmToThree(2.45), 0);
  group.add(chipLabel);

  const regulator = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(8), mmToThree(3.5), mmToThree(7)),
    ddsBlackInsetMat,
  );
  regulator.position.set(length * 0.32, pcbThickness + mmToThree(1.75), -width * 0.3);
  group.add(regulator);

  const xtal = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(7), mmToThree(2.5), mmToThree(5)),
    ddsChromeMat,
  );
  xtal.position.set(length * 0.18, pcbThickness + mmToThree(1.25), width * 0.3);
  group.add(xtal);

  // 4 SMA outputs on the +X (right) edge of the PCB, pointing in +X.
  // createSmaBulkheadJack already builds the jack along +X, so we mount the
  // hex flange flush to the edge (origin at panel) and the barrel sticks out.
  for (let index = 0; index < 4; index += 1) {
    const jack = createSmaBulkheadJack();
    jack.position.set(
      length / 2,
      pcbThickness + mmToThree(5),
      (index - 1.5) * mmToThree(14),
    );
    group.add(jack);
  }

  const headerBody = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(2.54 * 10), mmToThree(8), mmToThree(2.54 * 2)),
    ddsBlackInsetMat,
  );
  headerBody.position.set(-length * 0.32, pcbThickness + mmToThree(4), -width * 0.3);
  group.add(headerBody);
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 10; col += 1) {
      const pin = new THREE.Mesh(
        new THREE.BoxGeometry(mmToThree(0.6), mmToThree(7), mmToThree(0.6)),
        ddsBrassMat,
      );
      pin.position.set(
        -length * 0.32 + (col - 4.5) * mmToThree(2.54),
        pcbThickness + mmToThree(4),
        -width * 0.3 + (row - 0.5) * mmToThree(2.54),
      );
      group.add(pin);
    }
  }

  for (const x of [-0.45, 0.45]) {
    for (const z of [-0.45, 0.45]) {
      const hole = new THREE.Mesh(
        new THREE.CylinderGeometry(mmToThree(1.6), mmToThree(1.6), pcbThickness * 1.05, 14),
        ddsBlackInsetMat,
      );
      hole.position.set(x * length * 0.95, pcbThickness / 2, z * width * 0.95);
      group.add(hole);
    }
  }
  return group;
}
