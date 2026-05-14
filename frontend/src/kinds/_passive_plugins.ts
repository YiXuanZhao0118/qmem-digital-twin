/**
 * PassivePlugins — componentTypes that appear in the catalog but have
 * no ElementKind / physics contract. They render via STL (auto-linked
 * by `assetNamePattern`) or via a procedural primitive renderer
 * (M6 will inline those geometry functions into per-type folders).
 *
 * Kept in a single file because each entry is ~5 lines and folder-per-
 * type would inflate the kinds directory by 22 trivial folders. If a
 * passive type later grows a procedural renderer / instance editor /
 * its own kindParams shape, extract it into its own folder following
 * the physics-plugin convention.
 *
 * Coverage (matches AssetLibraryPanel.tsx's hand-written Sets):
 *   - Mechanical (12)   : MECHANICAL_TYPES minus mirror_mount
 *   - Infrastructure (1): optical_table
 *   - Misc (2)          : text_annotation, tool
 *   - Electronics (7)   : passive electronics componentTypes that
 *                         don't map to an ElementKind (chassis trim,
 *                         standalone jacks, IEC inlet, etc.)
 */
import { definePassivePlugin, type PassivePlugin } from "./_plugin";

// =============================================================================
// Mechanical — STL-rendered Thorlabs hardware. `assetNamePattern` lets
// the M5 API-layer auto-linker resolve Component.name → Asset3D by the
// `<name>_stl` convention without per-row asset_3d_id wiring.
// =============================================================================

const mechanical = (id: string, displayName: string): PassivePlugin =>
  definePassivePlugin({
    id,
    displayName,
    componentTypes: [id],
    assetCategory: "mechanical",
    assetNamePattern: "{name}_stl",
  });

export const clampingForkPlugin = mechanical("clamping_fork", "Clamping Fork");
export const opticalPostPlugin = mechanical("optical_post", "Optical Post");
export const postHolderPlugin = mechanical("post_holder", "Post Holder");
export const pedestalPostPlugin = mechanical("pedestal_post", "Pedestal Post");
export const pedestalBasePlugin = mechanical("pedestal_base", "Pedestal Base");
export const pedestalForkPlugin = mechanical("pedestal_fork", "Pedestal Fork");
export const postSpacerPlugin = mechanical("post_spacer", "Post Spacer");
export const postAdapterPlugin = mechanical("post_adapter", "Post Adapter");
export const laserDiodeMountPlugin = mechanical("laser_diode_mount", "Laser Diode Mount");
export const mountingClampPlugin = mechanical("mounting_clamp", "Mounting Clamp");
export const polarisClampingArmPlugin = mechanical(
  "polaris_clamping_arm",
  "Polaris Clamping Arm",
);
export const benchEnhancementPlugin = mechanical(
  "bench_enhancement",
  "Bench Enhancement",
);

// =============================================================================
// Infrastructure — optical table, room geometry.
// =============================================================================

export const opticalTablePlugin = definePassivePlugin({
  id: "optical_table",
  displayName: "Optical Table",
  componentTypes: ["optical_table"],
  assetCategory: "infrastructure",
});

// =============================================================================
// Misc — annotations / scene aids.
// =============================================================================

export const textAnnotationPlugin = definePassivePlugin({
  id: "text_annotation",
  displayName: "Text Annotation",
  componentTypes: ["text_annotation"],
  assetCategory: "misc",
});

export const toolPlugin = definePassivePlugin({
  id: "tool",
  displayName: "Tool",
  componentTypes: ["tool"],
  assetCategory: "misc",
  // Some tools (spanners, hex drivers) have an STL on disk; auto-link
  // with the same `<name>_stl` convention as Mechanical.
  assetNamePattern: "{name}_stl",
});

// =============================================================================
// Electronics (passive) — chassis trim, standalone connectors, IEC
// inlet. These have procedural renderers in `createPrimitive` (M6 will
// move them into per-type folders); for now `_passive_plugins.ts` just
// declares their catalog membership.
// =============================================================================

const electronicsPassive = (id: string, displayName: string): PassivePlugin =>
  definePassivePlugin({
    id,
    displayName,
    componentTypes: [id],
    assetCategory: "electronics",
  });

export const mcuBoardPlugin = electronicsPassive("mcu_board", "MCU Board");
export const tcxoModulePlugin = electronicsPassive("tcxo_module", "TCXO Module");
export const powerSupplyAcDcPlugin = electronicsPassive("power_supply_ac_dc", "Power Supply (AC/DC)");
export const smaJackPlugin = electronicsPassive("sma_jack", "SMA Jack");
export const usbBJackPlugin = electronicsPassive("usb_b_jack", "USB-B Jack");
export const iecC14InletPlugin = electronicsPassive("iec_c14_inlet", "IEC C14 Inlet");
export const instrumentChassisPlugin = electronicsPassive("instrument_chassis", "Instrument Chassis");

// =============================================================================
// Barrel — all passive plugins in one array for the registry.
// =============================================================================

export const PASSIVE_PLUGINS: readonly PassivePlugin[] = [
  // Mechanical
  clampingForkPlugin,
  opticalPostPlugin,
  postHolderPlugin,
  pedestalPostPlugin,
  pedestalBasePlugin,
  pedestalForkPlugin,
  postSpacerPlugin,
  postAdapterPlugin,
  laserDiodeMountPlugin,
  mountingClampPlugin,
  polarisClampingArmPlugin,
  benchEnhancementPlugin,
  // Infrastructure
  opticalTablePlugin,
  // Misc
  textAnnotationPlugin,
  toolPlugin,
  // Electronics passive
  mcuBoardPlugin,
  tcxoModulePlugin,
  powerSupplyAcDcPlugin,
  smaJackPlugin,
  usbBJackPlugin,
  iecC14InletPlugin,
  instrumentChassisPlugin,
];
