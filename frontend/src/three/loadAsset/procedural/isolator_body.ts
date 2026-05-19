/**
 * Procedural isolator body — cylinder + 2 ferrules.
 *
 * Extracted from ``kinds/_renderer_bindings.ts::renderIsolator`` in
 * Stage A''.6 so the body geometry is an Asset3D the binding tree can
 * reference, not hidden state inside a per-kind renderer. The bespoke
 * pbsOverlay was the source of the cylinder + ferrules + PBS overlay
 * triplet; this module owns just the body part (cylinder + ferrules),
 * leaving the PBS to be expressed as ComponentBinding sub-Components
 * in the binding tree.
 *
 * The body's dimensions read from ``component.properties`` with the
 * same defaults as before (22 mm diameter × 51.4 mm length, 13 mm
 * ferrule × 5 mm long), so a Component pointing at this asset
 * renders visually identical to ``renderIsolator``'s cylinder + ferrule
 * subtree.
 *
 * Renderer dispatch (Stage A''.6+):
 *   Asset3D.filePath = "procedural://isolator_body"
 *     → ``loadAsset/index.ts`` dispatches to ``buildIsolatorBodyObject``
 *     → returns just the body Group (no PBS overlay).
 *
 * Translucent housing material + depthWrite:false matches the legacy
 * baseMat tweak inside ``renderIsolator`` so once
 * Asset3D.properties.viewerHints.material is plumbed in A''.7+ this
 * code can collapse onto ``createTranslucentHousingMaterial``.
 */
import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../types/digitalTwin";
import { getNumericProperty, mmToThree } from "../../transformUtils";
import { materialFor } from "../materials";


/** Marker filePath for an Asset3D that should render via this
 *  builder. The matching ``isIsolatorBodyAsset`` predicate is wired
 *  into ``loadAsset/index.ts``'s asset-format dispatch in A''.6. */
export const ISOLATOR_BODY_FILEPATH = "procedural://isolator_body";


export function isIsolatorBodyAsset(filePath: string): boolean {
  return filePath === ISOLATOR_BODY_FILEPATH;
}


/** Build the procedural isolator body (Faraday housing cylinder + two
 *  fibre ferrules at the ends). No PBS overlay — that comes from the
 *  binding tree's PBS sub-Component bindings.
 *
 *  ``component.properties`` may override:
 *    - ``diameterMm``        (default 22)   housing OD
 *    - ``lengthMm``          (default 51.4) housing length along Z
 *    - ``ferruleDiameterMm`` (default 13)   end-cap OD
 *    - ``ferruleLengthMm``   (default 5)    end-cap length
 */
export function buildIsolatorBodyObject(
  component: ComponentItem,
  state?: DeviceState,
): THREE.Object3D {
  const diameterMm = getNumericProperty(component.properties, "diameterMm", 22);
  const lengthMm = getNumericProperty(component.properties, "lengthMm", 51.4);
  const ferruleDiameterMm = getNumericProperty(
    component.properties,
    "ferruleDiameterMm",
    13,
  );
  const ferruleLengthMm = getNumericProperty(
    component.properties,
    "ferruleLengthMm",
    5,
  );
  const bodyRadius = mmToThree(diameterMm / 2);
  const bodyLength = mmToThree(lengthMm);
  const ferruleRadius = mmToThree(ferruleDiameterMm / 2);
  const ferruleLen = mmToThree(ferruleLengthMm);

  const group = new THREE.Group();
  const baseMat = materialFor(component, state);
  baseMat.transparent = true;
  baseMat.opacity = 0.35;
  baseMat.depthWrite = false;
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(bodyRadius, bodyRadius, bodyLength, 40),
    baseMat,
  );
  body.renderOrder = 0;
  group.add(body);

  const steelMat = new THREE.MeshStandardMaterial({
    color: "#cbd5e1",
    metalness: 0.85,
    roughness: 0.22,
  });
  const inFerrule = new THREE.Mesh(
    new THREE.CylinderGeometry(ferruleRadius, ferruleRadius, ferruleLen, 24),
    steelMat,
  );
  inFerrule.position.y = -(bodyLength / 2 + ferruleLen / 2);
  group.add(inFerrule);
  const outFerrule = new THREE.Mesh(
    new THREE.CylinderGeometry(ferruleRadius, ferruleRadius, ferruleLen, 24),
    steelMat,
  );
  outFerrule.position.y = bodyLength / 2 + ferruleLen / 2;
  group.add(outFerrule);

  return group;
}
