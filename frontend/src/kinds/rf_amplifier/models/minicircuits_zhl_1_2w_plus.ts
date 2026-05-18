import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../types/digitalTwin";
import { mmToThree } from "../../../three/transformUtils";
import {
  colorForComponent,
  ddsBlackInsetMat,
  ddsBrassFlatMat,
  ddsBrassMat,
  ddsTeflonWhiteMat,
} from "../../../three/loadAsset/materials";
import { createSmaBulkheadJack } from "../../../three/loadAsset/passive/electronics";

/** Procedural Mini-Circuits ZHL-1-2W+ coaxial amplifier (heatsink variant).
 *
 *  Geometry mirrors the OpenSCAD reference at `/c/repos/zhl-1-2w-3d.scad`:
 *  flange + main body + heatsink base + 14 longitudinal fins, with one SMA
 *  female on the +X face (RF IN), another on -X (RF OUT), and the
 *  +24V / GND feedthrough posts on the +Y (front) face. The OBJ/STL
 *  loader path used to handle this; after the M6 plugin-renderer cleanup
 *  it dropped to a featureless box. This brings the detailed visual back
 *  for the canonical Mini-Circuits part — other rf_amplifier brands /
 *  models still fall through to the generic chassis box.
 *
 *  Frame convention (matches the rest of loadAsset.ts):
 *    +X = length (flange ↔ flange)
 *    +Y = up (heatsink fins poke up)
 *    +Z = front (feedthrough posts poke towards +Z)
 *  Origin sits at the bottom centre of the flange so the part rests
 *  flat on the table when y_mm = 0. */
export function createMinicircuitsZhl12wPlus(
  component: ComponentItem,
  state?: DeviceState,
): THREE.Object3D {
  // Dimensions kept in lockstep with the SCAD source.
  const A_LEN = 108.0;
  const E_LEN = 88.9;
  const W_MM = 49.5;
  const BODY_H = 26.0;
  const FLANGE_T = 4.0;
  const HS_BASE_H = 4.0;
  const HS_FIN_H = 19.5;
  const FIN_COUNT = 14;
  const FIN_T = 1.0;
  const flangeOverhang = (A_LEN - E_LEN) / 2;

  const group = new THREE.Group();

  // Black-anodised cast aluminium housing — same material for flange,
  // body, and heatsink. Heatsink fins use the same material so the part
  // reads as one machined piece (matches the real ZHL casting).
  const housingMat = new THREE.MeshStandardMaterial({
    color: "#1f2937",
    metalness: 0.55,
    roughness: 0.5,
  });
  // Slightly lighter so the heatsink stack pops visually against the body.
  const finMat = new THREE.MeshStandardMaterial({
    color: "#2b3340",
    metalness: 0.55,
    roughness: 0.45,
  });

  // Flanges — short overhang at each end with mounting holes (rendered as
  // dark recesses on top, since at this scale a real through-hole barely
  // reads). Kept geometrically simple so the visual silhouette matches the
  // photo without bloating the geometry.
  const flangeDepth = mmToThree(W_MM);
  const flangeHeight = mmToThree(FLANGE_T);
  const flangeOverhangLen = mmToThree(flangeOverhang);
  const bodyLen = mmToThree(E_LEN);
  const bodyHeight = mmToThree(BODY_H);
  const baseHeight = mmToThree(HS_BASE_H);
  const finHeight = mmToThree(HS_FIN_H);

  // Left flange (SCAD: −A_LEN/2 .. −E_LEN/2).
  const leftFlange = new THREE.Mesh(
    new THREE.BoxGeometry(flangeOverhangLen, flangeHeight, flangeDepth),
    housingMat,
  );
  leftFlange.position.set(
    -(bodyLen / 2 + flangeOverhangLen / 2),
    flangeHeight / 2,
    0,
  );
  group.add(leftFlange);

  // Right flange (SCAD: +E_LEN/2 .. +A_LEN/2).
  const rightFlange = new THREE.Mesh(
    new THREE.BoxGeometry(flangeOverhangLen, flangeHeight, flangeDepth),
    housingMat,
  );
  rightFlange.position.set(
    bodyLen / 2 + flangeOverhangLen / 2,
    flangeHeight / 2,
    0,
  );
  group.add(rightFlange);

  // Main body (sits on top of the flange surface, between the two
  // overhangs).
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(bodyLen, bodyHeight, flangeDepth),
    housingMat,
  );
  body.position.set(0, flangeHeight + bodyHeight / 2, 0);
  group.add(body);

  // Heatsink base plate — the slab the fins sit on.
  const hsBase = new THREE.Mesh(
    new THREE.BoxGeometry(bodyLen, baseHeight, flangeDepth),
    housingMat,
  );
  hsBase.position.set(0, flangeHeight + bodyHeight + baseHeight / 2, 0);
  group.add(hsBase);

  // Heatsink fins — FIN_COUNT longitudinal blades, evenly spaced across
  // the +Z..-Z width. Each fin is 1.5 mm shorter than the body on each
  // side (matches the SCAD `0.75` end-margin both ends).
  const finPitch = flangeDepth / FIN_COUNT;
  const finThickness = mmToThree(FIN_T);
  const finLength = bodyLen - mmToThree(1.5);
  for (let i = 0; i < FIN_COUNT; i += 1) {
    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(finLength, finHeight, finThickness),
      finMat,
    );
    const z0 = -flangeDepth / 2;
    const zCentre = z0 + i * finPitch + (finPitch - finThickness) / 2 + finThickness / 2;
    fin.position.set(
      0,
      flangeHeight + bodyHeight + baseHeight + finHeight / 2,
      zCentre,
    );
    group.add(fin);
  }

  // SMA panel jacks on +X / -X faces. Reuse the bulkhead jack helper so
  // the connector geometry matches the rest of the catalog. The helper
  // sits with its mounting axis along +X by default; rotate 180° around
  // Y for the -X end so the front of the connector faces outward.
  const smaCentreY = flangeHeight + bodyHeight / 2;
  const smaIn = createSmaBulkheadJack();
  smaIn.position.set(bodyLen / 2, smaCentreY, 0);
  group.add(smaIn);
  const smaOut = createSmaBulkheadJack();
  smaOut.rotation.y = Math.PI;
  smaOut.position.set(-bodyLen / 2, smaCentreY, 0);
  group.add(smaOut);

  // +24V (upper) and GND (lower) feedthrough posts on +Z (front) face.
  // SCAD has them at body-height fractions 0.72 / 0.28; we replicate.
  // All maths stays in mm and only converts to scene units at assignment
  // time so a unit mismatch can't sneak in.
  const postYsMm = [FLANGE_T + BODY_H * 0.72, FLANGE_T + BODY_H * 0.28];
  const postX = -bodyLen / 2 + mmToThree(14);
  const postZ = flangeDepth / 2;
  for (const postYMm of postYsMm) {
    const yMmFractional = mmToThree(postYMm);
    const group2 = new THREE.Group();
    // Insulator bushing (white)
    const bushing = new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(8.8 / 2), mmToThree(8.8 / 2), mmToThree(2.6), 24),
      ddsTeflonWhiteMat,
    );
    bushing.rotation.x = Math.PI / 2;
    bushing.position.z = mmToThree(2.6) / 2;
    group2.add(bushing);
    // Insulator stack
    const ins = new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(6.2 / 2), mmToThree(6.2 / 2), mmToThree(2.4), 24),
      ddsTeflonWhiteMat,
    );
    ins.rotation.x = Math.PI / 2;
    ins.position.z = mmToThree(2.6) + mmToThree(2.4) / 2;
    group2.add(ins);
    // Brass post
    const brass = new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(2.6 / 2), mmToThree(2.6 / 2), mmToThree(7.0), 16),
      ddsBrassMat,
    );
    brass.rotation.x = Math.PI / 2;
    brass.position.z = mmToThree(2.6) + mmToThree(2.4) + mmToThree(7.0) / 2;
    group2.add(brass);
    // Hex nut crown
    const nut = new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(4.0 / (2 * Math.cos(Math.PI / 6))), mmToThree(4.0 / (2 * Math.cos(Math.PI / 6))), mmToThree(1.4), 6),
      ddsBrassFlatMat,
    );
    nut.rotation.x = Math.PI / 2;
    nut.position.z = mmToThree(2.6) + mmToThree(2.4) + mmToThree(7.0) - mmToThree(1.4) / 2;
    group2.add(nut);

    group2.position.set(postX, yMmFractional, postZ);
    group.add(group2);
  }

  // Subtle silkscreen on the heatsink base — "ZHL-1-2W+" as a tiny dark
  // recess. At catalog-icon zoom this just reads as "there's a label
  // there"; at close zoom the user can tell the part apart from a
  // ZHL-42W+. Implemented as a thin dark strip rather than real text to
  // avoid pulling in a font loader for this single label.
  const label = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(36), mmToThree(0.4), mmToThree(8)),
    ddsBlackInsetMat,
  );
  label.position.set(
    0,
    flangeHeight + bodyHeight + baseHeight + finHeight + mmToThree(0.2),
    0,
  );
  group.add(label);

  // Apply the colour-override path so a hot-state tint (red when
  // temperatureC > 45 °C — see `colorForComponent`) still tints the
  // housing visually. Skip this when no state hot-flag fires, so the
  // default anodised black stays as-is.
  const override = colorForComponent(component, state);
  if (override === "#dc2626") {
    housingMat.color.set("#dc2626");
    finMat.color.set("#a91920");
  }

  return group;
}
