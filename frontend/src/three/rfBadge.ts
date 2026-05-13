/**
 * Phase RF.6 — small text sprite that floats above an RF-driven device
 * (AOM / EOM / etc.) in the 3D scene, showing "f MHz @ ±dBm" computed
 * from the device's RfChain. Uses THREE.CanvasTexture + Sprite so the
 * label always faces the camera.
 *
 * The renderer in DigitalTwinViewer.tsx creates one badge per
 * SceneObject that has an RfChain and parents it to the object wrapper
 * — that way it tracks the device's position automatically. Badges are
 * cleared / rebuilt whenever the chain or selection changes, gated by
 * the `connections` overlay flag (since RF cabling logically belongs to
 * the Relations group).
 */
import * as THREE from "three";

function makeBadgeCanvas(text: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  // Pre-size based on text length so we don't clip wide labels.
  const padding = 16;
  const tmp = document.createElement("canvas").getContext("2d")!;
  tmp.font = "600 32px ui-monospace, Menlo, monospace";
  const w = Math.ceil(tmp.measureText(text).width) + padding * 2;
  const h = 56;
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d")!;
  // Dark sky-blue pill background.
  ctx.fillStyle = "rgba(7, 89, 133, 0.88)";
  ctx.beginPath();
  const radius = h / 2;
  ctx.moveTo(radius, 0);
  ctx.arcTo(w, 0, w, h, radius);
  ctx.arcTo(w, h, 0, h, radius);
  ctx.arcTo(0, h, 0, 0, radius);
  ctx.arcTo(0, 0, w, 0, radius);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(56, 189, 248, 0.85)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = "rgba(254, 240, 138, 0.97)";
  ctx.font = "600 32px ui-monospace, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2 + 1);
  return canvas;
}

export function makeRfBadgeSprite(text: string): THREE.Sprite {
  const canvas = makeBadgeCanvas(text);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  // Three.js scene is in metres; one cell of the lab grid = 10 mm = 0.01 m.
  // Aim for a label ~30 mm wide on the screen.
  const aspect = canvas.width / canvas.height;
  const heightM = 0.012;
  sprite.scale.set(heightM * aspect, heightM, 1);
  sprite.renderOrder = 999;
  sprite.userData.disposeTexture = () => texture.dispose();
  return sprite;
}

export function disposeRfBadgeSprite(sprite: THREE.Sprite): void {
  const disposer = sprite.userData.disposeTexture as (() => void) | undefined;
  disposer?.();
  if (sprite.material instanceof THREE.SpriteMaterial) sprite.material.dispose();
}
