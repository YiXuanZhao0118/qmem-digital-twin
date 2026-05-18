/**
 * Per-component-type anchor contracts — frontend accessor.
 *
 * Stage H consolidated the contract data into the kinds plugin
 * definitions (``frontend/src/kinds/<id>/index.ts``'s
 * ``componentAnchorContracts`` field). This module is now a thin
 * reader that flattens every plugin's contracts into a single lookup
 * table and surfaces the PHY-Editor helpers on top.
 *
 * The backend reads the SAME data via
 * ``backend/data/kinds.json::component_anchor_contracts`` (exported by
 * ``scripts/export_kinds_manifest.ts``), so adding a new fixed-port
 * chip is now a one-file change in the plugin — no more "keep both in
 * sync" foot-gun.
 *
 * Two registries combine into the unified anchor contract that the PHY
 * Editor uses to LOCK anchor identity:
 *
 *   1. COMPONENT_ANCHOR_CONTRACTS — per-component-type override (the
 *      plugin-declared templates). Needed when a single ElementKind
 *      covers devices with different physical port layouts (e.g.
 *      ``rf_source`` covers both single-channel synths and the
 *      4-channel AD9959 DDS, which has 4 SMA ports distinguished by
 *      ``name``, not ``id``).
 *
 *   2. KIND_REGISTRY (already exists, in ``kinds/_registry.ts``):
 *      per-ElementKind contract listing requiredAnchors +
 *      optionalAnchors by id only. Used as fallback when a
 *      component_type has no entry in (1).
 *
 * ``getAnchorContractFor(componentType)`` returns a flat list of
 * AnchorTemplate entries; the PHY Editor uses this list to:
 *   - auto-create missing anchors on selection (so the user always sees
 *     the full port set, never a "no anchors yet" empty list)
 *   - hide the "+ Add" / "Delete" buttons and the id ``<select>``
 *     (anchor identity is locked at the contract level)
 *   - keep position / direction inputs enabled (the user still drags
 *     each port onto the real STL geometry).
 */

import type { AnchorId } from "../kinds/_registry";
import { KIND_REGISTRY } from "../kinds/_registry";
import { PLUGINS } from "../kinds/_plugins";
import type { ComponentAnchorTemplate } from "../kinds/_plugin";
import type { ElementKind } from "../types/digitalTwin";
import { componentTypeToElementKind } from "../utils/elementDefaults";


export type AnchorTemplate = {
  id: AnchorId;
  name?: string;
  positionMmBodyLocal?: { x: number; y: number; z: number };
  directionBodyLocal?: { x: number; y: number; z: number };
};


/** Flat ``componentType → AnchorTemplate[]`` map collected from every
 *  plugin's ``componentAnchorContracts`` field. Built once at module
 *  load — adding a new plugin contract takes effect on next bundle. */
export const COMPONENT_ANCHOR_CONTRACTS: Readonly<Record<string, AnchorTemplate[]>> =
  (() => {
    const out: Record<string, AnchorTemplate[]> = {};
    for (const plugin of PLUGINS) {
      const contracts = (plugin as { componentAnchorContracts?: Readonly<Record<string, readonly ComponentAnchorTemplate[]>> })
        .componentAnchorContracts;
      if (!contracts) continue;
      for (const [componentType, templates] of Object.entries(contracts)) {
        // First write wins — plugins should never collide on
        // componentType keys (every componentType is owned by exactly
        // one plugin). If they do, the export:kinds manifest also
        // first-wins, so behaviour stays consistent across backend +
        // frontend.
        if (out[componentType]) continue;
        out[componentType] = templates.map((t) => ({
          id: t.id as AnchorId,
          ...(t.name !== undefined ? { name: t.name } : {}),
          ...(t.positionMmBodyLocal !== undefined
            ? { positionMmBodyLocal: { ...t.positionMmBodyLocal } }
            : {}),
          ...(t.directionBodyLocal !== undefined
            ? { directionBodyLocal: { ...t.directionBodyLocal } }
            : {}),
        }));
      }
    }
    return out;
  })();


/** Unified contract lookup. Per-component override wins; otherwise falls
 *  back to KIND_REGISTRY's required + optional anchors (identified by id
 *  only — no name). Returns ``[]`` for unknown component_types so the
 *  editor can treat "no contract" the same as "empty contract" (still
 *  locked, just no anchors expected). */
export function getAnchorContractFor(
  componentType: string | null | undefined,
): AnchorTemplate[] {
  if (!componentType) return [];
  const compContract = COMPONENT_ANCHOR_CONTRACTS[componentType];
  if (compContract) return compContract;
  const kind: ElementKind | null = componentTypeToElementKind(componentType);
  if (!kind) return [];
  const kindContract = KIND_REGISTRY[kind];
  if (!kindContract) return [];
  return [
    ...kindContract.requiredAnchors.map((id): AnchorTemplate => ({ id })),
    ...kindContract.optionalAnchors.map((id): AnchorTemplate => ({ id })),
  ];
}


/** Match by (id, name) when the contract anchor has a name; otherwise
 *  match by id alone. Used to identify whether a draft anchor corresponds
 *  to a contract entry. */
export function anchorMatchesTemplate(
  draft: { id: string; name?: string | null },
  tpl: AnchorTemplate,
): boolean {
  if (draft.id !== tpl.id) return false;
  if (tpl.name == null) return true;
  return draft.name === tpl.name;
}
