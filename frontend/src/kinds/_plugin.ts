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

import type { ComponentItem, DeviceState } from "../types/digitalTwin";
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
