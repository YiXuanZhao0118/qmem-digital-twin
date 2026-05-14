/**
 * Plugin registry — collects every ComponentPlugin into a single tuple
 * and exposes derive helpers so all hand-written tables (KIND_REGISTRY,
 * COMPONENT_TYPE_TO_KIND, KIND_LABELS, DEFAULT_KIND_PARAMS, KIND_GROUPS,
 * RF_DOMAIN_KINDS, AssetLibraryPanel's 5 category Sets) can be derived
 * from this one source instead of hand-maintained.
 *
 * M1 scope: 5 sample plugins (mirror / aom / rf_switch / fiber /
 * mirror_mount). The remaining 22 kinds still live in the old tables
 * (`_registry.ts` + `elementDefaults.ts`) until M2 migrates them. The
 * `verifyAlignment` function asserts the derived data matches the
 * existing tables for the 5 already-migrated kinds — runs at module
 * import in dev (`import.meta.env.DEV`) and is the early-warning
 * system for plugin authoring mistakes.
 */
import { aomPlugin } from "./aom";
import { fiberPlugin } from "./fiber";
import { mirrorPlugin } from "./mirror";
import { mirrorMountPlugin } from "./mirror_mount";
import { rfSwitchPlugin } from "./rf_switch";
import {
  isPhysicsPlugin,
  type AssetCategory,
  type ComponentPlugin,
  type ElementDomain,
  type PhysicsPlugin,
} from "./_plugin";

// =============================================================================
// The registry — order is stable, used for catalog list ordering when no
// `catalogGroup` is specified.
// =============================================================================

// Each plugin file keeps its strong-typed PhysicsPlugin<Params>; the
// registry stores them under the type-erased base. TParams appears in
// both covariant (defaultParams) and contravariant (Inspector args)
// positions, so PhysicsPlugin<T> is invariant in T — we need a single
// explicit widening here to collapse the union. Consumers use the
// `pluginForKind` helper, which can re-narrow if needed.
export const PLUGINS: readonly ComponentPlugin[] = [
  mirrorPlugin,
  aomPlugin,
  rfSwitchPlugin,
  fiberPlugin,
  mirrorMountPlugin,
] as readonly ComponentPlugin[];

export type AnyPlugin = ComponentPlugin;

// =============================================================================
// Derive helpers — every existing hand-written table has a counterpart
// here. Consumers (M3) will swap their imports from elementDefaults /
// _registry to these functions.
// =============================================================================

/** Subset of PLUGINS that have a physics contract (excludes PassivePlugin). */
export function physicsPlugins(): readonly PhysicsPlugin[] {
  return PLUGINS.filter(isPhysicsPlugin);
}

/** All componentType strings handled by any plugin — replaces the union
 *  of OPTICAL_TYPES / ELECTRONICS_TYPES / MECHANICAL_TYPES sets in
 *  AssetLibraryPanel.tsx once M2 covers every plugin. */
export function knownComponentTypes(): readonly string[] {
  return PLUGINS.flatMap((p) => p.componentTypes);
}

/** componentType → plugin (M-to-1; multiple componentTypes can share a
 *  plugin, e.g. `laser` and `laser_source` both → laserSourcePlugin). */
export function pluginForComponentType(componentType: string): ComponentPlugin | null {
  const trimmed = componentType.trim();
  for (const p of PLUGINS) {
    if (p.componentTypes.includes(trimmed)) return p;
  }
  return null;
}

/** ElementKind → plugin (1-to-1 for physics plugins). */
export function pluginForKind(kind: string): PhysicsPlugin | null {
  for (const p of physicsPlugins()) {
    if (p.physics.elementKind === kind) return p;
  }
  return null;
}

/** Replaces `COMPONENT_TYPE_TO_KIND` (elementDefaults.ts:11). */
export function derivedComponentTypeToKind(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of physicsPlugins()) {
    for (const ct of p.componentTypes) {
      out[ct] = p.physics.elementKind;
    }
  }
  return out;
}

/** Replaces `KIND_LABELS` (elementDefaults.ts:63). */
export function derivedKindLabels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of physicsPlugins()) {
    out[p.physics.elementKind] = p.displayName;
  }
  return out;
}

/** Replaces `DEFAULT_KIND_PARAMS` (elementDefaults.ts:152). */
export function derivedDefaultKindParams(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const p of physicsPlugins()) {
    out[p.physics.elementKind] = p.physics.defaultParams;
  }
  return out;
}

/** Replaces `RF_DOMAIN_KINDS` (elementDefaults.ts:102). */
export function derivedRfDomainKinds(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const p of physicsPlugins()) {
    if (p.physics.primaryDomain === "rf") out.add(p.physics.elementKind);
  }
  return out;
}

/** Replaces the 5 hand-written Sets at the top of AssetLibraryPanel.tsx:
 *  OPTICAL_TYPES / ELECTRONICS_TYPES / MECHANICAL_TYPES /
 *  INFRASTRUCTURE_TYPES / MISC_TYPES. Returns a `Record<AssetCategory,
 *  Set<componentType>>` so consumers can `category[type]` lookup. */
export function derivedCategoryToComponentTypes(): Record<AssetCategory, ReadonlySet<string>> {
  const out: Record<AssetCategory, Set<string>> = {
    optical: new Set(),
    electronics: new Set(),
    mechanical: new Set(),
    infrastructure: new Set(),
    misc: new Set(),
  };
  for (const p of PLUGINS) {
    for (const ct of p.componentTypes) {
      out[p.assetCategory].add(ct);
    }
  }
  return out;
}

/** Replaces `KIND_GROUPS` (elementDefaults.ts:120) — kind organisation
 *  inside the Components panel's grouping ("Emitters" / "Passive" /
 *  "Active / Nonlinear" / "Sinks" / "RF"). Plugins without a
 *  `catalogGroup` fall under the category root. */
export function derivedKindGroups(): { label: string; kinds: string[] }[] {
  const byLabel = new Map<string, string[]>();
  for (const p of physicsPlugins()) {
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
  // Identical to frontend mapping by design — keep separate function
  // signature so M4 can swap the implementation to JSON-load from a
  // generated artifact.
  return derivedComponentTypeToKind();
}

// =============================================================================
// Dev-time alignment check — fires at module import in dev builds. If a
// plugin gets the elementKind / displayName / defaultParams / etc. wrong,
// the dev sees a console error pointing at exactly which kind and field
// is misaligned. M1's safety net before we replace the old tables.
// =============================================================================

interface AlignmentReport {
  ok: boolean;
  errors: string[];
}

export function verifyAlignment(
  oldKindRegistry: Record<string, { kind: string; displayName: string; requiredAnchors: readonly string[] }>,
  oldKindLabels: Record<string, string>,
  oldDefaultKindParams: Record<string, Record<string, unknown>>,
  /** Lookup function rather than a map so callers can pass
   *  `componentTypeToElementKind` from elementDefaults.ts directly
   *  (the map itself is non-exported). */
  lookupOldKind: (componentType: string) => string | null,
): AlignmentReport {
  const errors: string[] = [];

  for (const p of physicsPlugins()) {
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
      // M2 derives both from the plugin and the drift disappears.
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

// Exported types for downstream consumers (kept tight — most should
// import from `_plugin.ts` directly).
export type { AssetCategory, ElementDomain, PhysicsPlugin };
