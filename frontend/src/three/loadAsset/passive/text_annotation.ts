import * as THREE from "three";

import type { ComponentItem } from "../../../types/digitalTwin";
import { mmToThree } from "../../transformUtils";

/** Free-form text annotation rendered as a billboard sprite. Uses the same
 *  canvas-textured rounded-rectangle approach as `addTaPortLabels` in the
 *  viewer, but driven entirely by the SceneObject's component properties so
 *  the user can place arbitrary labels anywhere in the scene (section
 *  headers, debug notes, "Cooling beam" markers …) without writing code.
 *
 *  Properties read from component.properties:
 *   - text         : string  – label content (default = component.name)
 *   - textColor    : string  – CSS colour for the glyphs (default white)
 *   - bgColor      : string  – CSS colour for the rounded panel (default
 *                              dark slate at 85% alpha)
 *   - accentColor  : string  – stroke colour around the panel (default teal)
 *   - fontSizePx   : number  – canvas-space font size; bigger = sharper
 *                              when zoomed in (default 56)
 *   - scaleMm      : number  – on-screen WIDTH of the label in mm at scene
 *                              scale; height auto-derives from aspect ratio
 *                              (default 80) */
export function createTextAnnotation(component: ComponentItem): THREE.Sprite {
  const props = component.properties as {
    text?: unknown;
    textColor?: unknown;
    bgColor?: unknown;
    accentColor?: unknown;
    fontSizePx?: unknown;
    scaleMm?: unknown;
  };
  const text =
    typeof props.text === "string" && props.text.length > 0
      ? props.text
      : component.name || "Text";
  const textColor = typeof props.textColor === "string" ? props.textColor : "#ffffff";
  const bgColor =
    typeof props.bgColor === "string" ? props.bgColor : "rgba(15, 23, 42, 0.85)";
  const accentColor =
    typeof props.accentColor === "string" ? props.accentColor : "#38bdf8";
  const fontSizePx =
    typeof props.fontSizePx === "number" && props.fontSizePx > 0 ? props.fontSizePx : 56;
  const scaleMm =
    typeof props.scaleMm === "number" && props.scaleMm > 0 ? props.scaleMm : 80;

  const canvas = document.createElement("canvas");
  const measureCtx = canvas.getContext("2d");
  const fontSpec = `bold ${fontSizePx}px 'Inter', 'Segoe UI', sans-serif`;
  let textWidth = fontSizePx * 4;
  if (measureCtx) {
    measureCtx.font = fontSpec;
    textWidth = measureCtx.measureText(text).width;
  }
  const padX = Math.max(16, fontSizePx * 0.55);
  const padY = Math.max(10, fontSizePx * 0.4);
  const cw = Math.max(96, Math.ceil(textWidth + padX * 2));
  const ch = Math.ceil(fontSizePx + padY * 2);
  canvas.width = cw;
  canvas.height = ch;

  const ctx = canvas.getContext("2d");
  if (ctx) {
    const radius = Math.min(cw, ch) * 0.18;
    ctx.fillStyle = bgColor;
    ctx.beginPath();
    ctx.moveTo(radius, 0);
    ctx.arcTo(cw, 0, cw, ch, radius);
    ctx.arcTo(cw, ch, 0, ch, radius);
    ctx.arcTo(0, ch, 0, 0, radius);
    ctx.arcTo(0, 0, cw, 0, radius);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = Math.max(2, fontSizePx * 0.06);
    ctx.stroke();
    ctx.fillStyle = textColor;
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
  // scaleMm sets the on-table WIDTH; height tracks the canvas aspect ratio
  // so the rounded box doesn't squash when text is short or long.
  const widthThree = mmToThree(scaleMm);
  const aspectHW = ch / cw;
  sprite.scale.set(widthThree, widthThree * aspectHW, 1);
  sprite.userData.isTextAnnotation = true;
  sprite.renderOrder = 100;
  return sprite;
}
