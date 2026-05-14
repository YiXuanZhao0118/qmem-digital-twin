/**
 * Mirror 3D renderer — moved out of `loadAsset.ts`'s 3274-line switch
 * statement (M6 POC). Pattern other kinds will follow once the
 * dispatcher fully delegates to `plugin.renderer`.
 *
 * Geometry: a flat disc with the reflective face at local +X. Beam in
 * +X reflects off the +X face. Body extends in -X so the SceneObject
 * origin lands on the reflective surface — the align algorithm uses
 * this to snap the mirror plane onto the incoming beam.
 */
import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../types/digitalTwin";
import { materialFor } from "../../three/loadAsset";
import { getNumericProperty, mmToThree } from "../../three/transformUtils";

export function renderMirror(
  component: ComponentItem,
  state: DeviceState | undefined,
): THREE.Object3D {
  const radiusMm = getNumericProperty(component.properties, "diameterMm", 25.4) / 2;
  const thicknessMm = getNumericProperty(component.properties, "thicknessMm", 6);
  const radius = mmToThree(radiusMm);
  const thickness = mmToThree(thicknessMm);
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, thickness, 40),
    materialFor(component, state),
  );
  // CylinderGeometry has its axis along +Y by default; rotate so axis
  // points along +X, then shift so the +X face sits at local x=0 and
  // the body extends in -X. The disc spans local x = -thickness to 0.
  disc.rotation.z = Math.PI / 2;
  disc.position.x = -thickness / 2;
  return disc;
}
