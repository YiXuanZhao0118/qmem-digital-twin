import * as THREE from "three";

import { mmToThree } from "../../../transformUtils";
import {
  ddsBrassMat,
  ddsSmaNickelMat,
  ddsTeflonWhiteMat,
} from "../../materials";

export function createSmaBulkheadJack(): THREE.Object3D {
  const group = new THREE.Group();
  // Layout along the mounting axis (+X = panel-out, where cable mates):
  //
  //   -6.7      -3.7      -1.75       0      2.25       8.5         12.5
  //    | back-nut | washer | back-shaft | flange | front threaded barrel |
  //    +---------+---------+-----------+--------+-----------------------+
  //                                    ^
  //                                    panel surface
  //
  // 2026-05-13: added back-of-panel lock nut + lock washer + threaded
  // back-shaft. Matches a real Amphenol 132357 panel-mount SMA-F which
  // ships as flange + threaded shaft + lock washer + lock nut — the prior
  // model only rendered the flange + front barrel, which is why the user
  // reported "sma 母頭少了螺帽".
  const hexThickness = mmToThree(1);
  const hexRadius = mmToThree(5.0);
  const hex = new THREE.Mesh(
    new THREE.CylinderGeometry(hexRadius, hexRadius, hexThickness, 6),
    ddsSmaNickelMat,
  );
  hex.rotation.z = Math.PI / 2;
  hex.position.x = hexThickness / 2;
  group.add(hex);

  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(3.2), mmToThree(3.2), mmToThree(8), 24),
    ddsSmaNickelMat,
  );
  barrel.rotation.z = Math.PI / 2;
  barrel.position.x = hexThickness + mmToThree(4);
  group.add(barrel);

  // Back-of-panel threaded shaft. Goes through the panel hole; visible
  // from inside the chassis between the flange and the lock nut.
  const backShaft = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(3.0), mmToThree(3.0), mmToThree(3.5), 24),
    ddsSmaNickelMat,
  );
  backShaft.rotation.z = Math.PI / 2;
  backShaft.position.x = -mmToThree(1.75);
  group.add(backShaft);

  // Lock washer between the panel back and the nut.
  const lockWasher = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(4.5), mmToThree(4.5), mmToThree(0.4), 24),
    ddsSmaNickelMat,
  );
  lockWasher.rotation.z = Math.PI / 2;
  lockWasher.position.x = -mmToThree(3.7);
  group.add(lockWasher);

  // Back panel-mount hex nut. Slightly thinner than the front flange so
  // the flange stays visually dominant.
  const backNut = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(4.6), mmToThree(4.6), mmToThree(3.0), 6),
    ddsSmaNickelMat,
  );
  backNut.rotation.z = Math.PI / 2;
  backNut.position.x = -mmToThree(5.4);
  group.add(backNut);

  const teflon = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(2.0), mmToThree(2.0), mmToThree(0.8), 20),
    ddsTeflonWhiteMat,
  );
  teflon.rotation.z = Math.PI / 2;
  teflon.position.x = -mmToThree(0.45);
  group.add(teflon);

  const pin = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(0.5), mmToThree(0.5), mmToThree(1.6), 16),
    ddsBrassMat,
  );
  pin.rotation.z = Math.PI / 2;
  pin.position.x = -mmToThree(0.5);
  group.add(pin);
  return group;
}
