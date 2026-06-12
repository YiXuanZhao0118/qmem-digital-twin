import * as THREE from "three";

import { mmToThree } from "../../transformUtils";
import {
  ddsBlackInsetMat,
  ddsBrassFlatMat,
  ddsBrassMat,
  ddsCableBlackMat,
  ddsTeflonWhiteMat,
} from "../materials";

/** Build one SMA-FEMALE (jack) connector group at the origin, pieces
 *  extending along local +X (boot near origin, mating face at the far +X
 *  end). Same orientation convention as `buildSmaMaleConnectorGroup` so the
 *  spline renderer swaps gender per end without touching placement code.
 *
 *  Distinguishing features vs the male plug: a wider knurled coupling-nut
 *  barrel (the male threads INTO it) and a RECESSED socket — there is no
 *  protruding centre pin; the centre contact is a small dark bore set back
 *  inside the dielectric face. */
export function buildSmaFemaleConnectorGroup(): THREE.Group {
  const group = new THREE.Group();
  let offsetMm = 0;
  const place = (piece: THREE.Object3D, lenMm: number): void => {
    piece.rotation.z = Math.PI / 2;
    piece.position.set(mmToThree(offsetMm + lenMm / 2), 0, 0);
    group.add(piece);
    offsetMm += lenMm;
  };

  // Black heat-shrink strain-relief boot.
  place(
    new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(1.85), mmToThree(1.85), mmToThree(3), 18),
      ddsCableBlackMat,
    ),
    3,
  );

  // Gold-plated brass crimp ferrule.
  place(
    new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(2.2), mmToThree(2.2), mmToThree(4), 24),
      ddsBrassMat,
    ),
    4,
  );

  // Knurled coupling-nut barrel — wider than the male's threaded barrel so
  // the jack reads as a receptacle the male slides into.
  const barrelLenMm = 6;
  place(
    new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(3.4), mmToThree(3.4), mmToThree(barrelLenMm), 28),
      ddsBrassFlatMat,
    ),
    barrelLenMm,
  );

  // White PTFE dielectric face, RECESSED a little inside the barrel mouth
  // (does NOT advance offsetMm to the barrel end → leaves a socket lip).
  {
    const ptfe = new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(2.85), mmToThree(2.85), mmToThree(2.5), 24),
      ddsTeflonWhiteMat,
    );
    ptfe.rotation.z = Math.PI / 2;
    // 1 mm back from the barrel mouth so the mouth forms a recessed socket.
    ptfe.position.set(mmToThree(offsetMm - 1.0 - 2.5 / 2), 0, 0);
    group.add(ptfe);
  }

  // Centre socket bore — a small dark recess (NOT a pin) at the dielectric
  // face, the visual cue that this is a female jack.
  {
    const bore = new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(0.55), mmToThree(0.55), mmToThree(2), 12),
      ddsBlackInsetMat,
    );
    bore.rotation.z = Math.PI / 2;
    bore.position.set(mmToThree(offsetMm - 1.0 - 2.0 / 2), 0, 0);
    group.add(bore);
  }

  return group;
}
