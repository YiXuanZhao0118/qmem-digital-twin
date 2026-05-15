/**
 * Binds renderers to plugins without modifying their index.ts files.
 *
 * M6 POC added `renderer` to mirror inline. M6 FULL would either
 * (a) add `renderer` to every plugin's index.ts (26 separate edits) or
 * (b) bind them centrally here. We chose (b) for two reasons:
 *   - lower commit risk (one file, atomic),
 *   - the renderer code itself still lives in loadAsset.ts as named
 *     exports (createAom, createTaperedAmplifier, ...) so this file
 *     stays a thin lookup. Moving each renderer body into its plugin
 *     folder is a follow-up that doesn't change behaviour, just file
 *     location.
 *
 * Once a plugin's index.ts declares `renderer: ...` directly, drop the
 * binding here. The wrapper `withRenderer()` below is a no-op when
 * the plugin already has one.
 */
import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../types/digitalTwin";
import {
  createAom,
  createBox,
  createDdsAd9959Pcb,
  createDdsMcuBoard,
  createDdsTcxoModule,
  createIecC14Inlet,
  createInstrumentChassis1u,
  createMeanwellIrm30,
  createRfSwitch,
  createSmaBulkheadJack,
  createSmaShortCable,
  createTaperedAmplifier,
  createTextAnnotation,
  createThorlabsClampingFork,
  createThorlabsPedestalPost,
  createThorlabsPost,
  createThorlabsPostHolder,
  createTs2000aLaserMount,
  createUsbBJack,
  createZhl12wPlusAmplifier,
  materialFor,
} from "../three/loadAsset";
import { createNewportOpticalTable } from "../three/photoRoom";
import { getNumericProperty, mmToThree } from "../three/transformUtils";

import type { ComponentPlugin } from "./_plugin";

type Renderer = (component: ComponentItem, state: DeviceState | undefined) => THREE.Object3D;

// --- inline renderers for kinds whose pre-M6 geometry was small enough
// to keep in this file instead of an external helper -------------------

const renderLens: Renderer = (component, state) => {
  const radius = mmToThree(getNumericProperty(component.properties, "diameterMm", 25.4) / 2);
  const thickness = mmToThree(getNumericProperty(component.properties, "thicknessMm", 3.5));
  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, thickness, 40),
    materialFor(component, state),
  );
  lens.rotation.z = Math.PI / 2;
  lens.position.x = -thickness / 2;
  return lens;
};

const renderVacuumChamber: Renderer = (component, state) => {
  const radius = mmToThree(getNumericProperty(component.properties, "radiusMm", 150));
  const height = mmToThree(getNumericProperty(component.properties, "heightMm", 220));
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, 64),
    materialFor(component, state),
  );
  mesh.position.y = height / 2;
  return mesh;
};

const renderLaser: Renderer = (component, state) => {
  const mesh = createBox(component, state, [260, 90, 80]);
  mesh.position.y = 0.22;
  return mesh;
};

const renderEom: Renderer = (component, state) => {
  const lengthMm = getNumericProperty(component.properties, "lengthMm", 120);
  const widthMm = getNumericProperty(component.properties, "widthMm", 75);
  const heightMm = getNumericProperty(component.properties, "heightMm", 70);
  const length = mmToThree(lengthMm);
  const eom = new THREE.Mesh(
    new THREE.BoxGeometry(length, mmToThree(heightMm), mmToThree(widthMm)),
    materialFor(component, state),
  );
  eom.position.x = -length / 2;
  return eom;
};

const renderIsolator: Renderer = (component, state) => {
  const diameterMm = getNumericProperty(component.properties, "diameterMm", 22);
  const lengthMm = getNumericProperty(component.properties, "lengthMm", 51.4);
  const ferruleDiameterMm = getNumericProperty(component.properties, "ferruleDiameterMm", 13);
  const ferruleLengthMm = getNumericProperty(component.properties, "ferruleLengthMm", 5);
  const bodyRadius = mmToThree(diameterMm / 2);
  const bodyLength = mmToThree(lengthMm);
  const ferruleRadius = mmToThree(ferruleDiameterMm / 2);
  const ferruleLen = mmToThree(ferruleLengthMm);
  const isoGroup = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(bodyRadius, bodyRadius, bodyLength, 40),
    materialFor(component, state),
  );
  isoGroup.add(body);
  const steel = new THREE.MeshStandardMaterial({ color: "#cbd5e1", metalness: 0.85, roughness: 0.22 });
  const inFerrule = new THREE.Mesh(
    new THREE.CylinderGeometry(ferruleRadius, ferruleRadius, ferruleLen, 24),
    steel,
  );
  inFerrule.position.y = -(bodyLength / 2 + ferruleLen / 2);
  isoGroup.add(inFerrule);
  const outFerrule = new THREE.Mesh(
    new THREE.CylinderGeometry(ferruleRadius, ferruleRadius, ferruleLen, 24),
    steel,
  );
  outFerrule.position.y = bodyLength / 2 + ferruleLen / 2;
  isoGroup.add(outFerrule);
  return isoGroup;
};

const renderRfGenericBox = (dims: [number, number, number], yOffset: number): Renderer =>
  (component, state) => {
    const mesh = createBox(component, state, dims);
    mesh.position.y = yOffset;
    return mesh;
  };

// rf_amplifier ships as a generic-box for unknown brands, but the
// canonical Mini-Circuits ZHL-1-2W+ has a procedural model that matches
// the heatsink + SMA + feedthrough geometry of the real part. Dispatch on
// `component.model` so adding a new amplifier brand (ZHL-42W+, ZHL-2-4W+,
// …) is just one more case in the switch — the box stays the default.
const renderRfAmplifier: Renderer = (component, state) => {
  if (component.model === "ZHL-1-2W+") {
    return createZhl12wPlusAmplifier(component, state);
  }
  // Fallback: generic chassis box sized roughly like a small heatsink
  // amplifier. Matches the pre-M6 default for any rf_amplifier whose
  // model field doesn't match a known procedural renderer.
  const mesh = createBox(component, state, [108, 50, 50]);
  mesh.position.y = mmToThree(0.5);
  return mesh;
};

const renderOpticalTable: Renderer = () => {
  const table = createNewportOpticalTable();
  return table;
};

// rf_source has 3 componentTypes (rf_source / dds_ad9959_pcb / rf_generator)
// with different physical models. Dispatch on componentType inside the
// renderer keeps the binding flat.
const renderRfSource: Renderer = (component, state) => {
  if (component.componentType === "dds_ad9959_pcb") {
    return createDdsAd9959Pcb(component, state);
  }
  // Default rf_generator / rf_source: 280 x 220 x 100 mm chassis box.
  const mesh = createBox(component, state, [280, 220, 100]);
  mesh.position.y = 0.2;
  return mesh;
};

// rf_cable similarly: sma_cable / rf_cable both → procedural cable.
const renderRfCable: Renderer = (component, state) => {
  return createSmaShortCable(component, state);
};

// --- registry: componentType → renderer ----------------------------

const RENDERER_BY_COMPONENT_TYPE: Record<string, Renderer> = {
  // PhysicsPlugin componentTypes
  laser_source: renderLaser,
  laser: renderLaser,
  tapered_amplifier: createTaperedAmplifier,
  lens_biconvex: renderLens,
  lens: renderLens,
  lens_spherical: renderLens,
  lens_plano_convex: renderLens,
  lens_cylindrical: renderLens,
  isolator: renderIsolator,
  aom: createAom,
  eom: renderEom,
  rf_source: renderRfSource,
  dds_ad9959_pcb: renderRfSource,
  rf_generator: renderRfSource,
  rf_amplifier: renderRfAmplifier,
  rf_cable: renderRfCable,
  sma_cable: renderRfCable,
  rf_switch: createRfSwitch,

  // PassivePlugin componentTypes (mechanical procedural builders +
  // electronics + workspace + misc)
  laser_diode_mount: createTs2000aLaserMount,
  optical_post: createThorlabsPost,
  post_spacer: createThorlabsPost,
  pedestal_post: createThorlabsPedestalPost,
  post_holder: createThorlabsPostHolder,
  clamping_fork: createThorlabsClampingFork,
  optical_table: renderOpticalTable,
  text_annotation: createTextAnnotation,
  mcu_board: createDdsMcuBoard,
  tcxo_module: createDdsTcxoModule,
  power_supply_ac_dc: createMeanwellIrm30,
  sma_jack: () => createSmaBulkheadJack(),
  usb_b_jack: createUsbBJack,
  iec_c14_inlet: createIecC14Inlet,
  instrument_chassis: createInstrumentChassis1u,
};

/** Returns the plugin with a `renderer` field bound from the lookup
 *  table when none was declared in the plugin file itself. Plugins
 *  that already declare a renderer (e.g. mirror after the M6 POC)
 *  pass through unchanged. */
export function withRenderer(plugin: ComponentPlugin): ComponentPlugin {
  if (plugin.renderer) return plugin;
  for (const ct of plugin.componentTypes) {
    const r = RENDERER_BY_COMPONENT_TYPE[ct];
    if (r) {
      return { ...plugin, renderer: r };
    }
  }
  return plugin;
}
