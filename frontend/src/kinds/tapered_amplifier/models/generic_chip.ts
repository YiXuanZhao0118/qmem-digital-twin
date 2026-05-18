import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../types/digitalTwin";
import { getDimensionsMm, mmToThree } from "../../../three/transformUtils";

/** Generic bare-chip tapered amplifier — copper finned heatsink + ceramic
 *  submount + narrow trapezoidal chip on top. Used as the fallback when a
 *  TA catalog row doesn't specify a recognised brand/model. */
export function createGenericTaperedAmplifierChip(component: ComponentItem, state?: DeviceState): THREE.Object3D {
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
