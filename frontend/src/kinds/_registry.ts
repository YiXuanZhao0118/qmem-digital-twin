/**
 * Per-ElementKind contract registry — the kind-vs-anchor contract that
 * tells the Component Editor and align algorithm what each 3D model
 * needs.
 *
 * Post-P2 (this file): the `KIND_REGISTRY` data lives in
 * `kinds/<kind>/index.ts` PhysicsPlugins and is derived from them via
 * `_plugins.ts:derivedKindRegistry()`. This file now contains ONLY:
 *   - AnchorId   — whitelist of legal anchor IDs (TS literal union)
 *   - EDITABLE_ANCHOR_IDS — subset surfaced in the inspector dropdown
 *   - KindAlignVariant + KindContract — type definitions
 *   - KIND_REGISTRY — thin re-export of the derived map
 *   - helper functions (kindsWithFunction, kindsWithEditableAnchors,
 *     getKindContract) re-implemented against the derived map
 *
 * Adding a new kind = create `kinds/<id>/index.ts` and import its
 * plugin in `_plugins.ts`. No further edits here.
 */

import type { ElementKind } from "../types/digitalTwin";
import { derivedKindRegistry } from "./_plugins";

/** Whitelist of legal anchor IDs (mirrors backend AssetAnchorId Literal
 *  in app/schemas.py). Free strings get rejected by the inspector
 *  dropdown. */
export type AnchorId =
  | "intercept_face"
  | "intercept_in"
  | "intercept_out"
  | "in"
  | "seed"
  | "out"
  | "optical_anchor"
  | "center"
  // AOM-specific direction anchor (Phase 8 refactor 2026-05-10).
  // `id="rf_direction"` carries the body-local RF / acoustic propagation
  // direction; position is body origin; apertureMm unused.
  | "rf_direction"
  // RF ports for hybrid / RF-emitting kinds. `rf_out` marks an output
  // SMA / coax port (e.g. each AD9959 channel, AOM driver feed-through);
  // `rf_in` marks the RF input port (e.g. AOM RF connector). Position +
  // outward direction matter for visualising the cable hookup; aperture
  // is currently unused. (Added 2026-05-13 with the physics_elements
  // rename so the PHY Editor's anchor inspector can place these ports.)
  | "rf_in"
  | "rf_out"
  // TTL / digital-control input port (added 2026-05-14 with the
  // rf_switch kind). A logic-level input that selects switch state —
  // physically realised on the Mini-Circuits ZYSWA-2-50DR as a 4th
  // SMA-F jack on the case (labelled "TTL" next to RFIN/RF1/RF2), so
  // structurally it's just another coax port. Position = jack centre,
  // direction = outward face normal, so a mating control-line cable's
  // End-A anchor aligns to it like any RF port. Distinct id (not
  // `rf_in`) because solver / cable-routing semantics differ — TTL is
  // a digital control signal, not an RF analogue path, and downstream
  // RF-chain math should not see it as a signal source.
  | "ttl_in"
  // Horn-antenna aperture face — radiation lobe origin + main-beam
  // direction (cos^n parametric pattern).
  | "aperture"
  // Optical-isolator internal PBS cube anchors (diagonal cement
  // interface — position = cube centre, direction = coating normal,
  // apertureMm = half the active interface size). Used by the
  // `isolator` kind below.
  | "front_pbs"
  | "back_pbs"
  | "+x" | "-x" | "+y" | "-y" | "+z" | "-z";

/** Anchor IDs the Editor inspector exposes in its dropdown. We
 *  intentionally narrow this to the optical-relevant subset; the ±axis
 *  anchors are computed by face-bbox math and shouldn't be edited by
 *  hand. */
export const EDITABLE_ANCHOR_IDS: AnchorId[] = [
  "intercept_in",
  "intercept_out",
  "intercept_face",
  "in",
  "seed",
  "out",
  "optical_anchor",
  "center",
  "rf_in",
  "rf_out",
  "ttl_in",
  "aperture",
];

export type KindAlignVariant =
  | "translate_anchor_to_beam"
  | "translate_and_bragg_rotate"
  | "translate_anti_parallel"
  | "none";

export interface KindContract {
  kind: ElementKind;
  displayName: string;
  /** Anchors the kind cannot work without. */
  requiredAnchors: AnchorId[];
  /** Anchors that improve behaviour when present (e.g. asymmetric
   *  intercept_in / intercept_out for elements with directional
   *  geometry). */
  optionalAnchors: AnchorId[];
  /** Anchors whose `directionBodyLocal` must also be set, not just the
   *  position. Mirror's `intercept_face` is the canonical example: the
   *  align algorithm and ray-tracer both need to know which side of the
   *  reflective face the beam should reflect off, which is fully
   *  specified only by the (point, normal) pair. */
  anchorsNeedingDirection: AnchorId[];
  /** Anchors whose `apertureMm` must be set (not null/undefined).
   *  Optional in the contract type — defaults to `[]` when omitted, so
   *  pre-existing kind entries don't need to declare the field.
   *
   *  AOM is the canonical case: both ports need the active aperture so
   *  beam-clipping warnings can fire and the entry-port ambiguity
   *  guard has a length scale to compare against. The PHY Editor's
   *  Save validates this and blocks saves that leave any
   *  required-aperture anchor without a value; runtime align checks
   *  the same. */
  anchorsNeedingAperture?: AnchorId[];
  alignVariant: KindAlignVariant;
  alignToleranceMm: number;
  /** One-line description of what the align button does. Shown in the
   *  Editor's right pane so users editing a 3D model know what their
   *  anchor placement needs to satisfy. */
  alignSummary: string;
}

/** Source-of-truth registry — derived from PhysicsPlugins. Was a 380-
 *  line hand-maintained object literal before M3; now a thin shim. */
export const KIND_REGISTRY = derivedKindRegistry() as Record<
  ElementKind,
  KindContract
>;

/** ElementKinds that have a meaningful align contract — used to filter
 *  the Component Editor's left list down to "components with function". */
export function kindsWithFunction(): ElementKind[] {
  return (Object.keys(KIND_REGISTRY) as ElementKind[]).filter(
    (k) => KIND_REGISTRY[k].alignVariant !== "none",
  );
}

/** ElementKinds the PHY Editor's component list should show — anything
 *  with at least one defined anchor (required or optional) qualifies.
 *  Laser sources have alignVariant="none" but still need an editable
 *  `out` anchor to set the emission origin + direction, so we use this
 *  broader criterion in the editor instead of `kindsWithFunction`. */
export function kindsWithEditableAnchors(): ElementKind[] {
  return (Object.keys(KIND_REGISTRY) as ElementKind[]).filter((k) => {
    const c = KIND_REGISTRY[k];
    return c.requiredAnchors.length > 0 || c.optionalAnchors.length > 0;
  });
}

export function getKindContract(kind: ElementKind | null | undefined): KindContract | null {
  if (!kind) return null;
  return KIND_REGISTRY[kind] ?? null;
}
