import * as THREE from "three";

import { mmToThree } from "../../transformUtils";
import {
  ddsBrassFlatMat,
  ddsBrassMat,
  ddsCableBlackMat,
  ddsTeflonWhiteMat,
} from "../materials";

/** Build one SMA-male connector group at the origin, pieces extending
 *  along local +X (boot near origin, pin at the far +X end). Cable-end
 *  cap is centred at X=0. The straight-cable jacket Y=2 mm lift is NOT
 *  applied here — callers position the whole group. Used by both the
 *  straight-tube renderer (two mirrored copies on either end of the
 *  cylinder) and the spline renderer (one copy per spline endpoint,
 *  oriented to the outward tangent). */
export function buildSmaMaleConnectorGroup(): THREE.Group {
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
    3,
  );

  // Threaded coupling barrel.
  place(
    new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(3.0), mmToThree(3.0), mmToThree(4), 24),
      ddsBrassMat,
    ),
    4,
  );

  // Hex coupling flange with central bore — overlaps PTFE+pin (does NOT
  // advance offsetMm).
  {
    const hexThick = 6.5;
    const hexShape = new THREE.Shape();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const x = mmToThree(3.5) * Math.cos(a);
      const y = mmToThree(3.5) * Math.sin(a);
      if (i === 0) hexShape.moveTo(x, y);
      else hexShape.lineTo(x, y);
    }
    hexShape.closePath();
    const bore = new THREE.Path();
    bore.absarc(0, 0, mmToThree(2.5), 0, Math.PI * 2, false);
    hexShape.holes.push(bore);

    const hexGeom = new THREE.ExtrudeGeometry(hexShape, {
      depth: mmToThree(hexThick),
      bevelEnabled: false,
      curveSegments: 24,
    });
    hexGeom.translate(0, 0, -mmToThree(hexThick) / 2);
    hexGeom.rotateY(Math.PI / 2);

    const hex = new THREE.Mesh(hexGeom, ddsBrassFlatMat);
    hex.position.set(mmToThree(offsetMm + hexThick / 2), 0, 0);
    group.add(hex);
  }

  // White PTFE dielectric.
  place(
    new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(2.85), mmToThree(2.85), mmToThree(3.5), 24),
      ddsTeflonWhiteMat,
    ),
    3.5,
  );

  // Centre pin.
  place(
    new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(0.5), mmToThree(0.5), mmToThree(2), 12),
      ddsBrassMat,
    ),
    2,
  );

  return group;
}
