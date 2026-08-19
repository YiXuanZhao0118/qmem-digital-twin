import * as THREE from "three";

import type { ComponentItem } from "../../../types/digitalTwin";
import { mmToThree } from "../../transformUtils";

/** Flat rectangular outline used to mark out a region of the optical table
 *  ("MOT region", "beam prep", "keep clear"…). Sibling of
 *  `text_annotation.ts`: same passive-kind wiring (procedural Asset3D →
 *  binding leaf → `primitive://` dispatch), different geometry.
 *
 *  Frame contract: the world is Z-up and a renderer's output lives in the
 *  Component's body frame (`bindingTreeObject.ts`, "Frame contract"), so the
 *  rectangle is built in the body XY plane with its normal along +Z. At the
 *  identity pose it therefore lies flat on the table; the standard transform
 *  widgets move/rotate it like any other object.
 *
 *  Params arrive already merged — `bindingRendererGate` passes a synthetic
 *  component whose properties are `asset.defaultParams ⊕ (dynamicSources ∩
 *  tunableParams)` (alembic 0125). The defaults below are therefore only a
 *  last-resort fallback; the real defaults live on the kind / asset row:
 *   - widthMm       : number  – size along body X (default 300)
 *   - depthMm       : number  – size along body Y (default 200)
 *   - color         : string  – CSS colour of frame, fill and text (default
 *                               sky blue, matching the text annotation accent)
 *   - lineWidthMm   : number  – thickness of the frame band, in mm, so it is
 *                               a real on-table width rather than the
 *                               unreliable GL `linewidth` (default 3)
 *   - fillOpacity   : number  – 0..1 translucent fill inside the frame; 0
 *                               disables the fill mesh entirely (default 0.12)
 *   - showDimensions: boolean – "300 × 200 mm" caption at the lower-right
 *                               corner (default true)
 *   - showLabel     : boolean – free-text caption above the top edge; the
 *                               text comes from `label`, falling back to the
 *                               component name (default true)
 *   - label         : string  – the caption content
 *   - textHeightMm  : number  – on-table cap height of both captions
 *                               (default 20) */
/** `file_path` of the procedural Asset3D seeded by alembic 0124 — the binding
 *  leaf every rect-annotation Component resolves, exactly as
 *  `TEXT_ANNOTATION_ASSET_FILEPATH` is for labels (dispatch is by the
 *  Component's kindId, not by this key). */
export const RECT_ANNOTATION_ASSET_FILEPATH = "primitive://rect_annotation";

const DEFAULT_COLOR = "#38bdf8";

function numberProp(value: unknown, fallback: number, min = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value > min ? value : fallback;
}

function boolProp(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Trim "300.0" → "300" so the dimension caption stays readable at a glance. */
function formatMm(valueMm: number): string {
  return Number(valueMm.toFixed(1)).toString();
}

/** Transparent-background text sprite. Deliberately panel-less (unlike the
 *  text annotation's rounded box) — a table marking should read as ink on the
 *  breadboard, not as a floating UI chip. `heightMm` sets the on-table cap
 *  height; width follows the canvas aspect ratio. */
function makeCaption(text: string, color: string, heightMm: number): THREE.Sprite {
  const fontPx = 64;
  const canvas = document.createElement("canvas");
  const fontSpec = `bold ${fontPx}px 'Inter', 'Segoe UI', sans-serif`;
  const measureCtx = canvas.getContext("2d");
  let textWidth = fontPx * 4;
  if (measureCtx) {
    measureCtx.font = fontSpec;
    textWidth = measureCtx.measureText(text).width;
  }
  const cw = Math.max(32, Math.ceil(textWidth) + 8);
  const ch = Math.ceil(fontPx * 1.35);
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = color;
    ctx.font = fontSpec;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cw / 2, ch / 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false }),
  );
  const heightThree = mmToThree(heightMm);
  sprite.scale.set(heightThree * (cw / ch), heightThree, 1);
  sprite.renderOrder = 100;
  return sprite;
}

export function createRectAnnotation(component: ComponentItem): THREE.Object3D {
  const props = component.properties as Record<string, unknown>;
  const widthMm = numberProp(props.widthMm, 300);
  const depthMm = numberProp(props.depthMm, 200);
  const color = typeof props.color === "string" ? props.color : DEFAULT_COLOR;
  const lineWidthMm = numberProp(props.lineWidthMm, 3);
  const fillOpacity =
    typeof props.fillOpacity === "number" && Number.isFinite(props.fillOpacity)
      ? Math.min(1, Math.max(0, props.fillOpacity))
      : 0.12;
  const textHeightMm = numberProp(props.textHeightMm, 20);

  const group = new THREE.Group();
  group.name = component.name;
  group.userData.isRectAnnotation = true;

  const w = mmToThree(widthMm);
  const d = mmToThree(depthMm);
  // The band is drawn INSIDE the nominal rectangle, so widthMm/depthMm stay
  // the outer footprint the user typed no matter how thick the line gets.
  const band = Math.min(mmToThree(lineWidthMm), Math.min(w, d) / 2);

  // A marking sits ON the table, coplanar with it. polygonOffset (rather
  // than a hidden +Z lift) keeps the geometry exactly at the pose the user
  // set while still winning the depth test against the table top.
  const decalMaterial = (opacity: number) =>
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, -d / 2);
  shape.lineTo(w / 2, -d / 2);
  shape.lineTo(w / 2, d / 2);
  shape.lineTo(-w / 2, d / 2);
  shape.closePath();
  const innerW = w / 2 - band;
  const innerD = d / 2 - band;
  if (innerW > 0 && innerD > 0) {
    const hole = new THREE.Path();
    hole.moveTo(-innerW, -innerD);
    hole.lineTo(innerW, -innerD);
    hole.lineTo(innerW, innerD);
    hole.lineTo(-innerW, innerD);
    hole.closePath();
    shape.holes.push(hole);
  }
  const frame = new THREE.Mesh(new THREE.ShapeGeometry(shape), decalMaterial(0.95));
  frame.renderOrder = 91;
  group.add(frame);

  if (fillOpacity > 0) {
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(w, d), decalMaterial(fillOpacity));
    fill.renderOrder = 90;
    group.add(fill);
  }

  const captionGap = mmToThree(textHeightMm * 0.75);

  if (boolProp(props.showLabel, true)) {
    const labelText =
      typeof props.label === "string" && props.label.trim().length > 0
        ? props.label
        : component.name;
    if (labelText.length > 0) {
      const label = makeCaption(labelText, color, textHeightMm);
      // Centred above the top edge, outside the frame.
      label.position.set(0, d / 2 + captionGap, 0);
      group.add(label);
    }
  }

  if (boolProp(props.showDimensions, true)) {
    const dims = makeCaption(
      `${formatMm(widthMm)} × ${formatMm(depthMm)} mm`,
      color,
      textHeightMm * 0.75,
    );
    // Lower-right corner, right edge flush with the frame's right edge.
    dims.center.set(1, 0.5);
    dims.position.set(w / 2, -d / 2 - captionGap * 0.75, 0);
    group.add(dims);
  }

  return group;
}
