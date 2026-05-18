import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../types/digitalTwin";
import { getDimensionsMm, getNumericProperty, mmToThree } from "../../../three/transformUtils";

// TOPTICA BoosTA pro full-module envelope. Outer dimensions and clamp
// channels from the official 8-page technical drawing (TOPTICA,
// 20.03.2024); colour scheme + face features from the product photo on
// toptica.com — the housing is a clean two-tone box: the bottom ~60%
// is matte black, the top ~40% is a saturated TOPTICA-blue lid. Front
// face is black with a circular aluminium flange around the optical
// aperture and a small red "laser warning" sticker. "BoosTA" wordmark
// sits on the blue side, mid-front. No fans / fins / vents (the chip's
// heat is dumped to the optical-table surface through the bottom plate).
//
// Local frame convention (matches every other "+X-emitter" component):
//   - Local origin = FORWARD port (+X face centre at optical axis).
//   - Body extends in -X (length 275 mm).
//   - Optical axis at local y=0; bottom of housing at y=-47 mm,
//     top at y=+43 mm. SceneObject z_mm = beam height.
export function createTopticaBoostaPro(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const [lengthMm, widthMm, heightMm] = getDimensionsMm(component.properties, [275, 115, 90]);
  const opticalAxisFromBottomMm = getNumericProperty(
    component.properties,
    "opticalAxisHeightMm",
    47,
  );
  const length = mmToThree(lengthMm);
  const width = mmToThree(widthMm);
  const height = mmToThree(heightMm);
  const axisFromBottom = mmToThree(opticalAxisFromBottomMm);

  const group = new THREE.Group();

  // Materials — colours sampled from the BoosTA pro product photo.
  const enabled = state?.state?.enabled !== false;
  const blackHousing = new THREE.MeshStandardMaterial({
    color: enabled ? "#0c0c0e" : "#3a3a3e",
    metalness: 0.35,
    roughness: 0.62,
  });
  const blueLid = new THREE.MeshStandardMaterial({
    color: enabled ? "#1f8ed1" : "#54748a",  // TOPTICA blue
    metalness: 0.25,
    roughness: 0.45,
  });
  const aluminiumFlange = new THREE.MeshStandardMaterial({
    color: "#b8bbc0",
    metalness: 0.85,
    roughness: 0.32,
  });
  const apertureBlack = new THREE.MeshStandardMaterial({
    color: "#050505",
    metalness: 0.4,
    roughness: 0.85,
  });
  const channelMaterial = new THREE.MeshStandardMaterial({
    color: "#1a1a1c",  // slightly darker than the black housing to read as a recess
    metalness: 0.5,
    roughness: 0.45,
  });
  const screwHead = new THREE.MeshStandardMaterial({
    color: "#1d1d1f",
    metalness: 0.85,
    roughness: 0.3,
  });

  // Two-tone housing: bottom black box (54 mm tall) + top blue lid (36 mm).
  // The split is at ~60% height (matches photo: lid is roughly the upper
  // 40% of the body).
  const blackHeightMm = 54;
  const blueHeightMm = heightMm - blackHeightMm;  // 36 mm by default
  const blackHeight = mmToThree(blackHeightMm);
  const blueHeight = mmToThree(blueHeightMm);

  // Bottom black box: spans y from -axisFromBottom to (-axisFromBottom + 54).
  const blackCentreY = -axisFromBottom + blackHeight / 2;
  const blackBox = new THREE.Mesh(
    new THREE.BoxGeometry(length, blackHeight, width),
    blackHousing,
  );
  blackBox.position.set(-length / 2, blackCentreY, 0);
  group.add(blackBox);

  // Top blue lid: spans y from (-axisFromBottom + 54) to (-axisFromBottom + 90).
  const blueCentreY = -axisFromBottom + blackHeight + blueHeight / 2;
  const blueBox = new THREE.Mesh(
    new THREE.BoxGeometry(length, blueHeight, width),
    blueLid,
  );
  blueBox.position.set(-length / 2, blueCentreY, 0);
  group.add(blueBox);

  // FRONT face features (z = +width/2, x ∈ [-length, 0]):
  //   1. Aluminium flange disc around the optical port (radius 14 mm).
  //   2. Inner aperture hole (radius 5 mm, very dark).
  //   3. Small red laser-warning sticker bottom-left.
  //   4. Four corner mounting screws.
  const flangeRadius = mmToThree(14);
  const flangeDepth = mmToThree(1.5);
  const apertureRadius = mmToThree(5);
  const apertureDepth = mmToThree(2.0);

  // Forward port: aluminium flange protruding 1.5mm from front face, then
  // an inner aperture hole going 2mm deeper.
  const flangeFront = new THREE.Mesh(
    new THREE.CylinderGeometry(flangeRadius, flangeRadius, flangeDepth, 32),
    aluminiumFlange,
  );
  flangeFront.rotation.z = Math.PI / 2;
  flangeFront.position.set(flangeDepth / 2, 0, 0);
  group.add(flangeFront);
  const apertureFront = new THREE.Mesh(
    new THREE.CylinderGeometry(apertureRadius, apertureRadius, apertureDepth, 24),
    apertureBlack,
  );
  apertureFront.rotation.z = Math.PI / 2;
  apertureFront.position.set(-apertureDepth / 2, 0, 0);
  group.add(apertureFront);

  // Backward port (seed input): same construction on the -X face.
  const flangeBack = new THREE.Mesh(
    new THREE.CylinderGeometry(flangeRadius, flangeRadius, flangeDepth, 32),
    aluminiumFlange,
  );
  flangeBack.rotation.z = Math.PI / 2;
  flangeBack.position.set(-length - flangeDepth / 2, 0, 0);
  group.add(flangeBack);
  const apertureBack = new THREE.Mesh(
    new THREE.CylinderGeometry(apertureRadius, apertureRadius, apertureDepth, 24),
    apertureBlack,
  );
  apertureBack.rotation.z = Math.PI / 2;
  apertureBack.position.set(-length + apertureDepth / 2, 0, 0);
  group.add(apertureBack);

  // Red laser-warning sticker on the FRONT face, lower-left of the
  // aperture (visible in the product photo).
  const stickerW = mmToThree(14);
  const stickerH = mmToThree(10);
  const sticker = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(0.5), stickerH, stickerW),
    new THREE.MeshStandardMaterial({
      color: enabled ? "#d62828" : "#7d2424",
      metalness: 0.1,
      roughness: 0.7,
      emissive: enabled ? "#3a0a0a" : "#000000",
      emissiveIntensity: enabled ? 0.15 : 0,
    }),
  );
  sticker.position.set(mmToThree(0.25), -axisFromBottom + mmToThree(15), -mmToThree(35));
  group.add(sticker);

  // Four corner mounting screws on the FRONT face (M4 from PDF sheet 4)
  // — very small, just to convey "it's a bolted plate".
  const screwRadius = mmToThree(2.0);
  const screwDepth = mmToThree(1.0);
  for (const [dx, dy] of [
    [-mmToThree(50), -axisFromBottom + mmToThree(8)],
    [mmToThree(50), -axisFromBottom + mmToThree(8)],
    [-mmToThree(50), -axisFromBottom + mmToThree(blackHeightMm - 8)],
    [mmToThree(50), -axisFromBottom + mmToThree(blackHeightMm - 8)],
  ]) {
    const screw = new THREE.Mesh(
      new THREE.CylinderGeometry(screwRadius, screwRadius, screwDepth, 12),
      screwHead,
    );
    screw.rotation.z = Math.PI / 2;
    screw.position.set(screwDepth / 2 + mmToThree(0.1), dy, dx);
    group.add(screw);
  }

  // "BoosTA" wordmark on the BLUE LID side (front-facing). Drawn as a
  // canvas-backed sprite plane so the text reads at any zoom.
  const labelTexture = (() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 96;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 64px 'Inter', 'Segoe UI', sans-serif";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText("BoosTA pro", 16, canvas.height / 2);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    return tex;
  })();
  const labelMatBlue = new THREE.MeshBasicMaterial({
    map: labelTexture,
    transparent: true,
    depthWrite: false,
  });
  const labelW = mmToThree(80);
  const labelH = mmToThree(15);
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(labelW, labelH),
    labelMatBlue,
  );
  // Position on the FRONT face (z = +width/2 + 0.1mm), within the blue lid.
  label.position.set(
    -length / 2 + mmToThree(60),  // toward the back-end of the box (visible offset)
    blueCentreY,                    // centred on the blue lid
    width / 2 + mmToThree(0.1),    // slightly outside the front face
  );
  group.add(label);

  // Mounting-clamp channels — recessed strip on each Z side face. PDF
  // sheets 7/8: depth 5 mm, height ~20 mm, 10 mm back from each end.
  // Sit on the BLACK lower portion so they read as machined-into-block.
  const channelLengthMm = lengthMm - 20;
  const channelLength = mmToThree(channelLengthMm);
  const channelHeight = mmToThree(20);
  const channelDepth = mmToThree(2);  // visual hint; real depth is 5 mm
  const channelY = -axisFromBottom + mmToThree(15);  // mid-height of black portion
  for (const sign of [-1, 1] as const) {
    const channel = new THREE.Mesh(
      new THREE.BoxGeometry(channelLength, channelHeight, channelDepth),
      channelMaterial,
    );
    channel.position.set(
      -length / 2,
      channelY,
      sign * (width / 2 - channelDepth / 2),
    );
    group.add(channel);
  }

  return group;
}
