import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import { resolveAssetUrl } from "../api/client";
import type { Asset3D, ComponentItem, DeviceState } from "../types/digitalTwin";
import { createNewportOpticalTable } from "./photoRoom";
import { getDimensionsMm, getNumericProperty, mmToThree } from "./transformUtils";

const gltfLoader = new GLTFLoader();
const objLoader = new OBJLoader();
const stlLoader = new STLLoader();

function colorForComponent(component: ComponentItem, state?: DeviceState): THREE.ColorRepresentation {
  const deviceState = state?.state ?? {};
  const enabled = deviceState.enabled;
  const temperatureC = typeof deviceState.temperatureC === "number" ? deviceState.temperatureC : 0;
  const pressurePa = typeof deviceState.pressurePa === "number" ? deviceState.pressurePa : 0;

  if (component.componentType === "rf_amplifier" && temperatureC > 45) return "#dc2626";
  if (component.componentType === "vacuum_chamber" && pressurePa > 0.01) return "#dc2626";
  if (enabled === false) return "#6b7280";

  switch (component.componentType) {
    case "optical_table":
      return "#3f4742";
    case "vacuum_chamber":
      return "#8dd3c7";
    case "laser":
      return "#0f766e";
    case "laser_diode_mount":
      return "#6b7280";
    case "mirror":
      return "#c4b5fd";
    case "lens":
      return "#93c5fd";
    case "aom":
      return "#f59e0b";
    case "eom":
      return "#e879f9";
    case "rf_generator":
      return "#57534e";
    case "rf_amplifier":
      return "#7c2d12";
    case "post_holder":
      return "#111827";
    case "optical_post":
      return "#d1d5db";
    case "clamping_fork":
      return "#a8b0b8";
    default:
      return "#64748b";
  }
}

function materialFor(
  component: ComponentItem,
  state?: DeviceState,
): THREE.MeshStandardMaterial {
  const transparent = component.componentType === "vacuum_chamber" || component.componentType === "lens";
  return new THREE.MeshStandardMaterial({
    color: colorForComponent(component, state),
    metalness: ["mirror", "optical_post", "clamping_fork", "laser_diode_mount"].includes(component.componentType) ? 0.75 : 0.12,
    roughness: ["mirror", "optical_post", "clamping_fork", "laser_diode_mount"].includes(component.componentType) ? 0.2 : 0.42,
    transparent,
    opacity: component.componentType === "vacuum_chamber" ? 0.34 : component.componentType === "lens" ? 0.45 : 1,
  });
}

function createBox(
  component: ComponentItem,
  state: DeviceState | undefined,
  fallbackMm: [number, number, number],
): THREE.Mesh {
  const [xMm, yMm, zMm] = getDimensionsMm(component.properties, fallbackMm);
  return new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(xMm), mmToThree(zMm), mmToThree(yMm)),
    materialFor(component, state),
  );
}

function createThorlabsPost(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const radius = mmToThree(getNumericProperty(component.properties, "diameterMm", 12.7) / 2);
  const height = mmToThree(getNumericProperty(component.properties, "heightMm", 50));
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 40), materialFor(component, state));
  mesh.position.y = height / 2;
  return mesh;
}

function createThorlabsPostHolder(component: ComponentItem, state?: DeviceState): THREE.Object3D {
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

function createThorlabsClampingFork(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  const material = materialFor(component, state);
  const plateHeight = mmToThree(7);
  const armLength = mmToThree(58);
  const armWidth = mmToThree(13);
  const gap = mmToThree(18);
  const crossbar = new THREE.Mesh(new THREE.BoxGeometry(mmToThree(24), plateHeight, mmToThree(48)), material);
  crossbar.position.set(-mmToThree(24), plateHeight / 2, 0);
  group.add(crossbar);

  for (const z of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(armLength, plateHeight, armWidth), material);
    arm.position.set(mmToThree(11), plateHeight / 2, z * (gap / 2 + armWidth / 2));
    group.add(arm);
  }

  const screw = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(5.1), mmToThree(5.1), plateHeight + mmToThree(3), 28),
    new THREE.MeshStandardMaterial({ color: "#e5e7eb", metalness: 0.85, roughness: 0.18 }),
  );
  screw.position.set(mmToThree(8), plateHeight, 0);
  group.add(screw);
  return group;
}

function createTs2000aLaserMount(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const [lengthMm, widthMm, heightMm] = getDimensionsMm(component.properties, [72.6, 50.8, 44.5]);
  const length = mmToThree(lengthMm);
  const width = mmToThree(widthMm);
  const height = mmToThree(heightMm);
  const group = new THREE.Group();

  const bodyMaterial = materialFor(component, state);
  const darkMaterial = new THREE.MeshStandardMaterial({ color: "#111827", metalness: 0.45, roughness: 0.34 });
  const blackInset = new THREE.MeshStandardMaterial({ color: "#020617", metalness: 0.25, roughness: 0.5 });
  const connectorMaterial = new THREE.MeshStandardMaterial({ color: "#d1d5db", metalness: 0.82, roughness: 0.18 });
  const pinMaterial = new THREE.MeshStandardMaterial({ color: "#f8fafc", metalness: 0.9, roughness: 0.2 });
  const goldMaterial = new THREE.MeshStandardMaterial({ color: "#b7791f", metalness: 0.7, roughness: 0.25 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(length, height, width), bodyMaterial);
  body.position.y = height / 2;
  group.add(body);

  const rearBlock = new THREE.Mesh(new THREE.BoxGeometry(length * 0.2, height * 1.02, width * 1.02), bodyMaterial);
  rearBlock.position.set(-length * 0.4, height * 0.51, 0);
  group.add(rearBlock);

  const coverHeight = mmToThree(2.6);
  const cover = new THREE.Mesh(new THREE.BoxGeometry(length * 0.56, coverHeight, width * 0.94), bodyMaterial);
  cover.position.set(length * 0.08, height + coverHeight / 2, 0);
  group.add(cover);

  const coverSeam = new THREE.Mesh(new THREE.BoxGeometry(mmToThree(1.2), mmToThree(1.2), width * 1.03), darkMaterial);
  coverSeam.position.set(-length * 0.28, height + mmToThree(0.7), 0);
  group.add(coverSeam);

  const zifSocket = new THREE.Mesh(
    new THREE.BoxGeometry(length * 0.18, mmToThree(3), width * 0.18),
    goldMaterial,
  );
  zifSocket.position.set(length * 0.43, height * 0.36, 0);
  group.add(zifSocket);

  const frontX = length / 2 + mmToThree(0.9);
  const apertureFrame = new THREE.Mesh(new THREE.BoxGeometry(mmToThree(2.2), height * 0.48, width * 0.58), darkMaterial);
  apertureFrame.position.set(frontX, height * 0.48, 0);
  group.add(apertureFrame);

  const apertureVoid = new THREE.Mesh(new THREE.BoxGeometry(mmToThree(2.6), height * 0.33, width * 0.42), blackInset);
  apertureVoid.position.set(frontX + mmToThree(0.45), height * 0.48, 0);
  group.add(apertureVoid);

  const opticalNose = new THREE.Mesh(new THREE.CylinderGeometry(mmToThree(2.2), mmToThree(2.2), mmToThree(5.5), 24), blackInset);
  opticalNose.rotation.z = Math.PI / 2;
  opticalNose.position.set(frontX + mmToThree(2), height * 0.34, 0);
  group.add(opticalNose);

  const clampPost = new THREE.Mesh(new THREE.CylinderGeometry(mmToThree(1.5), mmToThree(1.5), height * 0.56, 24), connectorMaterial);
  clampPost.position.set(length * 0.37, height + height * 0.24, 0);
  group.add(clampPost);

  const knob = new THREE.Mesh(new THREE.CylinderGeometry(mmToThree(6), mmToThree(6), mmToThree(4), 32), connectorMaterial);
  knob.position.set(length * 0.37, height + height * 0.56, 0);
  group.add(knob);

  const spring = new THREE.Mesh(new THREE.TorusGeometry(mmToThree(4.2), mmToThree(0.45), 8, 28), connectorMaterial);
  spring.rotation.x = Math.PI / 2;
  spring.position.set(length * 0.37, height + mmToThree(4), 0);
  group.add(spring);

  for (const z of [-1, 1]) {
    for (const y of [0.33, 0.67]) {
      const cageHole = new THREE.Mesh(new THREE.CylinderGeometry(mmToThree(2.0), mmToThree(2.0), mmToThree(1.5), 20), blackInset);
      cageHole.rotation.z = Math.PI / 2;
      cageHole.position.set(frontX + mmToThree(1), height * y, z * width * 0.3);
      group.add(cageHole);
    }
  }

  const rearX = -length / 2 - mmToThree(1.5);
  const connectorSpecs = [
    { y: height * 0.68, pinCount: 15, connectorWidth: width * 0.56 },
    { y: height * 0.28, pinCount: 9, connectorWidth: width * 0.4 },
  ];

  for (const spec of connectorSpecs) {
    const connector = new THREE.Mesh(new THREE.BoxGeometry(mmToThree(3), height * 0.2, spec.connectorWidth), connectorMaterial);
    connector.position.set(rearX, spec.y, 0);
    group.add(connector);

    for (let index = 0; index < spec.pinCount; index += 1) {
      const row = index % 2;
      const column = Math.floor(index / 2);
      const columns = Math.ceil(spec.pinCount / 2);
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(mmToThree(0.45), mmToThree(0.45), mmToThree(2.2), 12), pinMaterial);
      pin.rotation.z = Math.PI / 2;
      pin.position.set(
        rearX - mmToThree(2.3),
        spec.y + (row - 0.5) * height * 0.07,
        (column - (columns - 1) / 2) * (spec.connectorWidth / columns) * 0.72,
      );
      group.add(pin);
    }

    for (const z of [-1, 1]) {
      const jackScrew = new THREE.Mesh(new THREE.CylinderGeometry(mmToThree(1.8), mmToThree(1.8), mmToThree(2.2), 18), connectorMaterial);
      jackScrew.rotation.z = Math.PI / 2;
      jackScrew.position.set(rearX - mmToThree(1), spec.y, z * spec.connectorWidth * 0.68);
      group.add(jackScrew);
    }
  }

  const finCount = 6;
  for (let index = 0; index < finCount; index += 1) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(mmToThree(2.2), height * 0.5, mmToThree(2.6)), darkMaterial);
    fin.position.set(length * (-0.02 + index * 0.085), height * 0.25, -width / 2 - mmToThree(1.2));
    group.add(fin);
  }

  for (const x of [-0.28, 0.28]) {
    for (const z of [-0.28, 0.28]) {
      const topHole = new THREE.Mesh(new THREE.CylinderGeometry(mmToThree(1.7), mmToThree(1.7), mmToThree(1.1), 20), blackInset);
      topHole.position.set(x * length, height + coverHeight + mmToThree(0.65), z * width * 0.72);
      group.add(topHole);
    }
  }

  for (const x of [-0.25, 0.36]) {
    const quarterTwenty = new THREE.Mesh(new THREE.CylinderGeometry(mmToThree(3.3), mmToThree(3.3), mmToThree(1.4), 24), blackInset);
    quarterTwenty.position.set(x * length, height + coverHeight + mmToThree(0.9), 0);
    group.add(quarterTwenty);
  }

  return group;
}

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
function createAom(component: ComponentItem, state?: DeviceState): THREE.Object3D {
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

/** Tapered-amplifier chip on heat sink — copper finned base with the chip
 *  itself rendered as a small narrow trapezoid on top, with a gold bond-pad
 *  near the input edge. Reads dimensionsMm so chip size matches the part. */
function createBoostaProModule(component: ComponentItem, state?: DeviceState): THREE.Object3D {
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

function createTaperedAmplifier(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  // BoosTA pro full module — distinguished from the bare-chip entry by
  // the `geometry` property on the ComponentTemplate.
  const geometry = (component.properties as { geometry?: string } | undefined)?.geometry;
  if (geometry === "boosta_pro_module") {
    return createBoostaProModule(component, state);
  }
  const [lengthMm, widthMm, heightMm] = getDimensionsMm(component.properties, [60, 30, 25]);
  const length = mmToThree(lengthMm);
  const width = mmToThree(widthMm);
  const height = mmToThree(heightMm);

  const group = new THREE.Group();

  const copperMaterial = new THREE.MeshStandardMaterial({
    color: "#b45309",
    metalness: 0.78,
    roughness: 0.34,
  });
  const goldMaterial = new THREE.MeshStandardMaterial({
    color: "#d4af37",
    metalness: 0.85,
    roughness: 0.22,
  });
  const ceramicMaterial = new THREE.MeshStandardMaterial({
    color: "#e2e8f0",
    metalness: 0.05,
    roughness: 0.6,
  });

  // Heat-sink base — copper block sized to the component's dimensionsMm.
  const heatSinkHeight = height * 0.55;
  const base = new THREE.Mesh(new THREE.BoxGeometry(length, heatSinkHeight, width), copperMaterial);
  base.position.y = heatSinkHeight / 2;
  group.add(base);

  // Cooling fins along the back edge.
  const finCount = 8;
  const finWidth = width * 0.05;
  const finHeight = heatSinkHeight * 0.85;
  for (let i = 0; i < finCount; i += 1) {
    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(length * 0.96, finHeight, finWidth),
      copperMaterial,
    );
    fin.position.set(
      0,
      heatSinkHeight + finHeight / 2,
      -width * 0.5 + finWidth * 0.5 + (i * width) / finCount,
    );
    group.add(fin);
  }

  // Ceramic submount the chip sits on.
  const submount = new THREE.Mesh(
    new THREE.BoxGeometry(length * 0.7, mmToThree(1.2), width * 0.55),
    ceramicMaterial,
  );
  submount.position.set(length * 0.05, heatSinkHeight + mmToThree(0.6), width * 0.18);
  group.add(submount);

  // The TA chip itself — a narrow trapezoid (CylinderGeometry with different
  // top/bottom radii standing in for the taper). Optical axis along +X so
  // the narrow end faces the input and the wide end faces the output.
  const chip = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(0.4), mmToThree(0.08), length * 0.55, 4),
    goldMaterial,
  );
  chip.rotation.z = Math.PI / 2;
  chip.position.set(length * 0.05, heatSinkHeight + mmToThree(1.6), width * 0.18);
  group.add(chip);

  // Gold bond pad near the input.
  const pad = new THREE.Mesh(
    new THREE.BoxGeometry(length * 0.08, mmToThree(0.6), width * 0.18),
    goldMaterial,
  );
  pad.position.set(-length * 0.22, heatSinkHeight + mmToThree(1.5), width * 0.18);
  group.add(pad);

  if (state?.state && (state.state as { enabled?: boolean }).enabled === false) {
    copperMaterial.color.set("#7c2d12");
  }
  return group;
}

function createPrimitive(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  group.name = component.name;

  let mesh: THREE.Object3D;
  switch (component.componentType) {
    case "optical_table":
      mesh = createBox(component, state, [1800, 1200, 90]);
      mesh.position.y = -0.45;
      break;
    case "mirror": {
      // Disc with optical axis along local +X — the reflective face is the
      // +X face of the disc, centred on the SceneObject origin so the beam
      // axis intersects it exactly when the user places the mirror at the
      // beam height. Replaces the old 8×42×3.5 mm thin-blade box (whose
      // largest faces were ±Z, not the +X face the kindParams.normalLocal
      // [1,0,0] was claiming).
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
      mesh = disc;
      break;
    }
    case "lens": {
      const radius = mmToThree(getNumericProperty(component.properties, "diameterMm", 25.4) / 2);
      const thickness = mmToThree(getNumericProperty(component.properties, "thicknessMm", 3.5));
      const lens = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, thickness, 40),
        materialFor(component, state),
      );
      // Optical axis along local +X. For a thin lens the "active surface"
      // is the +X face — beam in +X exits through it. Origin at +X face
      // centre, body in -X.
      lens.rotation.z = Math.PI / 2;
      lens.position.x = -thickness / 2;
      mesh = lens;
      break;
    }
    case "vacuum_chamber": {
      const radius = mmToThree(getNumericProperty(component.properties, "radiusMm", 150));
      const height = mmToThree(getNumericProperty(component.properties, "heightMm", 220));
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, height, 64),
        materialFor(component, state),
      );
      mesh.position.y = height / 2;
      break;
    }
    case "laser":
      mesh = createBox(component, state, [260, 90, 80]);
      mesh.position.y = 0.22;
      break;
    case "laser_diode_mount":
      mesh = createTs2000aLaserMount(component, state);
      break;
    case "aom":
      mesh = createAom(component, state);
      break;
    case "eom": {
      // Origin at the +X face centre of the EOM body, body extending in -X
      // (consistent with the optical-element convention so the beam axis
      // hits the active aperture when placed at scene-object position).
      const [lengthMm, widthMm, heightMm] = getDimensionsMm(component.properties, [120, 75, 70]);
      const length = mmToThree(lengthMm);
      const eom = new THREE.Mesh(
        new THREE.BoxGeometry(length, mmToThree(heightMm), mmToThree(widthMm)),
        materialFor(component, state),
      );
      eom.position.x = -length / 2;
      mesh = eom;
      break;
    }
    case "tapered_amplifier":
      mesh = createTaperedAmplifier(component, state);
      break;
    case "rf_generator":
      mesh = createBox(component, state, [280, 220, 100]);
      mesh.position.y = 0.2;
      break;
    case "rf_amplifier":
      mesh = createBox(component, state, [180, 140, 70]);
      mesh.position.y = 0.18;
      break;
    case "post_holder":
      mesh = createThorlabsPostHolder(component, state);
      break;
    case "optical_post":
      mesh = createThorlabsPost(component, state);
      break;
    case "clamping_fork":
      mesh = createThorlabsClampingFork(component, state);
      break;
    default:
      mesh = createBox(component, state, [100, 100, 80]);
      mesh.position.y = 0.2;
      break;
  }

  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  // Component-name sprite labels removed per UX feedback — labels above
  // every object cluttered the scene. Object identity is communicated via
  // the Outliner panel and on-hover highlighting instead.

  return group;
}

function applyAssetScale(object: THREE.Object3D, asset: Asset3D): void {
  const unitScale = asset.unit === "m" ? 10 : 1 / 100;
  object.scale.multiplyScalar(asset.scaleFactor * unitScale);
}

export async function loadAssetObject(
  component: ComponentItem,
  asset: Asset3D | undefined,
  state: DeviceState | undefined,
): Promise<THREE.Object3D> {
  if (component.componentType === "optical_table") {
    const table = createNewportOpticalTable();
    table.name = component.name;
    return table;
  }

  if (!asset || asset.filePath.startsWith("primitive://")) {
    return createPrimitive(component, state);
  }

  const assetUrl = resolveAssetUrl(asset.filePath);
  const extension = asset.filePath.split("?")[0].split(".").pop()?.toLowerCase();
  if (!["glb", "gltf", "obj", "stl"].includes(extension ?? "")) {
    return createPrimitive(component, state);
  }
  let object: THREE.Object3D;

  if (extension === "obj") {
    object = (await objLoader.loadAsync(assetUrl)).clone(true);
  } else if (extension === "stl") {
    const geometry = await stlLoader.loadAsync(assetUrl);
    geometry.computeVertexNormals();
    object = new THREE.Mesh(geometry, materialFor(component, state));
  } else {
    object = (await gltfLoader.loadAsync(assetUrl)).scene.clone(true);
  }

  object.name = component.name;
  applyAssetScale(object, asset);

  // Z-fighting on user-supplied GLBs (notably the BoosTA pro housing) where
  // the original CAD has coplanar surfaces — top plate + edge trim sharing
  // a face plane. Two compounding fixes:
  //   1. Force `side: FrontSide`. CAD exporters often default to
  //      DoubleSide which renders BOTH triangle faces; for two coplanar
  //      DoubleSide meshes the GPU has 4 faces (two front, two back) at
  //      the same depth → polygon offset can't fully disambiguate.
  //      Solid bodies only need front-face rendering anyway.
  //   2. Per-mesh polygon offset stratification cycling [0, -3.5] on
  //      mesh index. Even after #1 collapses to 2 front faces, identical
  //      coplanar surfaces still need a deterministic per-mesh bias so
  //      the GPU consistently picks the same winner every frame.
  // Materials are cloned to avoid bleeding the offset across meshes that
  // share a material instance from the GLB.
  let meshSeenIndex = 0;
  object.traverse((child) => {
    child.castShadow = true;
    child.receiveShadow = true;
    if (child instanceof THREE.Mesh && child.material) {
      const offsetMagnitude = (meshSeenIndex % 8) * 0.5;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      const cloned = materials.map((m) => {
        const c = m.clone();
        c.side = THREE.FrontSide;
        c.polygonOffset = true;
        c.polygonOffsetFactor = -offsetMagnitude;
        c.polygonOffsetUnits = -offsetMagnitude;
        return c;
      });
      child.material = Array.isArray(child.material) ? cloned : cloned[0];
      meshSeenIndex += 1;
    }
  });

  // Anchor strategy: STL/GLB authors put the local origin wherever they
  // want, so we shift the loaded object inside a wrapper Group so a
  // semantically-meaningful point lands at the wrapper origin. Downstream
  // code calls applyObjectTransform on the wrapper, which means user-set
  // (xMm, yMm, zMm) lands the chosen anchor at exactly that lab position.
  //
  // Two anchors supported:
  //   1. apertureForwardLocalMm (in component.properties): user-supplied
  //      [bx, by, bz] in Blender's NATIVE frame (X right, Y forward, Z up,
  //      mm). Used for emitter components like the BoosTA pro TA — places
  //      the OUTPUT APERTURE at the wrapper origin so the SceneObject's
  //      lab position equals the BEAM EMISSION POINT. Lets the user place
  //      the TA at a known beam-line coordinate without compensating for
  //      bbox geometry.
  //   2. Default: bbox center → wrapper origin. Sensible fallback for
  //      arbitrary catalog assets where we don't have semantic anchors.
  // Optical-table is excluded — it's already anchored at its top-surface
  // centre by createNewportOpticalTable.
  if (component.componentType !== "optical_table") {
    const wrapper = new THREE.Group();
    wrapper.name = component.name;
    wrapper.add(object);
    // Phase 6: prefer the new frame-suffixed key
    // (`apertureForwardMmBodyLocal`), fall back to legacy
    // `apertureForwardLocalMm` for un-migrated rows.
    const apertureProps = component.properties as
      | { apertureForwardMmBodyLocal?: number[]; apertureForwardLocalMm?: number[] }
      | undefined;
    const apertureForward = apertureProps?.apertureForwardMmBodyLocal
      ?? apertureProps?.apertureForwardLocalMm;
    if (apertureForward && apertureForward.length === 3) {
      // Blender (X, Y, Z) → glTF/three (X, Z, -Y); mm → three units (÷100).
      // The shift is applied AS POSITION on `object` (which lives in
      // wrapper-local space, no scale), so values are in three units.
      const [bx, by, bz] = apertureForward;
      const apertureShift = new THREE.Vector3(bx, bz, -by).divideScalar(100);
      object.position.sub(apertureShift);
    } else {
      const bbox = new THREE.Box3().setFromObject(object);
      if (!bbox.isEmpty()) {
        const centerVec = bbox.getCenter(new THREE.Vector3());
        object.position.sub(centerVec);
      }
    }
    return wrapper;
  }
  return object;
}

export function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((item) => item.dispose());
    } else if (material) {
      material.dispose();
    }
  });
}
