/**
 * ComponentPlugin — single source of truth for every "kind of thing" in
 * the digital twin (mirror, AOM, mount, RF switch, ...).
 *
 * Each plugin is a self-contained object that describes:
 *   - which componentType strings it covers (catalog mapping)
 *   - which assetCategory it lives under (Components panel grouping)
 *   - whether it participates in physics (the `physics` block)
 *   - its anchors / align contract / default kindParams (if physics)
 *   - how to render it in 3D (renderer)
 *   - how to edit its kindParams (Inspector)
 *
 * Plugins live in `frontend/src/kinds/<kind>/index.ts`. The barrel file
 * `_plugins.ts` collects them into a tuple from which every existing
 * table (KIND_REGISTRY, COMPONENT_TYPE_TO_KIND, KIND_LABELS,
 * DEFAULT_KIND_PARAMS, KIND_GROUPS, RF_DOMAIN_KINDS, the
 * AssetLibraryPanel category Sets, backend OPTICAL_COMPONENT_TYPE_TO_KIND
 * mirror) is *derived* — no hand-written list can drift from the truth
 * again.
 *
 * Two flavours:
 *   - `PhysicsPlugin<P>` — participates in solver dispatch / align /
 *     PHY Editor. AOM, mirror, lens, rf_switch, etc.
 *   - `PassivePlugin`    — appears in catalog but has no physics
 *     contract. mirror_mount, optical_post, mounting_clamp, tool, ...
 *
 * Both share `ComponentPluginBase`; `physics` is the discriminator.
 */

import type { ReactElement } from "react";
import type * as THREE from "three";

import type { Asset3D, ComponentItem, DeviceState } from "../types/digitalTwin";
import type { AnchorId } from "./_registry";

// =============================================================================
// Shared enums — every plugin picks values from these
// =============================================================================

/** Asset Library catalog grouping. Currently 5 hand-written `Set<string>`s
 *  in AssetLibraryPanel.tsx that this refactor replaces. */
export type AssetCategory =
  | "optical"
  | "electronics"
  | "mechanical"
  | "infrastructure"
  | "misc";

/** Multi-physics domain — the checkboxes shown in the Object panel
 *  "PHYSICS:" row (Stress / Optical / RF / EM / Thermal / Fluid /
 *  Quantum). Per-instance choices on a SceneObject default to the
 *  plugin's `physics.defaultPhysics`. */
export type PhysicsDomain =
  | "optical"
  | "rf"
  | "em"
  | "stress"
  | "thermal"
  | "fluid"
  | "quantum";

/** Primary domain for PHY Editor tab routing. Hybrid kinds (e.g. AOM
 *  with both intercept_in/out and rf_in) pick the dominant tab; their
 *  RF anchors still surface in the Object-panel RF link section. */
export type ElementDomain = "optical" | "rf";

/** Per-anchor signal domain. Lets the framework know which kind of link
 *  graph an anchor participates in — used by the RF / Optical / trigger
 *  link panels for type-safe cable connections and by the solver for
 *  domain dispatch. Distinct from `ElementDomain` (the plugin's primary
 *  tab) because hybrid kinds like AOM have anchors in MULTIPLE domains
 *  (intercept_in/out → optical, rf_in → rf).
 *
 *  Added in Phase 2 alongside `intrinsicParamKeys` / `stateParamKeys`.
 *  Optional on every plugin: omitting it falls back to the legacy
 *  "infer from anchor id prefix" heuristic the panels already use
 *  (rf_* → rf, intercept_* / fiber_* → optical). Filling it in makes the
 *  contract explicit for kinds whose anchors don't match the heuristic. */
export type PortDomain = "optical" | "rf" | "trigger" | "ttl" | "dc";

// =============================================================================
// Phase 5 — Transfer-function pattern (pure traversal)
// =============================================================================

/** Snapshot of an RF signal at a single port. Carried through the cable
 *  graph by the RF propagation walker; passed to a plugin's `rfTransfer`
 *  whenever the walker hits one of its rf_in ports.
 *
 *  Mirrors the `RfSignalState` defined in `utils/rfPropagation.ts` — kept
 *  here as a structural type so this file doesn't have to import from
 *  the utils layer (which would create a circular dependency back to the
 *  plugin registry). The two definitions are pinned-equal by a sanity
 *  assignment in `rfPropagation.ts`. */
export interface RfTransferSignal {
  readonly frequencyMhz: number;
  readonly vpp: number;
  readonly sourceObjectId: string;
  readonly sourceAnchorName: string;
  readonly cumulativeGainDb: number;
  readonly passthroughObjectIds: readonly string[];
  readonly saturated: boolean;
}

/** One downstream emission row returned by an `RfTransfer`. The walker
 *  uses `outputAnchorName` to look up the rf_out anchor on this kind's
 *  asset (so the cable adjacency is keyed correctly) and `outgoing` as
 *  the transformed signal to propagate. */
export interface RfTransferOutput {
  readonly outputAnchorName: string;
  readonly outgoing: RfTransferSignal;
}

/** A plugin-level transfer function: given the incoming signal at one of
 *  the kind's rf_in anchors, return the (output anchor, outgoing signal)
 *  rows that should propagate downstream. Return `null` (or `[]`) for a
 *  sink. MUST be pure and synchronous. */
export type RfTransfer = (args: {
  readonly inputAnchorName: string;
  readonly incoming: RfTransferSignal;
  readonly kindParams: Readonly<Record<string, unknown>>;
  readonly anchors: ReadonlyArray<{ id: string; name?: string }>;
  readonly objectId: string;
}) => ReadonlyArray<RfTransferOutput> | null;

/** Align algorithm dispatch — moved verbatim from the existing
 *  KindContract.alignVariant. */
export type AlignVariant =
  | "translate_anchor_to_beam"
  | "translate_and_bragg_rotate"
  | "translate_anti_parallel"
  | "none";

// =============================================================================
// Anchor contract
// =============================================================================

export interface AnchorContract {
  /** Anchors the kind cannot function without. */
  readonly required: ReadonlyArray<AnchorId>;
  /** Anchors that improve behaviour when present. */
  readonly optional: ReadonlyArray<AnchorId>;
  /** Subset of required+optional whose direction (not just position)
   *  matters for the align algorithm. */
  readonly needsDirection: ReadonlyArray<AnchorId>;
  /** Subset of required+optional whose `apertureMm` must be set.
   *  AOM is the canonical case — both ports need an aperture for
   *  beam-clipping warnings to fire. Defaults to `[]` when omitted. */
  readonly needsAperture?: ReadonlyArray<AnchorId>;
  /** Subset of required+optional whose `fastAxisDegBodyLocal` is the
   *  asset-level fast-axis angle (PHY Editor → Optical → Components).
   *  Waveplate uses this on `intercept_in`. Per-instance rotation
   *  around the beam axis is applied via SceneObject.transform.
   *  Defaults to `[]` when omitted. */
  readonly needsFastAxis?: ReadonlyArray<AnchorId>;
}

// =============================================================================
// Plugin shape
// =============================================================================

/** Fields common to all plugins (catalog + rendering). */
interface ComponentPluginBase {
  /** Stable id — for PhysicsPlugin this is the canonical ElementKind
   *  value. For PassivePlugin it's a free identifier (used only in this
   *  registry; not stored in the DB). */
  readonly id: string;

  /** Human-readable label shown in UI (Components panel, kind selector). */
  readonly displayName: string;

  /** componentType strings (as stored in DB) that map to this plugin.
   *  First entry is canonical; others are aliases handled for
   *  backwards-compat. Empty array forbidden — every plugin must claim
   *  at least one componentType. */
  readonly componentTypes: readonly [string, ...string[]];

  /** Drives the Components panel category header. */
  readonly assetCategory: AssetCategory;

  /** Sub-grouping label within the category (e.g. "Emitters", "Passive",
   *  "Active / Nonlinear", "Sinks", "RF" inside the Optical / RF
   *  groupings — replaces the existing KIND_GROUPS table). Optional;
   *  plugins without a group fall under the category root. */
  readonly catalogGroup?: string;

  /** When set, the asset linker auto-pairs a Component named X with the
   *  Asset3D named `<assetNamePattern.replace("{name}", X)>`. Used to
   *  resolve STL meshes for catalog items without per-row asset_3d_id.
   *  Today's `link_components_to_stl.py` is a one-shot version of this. */
  readonly assetNamePattern?: string;

  /** Optional 3D renderer. If absent, the framework falls back to:
   *    1. the Component's Asset3D filePath if it's a real mesh; else
   *    2. `createBox` with `properties.dimensionsMm` (or a generic box).
   *  Replacing the existing `createPrimitive` switch on componentType. */
  readonly renderer?: (
    component: ComponentItem,
    state: DeviceState | undefined,
    asset?: Asset3D,
  ) => THREE.Object3D;
}

/** Plugin whose kind participates in physics — has anchors, align,
 *  kindParams, Inspector. Generic on the kindParams shape so each
 *  plugin keeps its own strong-typed params. */
export interface PhysicsPlugin<TParams extends Record<string, unknown> = Record<string, unknown>>
  extends ComponentPluginBase {
  readonly physics: {
    /** The ElementKind union member this plugin defines. Must match
     *  `id` exactly — the type system enforces this in
     *  `derivePhysicsPlugins` (M1.4). */
    readonly elementKind: string;

    /** PHY Editor tab routing. */
    readonly primaryDomain: ElementDomain;

    /** Physics solvers enabled by default for new instances of this
     *  kind. User can per-instance override. */
    readonly defaultPhysics: ReadonlyArray<PhysicsDomain>;

    readonly anchors: AnchorContract;
    readonly alignVariant: AlignVariant;
    /** Snap-to-beam tolerance in mm. 0 for `alignVariant: "none"`. */
    readonly alignToleranceMm: number;
    /** Plain-English one-liner shown in OpticalKindsEditor. */
    readonly alignSummary: string;

    /** Default kindParams written into new Components of this kind. */
    readonly defaultParams: TParams;

    // -------------------------------------------------------------------
    // Phase 2 additions — all optional and backwards-compatible.
    // -------------------------------------------------------------------

    /** Subset of `defaultParams` keys that are INTRINSIC: spec-sheet values
     *  that don't change unless the physical part is swapped (refractive
     *  index, acoustic velocity, amplifier gain, channel count …). The
     *  Object panel renders these read-only and the DB-level Phase-4 split
     *  uses this to migrate the column.
     *
     *  When omitted, the framework treats every key as state — matching
     *  pre-Phase-2 behaviour so existing plugins keep working unchanged. */
    readonly intrinsicParamKeys?: ReadonlyArray<keyof TParams & string>;

    /** Subset of `defaultParams` keys that are OPERATING STATE: knobs the
     *  user dials in during an experiment (Bragg tilt angle, HWP fast-axis
     *  angle, AD9959 per-channel frequency / amplitude). Renders editable
     *  in the Object panel; `intrinsicParamKeys` and `stateParamKeys`
     *  partition the kindParams space.
     *
     *  When omitted, falls back to "every key not in intrinsicParamKeys"
     *  if that's set, else "every key". */
    readonly stateParamKeys?: ReadonlyArray<keyof TParams & string>;

    /** Anchor-id → signal-domain map. Lets cross-domain kinds like AOM
     *  (which has rf_in + intercept_in/out) be precise about which anchor
     *  belongs to which link graph. Anchors not listed fall through to the
     *  panel's heuristic (rf_* → rf, intercept_* / fiber_* → optical). */
    readonly portDomains?: Readonly<Record<string, PortDomain>>;

    /** Phase 5 — plugin-level RF transfer function (pure traversal).
     *
     *  Optional. When set, the RF propagation walker
     *  (`utils/rfPropagation.ts`) calls this whenever a signal arrives at
     *  one of this kind's rf_in ports, and uses the returned outputs to
     *  fan out the BFS. See `RfTransfer` above for the contract.
     *
     *  This is the migration target for the existing
     *  `PASSTHROUGH_BY_KIND` registry in `rfPropagation.ts`: when a plugin
     *  declares its own transfer the walker prefers it over the central
     *  registry. New RF passthrough kinds (attenuator, filter, combiner,
     *  …) should be one-file changes: write the plugin, declare `rfTransfer`,
     *  done. No central registry edit. Same pattern the optical solver
     *  will migrate to as `solve_chain` is broken up in follow-on PRs.
     *
     *  Backend parity contract: every kind that declares a TS `rfTransfer`
     *  MUST register a Python sibling in
     *  `backend/app/solvers/rf_propagation.py` (PASSTHROUGH_BY_KIND).
     *  The frontend test `plugin_partition.test.ts > rfTransfer parity`
     *  surfaces drift. */
    readonly rfTransfer?: RfTransfer;
  };

  /** Optional kindParams inspector — shown in the PHY Editor right
   *  panel when a Component of this kind is selected. If absent, the
   *  editor renders a generic JSON-edit fallback. */
  readonly Inspector?: (props: {
    component: ComponentItem;
    params: TParams;
    onChange: (next: TParams) => void;
  }) => ReactElement;
}

/** Plugin for componentTypes that appear in the catalog but have no
 *  physics contract (mechanical mounts, posts, tool, annotations).
 *  These render via STL/primitive but are filtered out of the PHY
 *  Editor and the kind-contract registry. */
export interface PassivePlugin extends ComponentPluginBase {
  readonly physics?: undefined; // discriminator: absent
}

export type ComponentPlugin = PhysicsPlugin | PassivePlugin;

// =============================================================================
// Type helpers (consumers use these instead of importing the registry)
// =============================================================================

/** Predicate that narrows to physics-bearing plugins. */
export function isPhysicsPlugin(p: ComponentPlugin): p is PhysicsPlugin {
  return p.physics !== undefined;
}

/** Plugin author convenience: build a strongly-typed PhysicsPlugin. The
 *  TParams flows through so callers get type-safe defaultParams + Inspector.
 *  Example: `definePhysicsPlugin<AomParams>({ id: "aom", physics: {...} })` */
export function definePhysicsPlugin<TParams extends Record<string, unknown>>(
  plugin: PhysicsPlugin<TParams>,
): PhysicsPlugin<TParams> {
  return plugin;
}

/** Plugin author convenience: build a PassivePlugin (no physics). */
export function definePassivePlugin(plugin: PassivePlugin): PassivePlugin {
  return plugin;
}

// =============================================================================
// Phase 2 derived helpers — read intrinsic/state partitions for a plugin
// =============================================================================

/** Partition of a plugin's defaultParams keys into intrinsic (spec-sheet)
 *  and state (knob) sets. The contract:
 *
 *   - When BOTH intrinsicParamKeys + stateParamKeys are set on the plugin,
 *     they MUST partition the kindParams namespace cleanly. Anything in
 *     both is reported in `overlap`; anything in neither is in `unclassified`.
 *
 *   - When only ONE is set, the other is derived: all remaining keys go
 *     to whichever side is unset. So a plugin can opt in incrementally
 *     by marking just the intrinsics, and the framework defaults the rest
 *     to state.
 *
 *   - When NEITHER is set (the pre-Phase-2 case), every key is treated as
 *     state. Renders identically to today's behaviour.
 *
 *  Returns `string[]` sets so consumers don't have to fight TS narrowing
 *  on `keyof TParams`. Callers that want strong typing can cast. */
export function partitionKindParamKeys<TParams extends Record<string, unknown>>(
  plugin: PhysicsPlugin<TParams>,
): {
  intrinsic: readonly string[];
  state: readonly string[];
  overlap: readonly string[];
  unclassified: readonly string[];
} {
  const all = Object.keys(plugin.physics.defaultParams);
  const intrinsicSet = new Set<string>((plugin.physics.intrinsicParamKeys ?? []) as readonly string[]);
  const stateSet = new Set<string>((plugin.physics.stateParamKeys ?? []) as readonly string[]);
  const intrinsicGiven = plugin.physics.intrinsicParamKeys !== undefined;
  const stateGiven = plugin.physics.stateParamKeys !== undefined;

  if (!intrinsicGiven && !stateGiven) {
    // Legacy plugin: everything is state. (The Object panel renders it
    // editable, exactly as today.)
    return { intrinsic: [], state: all, overlap: [], unclassified: [] };
  }

  const overlap = all.filter((k) => intrinsicSet.has(k) && stateSet.has(k));
  let intrinsic: string[];
  let state: string[];
  let unclassified: string[];

  if (intrinsicGiven && !stateGiven) {
    intrinsic = all.filter((k) => intrinsicSet.has(k));
    state = all.filter((k) => !intrinsicSet.has(k));
    unclassified = [];
  } else if (!intrinsicGiven && stateGiven) {
    state = all.filter((k) => stateSet.has(k));
    intrinsic = all.filter((k) => !stateSet.has(k));
    unclassified = [];
  } else {
    intrinsic = all.filter((k) => intrinsicSet.has(k) && !stateSet.has(k));
    state = all.filter((k) => stateSet.has(k) && !intrinsicSet.has(k));
    unclassified = all.filter((k) => !intrinsicSet.has(k) && !stateSet.has(k));
  }

  return { intrinsic, state, overlap, unclassified };
}

/** Resolve a port's signal domain. Plugin-declared overrides win; otherwise
 *  apply the heuristic the link panels already use (rf_* → rf, intercept_*
 *  / fiber_* → optical). Returns null when the heuristic can't classify
 *  the anchor — caller can fall back to whatever default makes sense.
 *
 *  Generic on TParams so callers passing strongly-typed plugins
 *  (`PhysicsPlugin<AomParams>`) don't have to widen to
 *  `PhysicsPlugin<Record<string, unknown>>` first. */
export function resolvePortDomain<TParams extends Record<string, unknown>>(
  plugin: PhysicsPlugin<TParams>,
  anchorId: string,
): PortDomain | null {
  const explicit = plugin.physics.portDomains?.[anchorId];
  if (explicit) return explicit;
  if (anchorId === "rf_in" || anchorId === "rf_out") return "rf";
  if (anchorId.startsWith("intercept_") || anchorId.startsWith("fiber_")) return "optical";
  if (anchorId === "trigger_in" || anchorId === "trigger_out") return "trigger";
  if (anchorId.startsWith("ttl_") || anchorId === "gate_in") return "ttl";
  return null;
}
