import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../types/digitalTwin";
import { getDimensionsMm, getNumericProperty, mmToThree } from "../../../three/transformUtils";

/** Acousto-optic modulator primitive — geometry follows the AAOptoelectronic
 *  MT80-A1.5-IR outline drawing (59.5 × 22.4 × 17.3 mm body, optical axis 8 mm
 *  above the bottom and 18 mm in from each end, ø3.9 mm clear aperture, SMA RF
 *  input on top, M2.5 mounting holes). All dimensions are read from
 *  component.properties so other AOM models render at their own size:
 *    dimensionsMm:           [length, width, height] of the housing
 *    bodyLengthMm:           length of the inner body (excluding end mount tabs)
 *    clearApertureMm:        diameter of the through-hole the beam passes through
 *    opticalAxisHeightMm:    height of the optical axis above the housing bottom
 *    opticalAxisFromEndMm:   distance from each end face to the aperture centre
 *    rfConnectorOffsetMm:    transverse offset of the SMA from the centre line  */
export function createAaoptoelectronicMt80(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const [lengthMm, widthMm, heightMm] = getDimensionsMm(component.properties, [59.5, 22.4, 17.3]);
  const bodyLengthMm = getNumericProperty(component.properties, "bodyLengthMm", lengthMm * 0.86);
  const clearApertureMm = getNumericProperty(component.properties, "clearApertureMm", 3.9);
  const axisHeightMm = getNumericProperty(component.properties, "opticalAxisHeightMm", heightMm / 2);
  const rfOffsetMm = getNumericProperty(component.properties, "rfConnectorOffsetMm", 0);
  const length = mmToThree(lengthMm);
  const width = mmToThree(widthMm);
  const height = mmToThree(heightMm);
  const bodyLength = mmToThree(bodyLengthMm);
  const axisHeight = mmToThree(axisHeightMm);

  const group = new THREE.Group();

  // Convention used throughout this primitive: the optical axis is at three.Y
  // = 0 (= SceneObject's z plane) and lies along three.X (= scene +X). The
  // body's +X face is at local x=0 (the "exit" aperture; beam exits here in
  // the convention where laser emits in +X). The whole body therefore sits
  // in -X from the origin, and is shifted down by axisHeight so the optical
  // axis pierces the body at the correct height above its bottom (8 mm for
  // MT80; mesh body bottom ends up at three.Y = -axisHeight).
  // ---------------------------------------------------------------
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: "#a82c2c",
    metalness: 0.45,
    roughness: 0.35,
  });
  const endCapMaterial = new THREE.MeshStandardMaterial({
    color: "#e5e7eb",
    metalness: 0.55,
    roughness: 0.4,
  });
  const bodyCenterX = -bodyLength / 2;
  const bodyCenterY = height / 2 - axisHeight;
  const topY = height - axisHeight;

  const body = new THREE.Mesh(new THREE.BoxGeometry(bodyLength, height, width), bodyMaterial);
  body.position.set(bodyCenterX, bodyCenterY, 0);
  group.add(body);

  // End caps — white aluminium plates on the input/output faces.
  const endCapThickness = mmToThree(2.5);
  for (const sign of [-1, 1]) {
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(endCapThickness, height * 0.98, width * 0.98),
      endCapMaterial,
    );
    const capX = sign === 1
      ? -endCapThickness / 2                          // exit cap right at +X face
      : -bodyLength + endCapThickness / 2;            // entry cap at -X end
    cap.position.set(capX, bodyCenterY, 0);
    group.add(cap);
  }

  // End mount tabs — the outline drawing shows small protrusions on both
  // ends. They sit at the same vertical level as the body bottom up to
  // ~70 % of body height.
  const tabLength = (length - bodyLength) / 2;
  if (tabLength > mmToThree(0.5)) {
    const tabHeight = height * 0.7;
    for (const sign of [-1, 1]) {
      const tab = new THREE.Mesh(
        new THREE.BoxGeometry(tabLength, tabHeight, width * 0.6),
        endCapMaterial,
      );
      const tabX = sign === 1
        ? tabLength / 2
        : -bodyLength - tabLength / 2;
      tab.position.set(tabX, tabHeight / 2 - axisHeight, 0);
      group.add(tab);
    }
  }

  // Optical aperture — cylinder along local +X, sitting on the optical axis
  // (three.Y = 0). Spans the whole body length so it pokes through both end
  // caps. Shifted to the body's mid-X.
  const apertureRadius = mmToThree(clearApertureMm / 2);
  const aperture = new THREE.Mesh(
    new THREE.CylinderGeometry(apertureRadius, apertureRadius, bodyLength * 1.04, 24),
    new THREE.MeshStandardMaterial({ color: "#020617", metalness: 0.2, roughness: 0.5 }),
  );
  aperture.rotation.z = Math.PI / 2;
  aperture.position.set(bodyCenterX, 0, 0);
  group.add(aperture);

  // SMA RF input on top — gold cylinder protruding upward, offset toward
  // one end (drawing's "11.2 mm").
  const smaHeight = mmToThree(8);
  const smaMaterial = new THREE.MeshStandardMaterial({
    color: "#d4af37",
    metalness: 0.85,
    roughness: 0.22,
  });
  const sma = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(2.4), mmToThree(2.4), smaHeight, 20),
    smaMaterial,
  );
  const smaXOffset = bodyCenterX + bodyLength * 0.32;
  const smaZOffset = Math.min(mmToThree(rfOffsetMm) - width / 2, width / 2 - mmToThree(2.4));
  sma.position.set(smaXOffset, topY + smaHeight / 2, smaZOffset);
  group.add(sma);

  const smaBase = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(3.4), mmToThree(3.4), mmToThree(1.6), 6),
    smaMaterial,
  );
  smaBase.position.set(smaXOffset, topY + mmToThree(0.8), smaZOffset);
  group.add(smaBase);

  // S/N label and accents — sit on top face.
  const label = new THREE.Mesh(
    new THREE.BoxGeometry(bodyLength * 0.7, mmToThree(0.4), width * 0.65),
    new THREE.MeshStandardMaterial({ color: "#f1f5f9", metalness: 0.05, roughness: 0.7 }),
  );
  label.position.set(bodyCenterX - bodyLength * 0.05, topY + mmToThree(0.2), 0);
  group.add(label);

  const braggHole = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(1.25), mmToThree(1.25), mmToThree(0.6), 20),
    new THREE.MeshStandardMaterial({ color: "#0f172a", metalness: 0.15, roughness: 0.6 }),
  );
  braggHole.position.set(bodyCenterX - bodyLength * 0.12, topY + mmToThree(0.5), 0);
  group.add(braggHole);

  const screwMaterial = new THREE.MeshStandardMaterial({
    color: "#cbd5e1",
    metalness: 0.85,
    roughness: 0.18,
  });
  for (const sx of [-0.42, 0.42]) {
    const screw = new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(1.6), mmToThree(1.6), mmToThree(0.8), 16),
      screwMaterial,
    );
    screw.position.set(bodyCenterX + sx * bodyLength, topY + mmToThree(0.4), width * 0.32);
    group.add(screw);
  }

  if (state?.state && (state.state as { enabled?: boolean }).enabled === false) {
    bodyMaterial.color.set("#7c2020");
  }
  return group;
}
