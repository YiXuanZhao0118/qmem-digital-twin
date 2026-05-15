import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import { resolveAssetUrl } from "../api/client";
import type { Asset3D, ComponentItem, DeviceState } from "../types/digitalTwin";
import { FIBER_FERRULE_TIP_MM } from "../utils/fiberAnchorResolver";
import { createNewportOpticalTable } from "./photoRoom";
import { getDimensionsMm, getNumericProperty, mmToThree } from "./transformUtils";
import { pluginForComponentType } from "../kinds/_plugins";

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

  // Per-component color override (catalog can ship a vendor-accurate color
  // for one part without changing the componentType default — used e.g. by
  // the red Coherent TORNOS isolator while the other isolators stay black).
  const colorOverride = (component.properties as { colorHex?: unknown } | null | undefined)?.colorHex;
  if (typeof colorOverride === "string" && /^#[0-9a-fA-F]{6}$/.test(colorOverride)) {
    return colorOverride;
  }

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
    case "pedestal_post":
      return "#d1d5db";
    case "post_spacer":
      return "#d1d5db";
    case "clamping_fork":
      return "#a8b0b8";
    case "mirror_mount":
      return "#1a1a1c";
    case "isolator":
      return "#1a1a1c";
    case "dds_ad9959_pcb":
      return "#0f3f2a";
    case "mcu_board":
      return "#1e293b";
    case "tcxo_module":
      return "#3f3422";
    case "power_supply_ac_dc":
      return "#7c2d12";
    case "sma_cable":
    case "rf_cable":
      return "#c4a884";
    case "rf_switch":
      // Brushed aluminium body of a Mini-Circuits ZYSWA-2-50DR-style
      // coaxial SP2T switch. White silkscreen + gold SMAs ride on top.
      return "#c8ccd0";
    case "sma_jack":
    case "usb_b_jack":
      return "#cbd5e1";
    case "iec_c14_inlet":
      return "#1f2937";
    case "instrument_chassis":
      return "#27272a";
    default:
      return "#64748b";
  }
}

// M6: exported so per-kind renderers in `kinds/<kind>/renderer.ts` can
// produce visually-consistent materials without depending on
// loadAsset.ts's full surface area. colorForComponent stays private —
// M6 follow-up moves the per-kind colour into the plugin's own
// renderer code.
export function materialFor(
  component: ComponentItem,
  state?: DeviceState,
): THREE.MeshStandardMaterial {
  const transparent = component.componentType === "vacuum_chamber" || component.componentType === "lens";
  const isPolished = ["mirror", "optical_post", "pedestal_post", "post_spacer", "clamping_fork", "laser_diode_mount", "sma_jack", "usb_b_jack"].includes(component.componentType);
  const isAnodized = component.componentType === "mirror_mount" || component.componentType === "isolator" || component.componentType === "instrument_chassis" || component.componentType === "power_supply_ac_dc";
  return new THREE.MeshStandardMaterial({
    color: colorForComponent(component, state),
    metalness: isPolished ? 0.75 : isAnodized ? 0.55 : 0.12,
    roughness: isPolished ? 0.2 : isAnodized ? 0.5 : 0.42,
    transparent,
    opacity: component.componentType === "vacuum_chamber" ? 0.34 : component.componentType === "lens" ? 0.45 : 1,
  });
}

export function createBox(
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

export function createThorlabsPost(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const radius = mmToThree(getNumericProperty(component.properties, "diameterMm", 12.7) / 2);
  const height = mmToThree(getNumericProperty(component.properties, "heightMm", 50));
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 40), materialFor(component, state));
  mesh.position.y = height / 2;
  return mesh;
}

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

export function createThorlabsClampingFork(component: ComponentItem, state?: DeviceState): THREE.Object3D {
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

export function createTs2000aLaserMount(component: ComponentItem, state?: DeviceState): THREE.Object3D {
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
export function createAom(component: ComponentItem, state?: DeviceState): THREE.Object3D {
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
export function createZhl12wPlusAmplifier(
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
  const flangeWidth = mmToThree(W_MM);
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

export function createTaperedAmplifier(component: ComponentItem, state?: DeviceState): THREE.Object3D {
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
export function createTextAnnotation(component: ComponentItem): THREE.Sprite {
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

const ddsPcbGreenMat = new THREE.MeshStandardMaterial({ color: "#0f3f2a", metalness: 0.05, roughness: 0.62 });
const ddsPcbDarkBlueMat = new THREE.MeshStandardMaterial({ color: "#1e293b", metalness: 0.08, roughness: 0.55 });
const ddsPcbTanGreenMat = new THREE.MeshStandardMaterial({ color: "#3f3422", metalness: 0.05, roughness: 0.58 });
const ddsBlackInsetMat = new THREE.MeshStandardMaterial({ color: "#020617", metalness: 0.25, roughness: 0.55 });
const ddsChromeMat = new THREE.MeshStandardMaterial({ color: "#d1d5db", metalness: 0.85, roughness: 0.2 });
const ddsBrassMat = new THREE.MeshStandardMaterial({ color: "#b7791f", metalness: 0.7, roughness: 0.28 });
const ddsTeflonWhiteMat = new THREE.MeshStandardMaterial({ color: "#f1f5f9", metalness: 0.05, roughness: 0.55 });
const ddsSilkscreenMat = new THREE.MeshStandardMaterial({ color: "#e5e7eb", metalness: 0.05, roughness: 0.65 });
const ddsCableBlackMat = new THREE.MeshStandardMaterial({ color: "#0f172a", metalness: 0.15, roughness: 0.62 });
// Brass with flat-shading — used for hex flanges so the 6 facets render as
// discrete planes (smooth shading on a 6-sided CylinderGeometry interpolates
// the normals across faces and the hex visually degenerates into a cylinder).
const ddsBrassFlatMat = new THREE.MeshStandardMaterial({
  color: "#b7791f",
  metalness: 0.7,
  roughness: 0.28,
  flatShading: true,
});
// RG-316 jacket: tan / beige fluorinated FEP outer. Reference: Thorlabs
// CA29xx dimension drawing photo — clearly distinguishable from a black
// RG-178 jacket.
// RG-316 FEP jacket — reddish-brown, matches Thorlabs CA29xx datasheet
// artwork and the colour of physical RG-316 in the lab. Prior `#c4a884` was
// closer to RG-174 PVC tan, which read as "wrong cable type" on screen.
const ddsCableTanMat = new THREE.MeshStandardMaterial({ color: "#a93226", metalness: 0.05, roughness: 0.62 });
const ddsPsuShellMat = new THREE.MeshStandardMaterial({ color: "#f8fafc", metalness: 0.05, roughness: 0.62 });
const ddsPsuLabelMat = new THREE.MeshStandardMaterial({ color: "#7c2d12", metalness: 0.05, roughness: 0.55 });

// SMA bulkhead jack body — nickel-plated steel. Darker / less mirror-bright
// than the generic chrome used on other DDS chassis trim.
const ddsSmaNickelMat = new THREE.MeshStandardMaterial({
  color: "#9ca3af",
  metalness: 0.9,
  roughness: 0.32,
});

export function createSmaBulkheadJack(): THREE.Object3D {
  const group = new THREE.Group();
  // Layout along the mounting axis (+X = panel-out, where cable mates):
  //
  //   -6.7      -3.7      -1.75       0      2.25       8.5         12.5
  //    | back-nut | washer | back-shaft | flange | front threaded barrel |
  //    +---------+---------+-----------+--------+-----------------------+
  //                                    ^
  //                                    panel surface
  //
  // 2026-05-13: added back-of-panel lock nut + lock washer + threaded
  // back-shaft. Matches a real Amphenol 132357 panel-mount SMA-F which
  // ships as flange + threaded shaft + lock washer + lock nut — the prior
  // model only rendered the flange + front barrel, which is why the user
  // reported "sma 母頭少了螺帽".
  const hexThickness = mmToThree(1);
  const hexRadius = mmToThree(5.0);
  const hex = new THREE.Mesh(
    new THREE.CylinderGeometry(hexRadius, hexRadius, hexThickness, 6),
    ddsSmaNickelMat,
  );
  hex.rotation.z = Math.PI / 2;
  hex.position.x = hexThickness / 2;
  group.add(hex);

  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(3.2), mmToThree(3.2), mmToThree(8), 24),
    ddsSmaNickelMat,
  );
  barrel.rotation.z = Math.PI / 2;
  barrel.position.x = hexThickness + mmToThree(4);
  group.add(barrel);

  // Back-of-panel threaded shaft. Goes through the panel hole; visible
  // from inside the chassis between the flange and the lock nut.
  const backShaft = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(3.0), mmToThree(3.0), mmToThree(3.5), 24),
    ddsSmaNickelMat,
  );
  backShaft.rotation.z = Math.PI / 2;
  backShaft.position.x = -mmToThree(1.75);
  group.add(backShaft);

  // Lock washer between the panel back and the nut.
  const lockWasher = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(4.5), mmToThree(4.5), mmToThree(0.4), 24),
    ddsSmaNickelMat,
  );
  lockWasher.rotation.z = Math.PI / 2;
  lockWasher.position.x = -mmToThree(3.7);
  group.add(lockWasher);

  // Back panel-mount hex nut. Slightly thinner than the front flange so
  // the flange stays visually dominant.
  const backNut = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(4.6), mmToThree(4.6), mmToThree(3.0), 6),
    ddsSmaNickelMat,
  );
  backNut.rotation.z = Math.PI / 2;
  backNut.position.x = -mmToThree(5.4);
  group.add(backNut);

  const teflon = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(2.0), mmToThree(2.0), mmToThree(0.8), 20),
    ddsTeflonWhiteMat,
  );
  teflon.rotation.z = Math.PI / 2;
  teflon.position.x = -mmToThree(0.45);
  group.add(teflon);

  const pin = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(0.5), mmToThree(0.5), mmToThree(1.6), 16),
    ddsBrassMat,
  );
  pin.rotation.z = Math.PI / 2;
  pin.position.x = -mmToThree(0.5);
  group.add(pin);
  return group;
}

export function createDdsAd9959Pcb(component: ComponentItem, _state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  const [lenMm, widMm] = getDimensionsMm(component.properties, [100, 80, 16]);
  const length = mmToThree(lenMm);
  const width = mmToThree(widMm);
  const pcbThickness = mmToThree(1.6);

  const pcb = new THREE.Mesh(new THREE.BoxGeometry(length, pcbThickness, width), ddsPcbGreenMat);
  pcb.position.y = pcbThickness / 2;
  group.add(pcb);

  const chip = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(16), mmToThree(2.4), mmToThree(16)),
    ddsBlackInsetMat,
  );
  chip.position.set(-length * 0.05, pcbThickness + mmToThree(1.2), 0);
  group.add(chip);

  const chipLabel = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(13), mmToThree(0.05), mmToThree(13)),
    ddsSilkscreenMat,
  );
  chipLabel.position.set(-length * 0.05, pcbThickness + mmToThree(2.45), 0);
  group.add(chipLabel);

  const regulator = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(8), mmToThree(3.5), mmToThree(7)),
    ddsBlackInsetMat,
  );
  regulator.position.set(length * 0.32, pcbThickness + mmToThree(1.75), -width * 0.3);
  group.add(regulator);

  const xtal = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(7), mmToThree(2.5), mmToThree(5)),
    ddsChromeMat,
  );
  xtal.position.set(length * 0.18, pcbThickness + mmToThree(1.25), width * 0.3);
  group.add(xtal);

  // 4 SMA outputs on the +X (right) edge of the PCB, pointing in +X.
  // createSmaBulkheadJack already builds the jack along +X, so we mount the
  // hex flange flush to the edge (origin at panel) and the barrel sticks out.
  for (let index = 0; index < 4; index += 1) {
    const jack = createSmaBulkheadJack();
    jack.position.set(
      length / 2,
      pcbThickness + mmToThree(5),
      (index - 1.5) * mmToThree(14),
    );
    group.add(jack);
  }

  const headerBody = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(2.54 * 10), mmToThree(8), mmToThree(2.54 * 2)),
    ddsBlackInsetMat,
  );
  headerBody.position.set(-length * 0.32, pcbThickness + mmToThree(4), -width * 0.3);
  group.add(headerBody);
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 10; col += 1) {
      const pin = new THREE.Mesh(
        new THREE.BoxGeometry(mmToThree(0.6), mmToThree(7), mmToThree(0.6)),
        ddsBrassMat,
      );
      pin.position.set(
        -length * 0.32 + (col - 4.5) * mmToThree(2.54),
        pcbThickness + mmToThree(4),
        -width * 0.3 + (row - 0.5) * mmToThree(2.54),
      );
      group.add(pin);
    }
  }

  for (const x of [-0.45, 0.45]) {
    for (const z of [-0.45, 0.45]) {
      const hole = new THREE.Mesh(
        new THREE.CylinderGeometry(mmToThree(1.6), mmToThree(1.6), pcbThickness * 1.05, 14),
        ddsBlackInsetMat,
      );
      hole.position.set(x * length * 0.95, pcbThickness / 2, z * width * 0.95);
      group.add(hole);
    }
  }
  return group;
}

export function createDdsMcuBoard(component: ComponentItem, _state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  const [lenMm, widMm] = getDimensionsMm(component.properties, [90, 70, 18]);
  const length = mmToThree(lenMm);
  const width = mmToThree(widMm);
  const pcbThickness = mmToThree(1.6);

  const pcb = new THREE.Mesh(new THREE.BoxGeometry(length, pcbThickness, width), ddsPcbDarkBlueMat);
  pcb.position.y = pcbThickness / 2;
  group.add(pcb);

  const mcu = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(12), mmToThree(1.4), mmToThree(12)),
    ddsBlackInsetMat,
  );
  mcu.position.set(0, pcbThickness + mmToThree(0.7), 0);
  group.add(mcu);

  const usbShell = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(11), mmToThree(11), mmToThree(15)),
    ddsChromeMat,
  );
  usbShell.position.set(-length / 2 + mmToThree(7), pcbThickness + mmToThree(5.5), -width * 0.3);
  group.add(usbShell);

  const usbCavity = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(0.6), mmToThree(7.8), mmToThree(8.5)),
    ddsBlackInsetMat,
  );
  usbCavity.position.set(-length / 2 + mmToThree(0.8), pcbThickness + mmToThree(5.5), -width * 0.3);
  group.add(usbCavity);

  for (let port = 0; port < 5; port += 1) {
    const headerBody = new THREE.Mesh(
      new THREE.BoxGeometry(mmToThree(2.54 * 6), mmToThree(8), mmToThree(2.54)),
      ddsBlackInsetMat,
    );
    const x = length * 0.45 - port * mmToThree(15);
    headerBody.position.set(x, pcbThickness + mmToThree(4), width * 0.32);
    group.add(headerBody);
    for (let col = 0; col < 6; col += 1) {
      const pin = new THREE.Mesh(
        new THREE.BoxGeometry(mmToThree(0.5), mmToThree(7), mmToThree(0.5)),
        ddsBrassMat,
      );
      pin.position.set(x + (col - 2.5) * mmToThree(2.54), pcbThickness + mmToThree(4), width * 0.32);
      group.add(pin);
    }
    const silkLabel = new THREE.Mesh(
      new THREE.BoxGeometry(mmToThree(2.54 * 6), mmToThree(0.05), mmToThree(2)),
      ddsSilkscreenMat,
    );
    silkLabel.position.set(x, pcbThickness + mmToThree(0.05), width * 0.18);
    group.add(silkLabel);
  }

  const button = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(6), mmToThree(3.2), mmToThree(6)),
    ddsChromeMat,
  );
  button.position.set(length * 0.42, pcbThickness + mmToThree(1.6), -width * 0.28);
  group.add(button);

  const xtal = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(7), mmToThree(2.5), mmToThree(5)),
    ddsChromeMat,
  );
  xtal.position.set(length * 0.18, pcbThickness + mmToThree(1.25), -width * 0.18);
  group.add(xtal);
  return group;
}

export function createDdsTcxoModule(component: ComponentItem, _state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  const [lenMm, widMm] = getDimensionsMm(component.properties, [50, 35, 12]);
  const length = mmToThree(lenMm);
  const width = mmToThree(widMm);
  const pcbThickness = mmToThree(1.6);

  const pcb = new THREE.Mesh(new THREE.BoxGeometry(length, pcbThickness, width), ddsPcbTanGreenMat);
  pcb.position.y = pcbThickness / 2;
  group.add(pcb);

  const tcxoCan = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(8.4), mmToThree(3.2), mmToThree(8.4)),
    ddsChromeMat,
  );
  tcxoCan.position.set(-length * 0.3, pcbThickness + mmToThree(1.6), 0);
  group.add(tcxoCan);

  const fanout = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(6), mmToThree(1.2), mmToThree(4)),
    ddsBlackInsetMat,
  );
  fanout.position.set(length * 0.05, pcbThickness + mmToThree(0.6), 0);
  group.add(fanout);

  for (let index = 0; index < 5; index += 1) {
    const jack = createSmaBulkheadJack();
    jack.position.set(
      length / 2,
      pcbThickness + mmToThree(5),
      (index - 2) * mmToThree(6),
    );
    jack.scale.setScalar(0.7);
    group.add(jack);
  }
  return group;
}

export function createMeanwellIrm30(component: ComponentItem, _state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  const [lenMm, widMm, heightMm] = getDimensionsMm(component.properties, [88, 52.4, 28.8]);
  const length = mmToThree(lenMm);
  const width = mmToThree(widMm);
  const height = mmToThree(heightMm);

  const shell = new THREE.Mesh(new THREE.BoxGeometry(length, height, width), ddsPsuShellMat);
  shell.position.y = height / 2;
  group.add(shell);

  const label = new THREE.Mesh(
    new THREE.BoxGeometry(length * 0.86, mmToThree(0.05), width * 0.78),
    ddsPsuLabelMat,
  );
  label.position.y = height + mmToThree(0.03);
  group.add(label);

  for (let pin = 0; pin < 4; pin += 1) {
    const pinMesh = new THREE.Mesh(
      new THREE.BoxGeometry(mmToThree(0.8), mmToThree(4), mmToThree(0.8)),
      ddsBrassMat,
    );
    pinMesh.position.set(-length * 0.4 + pin * mmToThree(5), -mmToThree(2), 0);
    group.add(pinMesh);
  }

  for (let pin = 0; pin < 2; pin += 1) {
    const pinMesh = new THREE.Mesh(
      new THREE.BoxGeometry(mmToThree(1), mmToThree(5), mmToThree(1)),
      ddsBrassMat,
    );
    pinMesh.position.set(length * 0.32 + pin * mmToThree(7), -mmToThree(2.5), 0);
    group.add(pinMesh);
  }
  return group;
}

/** Build one SMA-male connector group at the origin, pieces extending
 *  along local +X (boot near origin, pin at the far +X end). Cable-end
 *  cap is centred at X=0. The straight-cable jacket Y=2 mm lift is NOT
 *  applied here — callers position the whole group. Used by both the
 *  straight-tube renderer (two mirrored copies on either end of the
 *  cylinder) and the spline renderer (one copy per spline endpoint,
 *  oriented to the outward tangent). */
function buildSmaMaleConnectorGroup(): THREE.Group {
  const group = new THREE.Group();
  let offsetMm = 0;
  const place = (piece: THREE.Object3D, lenMm: number): void => {
    piece.rotation.z = Math.PI / 2;
    piece.position.set(mmToThree(offsetMm + lenMm / 2), 0, 0);
    group.add(piece);
    offsetMm += lenMm;
  };

  // Black heat-shrink strain-relief boot.
  place(
    new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(1.85), mmToThree(1.85), mmToThree(3), 18),
      ddsCableBlackMat,
    ),
    3,
  );

  // Gold-plated brass crimp ferrule.
  place(
    new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(2.2), mmToThree(2.2), mmToThree(4), 24),
      ddsBrassMat,
    ),
    3,
  );

  // Threaded coupling barrel.
  place(
    new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(3.0), mmToThree(3.0), mmToThree(4), 24),
      ddsBrassMat,
    ),
    4,
  );

  // Hex coupling flange with central bore — overlaps PTFE+pin (does NOT
  // advance offsetMm).
  {
    const hexThick = 6.5;
    const hexShape = new THREE.Shape();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const x = mmToThree(3.5) * Math.cos(a);
      const y = mmToThree(3.5) * Math.sin(a);
      if (i === 0) hexShape.moveTo(x, y);
      else hexShape.lineTo(x, y);
    }
    hexShape.closePath();
    const bore = new THREE.Path();
    bore.absarc(0, 0, mmToThree(2.5), 0, Math.PI * 2, false);
    hexShape.holes.push(bore);

    const hexGeom = new THREE.ExtrudeGeometry(hexShape, {
      depth: mmToThree(hexThick),
      bevelEnabled: false,
      curveSegments: 24,
    });
    hexGeom.translate(0, 0, -mmToThree(hexThick) / 2);
    hexGeom.rotateY(Math.PI / 2);

    const hex = new THREE.Mesh(hexGeom, ddsBrassFlatMat);
    hex.position.set(mmToThree(offsetMm + hexThick / 2), 0, 0);
    group.add(hex);
  }

  // White PTFE dielectric.
  place(
    new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(2.85), mmToThree(2.85), mmToThree(3.5), 24),
      ddsTeflonWhiteMat,
    ),
    3.5,
  );

  // Centre pin.
  place(
    new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(0.5), mmToThree(0.5), mmToThree(2), 12),
      ddsBrassMat,
    ),
    2,
  );

  return group;
}

/** Bezier-spline RF cable renderer — used when the SceneObject carries
 *  per-instance `properties.rfCableNodes`. Parallels `createFiberSplineObject`:
 *  TubeGeometry follows the curve, two SMA male connectors are placed at
 *  the spline endpoints with their +X axes aligned to the outward
 *  tangents so the connector orientation tracks node drag in real time. */
function createSmaCableSpline(
  component: ComponentItem,
  nodes: FiberNode[],
): THREE.Object3D {
  const group = new THREE.Group();
  // Tag the wrapper so the node-edit mode's traversal can recognise this
  // as an rf_cable instance. The outer wrapper (assigned by
  // DigitalTwinViewer at load time) carries the per-instance `objectId`;
  // tube + wrapper here only need to be discoverable by role.
  group.userData.rfCableRole = "wrapper";
  group.userData.rfCableComponentId = component.id;

  // RG-316 reddish-brown jacket — TubeGeometry sweeps a 1.6 mm radius
  // circle along the Bezier path. 64 longitudinal × 14 radial segments
  // matches the smoothness of the straight-tube cylinder fallback.
  const path = buildFiberCurvePath(nodes);
  const jacket = new THREE.Mesh(
    new THREE.TubeGeometry(path, 64, mmToThree(1.6), 14, false),
    ddsCableTanMat,
  );
  jacket.userData.rfCableRole = "tube";
  group.add(jacket);

  const xAxis = new THREE.Vector3(1, 0, 0);
  for (const end of ["A", "B"] as const) {
    const idx = end === "A" ? 0 : nodes.length - 1;
    const connector = buildSmaMaleConnectorGroup();
    const nodePos = labMmToFiberThree(nodes[idx].posMm);
    const outward = fiberEndpointOutwardThree(nodes, end);
    connector.quaternion.setFromUnitVectors(xAxis, outward);
    connector.position.copy(nodePos);
    // Tag so the node-edit re-render can find each endpoint connector and
    // re-orient it after the spline changes.
    connector.userData.rfCableConnectorEndpoint = end;
    group.add(connector);
  }

  return group;
}

/** Reapply position + quaternion for one rf_cable SMA-male connector
 *  after the underlying spline has been edited. Called by the node-edit
 *  pointer handlers in `DigitalTwinViewer` so connectors track endpoint
 *  drags without rebuilding the whole spline. */
export function applyRfCableConnectorTransform(
  connector: THREE.Object3D,
  nodes: FiberNode[],
  endpoint: "A" | "B",
): void {
  if (nodes.length < 2) return;
  const idx = endpoint === "A" ? 0 : nodes.length - 1;
  const nodePos = labMmToFiberThree(nodes[idx].posMm);
  const outward = fiberEndpointOutwardThree(nodes, endpoint);
  connector.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), outward);
  connector.position.copy(nodePos);
}

export function createSmaShortCable(
  component: ComponentItem,
  _state?: DeviceState,
  /** Per-instance Bezier nodes. When absent or < 2 nodes, a straight
   *  2-node default spline is auto-generated from `component.properties
   *  .lengthMm` so every rf_cable instance is ready for node-drag editing
   *  without needing a catalog template or backend bootstrap. */
  rfCableNodes?: FiberNode[],
): THREE.Object3D {
  let nodes = rfCableNodes;
  if (!nodes || nodes.length < 2) {
    // Default 2-node straight spline centred on the object origin so a
    // freshly-spawned cable renders symmetrically (matches the old
    // straight-cylinder convention where the jacket was centred at
    // `cable.position = 0`).
    const lengthMm = getNumericProperty(component.properties, "lengthMm", 150);
    nodes = [
      { posMm: [-lengthMm / 2, 0, 0] },
      { posMm: [lengthMm / 2, 0, 0] },
    ];
  }
  return createSmaCableSpline(component, nodes);
}

export function createUsbBJack(_component: ComponentItem, _state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(16), mmToThree(11), mmToThree(12)),
    ddsChromeMat,
  );
  shell.position.set(mmToThree(8), mmToThree(5.5), 0);
  group.add(shell);

  const cavity = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(0.5), mmToThree(8.5), mmToThree(8.5)),
    ddsBlackInsetMat,
  );
  cavity.position.set(mmToThree(1.6), mmToThree(5.5), 0);
  group.add(cavity);

  const tongue = new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(0.6), mmToThree(1.2), mmToThree(6.5)),
    ddsTeflonWhiteMat,
  );
  tongue.position.set(mmToThree(1.4), mmToThree(5.5), 0);
  group.add(tongue);
  return group;
}

export function createIecC14Inlet(_component: ComponentItem, _state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  const length = mmToThree(30);
  const width = mmToThree(22.5);
  const depth = mmToThree(27);

  const body = new THREE.Mesh(new THREE.BoxGeometry(depth, width, length), ddsBlackInsetMat);
  body.position.set(depth / 2, width / 2, 0);
  group.add(body);

  for (const offset of [-1, 0, 1]) {
    const socket = new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(1.5), mmToThree(1.5), mmToThree(2), 14),
      ddsBrassMat,
    );
    socket.rotation.z = Math.PI / 2;
    socket.position.set(
      mmToThree(0.6),
      width / 2 + (offset === 0 ? mmToThree(4) : -mmToThree(2)),
      offset === 0 ? 0 : offset * mmToThree(7),
    );
    group.add(socket);
  }
  return group;
}

export function createInstrumentChassis1u(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  const [lenMm, depthMm, heightMm] = getDimensionsMm(component.properties, [482.6, 246, 44.45]);
  const length = mmToThree(lenMm);
  const depth = mmToThree(depthMm);
  const height = mmToThree(heightMm);
  const wall = mmToThree(1.5);

  const material = materialFor(component, state);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(length, wall, depth), material);
  floor.position.set(0, wall / 2, 0);
  group.add(floor);

  const ceiling = floor.clone();
  ceiling.position.y = height - wall / 2;
  group.add(ceiling);

  const frontPanel = new THREE.Mesh(new THREE.BoxGeometry(length, height, wall), material);
  frontPanel.position.set(0, height / 2, depth / 2 - wall / 2);
  group.add(frontPanel);

  const backPanel = frontPanel.clone();
  backPanel.position.z = -depth / 2 + wall / 2;
  group.add(backPanel);

  const sideGeometry = new THREE.BoxGeometry(wall, height, depth - 2 * wall);
  const left = new THREE.Mesh(sideGeometry, material);
  left.position.set(-length / 2 + wall / 2, height / 2, 0);
  group.add(left);

  const right = new THREE.Mesh(sideGeometry, material);
  right.position.set(length / 2 - wall / 2, height / 2, 0);
  group.add(right);
  return group;
}

/**
 * Coaxial RF switch (Mini-Circuits ZYSWA-2-50DR-style — case ZZ121).
 *
 * Geometry (mm, body-local frame, Z-up after `mmToThree` flip):
 *   - Body: aluminium cube ~19 × 15.5 × 19 (xMm = bodyWidthMm, yMm = thickness,
 *     zMm = bodyDepthMm). Top face wears a white silkscreen label.
 *   - SMA jacks: one on each end of the +X and -X faces. RFIN sits on +X
 *     (the common port, anchor id `rf_in`), RF1 / RF2 sit on -X (the two
 *     throws, anchor id `rf_out` with `name` = "RF1" / "RF2").
 *   - Power + control pins (2026-05-14 revision per photo): feedthroughs
 *     sit on the ±Z (front/back) faces, NOT the top face — -5V on -Z
 *     (back), +5V on +Z (front), both in the upper half so they line up
 *     with the silkscreen "-5V" / "+5V" edge labels on the top. A small
 *     GND chassis-ground lug sits on the +Z (front) face, offset toward
 *     the +X edge ("上面偏側邊"). The TTL pin is co-located with the +5V
 *     feedthrough on the real PCB header; we model it visually as the
 *     same group.
 *   - Mounting flanges extend the footprint along ±Z to match the
 *     datasheet's ZZ121 case (overall 31.75 mm corner-to-corner).
 *
 * Convention: the scene origin sits at the body geometric centre (top
 * face at +Y/2, bottom at -Y/2) — no axis offset, unlike beam-emitting
 * kinds. Anchors placed on the asset by the catalog seed drive the
 * actual cable-routing math; this primitive is the visual stand-in.
 */
export function createRfSwitch(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const props = component.properties ?? {};
  const bodyWidthMm = getNumericProperty(props, "bodyWidthMm", 19.05);
  const bodyDepthMm = getNumericProperty(props, "bodyDepthMm", 19.05);
  const bodyHeightMm = getNumericProperty(props, "bodyHeightMm", 15.49);
  const flangeFootprintMm = getNumericProperty(props, "flangeFootprintMm", 31.75);
  const flangeThicknessMm = getNumericProperty(props, "flangeThicknessMm", 2.6);

  const W = mmToThree(bodyWidthMm);   // along three.X
  const H = mmToThree(bodyHeightMm);  // along three.Y (= scene up)
  const D = mmToThree(bodyDepthMm);   // along three.Z
  const flangeExtra = (mmToThree(flangeFootprintMm) - D) / 2;
  const flangeT = mmToThree(flangeThicknessMm);

  const group = new THREE.Group();

  // --- Aluminium body ----------------------------------------------------
  const bodyMat = materialFor(component, state);
  const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), bodyMat);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // White silkscreen label on the +Y (top) face. Inset slightly so the
  // label appears recessed under the aluminium edge highlight.
  const labelInset = mmToThree(0.5);
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(W - labelInset * 2, D - labelInset * 2),
    new THREE.MeshStandardMaterial({
      color: "#fafafa",
      metalness: 0.02,
      roughness: 0.6,
    }),
  );
  label.rotation.x = -Math.PI / 2;
  label.position.y = H / 2 + mmToThree(0.05);
  group.add(label);

  // --- Mounting flanges on ±Z (front / back of the body) -----------------
  if (flangeExtra > 0) {
    const flangeMat = new THREE.MeshStandardMaterial({
      color: "#cfd3d6",
      metalness: 0.85,
      roughness: 0.45,
    });
    for (const sign of [-1, 1]) {
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(W, flangeT, flangeExtra),
        flangeMat,
      );
      plate.position.set(0, -H / 2 + flangeT / 2, sign * (D / 2 + flangeExtra / 2));
      plate.castShadow = true;
      plate.receiveShadow = true;
      group.add(plate);

      // Two through-holes per flange (visualised as dark cylinders).
      const holeRadius = mmToThree(1.4);
      const holeXOffset = mmToThree(5.5);
      for (const xs of [-1, 1]) {
        const hole = new THREE.Mesh(
          new THREE.CylinderGeometry(holeRadius, holeRadius, flangeT * 1.05, 20),
          new THREE.MeshStandardMaterial({ color: "#1f2937", roughness: 0.9 }),
        );
        hole.position.set(
          xs * holeXOffset,
          -H / 2 + flangeT / 2,
          sign * (D / 2 + flangeExtra * 0.65),
        );
        group.add(hole);
      }
    }
  }

  // --- SMA bulkhead jacks (4× on the ±X faces) ---------------------------
  // The reusable createSmaBulkheadJack builder mounts a jack along its
  // own +X axis. We instance it 4 times and rotate / offset to mate with
  // each face. The Z-offset within each face places the connector closer
  // to the corresponding label ("RF1"/"RFIN" near top, "RF2"/"TTL" near
  // bottom in the photo).
  const portZOffset = D * 0.22;
  const smaConfigs: { x: number; z: number; rotateY: number }[] = [
    // -X face: RF1 (top), RF2 (bottom). Jack points in -X.
    { x: -W / 2, z: +portZOffset, rotateY: Math.PI },
    { x: -W / 2, z: -portZOffset, rotateY: Math.PI },
    // +X face: RFIN (top, common), TTL/RF2 reuse pattern (bottom).
    { x: +W / 2, z: +portZOffset, rotateY: 0 },
    { x: +W / 2, z: -portZOffset, rotateY: 0 },
  ];
  for (const cfg of smaConfigs) {
    const jack = createSmaBulkheadJack();
    jack.rotation.y = cfg.rotateY;
    jack.position.set(cfg.x, 0, cfg.z);
    group.add(jack);
  }

  // --- Power feedthroughs on ±Z (front / back faces) --------------------
  // Per user spec (2026-05-14 revision): the ±5 V feedthroughs sit on the
  // ±Z faces of the body, NOT on the ±Y (top/bottom) faces. -5V on the
  // -Z (back) face, +5V on the +Z (front) face — both in the upper half
  // of their face so the silkscreen "+5V" / "-5V" edge labels on the top
  // align with the matching feedthrough below. White hookup wire is
  // omitted (it occludes the anchor inspector); a follow-up GLB can
  // carry photoreal wiring if needed later.
  const feedthroughHexR = mmToThree(1.9);
  const feedthroughHexH = mmToThree(1.5);
  const insulR = mmToThree(1.15);
  const insulH = mmToThree(1.6);
  const feedPinR = mmToThree(0.45);
  const feedPinH = mmToThree(4.5);
  const aluHexMat = new THREE.MeshStandardMaterial({
    color: "#cfd3d6", metalness: 0.85, roughness: 0.45,
  });
  const insulMat = new THREE.MeshStandardMaterial({
    color: "#8d2222", metalness: 0.05, roughness: 0.55,
  });
  function makeFeedthrough(): THREE.Object3D {
    const ft = new THREE.Group();
    const hex = new THREE.Mesh(
      new THREE.CylinderGeometry(feedthroughHexR, feedthroughHexR, feedthroughHexH, 6),
      aluHexMat,
    );
    hex.position.y = feedthroughHexH / 2;
    ft.add(hex);
    const insul = new THREE.Mesh(
      new THREE.CylinderGeometry(insulR, insulR, insulH, 18),
      insulMat,
    );
    insul.position.y = feedthroughHexH + insulH / 2;
    ft.add(insul);
    const pin = new THREE.Mesh(
      new THREE.CylinderGeometry(feedPinR, feedPinR, feedPinH, 14),
      ddsBrassMat,
    );
    pin.position.y = feedthroughHexH + insulH + feedPinH / 2;
    ft.add(pin);
    ft.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return ft;
  }
  // makeFeedthrough() builds the stack along local +Y. Rotating around X
  // by +π/2 maps local +Y → world +Z (front-mount), and by -π/2 maps it
  // to -Z (back-mount). The group origin sits ON the body face, so the
  // hex nut starts flush with the aluminium.
  const ftYUpper = H * 0.25; // "upper half" per user spec
  const frontFeed = makeFeedthrough();
  frontFeed.rotation.x = Math.PI / 2;
  frontFeed.position.set(0, ftYUpper, D / 2);
  group.add(frontFeed);
  const backFeed = makeFeedthrough();
  backFeed.rotation.x = -Math.PI / 2;
  backFeed.position.set(0, ftYUpper, -D / 2);
  group.add(backFeed);

  // --- GND pin on the +Z (front) face, upper area, offset toward +X ----
  // ("上面偏側邊" per user spec — chassis-ground lug on the same face as
  // the +5V feedthrough, shifted toward the +X edge.)
  const gnd = new THREE.Group();
  const gndCollar = new THREE.Mesh(
    new THREE.CylinderGeometry(mmToThree(1.1), mmToThree(1.1), mmToThree(1.0), 16),
    aluHexMat,
  );
  gndCollar.position.y = mmToThree(0.5);
  gnd.add(gndCollar);
  const gndPin = new THREE.Mesh(
    new THREE.CylinderGeometry(feedPinR, feedPinR, mmToThree(4.5), 12),
    ddsBrassMat,
  );
  gndPin.position.y = mmToThree(1.0) + mmToThree(4.5) / 2;
  gnd.add(gndPin);
  gnd.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  gnd.rotation.x = Math.PI / 2; // axis along +Z (out of front face)
  gnd.position.set(W / 2 - mmToThree(4.0), ftYUpper, D / 2);
  group.add(gnd);

  // --- Phillips screws at the 4 corners of the top face (label cover) --
  // Holds the top lid down per user spec ("頂面螺絲: label 四角，固定上蓋").
  function makeScrew(): THREE.Object3D {
    const s = new THREE.Group();
    const head = new THREE.Mesh(
      new THREE.CylinderGeometry(mmToThree(1.0), mmToThree(0.95), mmToThree(0.7), 18),
      aluHexMat,
    );
    s.add(head);
    const slotMat = new THREE.MeshStandardMaterial({
      color: "#1a1a1a", roughness: 0.9,
    });
    const slot1 = new THREE.Mesh(
      new THREE.BoxGeometry(mmToThree(1.6), mmToThree(0.12), mmToThree(0.4)),
      slotMat,
    );
    slot1.position.y = mmToThree(0.4);
    s.add(slot1);
    const slot2 = slot1.clone() as THREE.Mesh;
    slot2.rotation.y = Math.PI / 2;
    s.add(slot2);
    s.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return s;
  }
  const screwInset = mmToThree(2.5);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const sc = makeScrew();
      sc.position.set(
        sx * (W / 2 - screwInset),
        H / 2 + mmToThree(0.4),
        sz * (D / 2 - screwInset),
      );
      group.add(sc);
    }
  }

  return group;
}

function createPrimitive(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  group.name = component.name;

  // Post-M6 FULL: every legacy `case "X":` block from this function's
  // old switch statement lives in `kinds/_renderer_bindings.ts` and is
  // wired into the plugin registry at module load. Adding a new
  // primitive geometry = (a) write the renderer in a plugin folder
  // (or temporarily in _renderer_bindings.ts), (b) register it. No
  // changes to this file needed.
  //
  // The fallback below catches componentTypes that have a plugin but
  // no renderer (rare — currently only the kinds whose primary render
  // path is STL/GLB through `loadAssetObject`) and componentTypes
  // with no plugin at all (a bug to surface).
  const plugin = pluginForComponentType(component.componentType);
  let mesh: THREE.Object3D;
  if (plugin?.renderer) {
    mesh = plugin.renderer(component, state);
  } else {
    mesh = createBox(component, state, [100, 100, 80]);
    mesh.position.y = 0.2;
  }

  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
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
// Length of the FC housing along its longitudinal +Y axis (cable end at
// y=0, ferrule tip at y=FIBER_FERRULE_TIP_MM). Canonical export lives in
// `utils/fiberAnchorResolver.ts`; the local re-export here keeps the
// reference greppable in this file.
const FC_HOUSING_LENGTH_MM = FIBER_FERRULE_TIP_MM;
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

  // Raycastable port disk at the ferrule tip (2026-05-12 fix). The
  // imported 30126A9 STL housing — and its procedural fallback — is a
  // hollow shell with NO end cap at the ferrule tip. A laser beam
  // travelling exactly along the fiber's optical axis (the well-aligned
  // case) passes through the entire housing without hitting a single
  // triangle, so rayTrace.ts sees no hit and the fiber dispatch never
  // fires. We add an explicit disk perpendicular to outward at the tip
  // so the ray-tracer can intercept dead-center on-axis rays. The disk
  // is INVISIBLE in the render pass (colorWrite/depthWrite off) but the
  // ray-tracer's Raycaster uses default all-layer mask and finds it.
  //
  // Radius matches the FC ferrule sleeve OD (Ø2.5 mm → 1.25 mm radius).
  // For APC tips, the disk is tilted 8° around the local X axis so its
  // normal matches the slanted polish baked into the STL.
  const portDiskRadiusMm = 1.25;
  const portDisk = new THREE.Mesh(
    new THREE.CircleGeometry(portDiskRadiusMm / 100, 24),
    new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  // CircleGeometry's normal is +Z by default. Rotate -π/2 around local X
  // so the normal points +Y (= outward in the connector frame). APC
  // adds +8° about X, tilting the normal 8° toward +Z to match the
  // polish baked into the STL ferrule tip.
  const apcRad = (8 * Math.PI) / 180;
  portDisk.rotation.x = -Math.PI / 2 + (options.polish === "APC" ? apcRad : 0);
  portDisk.position.y = FIBER_FERRULE_TIP_MM / 100;
  portDisk.userData.fiberRole = "portDisk";
  portDisk.userData.fiberPolish = options.polish;
  conn.add(portDisk);

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

/** Refresh a previously-built fiber wrapper's procedural geometry to
 *  match a new node array / jacket radius, without rebuilding the
 *  whole wrapper. Walks the wrapper tree, finds the tube mesh + the two
 *  FC connector groups (tagged by `userData.fiberRole` and
 *  `userData.fiberConnectorEndpoint`), and:
 *    - rebuilds the TubeGeometry from the new Bezier path / radius,
 *    - re-applies `applyFiberConnectorTransform` for each connector.
 *  The old tube geometry is disposed so the GPU buffer doesn't leak.
 *
 *  Called from DigitalTwinViewer's cache-hit branch when the fiber's
 *  per-instance `SceneObject.properties.fiberNodes` / `.radiusMm`
 *  changed but the wrapper itself is being reused. Without this the
 *  procedural fiber would visually freeze on its initial pose while
 *  the underlying spline/anchor data evolves. Returns true if a tube
 *  mesh was found and updated; false when the wrapper doesn't contain
 *  a fiber sub-tree (caller can fall through to wrapper-rebuild). */
/** Re-apply rf_cable Bezier tube + SMA-male connector transforms in
 *  place against an existing wrapper. Used in the DigitalTwinViewer
 *  cache-hit path so the cable's geometry tracks per-instance spline
 *  edits (node drag in node-edit mode) AND linked endpoint movement
 *  (Align-RF target SceneObject pose changes) without rebuilding the
 *  whole wrapper. Mirrors `refreshFiberWrapperGeometry`. */
export function refreshRfCableWrapperGeometry(
  wrapper: THREE.Object3D,
  nodes: FiberNode[],
): boolean {
  if (!nodes || nodes.length < 2) return false;
  let tubeMesh: THREE.Mesh | null = null;
  const connectors: { conn: THREE.Object3D; endpoint: "A" | "B" }[] = [];
  wrapper.traverse((node) => {
    if (!tubeMesh && (node as THREE.Mesh).isMesh && node.userData?.rfCableRole === "tube") {
      tubeMesh = node as THREE.Mesh;
    }
    const ep = node.userData?.rfCableConnectorEndpoint;
    if (ep === "A" || ep === "B") connectors.push({ conn: node, endpoint: ep });
  });
  if (!tubeMesh) return false;

  const path = buildFiberCurvePath(nodes);
  const tubularSegments = Math.max(64, (nodes.length - 1) * 32);
  const newGeom = new THREE.TubeGeometry(path, tubularSegments, mmToThree(1.6), 14, false);
  const old = (tubeMesh as THREE.Mesh).geometry;
  (tubeMesh as THREE.Mesh).geometry = newGeom;
  old.dispose();

  for (const { conn, endpoint } of connectors) {
    applyRfCableConnectorTransform(conn, nodes, endpoint);
  }
  return true;
}

export function refreshFiberWrapperGeometry(
  wrapper: THREE.Object3D,
  nodes: FiberNode[],
  radiusMm: number,
): boolean {
  if (!nodes || nodes.length < 2) return false;
  let tubeMesh: THREE.Mesh | null = null;
  const connectors: { conn: THREE.Object3D; endpoint: "A" | "B" }[] = [];
  wrapper.traverse((node) => {
    if (!tubeMesh && (node as THREE.Mesh).isMesh && node.userData?.fiberRole === "tube") {
      tubeMesh = node as THREE.Mesh;
    }
    const ep = node.userData?.fiberConnectorEndpoint;
    if (ep === "A" || ep === "B") connectors.push({ conn: node, endpoint: ep });
  });
  if (!tubeMesh) return false;

  const path = buildFiberCurvePath(nodes);
  const tubularSegments = Math.max(64, (nodes.length - 1) * 32);
  const newGeom = new THREE.TubeGeometry(
    path,
    tubularSegments,
    Math.max(radiusMm, 0.01) / 100,
    12,
    false,
  );
  const old = (tubeMesh as THREE.Mesh).geometry;
  (tubeMesh as THREE.Mesh).geometry = newGeom;
  old.dispose();

  for (const { conn, endpoint } of connectors) {
    applyFiberConnectorTransform(conn, nodes, endpoint);
  }
  return true;
}

function createFiberSplineObject(
  component: ComponentItem,
  /** Per-instance overrides — preferred over the component's catalog
   *  defaults when present. fiberNodes (the spline) and radiusMm (the
   *  jacket thickness) are both per-instance per V2: each fiber cable
   *  in the scene should have its own spline shape. */
  objectFiberNodes?: FiberNode[],
  objectRadiusMm?: number,
): THREE.Object3D {
  const compProps = (component.properties as { fiberNodes?: FiberNode[]; radiusMm?: number } | undefined) ?? {};
  const resolvedNodes: FiberNode[] | undefined =
    (objectFiberNodes && objectFiberNodes.length >= 2)
      ? objectFiberNodes
      : (compProps.fiberNodes && compProps.fiberNodes.length >= 2)
        ? compProps.fiberNodes
        : undefined;
  const nodes: FiberNode[] = resolvedNodes ?? [
    { posMm: [0, 0, 50], handleOutMm: [100, 0, 0] },
    { posMm: [300, 0, 50], handleInMm: [-100, 0, 0] },
  ];
  const radiusMm =
    typeof objectRadiusMm === "number" && objectRadiusMm > 0
      ? objectRadiusMm
      : typeof compProps.radiusMm === "number" && compProps.radiusMm > 0
        ? compProps.radiusMm
        : 1.0;

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

// Render the AD9959/PCBZ evaluation board STL with a two-zone material split.
// The single STEP→STL export merges the entire board (PCB substrate + chips +
// regulators + SMA jacks + headers) into one triangle soup, so a single
// `materialFor()` call paints everything in the component-type colour
// (#0f3f2a PCB green) — including the SMA flanges, which looks wrong.
//
// We split by triangle-centroid Z (body-local Z-up frame, PCB substrate sits
// at Z ∈ [-1.4, +0.6] mm — verified empirically: 92% of total surface area
// lives in that band). Triangles below the threshold get the PCB green
// material that matches the procedural primitive; everything above gets a
// dark-matte "components-on-board" material so the SMAs / chips / headers no
// longer read as green.
function isAd9959PcbAsset(asset: Asset3D): boolean {
  return asset.name === "primitive_dds_ad9959_pcb"
    || /ad9959_pcbz\.stl$/i.test(asset.filePath);
}

// PCB substrate top sits near z = 0 in the imported STL frame (gmsh kept
// the corner-anchored Z and we recentred only X/Y in `_finalize_ad9959_stl.py`).
// 0.6 mm clears the silkscreen + solder mask thickness without bleeding into
// surface-mount component bodies whose lowest faces start around z = 1 mm.
const AD9959_PCB_TOP_Z_MM = 0.6;

// SMA gold-zone classifier. The AD9959/PCBZ uses right-angle edge-launch
// SMAs at the ±X edges (CH0–CH3 on +X, REF_CLK on −X). The connector body
// sits within ~8 mm of the board edge and rises 1–12 mm above the PCB
// substrate (hex flange ~9 mm AF, barrel ø ~6 mm, total height ≲ 11 mm).
// Empirical probe of the mesh (`above PCB tris near +X edge: 199 tris in
// Y ∈ [-49, 53]`) confirms the classifier captures the connector bodies
// without bleeding into the centre of the board.
const AD9959_SMA_X_EDGE_BAND_MM = 8.0;
const AD9959_SMA_Z_MIN_MM = 1.0;
const AD9959_SMA_Z_MAX_MM = 12.0;

function buildAd9959PcbObject(
  geometry: THREE.BufferGeometry,
  component: ComponentItem,
): THREE.Object3D {
  const positionAttr = geometry.attributes.position as THREE.BufferAttribute;
  const oldPositions = positionAttr.array as Float32Array;

  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  // The mesh is symmetric in X around 0 (re-centred by `_finalize_ad9959_stl.py`);
  // pick the larger absolute edge as the half-width so the classifier is robust
  // even if a future export shifts the centroid by a fraction of a mm.
  const halfX = Math.max(Math.abs(bbox.min.x), Math.abs(bbox.max.x));

  const triangleCount = Math.floor(positionAttr.count / 3);
  const pcbTris: number[] = [];
  const smaTris: number[] = [];
  const componentTris: number[] = [];
  for (let t = 0; t < triangleCount; t += 1) {
    const o = t * 9;
    // Buffer layout per triangle is [x1,y1,z1, x2,y2,z2, x3,y3,z3]. STLLoader
    // loads file coordinates verbatim (mm, body-local frame) — `applyAssetScale`
    // only scales uniformly downstream and doesn't permute axes, so the file's
    // X / Z are still at offsets {0,3,6} and {2,5,8} respectively here.
    const centroidX = (oldPositions[o + 0] + oldPositions[o + 3] + oldPositions[o + 6]) / 3;
    const centroidZ = (oldPositions[o + 2] + oldPositions[o + 5] + oldPositions[o + 8]) / 3;
    if (centroidZ <= AD9959_PCB_TOP_Z_MM) {
      pcbTris.push(t);
    } else if (
      Math.abs(centroidX) > halfX - AD9959_SMA_X_EDGE_BAND_MM
      && centroidZ >= AD9959_SMA_Z_MIN_MM
      && centroidZ <= AD9959_SMA_Z_MAX_MM
    ) {
      smaTris.push(t);
    } else {
      componentTris.push(t);
    }
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

  const pcbMat = new THREE.MeshStandardMaterial({
    color: "#0f3f2a",   // matches `ddsPcbGreenMat` used by the procedural fallback
    metalness: 0.05,
    roughness: 0.62,
  });
  const componentMat = new THREE.MeshStandardMaterial({
    color: "#1f2733",   // dark matte for ICs / regulators / headers
    metalness: 0.18,
    roughness: 0.45,
  });
  // Gold-plated SMA hex flange + barrel. Reference: a representative SMA
  // model on 3DContentCentral (catalogid=171 → connectors) shipped from a
  // supplier rendered with a brighter, more saturated gold than the muted
  // brass tone (#b7791f) used for procedural placeholder pins inside the
  // PCB. We bump toward true gold (#d4a017) and crank metalness so the
  // SMA bodies read as a polished plated metal instead of a dull alloy.
  const smaMat = new THREE.MeshStandardMaterial({
    color: "#d4a017",
    metalness: 0.85,
    roughness: 0.22,
  });

  const group = new THREE.Group();
  group.name = component.name;

  if (pcbTris.length > 0) {
    group.add(new THREE.Mesh(buildSubGeometry(pcbTris), pcbMat));
  }
  if (componentTris.length > 0) {
    group.add(new THREE.Mesh(buildSubGeometry(componentTris), componentMat));
  }
  if (smaTris.length > 0) {
    group.add(new THREE.Mesh(buildSubGeometry(smaTris), smaMat));
  }

  geometry.dispose();
  return group;
}

export async function loadAssetObject(
  component: ComponentItem,
  asset: Asset3D | undefined,
  state: DeviceState | undefined,
  /** Per-instance properties — V2: each scene object can have its own
   *  fiberNodes / rfCableNodes / radiusMm overrides on top of the
   *  component's catalog defaults. Pass `sceneObject.properties` from
   *  the caller. */
  objectProperties?: {
    fiberNodes?: FiberNode[];
    rfCableNodes?: FiberNode[];
    radiusMm?: number;
  } | null,
): Promise<THREE.Object3D> {
  if (component.componentType === "optical_table") {
    const table = createNewportOpticalTable();
    table.name = component.name;
    return table;
  }

  // Fiber patch cables render procedurally as a Bezier-spline tube using
  // user-editable anchor + tangent-handle data. Per V2 the spline shape is
  // a per-instance property (objects.properties.fiberNodes); the catalog
  // template's component.properties.fiberNodes is the legacy fallback for
  // pre-2026-05-11 rows.
  if (component.componentType === "fiber") {
    const wrapper = new THREE.Group();
    wrapper.name = component.name;
    wrapper.add(createFiberSplineObject(
      component,
      objectProperties?.fiberNodes,
      objectProperties?.radiusMm,
    ));
    return wrapper;
  }

  // Phase RF.cable (2026-05-13): rf_cable / sma_cable render through the
  // procedural SMA-cable primitive. When the per-instance SceneObject
  // carries `rfCableNodes` we render the Bezier-spline version (jacket
  // follows the curve, connectors auto-orient to endpoint tangents).
  // Without nodes we fall back to the straight-cylinder rendering — same
  // appearance as before the spline mode landed.
  if (
    component.componentType === "rf_cable" ||
    component.componentType === "sma_cable"
  ) {
    const wrapper = new THREE.Group();
    wrapper.name = component.name;
    wrapper.add(createSmaShortCable(component, state, objectProperties?.rfCableNodes));
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
    } else if (isAd9959PcbAsset(asset)) {
      object = buildAd9959PcbObject(geometry, component);
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
