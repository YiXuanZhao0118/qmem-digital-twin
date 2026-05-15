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

import { PLUGINS } from "../frontend/src/kinds/_plugins";
import { isPhysicsPlugin } from "../frontend/src/kinds/_plugin";

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

interface Manifest {
  schema_version: 1;
  generated_at: string;
  /** Convenience flat list: componentType → ElementKind (the legacy
   *  OPTICAL_COMPONENT_TYPE_TO_KIND in components.py reads this). */
  component_type_to_kind: Record<string, string>;
  /** ElementKind values declared by physics plugins (Pydantic Literal
   *  uses this to validate incoming `kind` strings). */
  element_kinds: string[];
  physics_plugins: ManifestPhysicsPlugin[];
  passive_plugins: ManifestPassivePlugin[];
}

function build(): Manifest {
  const physics: ManifestPhysicsPlugin[] = [];
  const passive: ManifestPassivePlugin[] = [];
  const componentTypeToKind: Record<string, string> = {};
  const elementKinds: string[] = [];

  for (const p of PLUGINS) {
    if (isPhysicsPlugin(p)) {
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
    physics_plugins: physics,
    passive_plugins: passive,
  };
}

const manifest = build();
mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

const physicsCount = manifest.physics_plugins.length;
const passiveCount = manifest.passive_plugins.length;
console.log(
  `wrote ${OUT_PATH}\n  ${physicsCount} physics + ${passiveCount} passive plugins\n  ${Object.keys(manifest.component_type_to_kind).length} componentType → kind entries`,
);
