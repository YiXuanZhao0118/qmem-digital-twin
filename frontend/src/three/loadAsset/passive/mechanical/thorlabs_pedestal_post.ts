import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../../types/digitalTwin";
import { getNumericProperty, mmToThree } from "../../../transformUtils";
import { materialFor } from "../../materials";

// Thorlabs pedestal-style pillar post: a wide flange at the bottom, a narrower
// cylindrical body on top, and (visually) a darker M-tap recess on the top
// face. Matches the RS / TBP / RBP family — both Ø25 mm (RS*P/M, RS*P4M) and
// Ø1/2" (TBP, RBP) sub-families. `heightMm` is TOTAL length (flange + body)
// per Thorlabs spec convention.
export function createThorlabsPedestalPost(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const totalLengthMm = getNumericProperty(component.properties, "heightMm", 25);
  const bodyDiameterMm = getNumericProperty(component.properties, "diameterMm", 12.7);
  const flangeDiameterMm = getNumericProperty(
    component.properties,
    "flangeDiameterMm",
    bodyDiameterMm * 1.27,
  );
  const flangeThicknessMm = getNumericProperty(component.properties, "flangeThicknessMm", 5.0);
  const topTapDiameterMm = getNumericProperty(component.properties, "topTapDiameterMm", 6.0);

  const bodyHeightMm = Math.max(0.5, totalLengthMm - flangeThicknessMm);

  const flangeRadius = mmToThree(flangeDiameterMm / 2);
  const flangeHeight = mmToThree(flangeThicknessMm);
  const bodyRadius = mmToThree(bodyDiameterMm / 2);
  const bodyHeight = mmToThree(bodyHeightMm);

  const group = new THREE.Group();
  const mat = materialFor(component, state);

  const flange = new THREE.Mesh(
    new THREE.CylinderGeometry(flangeRadius, flangeRadius, flangeHeight, 48),
    mat,
  );
  flange.position.y = flangeHeight / 2;
  group.add(flange);

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(bodyRadius, bodyRadius, bodyHeight, 48),
    mat,
  );
  body.position.y = flangeHeight + bodyHeight / 2;
  group.add(body);

  // Top tap — a small dark recess at the centre of the top face so the post
  // reads as "pedestal with M-tap" instead of a featureless cylinder. Inset by
  // a sliver below the top so it looks like a hole, not a button.
  const tapRadius = mmToThree(topTapDiameterMm / 2);
  const tapDepth = mmToThree(2.0);
  const tap = new THREE.Mesh(
    new THREE.CylinderGeometry(tapRadius, tapRadius, tapDepth, 24),
    new THREE.MeshStandardMaterial({ color: "#1f2937", metalness: 0.25, roughness: 0.55 }),
  );
  tap.position.y = flangeHeight + bodyHeight - tapDepth / 2 + 0.001;
  group.add(tap);

  return group;
}
