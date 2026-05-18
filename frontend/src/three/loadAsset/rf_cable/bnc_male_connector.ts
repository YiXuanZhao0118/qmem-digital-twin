import * as THREE from "three";

import { mmToThree } from "../../transformUtils";
import {
  ddsBlackInsetMat,
  ddsBrassFlatMat,
  ddsBrassMat,
  ddsCableBlackMat,
  ddsTeflonWhiteMat,
} from "../materials";

/** Build one BNC-male connector group at the origin, pieces extending
 *  along local +X. Same orientation convention as `buildSmaMaleConnectorGroup`
 *  (cable-end cap at X=0, mating pin at far +X) so the spline renderer can
 *  swap connector type per end without touching the placement code.
 *
 *  Visual proportions follow a generic BNC-M plug (~14 mm OD bayonet
 *  sleeve, ~30 mm total length) so the connector reads as obviously
 *  chunkier than the SMA male built by `buildSmaMaleConnectorGroup`. */
export function buildBncMaleConnectorGroup(): THREE.Group {
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
      new THREE.CylinderGeometry(mmToThree(2.5), mmToThree(2.5), mmToThree(4), 18),
      ddsCableBlackMat,
    ),
    4,
  );

  // Gold-plated brass crimp ferrule.
  place(
    new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(3.2), mmToThree(3.2), mmToThree(5), 24),
      ddsBrassMat,
    ),
    5,
  );

  // Bayonet coupling sleeve — chunky brushed-nickel barrel, the
  // recognisable BNC silhouette. Two L-slots are cut by intersecting
  // small dark boxes so the part reads as a BNC and not a generic
  // cylinder.
  const sleeveLenMm = 12;
  const sleeve = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(4.5), mmToThree(4.5), mmToThree(sleeveLenMm), 28),
    ddsBrassFlatMat,
  );
  sleeve.rotation.z = Math.PI / 2;
  sleeve.position.set(mmToThree(offsetMm + sleeveLenMm / 2), 0, 0);
  group.add(sleeve);

  for (const slotPhi of [0, Math.PI]) {
    const slot = new THREE.Mesh(
      new THREE.BoxGeometry(mmToThree(3), mmToThree(1.4), mmToThree(1.4)),
      ddsBlackInsetMat,
    );
    slot.position.set(
      mmToThree(offsetMm + sleeveLenMm * 0.75),
      mmToThree(4.5) * Math.cos(slotPhi),
      mmToThree(4.5) * Math.sin(slotPhi),
    );
    group.add(slot);
  }
  offsetMm += sleeveLenMm;

  // White PTFE dielectric face.
  place(
    new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(4.0), mmToThree(4.0), mmToThree(3), 24),
      ddsTeflonWhiteMat,
    ),
    3,
  );

  // Centre pin.
  place(
    new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(0.7), mmToThree(0.7), mmToThree(3), 12),
      ddsBrassMat,
    ),
    3,
  );

  return group;
}
