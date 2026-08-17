/**
 * Device registry — the OPEN, flat axis of the three-axis model
 * (behavior / device / catalog) from RF_ARCHITECTURE_PLAN.md §1.
 *
 * A *device* is one concrete instrument: a mesh + a named-anchor layout +
 * its default params, pinned to ONE behavioral kind. Adding the 50th
 * instrument is supposed to be "add one file in this directory" — never a
 * new behavioral kind, never a schema change, never a per-type editor
 * branch (plan §1, the three "never stack another layer on top" rules).
 *
 * IRON RULE — dependency is one-way: `device → behavioral kind`, never the
 * reverse. A device names a `behavioralKind` (an ElementKind string the
 * solver already dispatches on); the behavioral kind never imports a
 * device. The build-time manifest exporter (`scripts/export_kinds_manifest.ts`)
 * is allowed to read BOTH layers to materialise anchor templates — that's a
 * tool, not a runtime layer, so it doesn't break the rule.
 *
 * Cardinality / role typing lives on the behavioral kind's `roles` map
 * (see `kinds/_plugin.ts` RoleSpec). A device just places named anchors
 * against those roles; the role's `max` decides whether repeating a role
 * (CH0..CH3 on a 4-channel DDS) is legal. No `repeatable` flag — multiport
 * is expressed by the role's cardinality, exactly as plan §2.2 requires.
 *
 * RF scope (this slice): leaf devices only. The `composite` shape
 * (sub-device tree, for the isolator) lands with the optical rollout in a
 * later phase — kept out here to honour Simplicity First.
 */

/** One named anchor a device places against a behavioral-kind role.
 *
 *  `positionMmBodyLocal` / `directionBodyLocal` are body-local Z-up mm.
 *  Both are optional — when omitted the PHY Editor seeds the anchor at the
 *  body origin and the user drags it onto the real mesh feature (same
 *  contract the legacy `ComponentAnchorTemplate` used). Only the AD9959 has
 *  measured coordinates today; the other RF device examples seed at origin
 *  and are dragged in. */
export interface DeviceAnchorTemplate {
  /** Behavioral-kind role this anchor fills (rf_out / rf_in / ttl_in / …).
   *  MUST be a role declared on the device's `behavioralKind`. */
  readonly role: string;
  /** Disambiguator when one role repeats (CH0..CH3, RF1/RF2). Becomes the
   *  anchor's `name`; the RF BFS keys multiport adjacency by it. */
  readonly name?: string;
  readonly positionMmBodyLocal?: { x: number; y: number; z: number };
  /** Propagation / face normal → seeds the anchor's body-local axisX. */
  readonly directionBodyLocal?: { x: number; y: number; z: number };
  /** Explicit body-local transverse reference axis. Only needed for
   *  polarisation-sensitive optics (waveplate / PBS / Glan / Faraday) where
   *  the seeder must NOT pick an arbitrary axisY; it is Gram-Schmidt'd against
   *  axisX and Z = X × Y. Omit for rotationally-symmetric / RF parts — the
   *  seeder then derives an arbitrary consistent complement. */
  readonly axisYBodyLocal?: { x: number; y: number; z: number };
  /** Connector family string ("sma" / "bnc" / …) — drives RF-Link
   *  connector-compatibility + the cable-tip mesh. Optional. */
  readonly connectorType?: string;
  /** Hit aperture in mm (optical sinks / apertured ports). Optional. */
  readonly apertureMm?: number;
  /** Aperture outline. "rectangle" parts (PBS / cylindrical lens / Glan)
   *  additionally carry width/height below. Optional. */
  readonly apertureShape?: "rectangle" | "ellipse" | "circle";
  readonly apertureWidthMm?: number;
  readonly apertureHeightMm?: number;
}

/** A leaf device — covers every RF instrument (and, later, single-mesh
 *  optical parts + null-behavior mechanical parts). */
export interface LeafDevice {
  /** Stable device slug — the value an Asset3D's `device_id` references.
   *  e.g. "ad9959", "zhl_1_2w", "zyswa_2_50dr". */
  readonly id: string;
  /** Human-readable label (PHY Editor device picker). */
  readonly displayName: string;
  /** Behavioral kind this instrument dispatches as — an ElementKind string.
   *  `null` = pure mechanical / render-only (no solver participation).
   *  The asset's `kind_id` is derived from (written through from) this. */
  readonly behavioralKind: string | null;
  /** Catalog componentType this device materialises. Lets the manifest
   *  exporter key the per-componentType anchor template (replacing the
   *  plugin's `componentAnchorContracts`). */
  readonly componentType: string;
  /** Mesh filename / path (relative to the asset file store). */
  readonly mesh: string;
  /** Named-anchor layout placed against the behavioral kind's roles. */
  readonly anchors: readonly DeviceAnchorTemplate[];
  /** Device-level default params merged onto the seeded asset's
   *  default_params on top of the behavioral kind's defaults (spec-sheet
   *  metadata: max output frequency, reference clock, …). Optional. */
  readonly defaultParams?: Readonly<Record<string, number | boolean | string>>;
}

export type Device = LeafDevice;

/** Author-convenience constructor (mirrors `definePhysicsPlugin`). */
export function defineDevice(device: LeafDevice): LeafDevice {
  return device;
}
