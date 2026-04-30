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

function createLabel(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) {
    return new THREE.Sprite();
  }

  context.fillStyle = "rgba(250, 250, 247, 0.92)";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "rgba(36, 39, 38, 0.18)";
  context.lineWidth = 8;
  context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  context.fillStyle = "#242726";
  context.font = "42px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 40);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.15, 0.29, 1);
  sprite.position.y = 0.65;
  sprite.name = "component-label";
  return sprite;
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

function createPrimitive(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const group = new THREE.Group();
  group.name = component.name;

  let mesh: THREE.Object3D;
  switch (component.componentType) {
    case "optical_table":
      mesh = createBox(component, state, [1800, 1200, 90]);
      mesh.position.y = -0.45;
      break;
    case "mirror":
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.42, 0.035),
        materialFor(component, state),
      );
      mesh.position.y = 0.18;
      break;
    case "lens": {
      const radius = mmToThree(getNumericProperty(component.properties, "diameterMm", 25.4) / 2);
      const lens = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, 0.035, 40),
        materialFor(component, state),
      );
      lens.rotation.z = Math.PI / 2;
      lens.position.y = 0.2;
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
    case "eom":
      mesh = createBox(component, state, [120, 75, 70]);
      mesh.position.y = 0.2;
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

  if (component.componentType !== "optical_table") {
    group.add(createLabel(component.name));
  }

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
  object.traverse((child) => {
    child.castShadow = true;
    child.receiveShadow = true;
  });
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
