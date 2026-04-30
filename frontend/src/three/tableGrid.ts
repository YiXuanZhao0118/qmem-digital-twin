import * as THREE from "three";

export function createOpticalTableGrid(): THREE.Group {
  const group = new THREE.Group();
  group.name = "optical-table-grid";

  const grid = new THREE.GridHelper(18, 36, "#397367", "#5d716b");
  grid.position.y = 0.012;
  const gridMaterial = grid.material as THREE.Material;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.32;
  group.add(grid);

  const xAxis = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-9, 0.05, 6),
    1,
    "#c2410c",
    0.16,
    0.09,
  );
  const zAxis = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(-9, 0.05, 6),
    1,
    "#0f766e",
    0.16,
    0.09,
  );
  group.add(xAxis, zAxis);

  return group;
}

