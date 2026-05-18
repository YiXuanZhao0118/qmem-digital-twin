import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../types/digitalTwin";
import { getNumericProperty, mmToThree } from "../../../three/transformUtils";
import { ddsBrassMat, materialFor } from "../../../three/loadAsset/materials";
import { createSmaBulkheadJack } from "../../../three/loadAsset/passive/electronics";

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
export function createMinicircuitsZyswa250dr(component: ComponentItem, state?: DeviceState): THREE.Object3D {
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
  // align with the matching feedthrough below.
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
  const ftYUpper = H * 0.25;
  const frontFeed = makeFeedthrough();
  frontFeed.rotation.x = Math.PI / 2;
  frontFeed.position.set(0, ftYUpper, D / 2);
  group.add(frontFeed);
  const backFeed = makeFeedthrough();
  backFeed.rotation.x = -Math.PI / 2;
  backFeed.position.set(0, ftYUpper, -D / 2);
  group.add(backFeed);

  // --- GND pin on the +Z (front) face, upper area, offset toward +X ----
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
  gnd.rotation.x = Math.PI / 2;
  gnd.position.set(W / 2 - mmToThree(4.0), ftYUpper, D / 2);
  group.add(gnd);

  // --- Phillips screws at the 4 corners of the top face (label cover) --
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
