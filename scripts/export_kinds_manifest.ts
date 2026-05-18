/**
 * Export kind metadata from the frontend PhysicsPlugin / PassivePlugin
 * registry to a JSON manifest the backend reads at import time.
 *
 * Run from repo root:
 *     cd frontend && npx tsx ../scripts/export_kinds_manifest.ts
 *
 * Or via npm script:
 *     cd frontend && npm run export:kinds
 *
 * Output:
 *     backend/data/kinds.json
 *
 * Idempotent — the file is overwritten every run. Add it to git so
 * fresh checkouts have the file before the seed runs (M5's
 * `make data-bootstrap` runs this as step 1).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (typeof globalThis.ProgressEvent === "undefined") {
  class NodeProgressEvent extends Event {
    readonly lengthComputable: boolean;
    readonly loaded: number;
    readonly total: number;

    constructor(type: string, init: ProgressEventInit = {}) {
      super(type);
      this.lengthComputable = init.lengthComputable ?? false;
      this.loaded = init.loaded ?? 0;
      this.total = init.total ?? 0;
    }
  }

  (globalThis as unknown as { ProgressEvent: typeof ProgressEvent }).ProgressEvent =
    NodeProgressEvent as typeof ProgressEvent;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, "..", "backend", "data", "kinds.json");

interface ManifestPhysicsPlugin {
  id: string;
  display_name: string;
  component_types: string[];
  asset_category: string;
  catalog_group: string | null;
  asset_name_pattern: string | null;
  physics: {
    element_kind: string;
    primary_domain: "optical" | "rf";
    default_physics: string[];
    anchors: {
      required: string[];
      optional: string[];
      needs_direction: string[];
      needs_aperture: string[];
    };
    align_variant: string;
    align_tolerance_mm: number;
    align_summary: string;
    default_params: Record<string, unknown>;
    // Phase 2 / 3 additions. Always emitted (even when the plugin author
    // didn't supply intrinsic/state lists) so the backend can detect
    // un-migrated kinds by `intrinsic_param_keys === null` and fall back
    // to "treat every key as state" (the pre-Phase-2 behaviour).
    intrinsic_param_keys: string[] | null;
    state_param_keys: string[] | null;
    port_domains: Record<string, string>;
  };
}

interface ManifestPassivePlugin {
  id: string;
  display_name: string;
  component_types: string[];
  asset_category: string;
  catalog_group: string | null;
  asset_name_pattern: string | null;
}

interface ManifestAnchorTemplate {
  id: string;
  name?: string;
  position_mm_body_local?: { x: number; y: number; z: number };
  direction_body_local?: { x: number; y: number; z: number };
}

interface Manifest {
  schema_version: 1;
  generated_at: string;
  /** Convenience flat list: componentType → ElementKind (the legacy
   *  OPTICAL_COMPONENT_TYPE_TO_KIND in components.py reads this). */
  component_type_to_kind: Record<string, string>;
  /** ElementKind values declared by physics plugins (Pydantic Literal
   *  uses this to validate incoming `kind` strings). */
  element_kinds: string[];
  /** Per-componentType anchor templates (Stage H, single source of
   *  truth). Backend reads via ``kinds_manifest.component_anchor_contracts()``
   *  to drive PHY-Editor "lock anchor identity"; was previously
   *  duplicated in ``anchor_contracts.py`` + ``componentAnchorContracts.ts``. */
  component_anchor_contracts: Record<string, ManifestAnchorTemplate[]>;
  physics_plugins: ManifestPhysicsPlugin[];
  passive_plugins: ManifestPassivePlugin[];
}

function build(
  plugins: readonly unknown[],
  isPhysics: (plugin: unknown) => boolean,
): Manifest {
  const physics: ManifestPhysicsPlugin[] = [];
  const passive: ManifestPassivePlugin[] = [];
  const componentTypeToKind: Record<string, string> = {};
  const elementKinds: string[] = [];
  const componentAnchorContracts: Record<string, ManifestAnchorTemplate[]> = {};

  for (const pUnknown of plugins) {
    const p = pUnknown as any;
    // Pull componentAnchorContracts off every plugin (physics + passive).
    // The map's key (componentType) is unique across the registry, so we
    // can safely flatten into one top-level dict — Pydantic / Python
    // consumers don't need to know which plugin owns which entry.
    if (p.componentAnchorContracts) {
      for (const [ct, templates] of Object.entries(p.componentAnchorContracts)) {
        componentAnchorContracts[ct] = (templates as any[]).map((t) => ({
          id: t.id,
          ...(t.name !== undefined ? { name: t.name } : {}),
          ...(t.positionMmBodyLocal !== undefined
            ? { position_mm_body_local: t.positionMmBodyLocal }
            : {}),
          ...(t.directionBodyLocal !== undefined
            ? { direction_body_local: t.directionBodyLocal }
            : {}),
        }));
      }
    }
    if (isPhysics(pUnknown)) {
      const ek = p.physics.elementKind;
      elementKinds.push(ek);
      for (const ct of p.componentTypes) componentTypeToKind[ct] = ek;
      physics.push({
        id: p.id,
        display_name: p.displayName,
        component_types: [...p.componentTypes],
        asset_category: p.assetCategory,
        catalog_group: p.catalogGroup ?? null,
        asset_name_pattern: p.assetNamePattern ?? null,
        physics: {
          element_kind: ek,
          primary_domain: p.physics.primaryDomain,
          default_physics: [...p.physics.defaultPhysics],
          anchors: {
            required: [...p.physics.anchors.required],
            optional: [...p.physics.anchors.optional],
            needs_direction: [...p.physics.anchors.needsDirection],
            needs_aperture: [...(p.physics.anchors.needsAperture ?? [])],
          },
          align_variant: p.physics.alignVariant,
          align_tolerance_mm: p.physics.alignToleranceMm,
          align_summary: p.physics.alignSummary,
          default_params: p.physics.defaultParams,
          intrinsic_param_keys: p.physics.intrinsicParamKeys
            ? [...p.physics.intrinsicParamKeys]
            : null,
          state_param_keys: p.physics.stateParamKeys
            ? [...p.physics.stateParamKeys]
            : null,
          port_domains: { ...(p.physics.portDomains ?? {}) },
        },
      });
    } else {
      passive.push({
        id: p.id,
        display_name: p.displayName,
        component_types: [...p.componentTypes],
        asset_category: p.assetCategory,
        catalog_group: p.catalogGroup ?? null,
        asset_name_pattern: p.assetNamePattern ?? null,
      });
    }
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    component_type_to_kind: componentTypeToKind,
    element_kinds: elementKinds,
    component_anchor_contracts: componentAnchorContracts,
    physics_plugins: physics,
    passive_plugins: passive,
  };
}

async function main(): Promise<void> {
  const [{ PLUGINS }, { isPhysicsPlugin }] = await Promise.all([
    import("../frontend/src/kinds/_plugins"),
    import("../frontend/src/kinds/_plugin"),
  ]);

  const manifest = build(PLUGINS, isPhysicsPlugin as (plugin: unknown) => boolean);
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

  const physicsCount = manifest.physics_plugins.length;
  const passiveCount = manifest.passive_plugins.length;
  console.log(
  `wrote ${OUT_PATH}\n  ${physicsCount} physics + ${passiveCount} passive plugins\n  ${Object.keys(manifest.component_type_to_kind).length} componentType → kind entries`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
