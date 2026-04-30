import * as THREE from "three";

import type { BeamPath } from "../types/digitalTwin";
import { labToThreeVector } from "./transformUtils";

export function createBeamPath(beamPath: BeamPath, active: boolean): THREE.Group {
  const group = new THREE.Group();
  group.name = `beam-${beamPath.id}`;
  group.userData.beamPathId = beamPath.id;

  const points = beamPath.points.map(labToThreeVector);
  if (points.length < 2) return group;

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: beamPath.color,
    transparent: true,
    opacity: active ? 0.96 : 0.2,
  });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 5;
  group.add(line);

  for (const point of points) {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(active ? 0.035 : 0.025, 12, 12),
      new THREE.MeshBasicMaterial({
        color: beamPath.color,
        transparent: true,
        opacity: active ? 0.9 : 0.2,
      }),
    );
    marker.position.copy(point);
    group.add(marker);
  }

  return group;
}

