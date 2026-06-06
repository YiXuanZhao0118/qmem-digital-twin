// =============================================================================
// L1 — Global overlay flags
// =============================================================================

// Only overlay flags that actually gate something in the 3D scene live
// here. Old flags (bounding_boxes / coordinate_axes / field_map /
// regions / warnings) were never wired to a renderer — removing them
// matches what the user can actually toggle. Restore an entry the day a
// renderer starts consulting it.
export type OverlayKind =
  // Geometry
  | "components"
  // Relations
  | "connections"
  | "assembly_relations"
  // Physics
  | "beam_segments"
  // Debug — asset anchor markers (world pos + axisX)
  | "anchors";

export type OverlayFlags = Record<OverlayKind, boolean>;

export const OVERLAY_KINDS: OverlayKind[] = [
  "components",
  "connections",
  "assembly_relations",
  "beam_segments",
  "anchors",
];

export const DEFAULT_OVERLAY_FLAGS: OverlayFlags = {
  components: true,
  connections: true,
  assembly_relations: true,
  beam_segments: true,
  // Debug overlay — off by default.
  anchors: false,
};

// Only Models / Cables / Beams / Anchors are surfaced as toggles —
// assembly_relations stays in the type and keeps its default flag so its live
// renderer (relation lines) behaves unchanged; it was just clutter in the
// popover. "Cables" (connections) gates the RF-cable / fiber-cable models in
// the 3D scene (see DigitalTwinViewer renderComponents) plus the RF freq/power
// badges.
export const OVERLAY_GROUPS: { label: string; kinds: OverlayKind[] }[] = [
  { label: "Geometry", kinds: ["components"] },
  { label: "Relations", kinds: ["connections"] },
  { label: "Physics", kinds: ["beam_segments"] },
  { label: "Debug", kinds: ["anchors"] },
];

export const OVERLAY_LABELS: Record<OverlayKind, string> = {
  components: "Models",
  connections: "Cables",
  assembly_relations: "Asm.",
  beam_segments: "Beams",
  anchors: "Anchors",
};

// =============================================================================
// L2 — Session-only visibility / solo mode
// =============================================================================

export type SessionVisibilityState = {
  // Visibility is purely instance-level. Component templates have no
  // visibility concept (they're catalog entries, not scene placements).
  // Hiding "a component" in the catalog UI means hiding all of its
  // SceneObject instances — that translation lives in the panel, not here.
  hiddenObjectIds: Set<string>;
  hiddenLinkIds: Set<string>;
  hiddenRelationIds: Set<string>;
  soloObjectIds: Set<string> | null;
  soloIncludeNeighbors: boolean;
  /** Per-object override of collection-cascade hide. When the user toggles
   *  visibility ON for an individual object whose parent collection is
   *  hidden, the object id is added here. `isObjectVisible` checks this
   *  set BEFORE the collection gate so the object resurfaces even though
   *  its collection cascade says hidden. Cleared when the user explicitly
   *  hides the object again, or when the parent collection is re-shown
   *  (override no longer needed). Session-only — not persisted to db. */
  forceVisibleObjectIds: Set<string>;
  /** Per-collection override of ancestor collection hide. This lets a child
   *  collection be shown even when its parent collection is hidden. The child
   *  collection's own `visible=false` still wins. Session-only. */
  forceVisibleCollectionIds: Set<string>;
};

export const EMPTY_SESSION_VISIBILITY: SessionVisibilityState = {
  hiddenObjectIds: new Set(),
  hiddenLinkIds: new Set(),
  hiddenRelationIds: new Set(),
  soloObjectIds: null,
  soloIncludeNeighbors: true,
  forceVisibleObjectIds: new Set(),
  forceVisibleCollectionIds: new Set(),
};
