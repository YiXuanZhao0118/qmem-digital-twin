import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../../types/digitalTwin";
import { getNumericProperty, mmToThree } from "../../../transformUtils";
import { materialFor } from "../../materials";

export function createThorlabsPost(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const radius = mmToThree(getNumericProperty(component.properties, "diameterMm", 12.7) / 2);
  const height = mmToThree(getNumericProperty(component.properties, "heightMm", 50));
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 40), materialFor(component, state));
  mesh.position.y = height / 2;
  return mesh;
}
