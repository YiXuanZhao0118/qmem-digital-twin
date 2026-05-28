/**
 * Procedural Glan-Laser calcite polariser — two right-angle prisms
 * separated by a thin air gap, cut along the body diagonal.
 *
 * Extracted from ``kinds/isolator/pbsOverlay.ts::buildGlanLaserPrism``
 * in Stage A''.11-prep so the prism geometry is an Asset3D the binding
 * tree can reference. After A''.11 the HP isolator binding trees
 * reference this builder as a ``glan_polarizer`` sub-Component.
 *
 * Geometry contract (physical frame, before alignment rotation):
 *   - Body cross-section: ``sizeMm × sizeMm`` in (X, Y). The OUTER
 *     crystal envelope, NOT the clear aperture.
 *   - Body length: ``lengthMm`` along Z (optical axis).
 *   - Cut plane: body diagonal, passing through the 4 corners on the
 *     plane ``L·y + a·z = 0`` (where a = sizeMm, L = lengthMm). The
 *     implicit wedge angle is ``atan(sizeMm/lengthMm)``; for the
 *     defaults below ≈ 40.9°, close to the canonical 38° calcite
 *     Glan-Laser spec. We use the simpler 8-vertex body-diagonal cut
 *     so a single shape covers any (sizeMm, lengthMm) pair without
 *     clamping — the elongated-prism variant (12-vertex internal cut
 *     for L >> sizeMm/tan(38°), e.g. Thorlabs GL5-B at 21 mm) lived
 *     here previously but was removed when no catalog Component used
 *     it; re-add if a longer Glan-Laser variant lands.
 *
 * ``component.properties`` overrides (defaults match the user's
 * catalog spec for the HP-isolator prism):
 *   - ``sizeMm`` (default 6.5): body cross-section W = H.
 *   - ``lengthMm`` (default 7.5): body length along the optical axis.
 *   - ``airGapMm`` (default 5 % of sizeMm ≈ 0.325 mm): visible
 *     separation between the two prisms along the cut normal. The
 *     real device has a ~50 µm gap; we exaggerate for 3D-viewer
 *     legibility. Override to match physical hardware if needed.
 */
import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../types/digitalTwin";
import { getNumericProperty, mmToThree } from "../../transformUtils";


export const GLAN_POLARIZER_PRISM_FILEPATH = "procedural://glan_polarizer_prism";


export function isGlanPolarizerPrismAsset(filePath: string): boolean {
  return filePath === GLAN_POLARIZER_PRISM_FILEPATH;
}


export function buildGlanPolarizerPrismObject(
  component: ComponentItem,
  _state?: DeviceState,
): THREE.Object3D {
  // Default body envelope (the prism actually used inside
  // IO-3-850-HP / IO-5-850-HP):
  //   - cross-section sizeMm × sizeMm in (X, Y)
  //   - length lengthMm along Z (optical axis)
  // Cut plane = body diagonal (corners 2-3-4-5). Implicit wedge =
  // atan(sizeMm/lengthMm) ≈ 40.9° at the default 6.5/7.5. The legacy
  // 8-vertex shape (also used by the Composer's bundled overlay) is
  // sufficient for these compact prisms. Elongated GL5-B-style prisms
  // (L >> sizeMm/tan(38°)) would need a 12-vertex internal-cut shape;
  // we removed that branch when no catalog Component used it.
  const sizeMm = getNumericProperty(component.properties, "sizeMm", 6.5);
  const lengthMm = getNumericProperty(component.properties, "lengthMm", 7.5);
  // Real Glan-Laser air gap is ~50 µm (hairline at this scale), but for
  // 3D-viewer legibility we exaggerate to ~5 % of body width.
  const airGapMm = getNumericProperty(
    component.properties,
    "airGapMm",
    sizeMm * 0.05,
  );

  const a = mmToThree(sizeMm);          // body cross-section (X, Y)
  const L = mmToThree(lengthMm);        // body length along Z
  const ha = a / 2;
  const hL = L / 2;

  const crystal = new THREE.MeshPhysicalMaterial({
    color: "#e8f3ff",
    metalness: 0,
    roughness: 0.04,
    transmission: 0.92,
    thickness: a * 0.5,
    ior: 1.66,
    attenuationColor: new THREE.Color("#c5dcf2"),
    attenuationDistance: a * 4,
    transparent: false,
    opacity: 1,
    envMapIntensity: 1.5,
  });

  // 8 body corners. Cut plane L·y + a·z = 0 passes through corners
  // 2, 3, 4, 5 (body diagonal from -Y/+Z to +Y/-Z).
  //   Prism A (L·y + a·z > 0, contains 6, 7): top-back wedge
  //   Prism B (L·y + a·z < 0, contains 0, 1): bottom-front wedge
  const c: number[][] = [
    [-ha, -ha, -hL], [+ha, -ha, -hL], [+ha, -ha, +hL], [-ha, -ha, +hL],
    [-ha, +ha, -hL], [+ha, +ha, -hL], [+ha, +ha, +hL], [-ha, +ha, +hL],
  ];

  const buildPrismGeom = (tris: number[][]): THREE.BufferGeometry => {
    const verts: number[] = [];
    for (const t of tris) for (const ci of t) verts.push(c[ci][0], c[ci][1], c[ci][2]);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geom.computeVertexNormals();
    return geom;
  };

  // Prism A faces (CCW from outside):
  //   +X cap (2, 5, 6) | -X cap (3, 7, 4)
  //   +Y face (4, 6, 5) (4, 7, 6)
  //   +Z aperture (2, 7, 3) (2, 6, 7)
  //   cut face outward -Y-Z (2, 3, 4) (2, 4, 5)
  const prismAGeom = buildPrismGeom([
    [2, 5, 6], [3, 7, 4],
    [4, 6, 5], [4, 7, 6],
    [2, 7, 3], [2, 6, 7],
    [2, 3, 4], [2, 4, 5],
  ]);
  // Prism B faces:
  //   +X cap (1, 2, 5) | -X cap (0, 4, 3)
  //   -Y face (0, 1, 2) (0, 2, 3)
  //   -Z aperture (0, 5, 1) (0, 4, 5)
  //   cut face outward +Y+Z (3, 5, 4) (3, 2, 5)
  const prismBGeom = buildPrismGeom([
    [1, 2, 5], [0, 4, 3],
    [0, 1, 2], [0, 2, 3],
    [0, 5, 1], [0, 4, 5],
    [3, 5, 4], [3, 2, 5],
  ]);

  const prismA = new THREE.Mesh(prismAGeom, crystal);
  const prismB = new THREE.Mesh(prismBGeom, crystal);

  // Air gap along cut-plane normal (L, a) in (Y, Z). Prism A is on
  // the +(L, a) side of the cut plane → moves in +(offY, offZ);
  // Prism B on the -(L, a) side → moves the opposite direction.
  // Sign mistake here pushes the halves through each other instead of
  // apart (the original cause of "crystals overlapping again").
  const cutNorm = Math.hypot(L, a);
  const gapUnit = mmToThree(airGapMm);
  const offY = (gapUnit * L) / cutNorm;
  const offZ = (gapUnit * a) / cutNorm;
  prismA.position.set(0, +offY, +offZ);
  prismB.position.set(0, -offY, -offZ);

  const group = new THREE.Group();
  group.add(prismA);
  group.add(prismB);

  // Align the visible diagonal cut with the physics coating face (the
  // asset's `intercept_face` / B1 anchor, normal (0.6225, 0, −0.7826) in
  // the X-Z plane), which is what both tracers actually reflect off.
  // The geometry above cuts in the Y-Z plane (cut normal (0, L, a)); a
  // +90° rotation about the optical axis (Z) maps that normal to
  // (−L, 0, a) — anti-parallel to the coating normal, i.e. the SAME
  // plane — so the air gap you see IS the reflective surface. Rotating
  // about Z leaves the optical axis and the square cross-section
  // unchanged, so the prism still seats in the housing identically;
  // only the internal cut turns 90°. Without this the beam reflected off
  // a plane perpendicular to the visible cut ("反射面跟可見切面差 90°").
  group.rotateZ(Math.PI / 2);

  return group;
}
