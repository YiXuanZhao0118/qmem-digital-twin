// Snap visual feedback — renders during drag to show what the engine just
// snapped to. Two pieces:
//   1. A dashed line from the dragged object's wireframe centre to the snap
//      point.
//   2. A 12-px circular sprite at the snap point (sized in pixels via
//      a scale-with-distance hack so it's always visible).
//
// Reads `lastPlacementResult` from the store, draws into a dedicated group.

import * as THREE from "three";

import type { PlacementResult, SnapTargetKind, LabPoint } from "./engine";

const SNAP_COLOURS: Record<SnapTargetKind, number> = {
  beam_centerline: 0xff5050,
  beam_along: 0xff8800,
  beam_intersection: 0xff3030,
  beam_endpoint: 0xff7080,
  mesh_vertex: 0xffffff,
  mesh_edge_midpoint: 0xdddddd,
  mesh_face_centroid: 0xeeeeee,
  mesh_bbox_center: 0xcccccc,
  anchor: 0x00ddff,
  cursor: 0xff2020,
  world_origin: 0xffaa00,
  object_plane: 0x99ff99,
  grid: 0x888888,
};

function labToThree(p: LabPoint): THREE.Vector3 {
  return new THREE.Vector3(p.x / 100, p.z / 100, -p.y / 100);
}

function makeDotTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.Texture();
  // White core with soft halo, a tiny black ring for contrast.
  const grad = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.95)");
  grad.addColorStop(0.55, "rgba(0,0,0,0.85)");
  grad.addColorStop(0.65, "rgba(0,0,0,0.5)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class SnapOverlay {
  group: THREE.Group;
  private line: THREE.Line;
  private sprite: THREE.Sprite;
  private dotTexture: THREE.Texture;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = "snap-overlay";

    const lineGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    const lineMat = new THREE.LineDashedMaterial({
      color: 0xffffff,
      dashSize: 0.05,
      gapSize: 0.04,
      depthWrite: false,
      transparent: true,
      opacity: 0.85,
    });
    this.line = new THREE.Line(lineGeom, lineMat);
    this.line.renderOrder = 950;
    this.group.add(this.line);

    this.dotTexture = makeDotTexture();
    const sprMat = new THREE.SpriteMaterial({
      map: this.dotTexture,
      color: 0xffffff,
      depthWrite: false,
      depthTest: false,
      transparent: true,
    });
    this.sprite = new THREE.Sprite(sprMat);
    this.sprite.scale.set(0.12, 0.12, 1);
    this.sprite.renderOrder = 951;
    this.group.add(this.sprite);

    this.hide();
  }

  hide(): void {
    this.line.visible = false;
    this.sprite.visible = false;
  }

  /** Update overlay from the latest engine result. dragged-object position is
   * needed to anchor the line's start point. */
  update(result: PlacementResult, draggedObjectThree: THREE.Vector3): void {
    if (!result.snappedTo) {
      this.hide();
      return;
    }
    const snap = result.snappedTo;
    const target = labToThree(snap.pointLab);
    const colour = SNAP_COLOURS[snap.kind] ?? 0xffffff;

    const positions = new Float32Array([
      draggedObjectThree.x,
      draggedObjectThree.y,
      draggedObjectThree.z,
      target.x,
      target.y,
      target.z,
    ]);
    this.line.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(positions, 3),
    );
    this.line.geometry.attributes.position.needsUpdate = true;
    (this.line.geometry as THREE.BufferGeometry).computeBoundingSphere();
    this.line.computeLineDistances();
    (this.line.material as THREE.LineDashedMaterial).color.setHex(colour);
    this.line.visible = true;

    this.sprite.position.copy(target);
    (this.sprite.material as THREE.SpriteMaterial).color.setHex(colour);
    this.sprite.visible = true;
  }

  dispose(): void {
    this.line.geometry.dispose();
    (this.line.material as THREE.Material).dispose();
    this.dotTexture.dispose();
    (this.sprite.material as THREE.Material).dispose();
  }
}
