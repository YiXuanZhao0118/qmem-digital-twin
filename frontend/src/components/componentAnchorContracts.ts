/**
 * Per-component-type anchor contracts (frontend mirror of
 * `backend/app/components/anchor_contracts.py` — keep both in sync).
 *
 * Two registries combine into the unified anchor contract that the PHY
 * Editor uses to LOCK anchor identity:
 *
 *   1. COMPONENT_ANCHOR_CONTRACTS — per-component-type override. Needed
 *      when a single ElementKind covers devices with different physical
 *      port layouts (e.g. `rf_source` covers both single-channel synths
 *      and the 4-channel AD9959 DDS, which has 7 SMA ports distinguished
 *      by `name`, not `id`).
 *
 *   2. KIND_REGISTRY (already exists, in `kinds/_registry.ts`):
 *      per-ElementKind contract listing requiredAnchors + optionalAnchors
 *      by id only. Used as fallback when a component_type has no entry
 *      in (1).
 *
 * `getAnchorContractFor(componentType)` returns a flat list of
 * AnchorTemplate entries; the PHY Editor uses this list to:
 *   - auto-create missing anchors on selection (so the user always sees
 *     the full port set, never a "no anchors yet" empty list)
 *   - hide the "+ Add" / "Delete" buttons and the id `<select>` (anchor
 *     identity is locked at the contract level)
 *   - keep position / direction inputs enabled (the user still drags
 *     each port onto the real STL geometry).
 */

import type { AnchorId } from "../kinds/_registry";
import { KIND_REGISTRY } from "../kinds/_registry";
import type { ElementKind } from "../types/digitalTwin";
import { componentTypeToElementKind } from "../utils/elementDefaults";

export type AnchorTemplate = {
  id: AnchorId;
  name?: string;
  positionMmBodyLocal?: { x: number; y: number; z: number };
  directionBodyLocal?: { x: number; y: number; z: number };
};

/** Per-component-type override. Mirror of
 *  `backend/app/components/anchor_contracts.py::COMPONENT_ANCHOR_CONTRACTS`.
 *  Update both files when adding a new fixed-port chip. */
export const COMPONENT_ANCHOR_CONTRACTS: Record<string, AnchorTemplate[]> = {
  dds_ad9959_pcb: [
    {
      id: "rf_out",
      name: "CH0",
      positionMmBodyLocal: { x: 82.55, y: -30.0, z: 4.0 },
      directionBodyLocal: { x: 1.0, y: 0.0, z: 0.0 },
    },
    {
      id: "rf_out",
      name: "CH1",
      positionMmBodyLocal: { x: 82.55, y: -10.0, z: 4.0 },
      directionBodyLocal: { x: 1.0, y: 0.0, z: 0.0 },
    },
    {
      id: "rf_out",
      name: "CH2",
      positionMmBodyLocal: { x: 82.55, y: 10.0, z: 4.0 },
      directionBodyLocal: { x: 1.0, y: 0.0, z: 0.0 },
    },
    {
      id: "rf_out",
      name: "CH3",
      positionMmBodyLocal: { x: 82.55, y: 30.0, z: 4.0 },
      directionBodyLocal: { x: 1.0, y: 0.0, z: 0.0 },
    },
  ],
};

/** Unified contract lookup. Per-component override wins; otherwise falls
 *  back to KIND_REGISTRY's required + optional anchors (identified by id
 *  only — no name). Returns `[]` for unknown component_types so the
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
