import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../types/digitalTwin";
import { getDimensionsMm, mmToThree } from "../transformUtils";

function colorForComponent(component: ComponentItem, state?: DeviceState): THREE.ColorRepresentation {
  const deviceState = state?.state ?? {};
  const enabled = deviceState.enabled;
  const temperatureC = typeof deviceState.temperatureC === "number" ? deviceState.temperatureC : 0;
  const pressurePa = typeof deviceState.pressurePa === "number" ? deviceState.pressurePa : 0;

  if (component.componentType === "rf_amplifier" && temperatureC > 45) return "#dc2626";
  if (component.componentType === "vacuum_chamber" && pressurePa > 0.01) return "#dc2626";
  if (enabled === false) return "#6b7280";

  const colorOverride = (component.properties as { colorHex?: unknown } | null | undefined)?.colorHex;
  if (typeof colorOverride === "string" && /^#[0-9a-fA-F]{6}$/.test(colorOverride)) {
    return colorOverride;
  }

  switch (component.componentType) {
    case "optical_table":
      return "#3f4742";
    case "vacuum_chamber":
      return "#8dd3c7";
    case "laser":
      return "#0f766e";
    case "laser_diode_mount":
      return "#6b7280";
    case "mirror":
      return "#c4b5fd";
    case "lens":
      return "#93c5fd";
    case "aom":
      return "#f59e0b";
    case "eom":
      return "#e879f9";
    case "rf_generator":
      return "#57534e";
    case "rf_amplifier":
      return "#7c2d12";
    case "post_holder":
      return "#111827";
    case "optical_post":
      return "#d1d5db";
    case "pedestal_post":
      return "#d1d5db";
    case "post_spacer":
      return "#d1d5db";
    case "clamping_fork":
      return "#a8b0b8";
    case "mirror_mount":
      return "#1a1a1c";
    case "isolator":
      return "#1a1a1c";
    case "dds_ad9959_pcb":
      return "#0f3f2a";
    case "mcu_board":
      return "#1e293b";
    case "tcxo_module":
      return "#3f3422";
    case "power_supply_ac_dc":
      return "#7c2d12";
    case "sma_cable":
    case "rf_cable":
      return "#c4a884";
    case "rf_switch":
      return "#c8ccd0";
    case "sma_jack":
    case "usb_b_jack":
      return "#cbd5e1";
    case "iec_c14_inlet":
      return "#1f2937";
    case "instrument_chassis":
      return "#27272a";
    default:
      return "#64748b";
  }
}

/** Exported so renderers in other modules (e.g. `kinds/rf_amplifier/renderer.ts`)
 *  can read the same hot-state tint logic used by `materialFor`. Not part of
 *  the barrel's public surface. */
export { colorForComponent };

export function materialFor(
  component: ComponentItem,
  state?: DeviceState,
): THREE.MeshStandardMaterial {
  const transparent = component.componentType === "vacuum_chamber" || component.componentType === "lens";
  const isPolished = ["mirror", "optical_post", "pedestal_post", "post_spacer", "clamping_fork", "laser_diode_mount", "sma_jack", "usb_b_jack"].includes(component.componentType);
  const isAnodized = component.componentType === "mirror_mount" || component.componentType === "isolator" || component.componentType === "instrument_chassis" || component.componentType === "power_supply_ac_dc";
  return new THREE.MeshStandardMaterial({
    color: colorForComponent(component, state),
    metalness: isPolished ? 0.75 : isAnodized ? 0.55 : 0.12,
    roughness: isPolished ? 0.2 : isAnodized ? 0.5 : 0.42,
    transparent,
    opacity: component.componentType === "vacuum_chamber" ? 0.72 : component.componentType === "lens" ? 0.82 : 1,
  });
}

export function createBox(
  component: ComponentItem,
  state: DeviceState | undefined,
  fallbackMm: [number, number, number],
): THREE.Mesh {
  const [xMm, yMm, zMm] = getDimensionsMm(component.properties, fallbackMm);
  return new THREE.Mesh(
    new THREE.BoxGeometry(mmToThree(xMm), mmToThree(zMm), mmToThree(yMm)),
    materialFor(component, state),
  );
}

export const ddsPcbGreenMat = new THREE.MeshStandardMaterial({ color: "#0f3f2a", metalness: 0.05, roughness: 0.62 });
export const ddsPcbDarkBlueMat = new THREE.MeshStandardMaterial({ color: "#1e293b", metalness: 0.08, roughness: 0.55 });
export const ddsPcbTanGreenMat = new THREE.MeshStandardMaterial({ color: "#3f3422", metalness: 0.05, roughness: 0.58 });
export const ddsBlackInsetMat = new THREE.MeshStandardMaterial({ color: "#020617", metalness: 0.25, roughness: 0.55 });
export const ddsChromeMat = new THREE.MeshStandardMaterial({ color: "#d1d5db", metalness: 0.85, roughness: 0.2 });
export const ddsBrassMat = new THREE.MeshStandardMaterial({ color: "#b7791f", metalness: 0.7, roughness: 0.28 });
export const ddsTeflonWhiteMat = new THREE.MeshStandardMaterial({ color: "#f1f5f9", metalness: 0.05, roughness: 0.55 });
export const ddsSilkscreenMat = new THREE.MeshStandardMaterial({ color: "#e5e7eb", metalness: 0.05, roughness: 0.65 });
export const ddsCableBlackMat = new THREE.MeshStandardMaterial({ color: "#0f172a", metalness: 0.15, roughness: 0.62 });
// Brass with flat-shading — used for hex flanges so the 6 facets render as
// discrete planes (smooth shading on a 6-sided CylinderGeometry interpolates
// the normals across faces and the hex visually degenerates into a cylinder).
export const ddsBrassFlatMat = new THREE.MeshStandardMaterial({
  color: "#b7791f",
  metalness: 0.7,
  roughness: 0.28,
  flatShading: true,
});
// RG-316 FEP jacket — reddish-brown, matches Thorlabs CA29xx datasheet
// artwork and the colour of physical RG-316 in the lab.
export const ddsCableTanMat = new THREE.MeshStandardMaterial({ color: "#a93226", metalness: 0.05, roughness: 0.62 });
export const ddsPsuShellMat = new THREE.MeshStandardMaterial({ color: "#f8fafc", metalness: 0.05, roughness: 0.62 });
export const ddsPsuLabelMat = new THREE.MeshStandardMaterial({ color: "#7c2d12", metalness: 0.05, roughness: 0.55 });

// SMA bulkhead jack body — nickel-plated steel. Darker / less mirror-bright
// than the generic chrome used on other DDS chassis trim.
export const ddsSmaNickelMat = new THREE.MeshStandardMaterial({
  color: "#9ca3af",
  metalness: 0.9,
  roughness: 0.32,
});
