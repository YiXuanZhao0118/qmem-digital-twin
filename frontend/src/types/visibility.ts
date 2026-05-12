import type { PhysicsCapability } from "./digitalTwin";

// =============================================================================
// L1 — Global overlay flags
// =============================================================================

export type OverlayKind =
  // Geometry
  | "components"
  | "anchors"
  | "bounding_boxes"
  | "coordinate_axes"
  // Relations
  | "connections"
  | "assembly_relations"
  | "optical_links"
  // Physics
  | "beam_segments"
  | "beam_paths"
  | "field_map"
  | "regions"
  // Diagnostics
  | "warnings";

export type OverlayFlags = Record<OverlayKind, boolean>;

export const OVERLAY_KINDS: OverlayKind[] = [
  "components",
  "anchors",
  "bounding_boxes",
  "coordinate_axes",
  "connections",
  "assembly_relations",
  "optical_links",
  "beam_segments",
  "beam_paths",
  "field_map",
  "regions",
  "warnings",
];

export const DEFAULT_OVERLAY_FLAGS: OverlayFlags = {
  components: true,
  anchors: true,
  bounding_boxes: false,
  coordinate_axes: false,
  connections: true,
  assembly_relations: true,
  optical_links: true,
  beam_segments: true,
  beam_paths: true,
  field_map: false,
  regions: false,
  warnings: false,
};

export const OVERLAY_GROUPS: { label: string; kinds: OverlayKind[] }[] = [
  { label: "Geometry", kinds: ["components", "anchors", "bounding_boxes", "coordinate_axes"] },
  { label: "Relations", kinds: ["connections", "assembly_relations", "optical_links"] },
  { label: "Physics", kinds: ["beam_segments", "beam_paths", "field_map", "regions"] },
  { label: "Diagnostics", kinds: ["warnings"] },
];

export const OVERLAY_LABELS: Record<OverlayKind, string> = {
  components: "Models",
  anchors: "Anchors",
  bounding_boxes: "B.Box",
  coordinate_axes: "Axes",
  connections: "Cables",
  assembly_relations: "Asm.",
  optical_links: "Optic.",
  beam_segments: "Beams",
  beam_paths: "Path",
  field_map: "Field",
  regions: "Region",
  warnings: "Warnings",
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
  hiddenBeamPathIds: Set<string>;
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
  hiddenBeamPathIds: new Set(),
  hiddenLinkIds: new Set(),
  hiddenRelationIds: new Set(),
  soloObjectIds: null,
  soloIncludeNeighbors: true,
  forceVisibleObjectIds: new Set(),
  forceVisibleCollectionIds: new Set(),
};

// =============================================================================
// L3 — Saved views / filter expressions
// =============================================================================

export type ViewFilterExpr =
  | { type: "all" }
  | { type: "and"; clauses: ViewFilterExpr[] }
  | { type: "or"; clauses: ViewFilterExpr[] }
  | { type: "not"; clause: ViewFilterExpr }
  | { type: "component_type"; values: string[] }
  | { type: "physics_capability"; values: PhysicsCapability[] }
  | { type: "wavelength_range"; lowNm: number; highNm: number }
  | { type: "tag"; values: string[] }
  | {
      type: "reachable_from";
      sourceComponentId: string;
      via: ("optical" | "connection" | "rf")[];
      maxHops: number;
    }
  | { type: "in_region"; regionId: string }
  | { type: "in_stage"; stageId: string }
  | { type: "component_ids"; values: string[] };

export type SceneViewFilterKind = "all" | "any" | "leaf";

export type SceneView = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string;
  filterKind: SceneViewFilterKind;
  filterExpr: ViewFilterExpr;
  overlayOverrides: Partial<OverlayFlags>;
  isDefault: boolean;
  isPinned: boolean;
  sortOrder: number;
  createdBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type SceneViewCreatePayload = {
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string;
  filterKind?: SceneViewFilterKind;
  filterExpr?: ViewFilterExpr;
  overlayOverrides?: Partial<OverlayFlags>;
  isDefault?: boolean;
  isPinned?: boolean;
  sortOrder?: number;
};

export type SceneViewUpdatePayload = Partial<SceneViewCreatePayload>;

export const DEFAULT_FILTER_EXPR: ViewFilterExpr = { type: "all" };
