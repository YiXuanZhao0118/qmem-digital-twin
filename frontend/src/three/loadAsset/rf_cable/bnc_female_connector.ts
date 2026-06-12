import * as THREE from "three";

import { mmToThree } from "../../transformUtils";
import {
  ddsBrassFlatMat,
  ddsBrassMat,
  ddsCableBlackMat,
  ddsTeflonWhiteMat,
} from "../materials";

/** Build one BNC-FEMALE (jack) connector group at the origin, pieces
 *  extending along local +X. Same orientation convention as
 *  `buildBncMaleConnectorGroup` (cable-end cap at X=0, mating face at far +X).
 *
 *  Distinguishing features vs the male plug: the bayonet barrel carries two
 *  external bayonet PINS (small studs the male's L-slots ride over) instead
 *  of the male's cut slots, and the centre contact is a RECESSED socket — no
 *  protruding pin. */
export function buildBncFemaleConnectorGroup(): THREE.Group {
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

  // Bayonet receptacle barrel — slightly wider than the male sleeve so the
  // male bayonet sleeve slips over it.
  const sleeveLenMm = 11;
  const sleeve = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(4.0), mmToThree(4.0), mmToThree(sleeveLenMm), 28),
    ddsBrassFlatMat,
  );
  sleeve.rotation.z = Math.PI / 2;
  sleeve.position.set(mmToThree(offsetMm + sleeveLenMm / 2), 0, 0);
  group.add(sleeve);

  // Two external bayonet studs (vs the male's cut slots) — the female cue.
  for (const studPhi of [0, Math.PI]) {
    const stud = new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(0.7), mmToThree(0.7), mmToThree(1.6), 12),
      ddsBrassMat,
    );
    // Stud axis points radially outward from the barrel surface.
    stud.rotation.x = Math.PI / 2;
    stud.position.set(
      mmToThree(offsetMm + sleeveLenMm * 0.6),
      mmToThree(4.0) * Math.cos(studPhi),
      mmToThree(4.0) * Math.sin(studPhi),
    );
    group.add(stud);
  }
  offsetMm += sleeveLenMm;

  // White PTFE dielectric face, RECESSED inside the barrel mouth (leaves a
  // socket lip; does not advance to the barrel end).
  {
    const ptfe = new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(3.6), mmToThree(3.6), mmToThree(2.5), 24),
      ddsTeflonWhiteMat,
    );
    ptfe.rotation.z = Math.PI / 2;
    ptfe.position.set(mmToThree(offsetMm - 1.5 - 2.5 / 2), 0, 0);
    group.add(ptfe);
  }

  return group;
}
