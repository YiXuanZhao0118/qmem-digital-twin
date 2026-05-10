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

/** Free-form text annotation rendered as a billboard sprite. Uses the same
 *  canvas-textured rounded-rectangle approach as `addTaPortLabels` in the
 *  viewer, but driven entirely by the SceneObject's component properties so
 *  the user can place arbitrary labels anywhere in the scene (section
 *  headers, debug notes, "Cooling beam" markers …) without writing code.
 *
 *  Properties read from component.properties:
 *   - text         : string  – label content (default = component.name)
 *   - textColor    : string  – CSS colour for the glyphs (default white)
 *   - bgColor      : string  – CSS colour for the rounded panel (default
 *                              dark slate at 85% alpha)
 *   - accentColor  : string  – stroke colour around the panel (default teal)
 *   - fontSizePx   : number  – canvas-space font size; bigger = sharper
 *                              when zoomed in (default 56)
 *   - scaleMm      : number  – on-screen WIDTH of the label in mm at scene
 *                              scale; height auto-derives from aspect ratio
 *                              (default 80) */
function createTextAnnotation(component: ComponentItem): THREE.Sprite {
  const props = component.properties as {
    text?: unknown;
    textColor?: unknown;
    bgColor?: unknown;
    accentColor?: unknown;
    fontSizePx?: unknown;
    scaleMm?: unknown;
  };
  const text =
    typeof props.text === "string" && props.text.length > 0
      ? props.text
      : component.name || "Text";
  const textColor = typeof props.textColor === "string" ? props.textColor : "#ffffff";
  const bgColor =
    typeof props.bgColor === "string" ? props.bgColor : "rgba(15, 23, 42, 0.85)";
  const accentColor =
    typeof props.accentColor === "string" ? props.accentColor : "#38bdf8";
  const fontSizePx =
    typeof props.fontSizePx === "number" && props.fontSizePx > 0 ? props.fontSizePx : 56;
  const scaleMm =
    typeof props.scaleMm === "number" && props.scaleMm > 0 ? props.scaleMm : 80;

  const canvas = document.createElement("canvas");
  const measureCtx = canvas.getContext("2d");
  const fontSpec = `bold ${fontSizePx}px 'Inter', 'Segoe UI', sans-serif`;
  let textWidth = fontSizePx * 4;
  if (measureCtx) {
    measureCtx.font = fontSpec;
    textWidth = measureCtx.measureText(text).width;
  }
  const padX = Math.max(16, fontSizePx * 0.55);
  const padY = Math.max(10, fontSizePx * 0.4);
  const cw = Math.max(96, Math.ceil(textWidth + padX * 2));
  const ch = Math.ceil(fontSizePx + padY * 2);
  canvas.width = cw;
  canvas.height = ch;

  const ctx = canvas.getContext("2d");
  if (ctx) {
    const radius = Math.min(cw, ch) * 0.18;
    ctx.fillStyle = bgColor;
    ctx.beginPath();
    ctx.moveTo(radius, 0);
    ctx.arcTo(cw, 0, cw, ch, radius);
    ctx.arcTo(cw, ch, 0, ch, radius);
    ctx.arcTo(0, ch, 0, 0, radius);
    ctx.arcTo(0, 0, cw, 0, radius);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = Math.max(2, fontSizePx * 0.06);
    ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.font = fontSpec;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cw / 2, ch / 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false }),
  );
  // scaleMm sets the on-table WIDTH; height tracks the canvas aspect ratio
  // so the rounded box doesn't squash when text is short or long.
  const widthThree = mmToThree(scaleMm);
  const aspectHW = ch / cw;
  sprite.scale.set(widthThree, widthThree * aspectHW, 1);
  sprite.userData.isTextAnnotation = true;
  sprite.renderOrder = 100;
  return sprite;
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
    case "text_annotation":
      mesh = createTextAnnotation(component);
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

// Fiber patch cable rendering — procedural Bezier-spline tube editable in
// the viewer's "fiber edit mode". Each node carries its anchor position
// plus optional tangent-handle offsets (handleInMm = toward previous node,
// handleOutMm = toward next node). For a smooth curve, segment between
// nodes [i]/[i+1] is a CubicBezier with control points
//   P0 = nodes[i].posMm
//   P1 = P0 + nodes[i].handleOutMm
//   P2 = P3 + nodes[i+1].handleInMm
//   P3 = nodes[i+1].posMm
// All segments are stitched via CurvePath, then sweep TubeGeometry.
//
// Lab → three axis convention: lab (x, y, z) → three (x, z, -y); mm → three
// units divides by 100 (matches applyAssetScale's mm fallback).
export type FiberNode = {
  posMm: [number, number, number];
  handleInMm?: [number, number, number];
  handleOutMm?: [number, number, number];
};

const labMmToFiberThree = (p: [number, number, number]) =>
  new THREE.Vector3(p[0] / 100, p[2] / 100, -p[1] / 100);

const offsetMmToFiberThree = (d: [number, number, number]) =>
  new THREE.Vector3(d[0] / 100, d[2] / 100, -d[1] / 100);

export function buildFiberCurvePath(nodes: FiberNode[]): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>();
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const segmentDelta: [number, number, number] = [
      b.posMm[0] - a.posMm[0],
      b.posMm[1] - a.posMm[1],
      b.posMm[2] - a.posMm[2],
    ];
    const defaultHandle: [number, number, number] = [
      segmentDelta[0] / 3,
      segmentDelta[1] / 3,
      segmentDelta[2] / 3,
    ];
    const aOut = a.handleOutMm ?? defaultHandle;
    const bIn = b.handleInMm ?? [-defaultHandle[0], -defaultHandle[1], -defaultHandle[2]];
    const p0 = labMmToFiberThree(a.posMm);
    const p3 = labMmToFiberThree(b.posMm);
    const p1 = p0.clone().add(offsetMmToFiberThree(aOut));
    const p2 = p3.clone().add(offsetMmToFiberThree(bIn));
    path.add(new THREE.CubicBezierCurve3(p0, p1, p2, p3));
  }
  return path;
}

/** OUTWARD direction (in three units, fiber-wrapper-local) at endpoint
 *  `endpoint` of the Bezier polyline `nodes` — the unit vector pointing
 *  AWAY from the curve body, used to orient the FC connector ferrule. For
 *  endpoint A this is `-handleOut` (the curve leaves A toward B in the
 *  +handleOut direction); for endpoint B it's `-handleIn`. Falls back to
 *  the segment direction toward the neighbour if the handle is missing
 *  or zero-length. */
export function fiberEndpointOutwardThree(
  nodes: FiberNode[],
  endpoint: "A" | "B",
): THREE.Vector3 {
  const idx = endpoint === "A" ? 0 : nodes.length - 1;
  const neighbourIdx = endpoint === "A" ? 1 : nodes.length - 2;
  const node = nodes[idx];
  const handle = endpoint === "A" ? node.handleOutMm : node.handleInMm;
  if (handle && handle[0] ** 2 + handle[1] ** 2 + handle[2] ** 2 > 1e-9) {
    return offsetMmToFiberThree([-handle[0], -handle[1], -handle[2]]).normalize();
  }
  const neighbour = nodes[neighbourIdx];
  const seg = labMmToFiberThree(node.posMm).clone().sub(labMmToFiberThree(neighbour.posMm));
  if (seg.lengthSq() < 1e-9) seg.set(1, 0, 0);
  return seg.normalize();
}

// Jacket colours follow the Thorlabs colour-coding convention used in the
// product photos: yellow for SM single-mode, blue for PM polarization-
// maintaining, orange for MM multi-mode. This is also the boot colour used
// on PC ends (APC ends are always green by industry convention).
type FiberType = "single_mode" | "polarization_maintaining" | "multi_mode";
type Polish = "PC" | "UPC" | "APC" | "AR";

const FIBER_JACKET_COLOR: Record<FiberType, string> = {
  single_mode: "#facc15",            // yellow (Thorlabs SM PVC / Hytrel jacket)
  polarization_maintaining: "#1d4ed8", // deep blue (Thorlabs PM jacket)
  multi_mode: "#fb923c",             // orange (typical OM-series MM cable)
};

const APC_BOOT_COLOR = "#16a34a";    // bright green — industry standard for APC

function pickFiberType(component: ComponentItem): FiberType {
  const props = component.properties as
    | { fiberKindParamsOverride?: { fiberType?: string } }
    | undefined;
  const t = props?.fiberKindParamsOverride?.fiberType;
  if (t === "single_mode" || t === "multi_mode" || t === "polarization_maintaining") {
    return t;
  }
  // Default in DEFAULT_KIND_PARAMS["fiber"] is PM, mirror that here.
  return "polarization_maintaining";
}

function pickEndPolish(component: ComponentItem, endpoint: "A" | "B"): Polish {
  const props = component.properties as
    | {
        fiberKindParamsOverride?: {
          endA?: { polish?: string };
          endB?: { polish?: string };
        };
      }
    | undefined;
  const raw =
    endpoint === "A"
      ? props?.fiberKindParamsOverride?.endA?.polish
      : props?.fiberKindParamsOverride?.endB?.polish;
  if (raw === "PC" || raw === "UPC" || raw === "APC" || raw === "AR") return raw;
  return "PC";
}

interface FcConnectorOptions {
  polish: Polish;
  bootColor: string;
}

// 30126A9 reference geometry (Thorlabs FC/APC connector housing): high-fidelity
// mesh imported from the published STEP file via FreeCAD STEP→STL. Loaded once
// per session and shared across every fiber connector instance for memory
// efficiency. While the load is in flight, fiber connectors fall back to the
// procedural geometry below; once the cache fills they'll use the imported
// shape on the next fiber re-render.
//   - Original STEP frame: longitudinal axis +Z, cable-side end at z≈-25 mm,
//     ferrule tip at z≈+11.28 mm, Ø10 mm at the coupling nut.
//   - APC ferrule has the 8° polish baked into the geometry; the PC variant
//     is generated on demand by clamping the ferrule-tip vertices to a single
//     y so the slanted face becomes flat.
//   - All transforms are baked into the cached BufferGeometry: rotateX(-π/2)
//     swings +Z → +Y, translate(+25 mm in pre-scale frame) puts the cable end
//     at y=0, then scale 0.01 maps mm → scene units (1 unit = 100 mm).
const FC_HOUSING_ASSET_PATH = "uploads/thorlabs_fc_apc_30126a9.stl";
const FC_HOUSING_LENGTH_MM = 36.28;
const FC_HOUSING_FERRULE_TIP_RADIUS_MM = 1.25;
let fcHousingApcGeometryCache: THREE.BufferGeometry | null = null;
let fcHousingPcGeometryCache: THREE.BufferGeometry | null = null;
let fcHousingLoadPromise: Promise<void> | null = null;

function loadFcHousingGeometry(): Promise<void> {
  if (fcHousingApcGeometryCache && fcHousingPcGeometryCache) return Promise.resolve();
  if (!fcHousingLoadPromise) {
    fcHousingLoadPromise = stlLoader
      .loadAsync(resolveAssetUrl(FC_HOUSING_ASSET_PATH))
      .then((raw: THREE.BufferGeometry) => {
        // Bake the orientation/scale transforms once into the geometry so the
        // per-fiber Mesh just references it without further transforms. The
        // procedural boot was removed 2026-05-09 (it added an unwanted
        // Ø3→Ø6 taper at each cable end), so the housing's cable-side end
        // sits exactly at the fiber endpoint (y=0). The cable goes directly
        // into the rear plastic barrel of the imported model.
        raw.rotateX(-Math.PI / 2); // +Z → +Y in original STL frame
        raw.translate(0, 25, 0);   // cable end (was z=-25) → y=0 mm
        raw.scale(0.01, 0.01, 0.01); // mm → scene units (1 unit = 100 mm)
        raw.computeVertexNormals();

        // Split the housing into 3 visual zones along the longitudinal axis
        // by reordering triangles and emitting BufferGeometry groups. Per-
        // triangle Y boundaries chosen from inspecting the STL radial-vs-Z
        // distribution (scripts/_inspect_stl_zones.py): rear barrel narrows
        // and the wide hex coupling nut starts around STL z = -9 mm; the
        // ceramic ferrule (Ø2.5 mm) starts around z = +10 mm.
        //   group 0 → rear barrel (plastic, jacket-coloured by polish)
        //   group 1 → coupling nut + body sleeve + chrome ring (silver metal)
        //   group 2 → ceramic ferrule (white zirconia)
        const Y_REAR_TO_MID = 0.16; // 16 mm in scene units (= STL z -9 mm)
        const Y_MID_TO_TIP = 0.35;  // 35 mm in scene units (= STL z +10 mm)
        const pos = raw.attributes.position;
        const norm = raw.attributes.normal;
        const vertCount = pos.count;
        const triCount = vertCount / 3;
        const triZones: number[] = new Array(triCount);
        const counts = [0, 0, 0];
        for (let t = 0; t < triCount; t++) {
          const yc = (pos.getY(t * 3) + pos.getY(t * 3 + 1) + pos.getY(t * 3 + 2)) / 3;
          const z = yc < Y_REAR_TO_MID ? 0 : yc < Y_MID_TO_TIP ? 1 : 2;
          triZones[t] = z;
          counts[z]++;
        }
        // Stable reorder: triangles are written into the new buffer grouped
        // by zone, preserving original order within each zone.
        const newPos = new Float32Array(pos.array.length);
        const newNorm = new Float32Array(norm.array.length);
        const writeOffset = [0, counts[0], counts[0] + counts[1]]; // tri-index offsets per zone
        const writeCursor = [0, 0, 0];
        for (let t = 0; t < triCount; t++) {
          const z = triZones[t];
          const dstTri = writeOffset[z] + writeCursor[z]++;
          for (let v = 0; v < 3; v++) {
            const srcBase = (t * 3 + v) * 3;
            const dstBase = (dstTri * 3 + v) * 3;
            newPos[dstBase] = pos.array[srcBase];
            newPos[dstBase + 1] = pos.array[srcBase + 1];
            newPos[dstBase + 2] = pos.array[srcBase + 2];
            newNorm[dstBase] = norm.array[srcBase];
            newNorm[dstBase + 1] = norm.array[srcBase + 1];
            newNorm[dstBase + 2] = norm.array[srcBase + 2];
          }
        }
        (pos.array as Float32Array).set(newPos);
        (norm.array as Float32Array).set(newNorm);
        pos.needsUpdate = true;
        norm.needsUpdate = true;
        raw.clearGroups();
        let cursor = 0;
        for (let z = 0; z < 3; z++) {
          raw.addGroup(cursor, counts[z] * 3, z);
          cursor += counts[z] * 3;
        }
        raw.computeBoundingBox();
        fcHousingApcGeometryCache = raw;

        // Build a flat-tip clone for PC ends. The ferrule tip in the imported
        // STL is the cluster of vertices at the maximum Y; flatten any vertex
        // within ±0.5 mm of that y to a single value so the 8° slope becomes
        // perfectly flat. (Sub-millimetre clamp; the rest of the housing is
        // untouched, and BufferGeometry groups are inherited via clone().)
        const pc = raw.clone();
        const pcPos = pc.attributes.position;
        const bbox = pc.boundingBox!;
        const tipY = bbox.max.y;
        const flattenBand = 0.005; // 0.5 mm in scene units
        for (let i = 0; i < pcPos.count; i++) {
          if (pcPos.getY(i) > tipY - flattenBand) {
            pcPos.setY(i, tipY);
          }
        }
        pcPos.needsUpdate = true;
        pc.computeVertexNormals();
        fcHousingPcGeometryCache = pc;
      })
      .catch((err: unknown) => {
        console.warn("[fiber] failed to load FC housing STL, falling back to procedural geometry", err);
      });
  }
  return fcHousingLoadPromise;
}

// Kick off the load eagerly at module init so by the time the user drops a
// fiber on the scene the cache is populated. Errors are swallowed; fall-back
// procedural geometry still renders.
loadFcHousingGeometry();

function buildFcConnectorMesh(options: FcConnectorOptions = { polish: "PC", bootColor: "#0a0a0c" }): THREE.Group {
  // FC connector model. Stacked along local +Y from the cable side at y=0
  // to the ferrule tip at y ≈ 0.3628 (= 36.28 mm). The caller rotates the
  // group so +Y aligns with the outward direction at the fiber endpoint.
  //
  // No procedural boot: the cable's straight TubeGeometry feeds directly
  // into the imported Thorlabs 30126A9 housing whose rear plastic barrel
  // (group 0, jacket-coloured) provides the visual identity that a rubber
  // boot would give. The 30126A9 STL itself contains the rear barrel,
  // hex coupling nut, body sleeve, chrome shoulder ring and ceramic
  // ferrule — APC ends use the imported geometry as-is (8° polish baked
  // in); PC ends use a clone with the ferrule-tip vertices clamped flat.
  // Falls back to a procedural housing while the STL load is in flight.
  const conn = new THREE.Group();
  conn.userData.fiberRole = "connector";
  conn.userData.fiberPolish = options.polish;

  // ---------- materials ----------------------------------------------
  // Per-zone materials for the imported STL housing:
  //   group 0 (rear barrel): plastic, jacket-coloured for PC, green for APC.
  //   group 1 (coupling nut + body sleeve + chrome ring): silver metal.
  //   group 2 (ceramic ferrule tip): white zirconia.
  const rearPlastic = new THREE.MeshStandardMaterial({
    color: options.bootColor, metalness: 0.0, roughness: 0.85,
  });
  const housingMetal = new THREE.MeshStandardMaterial({
    color: "#c9ccd2", metalness: 0.92, roughness: 0.28,
  });
  const housingCeramic = new THREE.MeshStandardMaterial({
    color: "#f5f3ee", metalness: 0.05, roughness: 0.38,
  });

  // ---------- helpers ------------------------------------------------
  const mm = (v: number) => v / 100;

  // ---------- Thorlabs-imported housing (STL) ------------------------
  const cachedHousing = options.polish === "APC"
    ? fcHousingApcGeometryCache
    : fcHousingPcGeometryCache;

  if (cachedHousing) {
    // Geometry has 3 groups: 0=rear plastic, 1=silver metal, 2=ceramic ferrule.
    // Materials array order must match group materialIndex.
    const housing = new THREE.Mesh(cachedHousing, [rearPlastic, housingMetal, housingCeramic]);
    housing.userData.fiberRole = "housing";
    housing.userData.thorlabsModel = "30126A9";
    conn.add(housing);
  } else {
    // STL still loading — render a slim procedural placeholder so the
    // connector isn't invisible during the brief load window. Replaced
    // with the imported geometry on next fiber re-render once the cache
    // populates.
    const knurlMetal = new THREE.MeshStandardMaterial({
      color: "#a8acb2", metalness: 0.85, roughness: 0.42,
    });
    const sleeveMetal = new THREE.MeshStandardMaterial({
      color: "#8c9098", metalness: 0.88, roughness: 0.34,
    });
    const ceramic = new THREE.MeshStandardMaterial({
      color: "#f5f3ee", metalness: 0.05, roughness: 0.38,
    });
    const chromeRing = new THREE.MeshStandardMaterial({
      color: "#d8dadd", metalness: 0.95, roughness: 0.18,
    });

    let cursorY = 0;
    const rearLen = 16;
    const rearBarrel = new THREE.Mesh(
      new THREE.CylinderGeometry(mm(3.0), mm(2.5), mm(rearLen), 24),
      rearPlastic,
    );
    rearBarrel.position.y = mm(cursorY + rearLen / 2);
    conn.add(rearBarrel);
    cursorY += rearLen;

    const nutLen = 9, nutKnurlLen = 5.5;
    const nutSmoothLen = nutLen - nutKnurlLen;
    const nut = new THREE.Mesh(
      new THREE.CylinderGeometry(mm(4.0), mm(4.0), mm(nutSmoothLen), 6),
      housingMetal,
    );
    nut.position.y = mm(cursorY + nutSmoothLen / 2);
    conn.add(nut);
    const nutKnurl = new THREE.Mesh(
      new THREE.CylinderGeometry(mm(4.05), mm(4.05), mm(nutKnurlLen), 6),
      knurlMetal,
    );
    nutKnurl.position.y = mm(cursorY + nutSmoothLen + nutKnurlLen / 2);
    conn.add(nutKnurl);
    cursorY += nutLen;

    const sleeveLen = 4;
    const sleeve = new THREE.Mesh(
      new THREE.CylinderGeometry(mm(3.0), mm(3.5), mm(sleeveLen), 20),
      sleeveMetal,
    );
    sleeve.position.y = mm(cursorY + sleeveLen / 2);
    conn.add(sleeve);
    cursorY += sleeveLen;

    const shoulderRingLen = 1;
    const shoulderRing = new THREE.Mesh(
      new THREE.CylinderGeometry(mm(2.0), mm(2.0), mm(shoulderRingLen), 24),
      chromeRing,
    );
    shoulderRing.position.y = mm(cursorY + shoulderRingLen / 2);
    conn.add(shoulderRing);
    cursorY += shoulderRingLen;

    const ferruleLen = 10;
    const ferruleHeight = mm(ferruleLen);
    const ferruleGeom = new THREE.CylinderGeometry(mm(1.20), mm(1.25), ferruleHeight, 20);
    if (options.polish === "APC") {
      const pos = ferruleGeom.attributes.position;
      const topY = ferruleHeight / 2;
      const tan8 = Math.tan((8 * Math.PI) / 180);
      for (let i = 0; i < pos.count; i++) {
        if (Math.abs(pos.getY(i) - topY) < 1e-5) {
          pos.setY(i, topY - pos.getZ(i) * tan8);
        }
      }
      pos.needsUpdate = true;
      ferruleGeom.computeVertexNormals();
    }
    const ferrule = new THREE.Mesh(ferruleGeom, ceramic);
    ferrule.position.y = mm(cursorY + ferruleLen / 2);
    conn.add(ferrule);

    const keyPin = new THREE.Mesh(
      new THREE.CylinderGeometry(mm(0.6), mm(0.6), mm(1.6), 14),
      chromeRing,
    );
    keyPin.rotation.z = Math.PI / 2;
    keyPin.position.set(mm(4.05 + 0.8), mm(rearLen + nutSmoothLen + nutKnurlLen + sleeveLen * 0.4), 0);
    conn.add(keyPin);
  }

  conn.traverse((c) => {
    c.castShadow = true;
    c.receiveShadow = true;
  });
  return conn;
}

/** Re-orient and reposition a previously-built FC connector group to
 *  match the current node array. Used both at initial build (loadAsset)
 *  and live during drag (DigitalTwinViewer's rebuildTube), so the
 *  connector tracks anchor and tangent-handle changes in real time. */
export function applyFiberConnectorTransform(
  conn: THREE.Object3D,
  nodes: FiberNode[],
  endpoint: "A" | "B",
): void {
  const idx = endpoint === "A" ? 0 : nodes.length - 1;
  const outward = fiberEndpointOutwardThree(nodes, endpoint);
  conn.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), outward);
  conn.position.copy(labMmToFiberThree(nodes[idx].posMm));
}

function createFiberSplineObject(component: ComponentItem): THREE.Object3D {
  const props = (component.properties as { fiberNodes?: FiberNode[]; radiusMm?: number } | undefined) ?? {};
  const nodes: FiberNode[] = (props.fiberNodes && props.fiberNodes.length >= 2)
    ? props.fiberNodes
    : [
        { posMm: [0, 0, 50], handleOutMm: [100, 0, 0] },
        { posMm: [300, 0, 50], handleInMm: [-100, 0, 0] },
      ];
  const radiusMm = typeof props.radiusMm === "number" && props.radiusMm > 0 ? props.radiusMm : 1.0;

  const fiberType = pickFiberType(component);
  const jacketColor = FIBER_JACKET_COLOR[fiberType];
  const polishA = pickEndPolish(component, "A");
  const polishB = pickEndPolish(component, "B");
  const bootColorA = polishA === "APC" ? APC_BOOT_COLOR : jacketColor;
  const bootColorB = polishB === "APC" ? APC_BOOT_COLOR : jacketColor;

  const path = buildFiberCurvePath(nodes);
  const tubularSegments = Math.max(64, (nodes.length - 1) * 32);
  const geometry = new THREE.TubeGeometry(path, tubularSegments, radiusMm / 100, 12, false);

  const jacket = new THREE.MeshStandardMaterial({
    color: jacketColor,
    metalness: 0.05,
    roughness: 0.55,
  });
  const tube = new THREE.Mesh(geometry, jacket);
  tube.castShadow = true;
  tube.receiveShadow = true;
  tube.name = `${component.name}__tube`;
  tube.userData.fiberRole = "tube";

  const group = new THREE.Group();
  group.name = component.name;
  group.userData.fiberComponentId = component.id;
  group.userData.fiberType = fiberType;
  group.add(tube);

  // FC connector at each endpoint. Outward direction comes from the
  // Bezier handle on that endpoint — handleOut at A points INTO the curve,
  // so the connector's ferrule sticks out in -handleOut. handleIn at B
  // similarly points back INTO the curve. Per-end polish (PC vs APC)
  // controls both the ferrule tip geometry (flat vs 8°) and the boot
  // colour (jacket-coloured for PC, green for APC).
  const connA = buildFcConnectorMesh({ polish: polishA, bootColor: bootColorA });
  connA.userData.fiberConnectorEndpoint = "A";
  applyFiberConnectorTransform(connA, nodes, "A");
  group.add(connA);
  const connB = buildFcConnectorMesh({ polish: polishB, bootColor: bootColorB });
  connB.userData.fiberConnectorEndpoint = "B";
  applyFiberConnectorTransform(connB, nodes, "B");
  group.add(connB);

  return group;
}

// Render the Thorlabs BB1-E03 broadband dielectric mirror as glass body +
// pink iridescent reflective coating, instead of the default flat-grey STL
// look. Front face = the optical/coated face (bears the BB1-E03 THORLABS
// engraving in the photo); body = green-tinted glass substrate.
//
// The STEP→STL export from FreeCAD produces a non-indexed mesh oriented
// along whichever axis the original Thorlabs CAD used. We auto-detect the
// disc axis (= smallest bbox dimension) and partition triangles by face
// normal × axial position into two sub-meshes. The "+axis" flat face is
// designated as the optical face; if the user later finds the wrong face
// is coated, we expose a `frontFaceAxisSign` property override.
function isBB1E03Asset(asset: Asset3D): boolean {
  return asset.name === "thorlabs_bb1_e03_stl"
    || /thorlabs_bb1_e03\.stl$/i.test(asset.filePath);
}

function buildBB1E03MirrorObject(
  geometry: THREE.BufferGeometry,
  component: ComponentItem,
): THREE.Object3D {
  const positionAttr = geometry.attributes.position as THREE.BufferAttribute;
  const oldPositions = positionAttr.array as Float32Array;

  const bbox = new THREE.Box3().setFromBufferAttribute(positionAttr);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  let axisIdx: 0 | 1 | 2 = 0;
  if (size.y < size.x && size.y < size.z) axisIdx = 1;
  else if (size.z < size.x && size.z < size.y) axisIdx = 2;
  const axisCenter =
    (bbox.min.getComponent(axisIdx) + bbox.max.getComponent(axisIdx)) / 2;

  const frontSign = (() => {
    const raw = (component.properties as { frontFaceAxisSign?: number } | undefined)
      ?.frontFaceAxisSign;
    return raw === -1 ? -1 : 1;
  })();

  const triangleCount = Math.floor(positionAttr.count / 3);
  const frontTris: number[] = [];
  const bodyTris: number[] = [];
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let t = 0; t < triangleCount; t += 1) {
    const o = t * 9;
    v1.set(oldPositions[o + 0], oldPositions[o + 1], oldPositions[o + 2]);
    v2.set(oldPositions[o + 3], oldPositions[o + 4], oldPositions[o + 5]);
    v3.set(oldPositions[o + 6], oldPositions[o + 7], oldPositions[o + 8]);
    e1.subVectors(v2, v1);
    e2.subVectors(v3, v1);
    normal.crossVectors(e1, e2).normalize();

    const normalAxisComp = normal.getComponent(axisIdx) * frontSign;
    const centroidAxis =
      (v1.getComponent(axisIdx) + v2.getComponent(axisIdx) + v3.getComponent(axisIdx)) / 3;
    const centroidSide = (centroidAxis - axisCenter) * frontSign;
    const isFrontFace = normalAxisComp > 0.85 && centroidSide > 0;
    (isFrontFace ? frontTris : bodyTris).push(t);
  }

  const buildSubGeometry = (triangleIndices: number[]): THREE.BufferGeometry => {
    const sub = new THREE.BufferGeometry();
    const buf = new Float32Array(triangleIndices.length * 9);
    for (let i = 0; i < triangleIndices.length; i += 1) {
      const srcOff = triangleIndices[i] * 9;
      const dstOff = i * 9;
      for (let k = 0; k < 9; k += 1) buf[dstOff + k] = oldPositions[srcOff + k];
    }
    sub.setAttribute("position", new THREE.BufferAttribute(buf, 3));
    sub.computeVertexNormals();
    return sub;
  };

  const opticalCoating = new THREE.MeshPhysicalMaterial({
    color: "#ec9fb6",
    metalness: 0.25,
    roughness: 0.12,
    iridescence: 1.0,
    iridescenceIOR: 1.45,
    iridescenceThicknessRange: [180, 540],
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
    sheen: 0.4,
    sheenColor: new THREE.Color("#7ab8ff"),
    envMapIntensity: 1.4,
  });

  const glassBody = new THREE.MeshPhysicalMaterial({
    color: "#e3f1ea",
    metalness: 0.0,
    roughness: 0.04,
    transmission: 1.0,
    thickness: 0.06,
    ior: 1.52,
    attenuationColor: new THREE.Color("#bedacd"),
    attenuationDistance: 0.6,
    transparent: false,
    opacity: 1,
    envMapIntensity: 1.4,
  });

  const group = new THREE.Group();
  group.name = component.name;

  const bodyMesh = new THREE.Mesh(buildSubGeometry(bodyTris), glassBody);
  bodyMesh.renderOrder = 0;
  group.add(bodyMesh);

  const frontMesh = new THREE.Mesh(buildSubGeometry(frontTris), opticalCoating);
  frontMesh.renderOrder = 1;
  group.add(frontMesh);

  geometry.dispose();
  return group;
}

// Render the Thorlabs WPHSM05-850 mounted half-wave plate as black anodized
// SM05 mount + green-tinted glass waveplate disc in the centre. The STL
// already contains the disc as a separate body inside the mount; we
// partition triangles by (centroid radial distance from the optical axis)
// AND (normal alignment with the optical axis) to extract the disc faces.
function isWphsm05Asset(asset: Asset3D): boolean {
  return asset.name === "thorlabs_wphsm05_850_stl"
    || /thorlabs_wphsm05_850\.stl$/i.test(asset.filePath);
}

function buildWphsm05WaveplateObject(
  geometry: THREE.BufferGeometry,
  component: ComponentItem,
): THREE.Object3D {
  const positionAttr = geometry.attributes.position as THREE.BufferAttribute;
  const oldPositions = positionAttr.array as Float32Array;

  const bbox = new THREE.Box3().setFromBufferAttribute(positionAttr);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  let axisIdx: 0 | 1 | 2 = 0;
  if (size.y < size.x && size.y < size.z) axisIdx = 1;
  else if (size.z < size.x && size.z < size.y) axisIdx = 2;
  const radialAxes: [0 | 1 | 2, 0 | 1 | 2] = [
    [1, 2], [0, 2], [0, 1],
  ][axisIdx] as [0 | 1 | 2, 0 | 1 | 2];
  const radialCenters: [number, number] = [
    (bbox.min.getComponent(radialAxes[0]) + bbox.max.getComponent(radialAxes[0])) / 2,
    (bbox.min.getComponent(radialAxes[1]) + bbox.max.getComponent(radialAxes[1])) / 2,
  ];
  const outerRadius = Math.max(
    size.getComponent(radialAxes[0]),
    size.getComponent(radialAxes[1]),
  ) / 2;
  // Empirically the WPHSM05-850 STL has the glass disc as a clean 44-triangle
  // ring at radial distance < 5 mm; jumps to 2k+ triangles at >5 mm where the
  // mount's internal seating surface starts. 0.58 of the 8.89 mm outer radius
  // captures the disc cleanly without dragging in mount features.
  const apertureRadius = outerRadius * 0.58;
  const glassRadiusSq = apertureRadius * apertureRadius;

  const triangleCount = Math.floor(positionAttr.count / 3);
  const glassTris: number[] = [];
  const mountTris: number[] = [];
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let t = 0; t < triangleCount; t += 1) {
    const o = t * 9;
    v1.set(oldPositions[o + 0], oldPositions[o + 1], oldPositions[o + 2]);
    v2.set(oldPositions[o + 3], oldPositions[o + 4], oldPositions[o + 5]);
    v3.set(oldPositions[o + 6], oldPositions[o + 7], oldPositions[o + 8]);
    e1.subVectors(v2, v1);
    e2.subVectors(v3, v1);
    normal.crossVectors(e1, e2).normalize();

    const rA =
      (v1.getComponent(radialAxes[0]) + v2.getComponent(radialAxes[0]) + v3.getComponent(radialAxes[0])) / 3
      - radialCenters[0];
    const rB =
      (v1.getComponent(radialAxes[1]) + v2.getComponent(radialAxes[1]) + v3.getComponent(radialAxes[1])) / 3
      - radialCenters[1];
    const radialSq = rA * rA + rB * rB;
    const normalAxisAbs = Math.abs(normal.getComponent(axisIdx));
    const isGlass = radialSq < glassRadiusSq && normalAxisAbs > 0.85;
    (isGlass ? glassTris : mountTris).push(t);
  }

  const buildSubGeometry = (triangleIndices: number[]): THREE.BufferGeometry => {
    const sub = new THREE.BufferGeometry();
    const buf = new Float32Array(triangleIndices.length * 9);
    for (let i = 0; i < triangleIndices.length; i += 1) {
      const srcOff = triangleIndices[i] * 9;
      const dstOff = i * 9;
      for (let k = 0; k < 9; k += 1) buf[dstOff + k] = oldPositions[srcOff + k];
    }
    sub.setAttribute("position", new THREE.BufferAttribute(buf, 3));
    sub.computeVertexNormals();
    return sub;
  };

  const blackMount = new THREE.MeshStandardMaterial({
    color: "#1a1a1c",
    metalness: 0.25,
    roughness: 0.55,
  });

  const waveplateGlass = new THREE.MeshPhysicalMaterial({
    color: "#dceee3",
    metalness: 0.0,
    roughness: 0.05,
    transmission: 1.0,
    thickness: 0.04,
    ior: 1.55,
    attenuationColor: new THREE.Color("#a8ccb9"),
    attenuationDistance: 0.6,
    transparent: false,
    opacity: 1,
    envMapIntensity: 1.3,
  });

  const group = new THREE.Group();
  group.name = component.name;

  const mountMesh = new THREE.Mesh(buildSubGeometry(mountTris), blackMount);
  mountMesh.renderOrder = 0;
  group.add(mountMesh);

  if (glassTris.length > 0) {
    const glassMesh = new THREE.Mesh(buildSubGeometry(glassTris), waveplateGlass);
    glassMesh.renderOrder = 1;
    group.add(glassMesh);
  }

  geometry.dispose();
  return group;
}

// Render the Thorlabs PBS252 polarising beam splitter cube as clear glass
// with frosted top/bottom faces. The STEP→STL export already contains the
// engraved "PBS252" text + arrows on the +Y face as fine triangle detail
// (see top-face triangle count vs flat bottom), so we don't need to add a
// sprite — making the top frosted naturally lets the engravings catch
// light. Iridescence on the body fakes the diagonal coating's pink/purple
// sheen visible in the product photo.
function isPbs252Asset(asset: Asset3D): boolean {
  return asset.name === "thorlabs_pbs252_stl"
    || /thorlabs_pbs252\.stl$/i.test(asset.filePath);
}

function buildPbs252BeamSplitterObject(
  geometry: THREE.BufferGeometry,
  component: ComponentItem,
): THREE.Object3D {
  const positionAttr = geometry.attributes.position as THREE.BufferAttribute;
  const oldPositions = positionAttr.array as Float32Array;

  const topAxisStr = (component.properties as { topAxis?: string } | undefined)?.topAxis;
  const topAxisIdx: 0 | 1 | 2 =
    topAxisStr === "x" ? 0 : topAxisStr === "z" ? 2 : 1;

  const triangleCount = Math.floor(positionAttr.count / 3);
  const frostedTris: number[] = [];
  const clearTris: number[] = [];
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let t = 0; t < triangleCount; t += 1) {
    const o = t * 9;
    v1.set(oldPositions[o + 0], oldPositions[o + 1], oldPositions[o + 2]);
    v2.set(oldPositions[o + 3], oldPositions[o + 4], oldPositions[o + 5]);
    v3.set(oldPositions[o + 6], oldPositions[o + 7], oldPositions[o + 8]);
    e1.subVectors(v2, v1);
    e2.subVectors(v3, v1);
    normal.crossVectors(e1, e2).normalize();

    const isFrostedFace = Math.abs(normal.getComponent(topAxisIdx)) > 0.85;
    (isFrostedFace ? frostedTris : clearTris).push(t);
  }

  const buildSubGeometry = (triangleIndices: number[]): THREE.BufferGeometry => {
    const sub = new THREE.BufferGeometry();
    const buf = new Float32Array(triangleIndices.length * 9);
    for (let i = 0; i < triangleIndices.length; i += 1) {
      const srcOff = triangleIndices[i] * 9;
      const dstOff = i * 9;
      for (let k = 0; k < 9; k += 1) buf[dstOff + k] = oldPositions[srcOff + k];
    }
    sub.setAttribute("position", new THREE.BufferAttribute(buf, 3));
    sub.computeVertexNormals();
    return sub;
  };

  // Three.js docs: "When using transmission, set transparent to false." The
  // transmission render pass already provides the see-through effect; layering
  // it under transparent: true causes double-sorting and a milky look.
  const clearGlass = new THREE.MeshPhysicalMaterial({
    color: "#f4faf6",
    metalness: 0.0,
    roughness: 0.04,
    transmission: 1.0,
    thickness: 0.25,
    ior: 1.52,
    attenuationColor: new THREE.Color("#d0e7dc"),
    attenuationDistance: 1.2,
    iridescence: 0.55,
    iridescenceIOR: 1.4,
    iridescenceThicknessRange: [220, 580],
    transparent: false,
    opacity: 1,
    envMapIntensity: 1.5,
  });

  const frostedGlass = new THREE.MeshPhysicalMaterial({
    color: "#eef3ee",
    metalness: 0.0,
    roughness: 0.7,
    transmission: 0.6,
    thickness: 0.18,
    ior: 1.5,
    transparent: false,
    opacity: 1,
    envMapIntensity: 0.9,
  });

  const group = new THREE.Group();
  group.name = component.name;

  const clearMesh = new THREE.Mesh(buildSubGeometry(clearTris), clearGlass);
  clearMesh.renderOrder = 0;
  group.add(clearMesh);

  const frostedMesh = new THREE.Mesh(buildSubGeometry(frostedTris), frostedGlass);
  frostedMesh.renderOrder = 1;
  group.add(frostedMesh);

  geometry.dispose();
  return group;
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

  // Fiber patch cables render procedurally as a Bezier-spline tube using
  // user-editable anchor + tangent-handle data on component.properties.
  // Bypasses any STL asset attached to the catalogue template.
  if (component.componentType === "fiber") {
    const wrapper = new THREE.Group();
    wrapper.name = component.name;
    wrapper.add(createFiberSplineObject(component));
    return wrapper;
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
    if (isBB1E03Asset(asset)) {
      object = buildBB1E03MirrorObject(geometry, component);
    } else if (isWphsm05Asset(asset)) {
      object = buildWphsm05WaveplateObject(geometry, component);
    } else if (isPbs252Asset(asset)) {
      object = buildPbs252BeamSplitterObject(geometry, component);
    } else {
      object = new THREE.Mesh(geometry, materialFor(component, state));
    }
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
