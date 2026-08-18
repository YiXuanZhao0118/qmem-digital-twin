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
    // Per-role anchor spec (RF_ARCHITECTURE_PLAN §2.1). `null` for kinds that
    // still author the legacy `anchors` arrays directly (optical / mechanical
    // — converted in a later phase). `max`: 1 = single, N = bounded, null =
    // unbounded multiport.
    roles: Record<string, ManifestRoleSpec> | null;
    // Phase 2 / 3 additions. Always emitted (even when the plugin author
    // didn't supply intrinsic/state lists) so the backend can detect
    // un-migrated kinds by `intrinsic_param_keys === null` and fall back
    // to "treat every key as state" (the pre-Phase-2 behaviour).
    intrinsic_param_keys: string[] | null;
    state_param_keys: string[] | null;
    port_domains: Record<string, string>;
  };
}

interface ManifestRoleSpec {
  min: number;
  max: number | null; // 1 = single, N = bounded, null = unbounded
  domain: string;
  direction?: boolean;
  aperture?: boolean;
  fast_axis?: boolean;
}

interface ManifestDeviceAnchor {
  role: string;
  name?: string;
  position_mm_body_local?: { x: number; y: number; z: number };
  direction_body_local?: { x: number; y: number; z: number };
  axis_y_body_local?: { x: number; y: number; z: number };
  connector_type?: string;
  aperture_mm?: number;
  aperture_shape?: string;
  aperture_width_mm?: number;
  aperture_height_mm?: number;
}

interface ManifestDevice {
  id: string;
  display_name: string;
  behavioral_kind: string | null;
  component_type: string;
  mesh: string;
  anchors: ManifestDeviceAnchor[];
  default_params: Record<string, unknown>;
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
  /** Device registry (RF_ARCHITECTURE_PLAN §2.2). Concrete instruments;
   *  each pins a `behavioral_kind` and supplies the per-componentType anchor
   *  layout that used to live in the plugin's `componentAnchorContracts`. */
  devices: ManifestDevice[];
}

/** Build a per-role manifest spec from the plugin's authored RoleSpec.
 *  Normalises `max`: omitted → 1 (single), null → unbounded, N → bounded. */
function roleSpecToManifest(spec: any): ManifestRoleSpec {
  return {
    min: spec.min,
    max: spec.max === undefined ? 1 : spec.max,
    domain: spec.domain,
    ...(spec.direction ? { direction: true } : {}),
    ...(spec.aperture ? { aperture: true } : {}),
    ...(spec.fastAxis ? { fast_axis: true } : {}),
  };
}

function deviceAnchorToManifest(a: any): ManifestDeviceAnchor {
  return {
    role: a.role,
    ...(a.name !== undefined ? { name: a.name } : {}),
    ...(a.positionMmBodyLocal !== undefined
      ? { position_mm_body_local: a.positionMmBodyLocal }
      : {}),
    ...(a.directionBodyLocal !== undefined
      ? { direction_body_local: a.directionBodyLocal }
      : {}),
    ...(a.axisYBodyLocal !== undefined
      ? { axis_y_body_local: a.axisYBodyLocal }
      : {}),
    ...(a.connectorType !== undefined ? { connector_type: a.connectorType } : {}),
    ...(a.apertureMm !== undefined ? { aperture_mm: a.apertureMm } : {}),
    ...(a.apertureShape !== undefined ? { aperture_shape: a.apertureShape } : {}),
    ...(a.apertureWidthMm !== undefined
      ? { aperture_width_mm: a.apertureWidthMm }
      : {}),
    ...(a.apertureHeightMm !== undefined
      ? { aperture_height_mm: a.apertureHeightMm }
      : {}),
  };
}

function build(
  plugins: readonly unknown[],
  isPhysics: (plugin: unknown) => boolean,
  devices: readonly unknown[],
): Manifest {
  const physics: ManifestPhysicsPlugin[] = [];
  const passive: ManifestPassivePlugin[] = [];
  const componentTypeToKind: Record<string, string> = {};
  const elementKinds: string[] = [];
  const componentAnchorContracts: Record<string, ManifestAnchorTemplate[]> = {};
  const deviceRecords: ManifestDevice[] = [];

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
          roles: p.physics.roles
            ? Object.fromEntries(
                Object.entries(p.physics.roles).map(([role, spec]) => [
                  role,
                  roleSpecToManifest(spec),
                ]),
              )
            : null,
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

  // Device registry: emit each device into the `devices[]` block (keyed by the
  // unique device id — that's what the seeder reads via `device_by_id`).
  //
  // Additionally materialise the anchor layout into `component_anchor_contracts`
  // ONLY for devices whose `componentType` is a DISTINCT catalog part-form
  // (componentType !== behavioralKind, e.g. `dds_ad9959_pcb` vs kind
  // `rf_source`). That map is keyed by componentType and drives the PHY Editor's
  // "lock anchor identity" feature; it MUST NOT be keyed off the generic kind
  // componentType (e.g. `mirror`, `rf_amplifier`) because many devices share one
  // kind and would collide/overwrite. Generic-form devices live only in
  // `devices[]`; their anchors are still seedable, just not anchor-locked.
  for (const dUnknown of devices) {
    const d = dUnknown as any;
    deviceRecords.push({
      id: d.id,
      display_name: d.displayName,
      behavioral_kind: d.behavioralKind ?? null,
      component_type: d.componentType,
      mesh: d.mesh,
      anchors: (d.anchors as any[]).map(deviceAnchorToManifest),
      default_params: { ...(d.defaultParams ?? {}) },
    });
    // An anchorless device (the render-only mechanical fixtures, whose
    // behavioralKind is null so componentType can never equal it) would
    // otherwise write an empty contract over the key — inert today, but it
    // would silently clobber a real template later. Skip those.
    if (d.componentType !== d.behavioralKind && (d.anchors as any[]).length) {
      componentAnchorContracts[d.componentType] = (d.anchors as any[]).map((a) => ({
        id: a.role,
        ...(a.name !== undefined ? { name: a.name } : {}),
        ...(a.positionMmBodyLocal !== undefined
          ? { position_mm_body_local: a.positionMmBodyLocal }
          : {}),
        ...(a.directionBodyLocal !== undefined
          ? { direction_body_local: a.directionBodyLocal }
          : {}),
      }));
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
    devices: deviceRecords,
  };
}

async function main(): Promise<void> {
  const [{ PLUGINS }, { isPhysicsPlugin }, { DEVICES }] = await Promise.all([
    import("../frontend/src/kinds/_plugins"),
    import("../frontend/src/kinds/_plugin"),
    import("../frontend/src/devices/_registry"),
  ]);

  const manifest = build(
    PLUGINS,
    isPhysicsPlugin as (plugin: unknown) => boolean,
    DEVICES,
  );
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

  const physicsCount = manifest.physics_plugins.length;
  const passiveCount = manifest.passive_plugins.length;
  console.log(
  `wrote ${OUT_PATH}\n  ${physicsCount} physics + ${passiveCount} passive plugins\n  ${manifest.devices.length} devices\n  ${Object.keys(manifest.component_type_to_kind).length} componentType → kind entries`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
