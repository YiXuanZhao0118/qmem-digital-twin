/**
 * Procedural Glan-Laser calcite polariser — two right-angle prisms
 * separated by a thin air gap.
 *
 * Extracted from ``kinds/isolator/pbsOverlay.ts::buildGlanLaserPrism``
 * in Stage A''.11-prep so the prism geometry is an Asset3D the binding
 * tree can reference. The legacy pbsOverlay produced this geometry
 * inline as part of its bundled "PBS overlay" for high-power isolator
 * models (Thorlabs IO-*-HP); after A''.11 lands the HP isolator
 * binding trees will reference this builder as a ``glan_polarizer``
 * sub-Component instead.
 *
 * Renderer dispatch:
 *   Asset3D.filePath = "procedural://glan_polarizer_prism"
 *     → ``loadAsset/index.ts`` dispatches to
 *       ``buildGlanLaserPrismObject(component)``
 *     → returns the calcite prism pair + escape-arrow marker.
 *
 * Geometry contract (physical frame, before alignment rotation):
 *   - Aperture: ``sizeMm × sizeMm`` in (X, Y)
 *   - Length:   ``sizeMm / tan(wedgeAngle)`` along Z (optical axis)
 *   - Cut plane tilts ``wedgeAngle`` from optical axis
 *   - Wedge angle 38° matches calcite Glan-Laser at 850 nm
 *     (near-Brewster for E-ray, TIR for O-ray, escape ~68°)
 *
 * ``component.properties`` overrides:
 *   - ``sizeMm`` (default 5): aperture dimension
 *   - ``wedgeAngleDeg`` (default 38): cut-plane angle
 *   - ``airGapMm`` (default 0.15 = 3% of sizeMm): prism separation
 *
 * The legacy buildGlanLaserPrism is left in pbsOverlay.ts for now to
 * serve the un-migrated isolators; once A''.11 ships the HP binding
 * trees + A''.12 deletes pbsOverlay, this becomes the sole producer
 * of Glan-Laser geometry in the renderer.
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
  const sizeMm = getNumericProperty(component.properties, "sizeMm", 5);
  const wedgeAngleDeg = getNumericProperty(
    component.properties,
    "wedgeAngleDeg",
    38,
  );
  const airGapMm = getNumericProperty(
    component.properties,
    "airGapMm",
    sizeMm * 0.03,
  );

  const sizeUnit = mmToThree(sizeMm);
  const wedgeRad = (wedgeAngleDeg * Math.PI) / 180;
  const a = sizeUnit;
  const L = a / Math.tan(wedgeRad);
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

  const prismAGeom = buildPrismGeom([
    [2, 5, 6], [3, 7, 4],
    [4, 6, 5], [4, 7, 6],
    [2, 7, 3], [2, 6, 7],
    [2, 3, 4], [2, 4, 5],
  ]);
  const prismBGeom = buildPrismGeom([
    [1, 2, 5], [0, 4, 3],
    [0, 1, 2], [0, 2, 3],
    [0, 5, 1], [0, 4, 5],
    [3, 5, 4], [3, 2, 5],
  ]);
  const prismA = new THREE.Mesh(prismAGeom, crystal);
  const prismB = new THREE.Mesh(prismBGeom, crystal);

  // Air gap: offset each prism along its outward cut normal.
  const cutNorm = Math.hypot(L, a);
  const gapUnit = mmToThree(airGapMm);
  const offY = (gapUnit * L) / cutNorm;
  const offZ = (gapUnit * a) / cutNorm;
  prismA.position.set(0, -offY, -offZ);
  prismB.position.set(0, +offY, +offZ);

  const group = new THREE.Group();
  group.add(prismA);
  group.add(prismB);

  // Escape window marker — pinkish arrow showing the rejected O-ray
  // exit direction (~68° from optical axis after Snell at the -Y side).
  const escapeAngleRad = (68 * Math.PI) / 180;
  const escapeDir = new THREE.Vector3(0, -Math.sin(escapeAngleRad), Math.cos(escapeAngleRad));
  const escapeOrigin = new THREE.Vector3(0, -ha - a * 0.05, 0);
  const arrowLen = a * 1.2;
  const escapeArrow = new THREE.ArrowHelper(
    escapeDir,
    escapeOrigin,
    arrowLen,
    0xff4477,
    arrowLen * 0.25,
    arrowLen * 0.18,
  );
  escapeArrow.traverse((child) => {
    const m = (child as THREE.Mesh | THREE.Line).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    const mats = Array.isArray(m) ? m : [m];
    for (const mat of mats) {
      (mat as THREE.Material & { depthTest?: boolean; depthWrite?: boolean }).depthTest = false;
      (mat as THREE.Material & { depthTest?: boolean; depthWrite?: boolean }).depthWrite = false;
      mat.transparent = true;
    }
  });
  escapeArrow.renderOrder = 2;
  escapeArrow.userData.__glanEscapeArrow = true;
  group.add(escapeArrow);

  return group;
}
