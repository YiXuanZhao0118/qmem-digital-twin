import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../../types/digitalTwin";
import { getNumericProperty, mmToThree } from "../../../transformUtils";
import { materialFor } from "../../materials";

export function createThorlabsPostHolder(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const heightMm = getNumericProperty(component.properties, "heightMm", 54.7);
  const bodyRadius = mmToThree(getNumericProperty(component.properties, "baseDiameterMm", 31.8) / 2);
  const bodyHeight = mmToThree(heightMm);
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(bodyRadius, bodyRadius, bodyHeight, 44), materialFor(component, state));
  body.position.y = bodyHeight / 2;
  group.add(body);

  const boreRadius = mmToThree(getNumericProperty(component.properties, "diameterMm", 12.7) / 2);
  const bore = new THREE.Mesh(
    new THREE.CylinderGeometry(boreRadius, boreRadius, bodyHeight + 0.012, 32),
    new THREE.MeshStandardMaterial({ color: "#020617", metalness: 0.2, roughness: 0.5 }),
  );
  bore.position.y = bodyHeight / 2;
  group.add(bore);

  const screw = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(3.2), mmToThree(3.2), mmToThree(30), 20),
    new THREE.MeshStandardMaterial({ color: "#cbd5e1", metalness: 0.8, roughness: 0.24 }),
  );
  screw.rotation.z = Math.PI / 2;
  screw.position.set(bodyRadius + mmToThree(12), bodyHeight * 0.72, 0);
  group.add(screw);
  return group;
}
