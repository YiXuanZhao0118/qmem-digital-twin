import * as THREE from "three";

import type {
  Anchor,
  Asset3D,
  BeamSegment,
  ComponentItem,
  ElementKind,
  OpticalElement,
  OpticalLink,
  SceneObject,
} from "../types/digitalTwin";
import { labToThreeVector, mmToThree } from "./transformUtils";

const DEFAULT_RAY_LENGTH_MM = 600;
const MIN_BEAM_RADIUS_THREE = 0.005;
const MAX_BEAM_RADIUS_THREE = 0.05;
const PREVIEW_RAY_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>([
  "laser_source",
  "tapered_amplifier",
]);

function rotateVecLab(v: THREE.Vector3, rxDeg: number, ryDeg: number, rzDeg: number): THREE.Vector3 {
  // Mirror the lab-frame rotation R = Rz(rz) · Rx(rx) · Ry(ry) used by the
  // backend solver and frontend relationAnchors. v is in lab coords.
  const rx = (rxDeg * Math.PI) / 180;
  const ry = (ryDeg * Math.PI) / 180;
  const rz = (rzDeg * Math.PI) / 180;

  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const x1 = v.x * cy + v.z * sy;
  const y1 = v.y;
  const z1 = -v.x * sy + v.z * cy;

  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const x2 = x1;
  const y2 = y1 * cx - z1 * sx;
  const z2 = y1 * sx + z1 * cx;

  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  return new THREE.Vector3(x2 * cz - y2 * sz, x2 * sz + y2 * cz, z2);
}

/** Map a wavelength in nm to an approximate visible-light RGB tuple,
 * with a rolled-off red for IR (>700 nm) so users can still see the beam. */
function wavelengthToColor(wavelengthNm: number): THREE.Color {
  let r = 0;
  let g = 0;
  let b = 0;
  let factor = 1.0;

  if (wavelengthNm < 380) {
    r = 0.6; g = 0; b = 1.0; factor = 0.4;
  } else if (wavelengthNm < 440) {
    r = -(wavelengthNm - 440) / 60;
    g = 0;
    b = 1;
  } else if (wavelengthNm < 490) {
    r = 0;
    g = (wavelengthNm - 440) / 50;
    b = 1;
  } else if (wavelengthNm < 510) {
    r = 0;
    g = 1;
    b = -(wavelengthNm - 510) / 20;
  } else if (wavelengthNm < 580) {
    r = (wavelengthNm - 510) / 70;
    g = 1;
    b = 0;
  } else if (wavelengthNm < 645) {
    r = 1;
    g = -(wavelengthNm - 645) / 65;
    b = 0;
  } else if (wavelengthNm <= 780) {
    r = 1;
    g = 0;
    b = 0;
  } else {
    // IR: deep red, lower brightness (visually marks "invisible" wavelengths)
    r = 1;
    g = 0;
    b = 0;
    factor = Math.max(0.45, 1 - (wavelengthNm - 780) / 600);
  }

  return new THREE.Color(r * factor, g * factor, b * factor);
}

function findEmitterAnchor(asset: Asset3D | undefined): Anchor | null {
  if (!asset?.anchors) return null;
  for (const anchor of asset.anchors) {
    if (anchor.id === "+x" || anchor.id === "out") return anchor;
  }
  return null;
}

/** World-space emission origin and direction (lab coords) for a placement.
 * Falls back to placement origin + rotated +X axis when the asset has no
 * dedicated emitter anchor. */
export function emissionFromPlacement(
  placement: SceneObject,
  asset: Asset3D | undefined,
): { origin: THREE.Vector3; direction: THREE.Vector3 } {
  const anchor = findEmitterAnchor(asset);
  const localPosition = anchor?.localPosition ?? { x: 0, y: 0, z: 0 };
  const localDirection = anchor?.localDirection ?? { x: 1, y: 0, z: 0 };

  const offset = rotateVecLab(
    new THREE.Vector3(localPosition.x, localPosition.y, localPosition.z),
    placement.rxDeg,
    placement.ryDeg,
    placement.rzDeg,
  );
  const direction = rotateVecLab(
    new THREE.Vector3(localDirection.x, localDirection.y, localDirection.z),
    placement.rxDeg,
    placement.ryDeg,
    placement.rzDeg,
  );
  if (direction.lengthSq() === 0) direction.set(1, 0, 0);
  direction.normalize();

  return {
    origin: new THREE.Vector3(
      placement.xMm + offset.x,
      placement.yMm + offset.y,
      placement.zMm + offset.z,
    ),
    direction,
  };
}

function placementForComponent(
  componentId: string,
  scene: { objects: SceneObject[] },
): SceneObject | undefined {
  return scene.objects.find((object) => object.componentId === componentId);
}

function assetForComponent(
  componentId: string,
  scene: { components: ComponentItem[]; assets: Asset3D[] },
): Asset3D | undefined {
  const component = scene.components.find((item) => item.id === componentId);
  if (!component?.asset3dId) return undefined;
  return scene.assets.find((asset) => asset.id === component.asset3dId);
}

function spectrumWavelengthNm(segment: BeamSegment): number {
  const spatial = segment.spatialX as { wavelengthNm?: number };
  if (typeof spatial?.wavelengthNm === "number") return spatial.wavelengthNm;
  const spectrum = segment.spectrum as { centerThz?: number };
  if (typeof spectrum?.centerThz === "number" && spectrum.centerThz > 0) {
    return 299_792_458 / (spectrum.centerThz * 1e12) * 1e9;
  }
  return 780;
}

function clampThreeRadius(waistUm: number): number {
  // waistUm is in micrometres; convert to mm then to Three.js units (÷100),
  // then bound so very tight foci or very wide diverged beams stay visible.
  const radiusMm = Math.max(waistUm, 1) / 1000;
  const radiusThree = mmToThree(radiusMm) * 30; // exaggerate for visibility
  return Math.max(MIN_BEAM_RADIUS_THREE, Math.min(MAX_BEAM_RADIUS_THREE, radiusThree));
}

function buildBeamMaterial(wavelengthNm: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: wavelengthToColor(wavelengthNm),
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Render a beam segment between its link endpoints with Gaussian-derived
 * radius. Returns null if the link or its endpoints can't be resolved. */
export function buildBeamSegmentMesh(
  segment: BeamSegment,
  scene: {
    objects: SceneObject[];
    components: ComponentItem[];
    assets: Asset3D[];
    opticalLinks: OpticalLink[];
  },
): THREE.Object3D | null {
  const link = scene.opticalLinks.find((item) => item.id === segment.opticalLinkId);
  if (!link) return null;

  const fromPlacement = placementForComponent(link.fromComponentId, scene);
  const toPlacement = placementForComponent(link.toComponentId, scene);
  if (!fromPlacement || !toPlacement) return null;

  const fromAsset = assetForComponent(link.fromComponentId, scene);
  const fromEmission = emissionFromPlacement(fromPlacement, fromAsset);
  const fromVec = labToThreeVector([fromEmission.origin.x, fromEmission.origin.y, fromEmission.origin.z]);
  const toVec = labToThreeVector([toPlacement.xMm, toPlacement.yMm, toPlacement.zMm]);

  const distance = fromVec.distanceTo(toVec);
  if (distance < 1e-4) return null;

  const wavelengthNm = spectrumWavelengthNm(segment);
  const spatialX = segment.spatialX as { waistUm?: number; wAtZUm?: number };
  const spatialY = segment.spatialY as { waistUm?: number; wAtZUm?: number };
  const startRadiusUm = Math.max(spatialX.waistUm ?? 100, spatialY.waistUm ?? 100);
  const endRadiusUm = Math.max(spatialX.wAtZUm ?? startRadiusUm, spatialY.wAtZUm ?? startRadiusUm);
  const startRadius = clampThreeRadius(startRadiusUm);
  const endRadius = clampThreeRadius(endRadiusUm);

  const geometry = new THREE.CylinderGeometry(endRadius, startRadius, distance, 16, 1, true);
  // CylinderGeometry is built along Y; align it with the segment direction.
  geometry.translate(0, distance / 2, 0);

  const material = buildBeamMaterial(wavelengthNm, 0.55);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(fromVec);

  const dir = new THREE.Vector3().subVectors(toVec, fromVec).normalize();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(yAxis, dir);
  mesh.quaternion.copy(quat);

  // Add a thin centerline so very narrow beams stay visible
  const lineGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, distance, 0),
  ]);
  const line = new THREE.Line(
    lineGeom,
    new THREE.LineBasicMaterial({
      color: wavelengthToColor(wavelengthNm),
      transparent: true,
      opacity: 0.95,
    }),
  );
  mesh.add(line);
  mesh.userData.beamSegmentId = segment.id;
  return mesh;
}

/** Draw a faded preview ray from each emitter that has no outgoing
 * optical_link, so users see "the laser is on" before linking. */
export function buildEmitterPreviewRays(scene: {
  objects: SceneObject[];
  components: ComponentItem[];
  assets: Asset3D[];
  opticalElements: OpticalElement[];
  opticalLinks: OpticalLink[];
}): THREE.Object3D[] {
  const outgoingLinkSources = new Set(
    scene.opticalLinks.map((link) => link.fromComponentId),
  );
  const meshes: THREE.Object3D[] = [];

  for (const element of scene.opticalElements) {
    if (!PREVIEW_RAY_KINDS.has(element.elementKind)) continue;
    if (outgoingLinkSources.has(element.componentId)) continue;
    const placement = placementForComponent(element.componentId, scene);
    if (!placement) continue;

    const asset = assetForComponent(element.componentId, scene);
    const { origin, direction } = emissionFromPlacement(placement, asset);
    const tip = origin.clone().add(direction.multiplyScalar(DEFAULT_RAY_LENGTH_MM));

    const fromVec = labToThreeVector([origin.x, origin.y, origin.z]);
    const toVec = labToThreeVector([tip.x, tip.y, tip.z]);
    const distance = fromVec.distanceTo(toVec);

    let wavelengthNm = 780;
    if (element.elementKind === "laser_source") {
      const params = element.kindParams as { centerWavelengthNm?: number };
      if (typeof params.centerWavelengthNm === "number") wavelengthNm = params.centerWavelengthNm;
    }

    const radius = clampThreeRadius(200);
    const geometry = new THREE.CylinderGeometry(radius, radius, distance, 12, 1, true);
    geometry.translate(0, distance / 2, 0);
    const mesh = new THREE.Mesh(geometry, buildBeamMaterial(wavelengthNm, 0.18));
    mesh.position.copy(fromVec);

    const dir = new THREE.Vector3().subVectors(toVec, fromVec).normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    mesh.quaternion.copy(quat);

    const dashed = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, distance, 0),
      ]),
      new THREE.LineDashedMaterial({
        color: wavelengthToColor(wavelengthNm),
        dashSize: 0.12,
        gapSize: 0.08,
        transparent: true,
        opacity: 0.65,
      }),
    );
    dashed.computeLineDistances();
    mesh.add(dashed);
    mesh.userData.previewRayFor = element.componentId;
    meshes.push(mesh);
  }

  return meshes;
}
