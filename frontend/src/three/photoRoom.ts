import * as THREE from "three";

const ROOM_WIDTH = 42;
const ROOM_DEPTH = 18;
const ROOM_HEIGHT_MM = 4000;
const ROOM_HEIGHT = ROOM_HEIGHT_MM / 100;
const FLOOR_Y = 0;
const TABLE_LENGTH_MM = 3600;
const TABLE_DEPTH_MM = 1200;
const TABLE_TOP_HEIGHT_MM = 860;
const TABLE_THICKNESS_MM = 457;
const TABLE_LENGTH = TABLE_LENGTH_MM / 100;
const TABLE_DEPTH = TABLE_DEPTH_MM / 100;
const TABLE_TOP_Y = TABLE_TOP_HEIGHT_MM / 100;
const TABLE_THICKNESS = TABLE_THICKNESS_MM / 100;
const TABLE_CENTER_Z = 0;

type Vec3 = [number, number, number];

export type RoomDimensions = {
  widthMm: number;
  depthMm: number;
  heightMm: number;
};

function standardMaterial(
  color: THREE.ColorRepresentation,
  options: Partial<THREE.MeshStandardMaterialParameters> = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.54,
    metalness: 0.12,
    ...options,
  });
}

function addBox(
  group: THREE.Group,
  size: Vec3,
  position: Vec3,
  color: THREE.ColorRepresentation,
  name: string,
  options: Partial<THREE.MeshStandardMaterialParameters> = {},
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), standardMaterial(color, options));
  mesh.position.set(position[0], position[1], position[2]);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function addCylinder(
  group: THREE.Group,
  radius: number,
  height: number,
  position: Vec3,
  color: THREE.ColorRepresentation,
  name: string,
  options: Partial<THREE.MeshStandardMaterialParameters> = {},
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, 32),
    standardMaterial(color, options),
  );
  mesh.position.set(position[0], position[1], position[2]);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function addDisc(
  group: THREE.Group,
  radius: number,
  thickness: number,
  position: Vec3,
  rotation: Vec3,
  color: THREE.ColorRepresentation,
  name: string,
): THREE.Mesh {
  const disc = addCylinder(group, radius, thickness, position, color, name, {
    metalness: 0.58,
    roughness: 0.24,
  });
  disc.rotation.set(rotation[0], rotation[1], rotation[2]);
  return disc;
}

function addRoomShell(group: THREE.Group, dimensions: RoomDimensions): void {
  const roomWidth = Math.max(100, dimensions.widthMm) / 100;
  const roomDepth = Math.max(100, dimensions.depthMm) / 100;
  const roomHeight = Math.max(100, dimensions.heightMm) / 100;
  const backZ = -roomDepth / 2;
  const frontZ = roomDepth / 2;
  const leftX = -roomWidth / 2;
  const rightX = roomWidth / 2;
  const surfaceMaterialOptions: Partial<THREE.MeshStandardMaterialParameters> = {
    roughness: 0.88,
    metalness: 0,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
  };
  const wallMaterial = standardMaterial("#dad8c8", surfaceMaterialOptions);

  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(roomWidth, roomHeight), wallMaterial.clone());
  backWall.name = "white-back-wall";
  backWall.position.set(0, FLOOR_Y + roomHeight / 2, backZ);
  backWall.userData.fadeWhenBlocking = true;
  backWall.userData.roomSide = "back";
  group.add(backWall);

  const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(roomDepth, roomHeight), wallMaterial.clone());
  leftWall.name = "white-left-wall";
  leftWall.position.set(leftX, FLOOR_Y + roomHeight / 2, 0);
  leftWall.rotation.y = Math.PI / 2;
  leftWall.userData.fadeWhenBlocking = true;
  leftWall.userData.roomSide = "left";
  group.add(leftWall);

  const rightWall = new THREE.Mesh(new THREE.PlaneGeometry(roomDepth, roomHeight), wallMaterial.clone());
  rightWall.name = "white-right-wall";
  rightWall.position.set(rightX, FLOOR_Y + roomHeight / 2, 0);
  rightWall.rotation.y = -Math.PI / 2;
  rightWall.userData.fadeWhenBlocking = true;
  rightWall.userData.roomSide = "right";
  group.add(rightWall);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(roomWidth, roomDepth),
    standardMaterial("#dad8c8", { roughness: 0.76, metalness: 0.02, side: THREE.DoubleSide }),
  );
  floor.name = "plain-lab-floor";
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.receiveShadow = true;
  group.add(floor);

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(roomWidth, roomDepth),
    standardMaterial("#dad8c8", surfaceMaterialOptions),
  );
  ceiling.name = "plain-lab-ceiling";
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = FLOOR_Y + roomHeight;
  ceiling.userData.fadeWhenBlocking = true;
  ceiling.userData.roomSide = "ceiling";
  group.add(ceiling);

  const frameMaterial = new THREE.LineBasicMaterial({ color: "#c9cbc5", transparent: true, opacity: 0.55 });
  const frontFrame = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(leftX, FLOOR_Y, frontZ),
      new THREE.Vector3(rightX, FLOOR_Y, frontZ),
      new THREE.Vector3(rightX, FLOOR_Y + roomHeight, frontZ),
      new THREE.Vector3(leftX, FLOOR_Y + roomHeight, frontZ),
      new THREE.Vector3(leftX, FLOOR_Y, frontZ),
    ]),
    frameMaterial,
  );
  frontFrame.name = "open-camera-side";
  group.add(frontFrame);
}

function addTunedStabilizer(group: THREE.Group, x: number, z: number, tableBottomY: number): void {
  const height = tableBottomY - FLOOR_Y;
  const bodyHeight = Math.max(2.65, height - 0.78);
  const bodyCenterY = FLOOR_Y + 0.22 + bodyHeight / 2;
  const topCapY = FLOOR_Y + 0.22 + bodyHeight;

  addCylinder(group, 0.82, 0.14, [x, FLOOR_Y + 0.07, z], "#121413", "s2000a-floor-foot", {
    metalness: 0.48,
    roughness: 0.28,
  });
  addCylinder(group, 0.68, bodyHeight, [x, bodyCenterY, z], "#161817", "s2000a-black-pneumatic-isolator-body", {
    metalness: 0.28,
    roughness: 0.4,
  });
  addCylinder(group, 0.74, 0.16, [x, FLOOR_Y + 0.24, z], "#0f1110", "s2000a-bottom-body-ring", {
    metalness: 0.32,
    roughness: 0.3,
  });
  addCylinder(group, 0.74, 0.18, [x, topCapY - 0.08, z], "#0f1110", "s2000a-top-body-ring", {
    metalness: 0.32,
    roughness: 0.3,
  });

  for (const [ribX, ribZ, ribRotation] of [
    [x, z + 0.69, 0],
    [x, z - 0.69, 0],
    [x + 0.69, z, Math.PI / 2],
    [x - 0.69, z, Math.PI / 2],
  ] as Array<[number, number, number]>) {
    const rib = addBox(group, [0.12, bodyHeight * 0.34, 0.05], [ribX, FLOOR_Y + 0.72 + bodyHeight * 0.17, ribZ], "#202321", "s2000a-vertical-body-rib");
    rib.rotation.y = ribRotation;
  }

  addBox(group, [0.92, 0.54, 0.035], [x, bodyCenterY + 0.28, z + 0.686], "#f0f1eb", "s2000a-newport-label");
  addBox(group, [0.52, 0.16, 0.04], [x + 0.05, bodyCenterY + 0.16, z + 0.71], "#2b74b8", "s2000a-blue-label-band", {
    emissive: "#102a46",
    emissiveIntensity: 0.08,
  });

  addCylinder(group, 0.58, 0.18, [x, topCapY + 0.05, z], "#d7d8d0", "s2000a-silver-air-cap", {
    metalness: 0.58,
    roughness: 0.22,
  });
  addCylinder(group, 0.34, 0.22, [x, topCapY + 0.25, z], "#cfd2cc", "s2000a-top-piston", {
    metalness: 0.62,
    roughness: 0.2,
  });
  addCylinder(group, 0.72, 0.1, [x, tableBottomY - 0.05, z], "#d8d9d2", "s2000a-round-table-load-plate", {
    metalness: 0.68,
    roughness: 0.18,
  });

  const valveX = x + 0.86;
  const valveY = bodyCenterY + 0.28;
  addBox(group, [0.12, 1.15, 0.12], [valveX, valveY, z], "#d4d6cf", "s2000a-auto-relevel-vertical-bracket", {
    metalness: 0.45,
    roughness: 0.24,
  });
  addBox(group, [0.22, 0.42, 0.32], [valveX + 0.08, valveY + 0.18, z], "#252826", "s2000a-auto-relevel-valve-body", {
    metalness: 0.3,
    roughness: 0.32,
  });
  addCylinder(group, 0.16, 0.16, [valveX + 0.28, valveY + 0.2, z], "#171918", "s2000a-black-leveling-knob", {
    metalness: 0.36,
    roughness: 0.28,
  }).rotation.z = Math.PI / 2;
  addCylinder(group, 0.06, 0.04, [valveX + 0.2, valveY - 0.22, z + 0.17], "#c21d1d", "s2000a-red-air-port", {
    metalness: 0.18,
    roughness: 0.32,
  });
}

function addOpticalTable(group: THREE.Group): void {
  const bodyCenterY = TABLE_TOP_Y - TABLE_THICKNESS / 2;
  const bodyBottomY = TABLE_TOP_Y - TABLE_THICKNESS;
  const halfLength = TABLE_LENGTH / 2;
  const halfDepth = TABLE_DEPTH / 2;

  addBox(group, [TABLE_LENGTH, TABLE_THICKNESS, TABLE_DEPTH], [0, bodyCenterY, TABLE_CENTER_Z], "#111413", "newport-rs4000-3600x1200x457-body", {
    metalness: 0.2,
    roughness: 0.52,
  });
  addBox(group, [TABLE_LENGTH + 0.16, 0.12, TABLE_DEPTH + 0.12], [0, TABLE_TOP_Y - 0.06, TABLE_CENTER_Z], "#8c928b", "m6-plane-860mm-stainless-top", {
    metalness: 0.45,
    roughness: 0.34,
  });
  addBox(group, [TABLE_LENGTH + 0.18, 0.08, 0.12], [0, TABLE_TOP_Y + 0.02, halfDepth], "#c1c5bc", "front-stainless-table-edge", {
    metalness: 0.52,
    roughness: 0.26,
  });
  addBox(group, [TABLE_LENGTH + 0.18, 0.08, 0.12], [0, TABLE_TOP_Y + 0.02, -halfDepth], "#c1c5bc", "back-stainless-table-edge", {
    metalness: 0.52,
    roughness: 0.26,
  });
  addBox(group, [0.12, 0.08, TABLE_DEPTH + 0.12], [-halfLength, TABLE_TOP_Y + 0.02, TABLE_CENTER_Z], "#c1c5bc", "left-stainless-table-edge", {
    metalness: 0.52,
    roughness: 0.26,
  });
  addBox(group, [0.12, 0.08, TABLE_DEPTH + 0.12], [halfLength, TABLE_TOP_Y + 0.02, TABLE_CENTER_Z], "#c1c5bc", "right-stainless-table-edge", {
    metalness: 0.52,
    roughness: 0.26,
  });

  addBox(group, [3.2, 0.72, 0.045], [-11.6, bodyCenterY + 0.9, halfDepth + 0.025], "#e7e6dc", "newport-rs4000-label-panel");
  addBox(group, [1.55, 0.34, 0.05], [-12.35, bodyCenterY + 1.1, halfDepth + 0.055], "#0b655f", "newport-logo-block", {
    emissive: "#05312f",
    emissiveIntensity: 0.12,
  });

  for (const [x, z] of [
    [-13.5, 4.25],
    [0, 4.25],
    [13.5, 4.25],
    [-13.5, -4.25],
    [0, -4.25],
    [13.5, -4.25],
  ] as Array<[number, number]>) {
    addTunedStabilizer(group, x, z, bodyBottomY);
  }

  const dotMaterial = new THREE.MeshBasicMaterial({
    color: "#d8dcd6",
    transparent: true,
    opacity: 0.55,
  });
  const holes = new THREE.Group();
  holes.name = "m6-hole-grid-144x48";
  const holeGeometry = new THREE.CircleGeometry(0.012, 10);
  const holeCountX = 144;
  const holeCountZ = 48;
  const holeMesh = new THREE.InstancedMesh(holeGeometry, dotMaterial, holeCountX * holeCountZ);
  const matrix = new THREE.Matrix4();
  let instanceIndex = 0;
  for (let xIndex = 0; xIndex < holeCountX; xIndex += 1) {
    for (let zIndex = 0; zIndex < holeCountZ; zIndex += 1) {
      const x = -17.75 + xIndex * (35.5 / (holeCountX - 1));
      const z = -5.75 + zIndex * (11.5 / (holeCountZ - 1));
      matrix.makeRotationX(-Math.PI / 2);
      matrix.setPosition(x, TABLE_TOP_Y + 0.004, z);
      holeMesh.setMatrixAt(instanceIndex, matrix);
      instanceIndex += 1;
    }
  }
  holeMesh.instanceMatrix.needsUpdate = true;
  holes.add(holeMesh);
  group.add(holes);
}

function addUpperRack(group: THREE.Group): void {
  const y = 3.05;
  addBox(group, [15.4, 0.18, 0.22], [0, y, -3.65], "#202322", "rear-overhead-rack-beam");
  addBox(group, [15.4, 0.18, 0.22], [0, y, 3.38], "#202322", "front-overhead-rack-beam");
  addBox(group, [0.22, 0.18, 7.2], [-7.62, y, -0.12], "#202322", "left-overhead-rack-beam");
  addBox(group, [0.22, 0.18, 7.2], [7.62, y, -0.12], "#202322", "right-overhead-rack-beam");
  addBox(group, [15.2, 0.16, 7.0], [0, y + 0.28, -0.12], "#242725", "black-overhead-shelf", {
    roughness: 0.65,
    metalness: 0.18,
  });

  for (const x of [-7.62, -2.4, 2.4, 7.62]) {
    for (const z of [-3.65, 3.38]) {
      addBox(group, [0.16, 3.2, 0.16], [x, 1.46, z], "#111312", "vertical-black-frame-post");
    }
  }

  const instruments: Array<[number, number, number, number, number, string]> = [
    [-6.6, 3.55, -2.85, 1.0, 0.55, "#e4e4dd"],
    [-5.15, 3.55, -2.72, 1.05, 0.55, "#d7d9d3"],
    [-3.7, 3.55, -2.72, 1.0, 0.55, "#ecebe5"],
    [-2.1, 3.55, -2.8, 1.2, 0.6, "#d5d8d1"],
    [-0.35, 3.55, -2.85, 1.25, 0.6, "#e8e5dc"],
    [1.45, 3.55, -2.82, 1.1, 0.58, "#dadcd7"],
    [3.05, 3.55, -2.85, 1.2, 0.58, "#ede9df"],
    [4.8, 3.55, -2.78, 1.05, 0.56, "#d7d9d2"],
    [6.35, 3.55, -2.82, 1.0, 0.58, "#e6e5de"],
  ];

  for (const [x, yy, z, width, height, color] of instruments) {
    addBox(group, [width, height, 0.9], [x, yy, z], color, "rack-instrument");
    addBox(group, [width * 0.72, height * 0.26, 0.02], [x - width * 0.02, yy + 0.04, z + 0.461], "#2b3430", "instrument-display", {
      emissive: "#0f2b1d",
      emissiveIntensity: 0.18,
    });
    addCylinder(group, 0.045, 0.028, [x + width * 0.36, yy - 0.05, z + 0.48], "#d4d2c9", "instrument-knob");
  }
}

function addOpticalPost(group: THREE.Group, x: number, z: number, height = 0.62): void {
  addBox(group, [0.32, 0.06, 0.32], [x, 0.17, z], "#2b2e2c", "optical-base", {
    metalness: 0.45,
    roughness: 0.28,
  });
  addCylinder(group, 0.055, height, [x, 0.2 + height / 2, z], "#1b1d1c", "black-optical-post", {
    metalness: 0.52,
    roughness: 0.25,
  });
}

function addMirrorMount(group: THREE.Group, x: number, z: number, rotationY = 0, height = 0.68): void {
  addOpticalPost(group, x, z, height);
  const mount = addBox(group, [0.32, 0.32, 0.08], [x, 0.25 + height, z], "#111312", "mirror-mount-body", {
    metalness: 0.4,
    roughness: 0.28,
  });
  mount.rotation.y = rotationY;
  const mirror = addDisc(group, 0.12, 0.025, [x, 0.25 + height, z + 0.055], [Math.PI / 2, 0, rotationY], "#b8c5ca", "round-mirror");
  mirror.rotation.y = rotationY;
}

function addLensMount(group: THREE.Group, x: number, z: number, height = 0.68): void {
  addOpticalPost(group, x, z, height);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.15, 0.018, 12, 40),
    standardMaterial("#202321", { metalness: 0.48, roughness: 0.24 }),
  );
  ring.name = "lens-ring";
  ring.position.set(x, 0.24 + height, z);
  ring.rotation.y = Math.PI / 2;
  ring.castShadow = true;
  group.add(ring);

  const lens = addDisc(group, 0.118, 0.018, [x, 0.24 + height, z], [0, 0, Math.PI / 2], "#9fd2e5", "glass-lens");
  const lensMaterial = lens.material as THREE.MeshStandardMaterial;
  lensMaterial.transparent = true;
  lensMaterial.opacity = 0.48;
}

function addRail(group: THREE.Group, x: number, z: number, length: number, rotationY = 0): void {
  const rail = addBox(group, [length, 0.08, 0.13], [x, 0.2, z], "#202321", "black-optical-rail", {
    metalness: 0.42,
    roughness: 0.24,
  });
  rail.rotation.y = rotationY;
}

function addVacuumAssembly(group: THREE.Group): void {
  addBox(group, [1.8, 0.08, 1.35], [2.1, 0.25, -0.75], "#c5c7bf", "vacuum-small-breadboard", {
    metalness: 0.42,
    roughness: 0.3,
  });
  for (const [x, z] of [
    [1.35, -1.2],
    [2.85, -1.2],
    [1.35, -0.3],
    [2.85, -0.3],
  ] as Array<[number, number]>) {
    addCylinder(group, 0.055, 1.55, [x, 1.05, z], "#9ca19b", "vacuum-support-post", {
      metalness: 0.65,
      roughness: 0.22,
    });
  }
  addCylinder(group, 0.32, 0.72, [2.1, 0.75, -0.75], "#c7c4ba", "stainless-vacuum-cell", {
    metalness: 0.72,
    roughness: 0.2,
  });
  const shield = addBox(group, [1.1, 0.9, 0.92], [2.1, 1.55, -0.75], "#6c706c", "dark-magnetic-shield-box", {
    metalness: 0.46,
    roughness: 0.18,
    transparent: true,
    opacity: 0.78,
  });
  shield.rotation.y = 0.05;
  addBox(group, [0.42, 0.9, 0.03], [2.1, 1.55, -0.27], "#b99a42", "gold-window-on-shield", {
    metalness: 0.25,
    roughness: 0.28,
    transparent: true,
    opacity: 0.72,
  });
  addBox(group, [1.45, 0.08, 1.12], [2.1, 2.05, -0.75], "#b9bcb4", "vacuum-top-platform", {
    metalness: 0.45,
    roughness: 0.28,
  });
}

function addTableEquipment(group: THREE.Group): void {
  addBox(group, [2.0, 0.42, 0.86], [-3.2, 0.36, 2.5], "#1e7eb8", "blue-boosta-laser-box", {
    metalness: 0.15,
    roughness: 0.42,
  });
  addBox(group, [0.34, 0.28, 0.62], [-4.38, 0.35, 2.5], "#0e5f94", "blue-laser-front-head");
  addBox(group, [1.9, 0.44, 1.25], [4.95, 0.38, 1.55], "#d9d7ce", "white-controller-box");
  addBox(group, [2.1, 0.45, 1.32], [5.65, 0.38, -2.2], "#c8cbc4", "silver-metal-box-right");
  addBox(group, [1.85, 0.55, 1.18], [-1.15, 0.44, 2.75], "#bfc3bd", "large-silver-box-front");
  addBox(group, [1.05, 0.26, 0.58], [4.4, 0.28, -0.25], "#b01f2f", "red-driver-box-left");
  addBox(group, [1.05, 0.26, 0.58], [5.7, 0.28, -0.1], "#b01f2f", "red-driver-box-right");
  addCylinder(group, 0.42, 0.09, [3.8, 0.22, 2.65], "#c43838", "red-plastic-tray-front");
  addCylinder(group, 0.48, 0.09, [4.85, 0.22, 2.48], "#c43838", "red-plastic-tray-back");

  addVacuumAssembly(group);

  for (const [x, z, rot] of [
    [-6.4, 2.7, 0.2],
    [-5.8, 1.95, -0.5],
    [-5.1, 1.22, 0.75],
    [-4.4, 2.1, 0.35],
    [-3.6, 1.55, -0.2],
    [-2.8, 1.1, 0.5],
    [-2.0, 1.75, -0.7],
    [-1.1, 1.1, 0.15],
    [0.1, 1.55, 0.3],
    [0.9, 0.55, -0.45],
    [3.2, 0.55, 0.1],
    [4.0, 0.85, 0.65],
    [5.0, 0.58, -0.35],
    [6.15, 0.75, 0.5],
    [6.65, -1.15, -0.25],
    [5.85, -1.8, 0.35],
    [4.8, -1.55, -0.45],
    [3.6, -2.25, 0.2],
    [1.0, -2.45, -0.6],
    [-0.5, -2.1, 0.6],
    [-2.1, -2.3, -0.25],
    [-3.5, -1.85, 0.4],
    [-4.8, -2.55, -0.55],
    [-6.0, -2.25, 0.15],
  ] as Array<[number, number, number]>) {
    addMirrorMount(group, x, z, rot);
  }

  for (const [x, z] of [
    [-5.55, 0.35],
    [-4.25, 0.25],
    [-2.75, 0.35],
    [-1.35, -0.15],
    [0.3, -0.35],
    [3.25, -1.5],
    [4.45, -2.62],
    [6.25, -2.6],
  ] as Array<[number, number]>) {
    addLensMount(group, x, z);
  }

  for (const [x, z, length, rotation] of [
    [-5.0, 1.55, 1.8, -0.4],
    [-2.8, 0.95, 1.4, 0.1],
    [-0.1, 0.72, 1.8, 0.25],
    [3.55, 0.05, 1.5, -0.3],
    [5.25, -1.0, 1.4, 0.45],
    [-4.7, -2.05, 1.55, 0.65],
  ] as Array<[number, number, number, number]>) {
    addRail(group, x, z, length, rotation);
  }
}

function addForegroundInstruments(group: THREE.Group): void {
  addBox(group, [2.35, 1.28, 0.45], [5.35, 0.18, 4.7], "#e7e6df", "front-oscilloscope-body");
  addBox(group, [1.54, 0.78, 0.03], [5.05, 0.25, 4.47], "#111415", "front-oscilloscope-screen", {
    emissive: "#050707",
    emissiveIntensity: 0.3,
  });
  addBox(group, [0.62, 1.28, 0.09], [6.23, 0.18, 4.45], "#cfd5d4", "oscilloscope-button-panel");
  addBox(group, [1.4, 4.58, 1.4], [5.35, FLOOR_Y + 2.29, 4.95], "#d1a15f", "wood-stand");
  addBox(group, [1.55, 4.52, 1.2], [2.75, FLOOR_Y + 2.26, 4.8], "#bbbdb5", "front-power-supply-stand");
  addBox(group, [1.35, 0.72, 1.05], [2.75, -0.15, 4.8], "#e7e7e2", "front-white-power-supply");
}

export function createLabPhotoRoom(dimensions: RoomDimensions = {
  widthMm: ROOM_WIDTH * 100,
  depthMm: ROOM_DEPTH * 100,
  heightMm: ROOM_HEIGHT * 100,
}): THREE.Group {
  const group = new THREE.Group();
  group.name = "white-room-shell";
  addRoomShell(group, dimensions);
  return group;
}

export function createNewportOpticalTable(): THREE.Group {
  const group = new THREE.Group();
  group.name = "newport-rs4000-optical-table-object";
  addOpticalTable(group);
  return group;
}
