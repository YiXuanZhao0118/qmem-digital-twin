/**
 * Plugin registry — single source of truth for every ComponentPlugin
 * in the digital twin. Replaces the 8+ hand-maintained tables that the
 * pre-P2 codebase scattered across `_registry.ts`, `elementDefaults.ts`,
 * `AssetLibraryPanel.tsx`, and the backend `components.py`.
 *
 * Source-of-truth contract:
 *   - `PHYSICS_PLUGINS` declares every ElementKind exactly once.
 *   - `PASSIVE_PLUGINS` declares every catalog-only componentType.
 *   - `PLUGINS` is the union; consumers iterate this.
 *   - Derive helpers below project the registry into the shapes the
 *     legacy consumers expect (KIND_LABELS-shaped Record, KIND_GROUPS,
 *     RF_DOMAIN_KINDS set, AssetCategory→Set map, etc).
 *
 * After M3 lands, all `import { … } from "../utils/elementDefaults"`
 * and `import { … } from "./_registry"` calls flip to importing from
 * here, and the legacy tables get deleted.
 */
// Physics plugins — every ElementKind member.
import { aomPlugin } from "./aom";
import { beamDumpPlugin } from "./beam_dump";
import { beamSplitterPlugin } from "./beam_splitter";
import { cameraPlugin } from "./camera";
import { detectorPlugin } from "./detector";
import { dichroicMirrorPlugin } from "./dichroic_mirror";
import { eomPlugin } from "./eom";
import { fiberPlugin } from "./fiber";
import { fiberCouplerPlugin } from "./fiber_coupler";
import { hornAntennaPlugin } from "./horn_antenna";
import { isolatorPlugin } from "./isolator";
import { laserSourcePlugin } from "./laser_source";
import { lensBiconvexPlugin } from "./lens_biconvex";
import { lensCylindricalPlugin } from "./lens_cylindrical";
import { lensPlanoConvexPlugin } from "./lens_plano_convex";
import { mirrorPlugin } from "./mirror";
import { mirrorMountPlugin } from "./mirror_mount";
import { nonlinearCrystalPlugin } from "./nonlinear_crystal";
import { polarizerPlugin } from "./polarizer";
import { rfAmplifierPlugin } from "./rf_amplifier";
import { rfCablePlugin } from "./rf_cable";
import { rfSourcePlugin } from "./rf_source";
import { rfSwitchPlugin } from "./rf_switch";
import { saturableAbsorberPlugin } from "./saturable_absorber";
import { spectrometerPlugin } from "./spectrometer";
import { taperedAmplifierPlugin } from "./tapered_amplifier";
import { wavemeterPlugin } from "./wavemeter";
import { waveplatePlugin } from "./waveplate";

// Passive plugins — catalog componentTypes without an ElementKind.
import { PASSIVE_PLUGINS } from "./_passive_plugins";

// Per-componentType renderer bindings — M6 binds renderers without
// modifying every plugin's index.ts.
import { withRenderer } from "./_renderer_bindings";

import {
  isPhysicsPlugin,
  type AssetCategory,
  type ComponentPlugin,
  type ElementDomain,
  type PhysicsPlugin,
} from "./_plugin";

// =============================================================================
// Registries — order is stable; consumers should not rely on it but
// snapshot tests do.
// =============================================================================

/** Every physics-bearing plugin. One per ElementKind (27 entries). */
export const PHYSICS_PLUGINS: readonly PhysicsPlugin[] = [
  // Emitters
  laserSourcePlugin,
  taperedAmplifierPlugin,
  // Passive optical
  mirrorPlugin,
  dichroicMirrorPlugin,
  lensBiconvexPlugin,
  lensPlanoConvexPlugin,
  lensCylindricalPlugin,
  waveplatePlugin,
  polarizerPlugin,
  beamSplitterPlugin,
  fiberCouplerPlugin,
  fiberPlugin,
  isolatorPlugin,
  // Active / nonlinear optical
  aomPlugin,
  eomPlugin,
  nonlinearCrystalPlugin,
  saturableAbsorberPlugin,
  // Sinks
  detectorPlugin,
  cameraPlugin,
  spectrometerPlugin,
  wavemeterPlugin,
  beamDumpPlugin,
  // RF / Electronics
  rfSourcePlugin,
  rfAmplifierPlugin,
  hornAntennaPlugin,
  rfCablePlugin,
  rfSwitchPlugin,
] as unknown as readonly PhysicsPlugin[];

/** Every plugin (physics + passive), each wrapped with its renderer
 *  binding from `_renderer_bindings.ts`. Plugins that already declare
 *  `renderer` in their own file pass through unchanged. */
export const PLUGINS: readonly ComponentPlugin[] = [
  ...PHYSICS_PLUGINS,
  mirrorMountPlugin, // physics-flagged passive; lives in mirror_mount/
  ...PASSIVE_PLUGINS,
].map(withRenderer) as readonly ComponentPlugin[];

export type AnyPlugin = ComponentPlugin;

// =============================================================================
// Helpers — query the registry
// =============================================================================

export function physicsPlugins(): readonly PhysicsPlugin[] {
  return PHYSICS_PLUGINS;
}

export function knownComponentTypes(): readonly string[] {
  return PLUGINS.flatMap((p) => p.componentTypes);
}

export function pluginForComponentType(componentType: string): ComponentPlugin | null {
  const trimmed = componentType.trim();
  for (const p of PLUGINS) {
    if (p.componentTypes.includes(trimmed)) return p;
  }
  return null;
}

export function pluginForKind(kind: string): PhysicsPlugin | null {
  for (const p of PHYSICS_PLUGINS) {
    if (p.physics.elementKind === kind) return p;
  }
  return null;
}

// =============================================================================
// Derive helpers — every legacy hand-written table has a counterpart
// here. M3 swaps consumer imports to use these instead of the
// elementDefaults / _registry sources.
// =============================================================================

/** Replaces `COMPONENT_TYPE_TO_KIND` (elementDefaults.ts:11). */
export function derivedComponentTypeToKind(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of PHYSICS_PLUGINS) {
    for (const ct of p.componentTypes) out[ct] = p.physics.elementKind;
  }
  return out;
}

/** Replaces `KIND_LABELS` (elementDefaults.ts:63). */
export function derivedKindLabels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of PHYSICS_PLUGINS) out[p.physics.elementKind] = p.displayName;
  return out;
}

/** Replaces `DEFAULT_KIND_PARAMS` (elementDefaults.ts:152). */
export function derivedDefaultKindParams(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const p of PHYSICS_PLUGINS) out[p.physics.elementKind] = p.physics.defaultParams;
  return out;
}

/** Replaces `RF_DOMAIN_KINDS` (elementDefaults.ts:102). */
export function derivedRfDomainKinds(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const p of PHYSICS_PLUGINS) {
    if (p.physics.primaryDomain === "rf") out.add(p.physics.elementKind);
  }
  return out;
}

/** Replaces the 5 hand-written Sets at the top of AssetLibraryPanel.tsx:
 *  OPTICAL_TYPES / ELECTRONICS_TYPES / MECHANICAL_TYPES /
 *  INFRASTRUCTURE_TYPES / MISC_TYPES. */
export function derivedCategoryToComponentTypes(): Record<AssetCategory, ReadonlySet<string>> {
  const out: Record<AssetCategory, Set<string>> = {
    optical: new Set(),
    electronics: new Set(),
    mechanical: new Set(),
    infrastructure: new Set(),
    misc: new Set(),
  };
  for (const p of PLUGINS) {
    for (const ct of p.componentTypes) out[p.assetCategory].add(ct);
  }
  return out;
}

/** Replaces `KIND_GROUPS` (elementDefaults.ts:120). */
export function derivedKindGroups(): { label: string; kinds: string[] }[] {
  const byLabel = new Map<string, string[]>();
  for (const p of PHYSICS_PLUGINS) {
    const label = p.catalogGroup ?? "Other";
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(p.physics.elementKind);
    else byLabel.set(label, [p.physics.elementKind]);
  }
  return [...byLabel.entries()].map(([label, kinds]) => ({ label, kinds }));
}

/** Replaces backend `OPTICAL_COMPONENT_TYPE_TO_KIND`
 *  (components.py:54). M4 emits this via openapi codegen so backend
 *  and frontend share the same table. */
export function derivedBackendComponentTypeToKind(): Record<string, string> {
  return derivedComponentTypeToKind();
}

/** Replaces `KIND_REGISTRY` (kinds/_registry.ts:132). Builds the
 *  legacy `KindContract`-shaped record from plugins so existing
 *  consumers (OpticalComponentEditor, OpticalKindsEditor,
 *  componentAnchorContracts, getKindContract, kindsWithEditableAnchors)
 *  keep working unmodified. M3 swaps the legacy export to delegate to
 *  this function. */
export function derivedKindRegistry(): Record<
  string,
  {
    kind: string;
    displayName: string;
    requiredAnchors: readonly string[];
    optionalAnchors: readonly string[];
    anchorsNeedingDirection: readonly string[];
    anchorsNeedingAperture?: readonly string[];
    alignVariant: string;
    alignToleranceMm: number;
    alignSummary: string;
  }
> {
  const out: Record<string, ReturnType<typeof derivedKindRegistry>[string]> = {};
  for (const p of PHYSICS_PLUGINS) {
    out[p.physics.elementKind] = {
      kind: p.physics.elementKind,
      displayName: p.displayName,
      requiredAnchors: p.physics.anchors.required,
      optionalAnchors: p.physics.anchors.optional,
      anchorsNeedingDirection: p.physics.anchors.needsDirection,
      anchorsNeedingAperture: p.physics.anchors.needsAperture,
      alignVariant: p.physics.alignVariant,
      alignToleranceMm: p.physics.alignToleranceMm,
      alignSummary: p.physics.alignSummary,
    };
  }
  return out;
}

// =============================================================================
// Dev-time alignment check — verifies every migrated plugin matches the
// legacy table for fields we care about. Runs as a vitest test (see
// __tests__/plugin_alignment.test.ts).
// =============================================================================

interface AlignmentReport {
  ok: boolean;
  errors: string[];
}

export function verifyAlignment(
  oldKindRegistry: Record<
    string,
    { kind: string; displayName: string; requiredAnchors: readonly string[] }
  >,
  oldKindLabels: Record<string, string>,
  oldDefaultKindParams: Record<string, Record<string, unknown>>,
  /** Lookup function rather than a map so callers can pass
   *  `componentTypeToElementKind` from elementDefaults.ts directly
   *  (the map itself is non-exported). */
  lookupOldKind: (componentType: string) => string | null,
): AlignmentReport {
  const errors: string[] = [];

  for (const p of PHYSICS_PLUGINS) {
    const k = p.physics.elementKind;

    if (p.id !== k) {
      errors.push(`[${p.id}] plugin id !== physics.elementKind (${p.id} vs ${k})`);
    }

    const oldEntry = oldKindRegistry[k];
    if (!oldEntry) {
      errors.push(`[${k}] missing from old KIND_REGISTRY`);
    } else {
      // KIND_REGISTRY.displayName drifts from KIND_LABELS for some kinds
      // (e.g. aom registry has "AOM (Acousto-Optic Modulator)" but
      // KIND_LABELS has "AOM" — both are "legacy" so M1 alignment only
      // checks against KIND_LABELS, which is the user-facing canonical.
      // M3 derives both from the plugin and the drift disappears.
      const oldReq = JSON.stringify([...oldEntry.requiredAnchors].sort());
      const newReq = JSON.stringify([...p.physics.anchors.required].sort());
      if (oldReq !== newReq) {
        errors.push(`[${k}] requiredAnchors drift: plugin=${newReq} vs old=${oldReq}`);
      }
    }

    if (oldKindLabels[k] !== p.displayName) {
      errors.push(
        `[${k}] KIND_LABELS drift: plugin="${p.displayName}" vs old="${oldKindLabels[k]}"`,
      );
    }

    if (!oldDefaultKindParams[k]) {
      errors.push(`[${k}] missing from old DEFAULT_KIND_PARAMS`);
    } else {
      const oldKeys = Object.keys(oldDefaultKindParams[k]).sort();
      const newKeys = Object.keys(p.physics.defaultParams).sort();
      if (JSON.stringify(oldKeys) !== JSON.stringify(newKeys)) {
        errors.push(
          `[${k}] defaultParams key drift:\n    plugin=${JSON.stringify(newKeys)}\n    old=   ${JSON.stringify(oldKeys)}`,
        );
      }
    }

    for (const ct of p.componentTypes) {
      const oldKind = lookupOldKind(ct);
      if (oldKind && oldKind !== k) {
        errors.push(
          `[${k}] componentType "${ct}" maps to "${oldKind}" in legacy lookup, plugin says "${k}"`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export type { AssetCategory, ElementDomain, PhysicsPlugin };
