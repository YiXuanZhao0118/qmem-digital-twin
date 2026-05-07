// Smart Placement Engine — pure-function core for all object positioning.
//
// Every placement input source (gizmo drag, N-panel typing, Shift+S cursor
// command, multi-select align, "Place along beam") routes through
// `computePlacement` so the snap relevance + intent-metadata generation are
// uniform across the app.
//
// See `qmem-digital-twin/docs/PLACEMENT_DESIGN.md` for architecture.

import type * as THREE from "three";

import type {
  Asset3D,
  ComponentItem,
  OpticalElement,
  OpticalLink,
  SceneObject,
} from "../../types/digitalTwin";
import {
  collectAnchorSnaps,
  collectBeamAlongSnaps,
  collectBeamCenterlineSnaps,
  collectBeamEndpointSnaps,
  collectBeamIntersectionSnaps,
  collectCursorSnap,
  collectGridSnap,
  collectMeshBboxCenterSnaps,
  collectMeshFaceCentroidSnaps,
  collectMeshVertexSnaps,
  collectWorldOriginSnap,
} from "./snapTargets";

// ───────────────────────────────────────────────────────────────────────────
// Snap target taxonomy
// ───────────────────────────────────────────────────────────────────────────

export type SnapTargetKind =
  | "beam_centerline"
  | "beam_along"
  | "beam_intersection"
  | "beam_endpoint"
  | "mesh_vertex"
  | "mesh_edge_midpoint"
  | "mesh_face_centroid"
  | "mesh_bbox_center"
  | "anchor"
  | "cursor"
  | "world_origin"
  | "object_plane"
  | "grid";

/** Categories the user can enable/disable in the snap popover. Each
 * `SnapTargetKind` belongs to one. */
export type SnapCategory =
  | "beam"
  | "geometry"
  | "anchor"
  | "reference"
  | "grid";

export const SNAP_KIND_TO_CATEGORY: Record<SnapTargetKind, SnapCategory> = {
  beam_centerline: "beam",
  beam_along: "beam",
  beam_intersection: "beam",
  beam_endpoint: "beam",
  mesh_vertex: "geometry",
  mesh_edge_midpoint: "geometry",
  mesh_face_centroid: "geometry",
  mesh_bbox_center: "geometry",
  anchor: "anchor",
  cursor: "reference",
  world_origin: "reference",
  object_plane: "reference",
  grid: "grid",
};

export type SnapTargetRef = {
  objectId?: string;
  componentId?: string;
  linkId?: string;
  anchorId?: string;
  distanceMm?: number;
};

export type SnapTarget = {
  kind: SnapTargetKind;
  /** Lab-frame point in mm where the dragged object should land. Visual
   * feedback (Layer 4) converts to THREE units at the boundary. */
  pointLab: LabPoint;
  /** Optional direction (lab frame, unit) — beam forward, face normal,
   * anchor outward. Used by Layer 4 to align the dragged object's forward
   * axis. */
  directionLab?: LabVec3;
  /** Free-form payload used by Re-snap to reconstruct the snap from intent
   * metadata. */
  ref?: SnapTargetRef;
  /** Human-readable description for viewport readout. */
  label: string;
  /** Distance from the dragged object's reference point in lab mm. Used for
   * ranking + threshold filtering. */
  distanceMm: number;
};

// ───────────────────────────────────────────────────────────────────────────
// Intent metadata (persisted on SceneObject.properties.placedRelativeTo)
// ───────────────────────────────────────────────────────────────────────────

export type PlacedRelativeToKind =
  | "beam_along"
  | "beam_centerline"
  | "face_touch"
  | "anchor_match"
  | "vertex_snap"
  | "cursor"
  | "absolute";

export type PlacedRelativeTo = {
  kind: PlacedRelativeToKind;
  recordedAt: string; // ISO8601
  linkId?: string;
  distanceMm?: number;
  refObjectId?: string;
  refAnchorId?: string;
  axisLockedToBeam?: boolean;
};

// ───────────────────────────────────────────────────────────────────────────
// Engine I/O
// ───────────────────────────────────────────────────────────────────────────

export type LabPoint = { x: number; y: number; z: number };
export type LabRotation = { rxDeg: number; ryDeg: number; rzDeg: number };
export type LabVec3 = { x: number; y: number; z: number };

export type SceneSnapshot = {
  components: ComponentItem[];
  objects: SceneObject[];
  assets: Asset3D[];
  opticalElements: OpticalElement[];
  opticalLinks: OpticalLink[];
};

export type PlacementIntent = {
  /** Where the user is "trying to go", in lab mm (= the unsnapped pointer-
   * derived position). */
  candidatePosLab: LabPoint;
  candidateRotLab?: LabRotation;
  /** If the dragged object has a forward axis (laser, mirror normal), passing
   * it here lets the engine compute beam-axis alignment. */
  forwardLab?: LabVec3;
  snapEnabled: boolean;
  /** Categories the user has enabled. Empty = no snap. */
  snapCategories: SnapCategory[];
  /** Constrains the candidate position to one axis (when the user holds an
   * axis lock from gizmo / G+X). The other axes pass through unchanged. */
  axisLock?: "x" | "y" | "z" | null;
  /** When the user picked a reference object first (e.g., "Place this lens
   * relative to laser_001"), pass its id. Currently advisory; reserved for
   * future relative-mode UX. */
  referenceObjectId?: string;
  /** Click point on a beam — used by Layer 4's "Place along beam @ N mm". */
  beamProbe?: { linkId: string; distanceMm: number };
};

export type PlacementConfig = {
  thresholdsMm: Partial<Record<SnapTargetKind, number>>;
  gridStepMm: number;
};

export const DEFAULT_THRESHOLDS_MM: Record<SnapTargetKind, number> = {
  beam_centerline: 25,
  beam_along: 25,
  beam_intersection: 15,
  beam_endpoint: 15,
  mesh_vertex: 10,
  mesh_edge_midpoint: 10,
  mesh_face_centroid: 15,
  mesh_bbox_center: 20,
  anchor: 5,
  cursor: 30,
  world_origin: 30,
  object_plane: 5,
  grid: 1, // grid is a fall-through, threshold not really used
};

export const DEFAULT_GRID_STEP_MM = 10;

export type PlacementResult = {
  positionLab: LabPoint;
  rotationLab?: LabRotation;
  snappedTo: SnapTarget | null;
  /** Up to 3 next-best snap candidates the UI can cycle to via Tab. */
  alternatives: SnapTarget[];
  reasoning: string;
  /** What to write into SceneObject.properties.placedRelativeTo. Always
   * non-null — at minimum "absolute". */
  intentMetadata: PlacedRelativeTo;
};

// ───────────────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────────────

export type PlacementInput = {
  scene: SceneSnapshot;
  /** 3D cursor's lab position — passed in so the engine doesn't reach into
   * the store. */
  cursorMm?: LabPoint;
  target: { id: string; componentId: string; currentLab: LabPoint };
  intent: PlacementIntent;
  config: PlacementConfig;
  /** Three.js group containing all loaded component meshes. Required for
   * geometry-based snaps; pass null to skip those. */
  componentGroup: THREE.Group | null;
};

export function computePlacement(input: PlacementInput): PlacementResult {
  const { intent, target, scene, componentGroup, cursorMm, config } = input;

  // Apply axis-lock first: if the user has constrained motion to one axis,
  // restore the other two from the object's current pose.
  const candidate: LabPoint = applyAxisLock(
    intent.candidatePosLab,
    target.currentLab,
    intent.axisLock ?? null,
  );

  // Snap disabled → absolute landing.
  if (!intent.snapEnabled || intent.snapCategories.length === 0) {
    return {
      positionLab: candidate,
      rotationLab: intent.candidateRotLab,
      snappedTo: null,
      alternatives: [],
      reasoning: "snap disabled",
      intentMetadata: { kind: "absolute", recordedAt: new Date().toISOString() },
    };
  }

  const cats = new Set(intent.snapCategories);
  const allTargets: SnapTarget[] = [];

  if (cats.has("beam")) {
    allTargets.push(
      ...collectBeamCenterlineSnaps(scene, candidate, target.componentId),
      ...collectBeamEndpointSnaps(scene, candidate, target.componentId),
      ...collectBeamIntersectionSnaps(scene, candidate),
    );
    if (intent.beamProbe) {
      allTargets.push(...collectBeamAlongSnaps(scene, intent.beamProbe));
    }
  }

  if (cats.has("geometry") && componentGroup) {
    allTargets.push(
      ...collectMeshBboxCenterSnaps(componentGroup, candidate, target.id),
      ...collectMeshFaceCentroidSnaps(componentGroup, candidate, target.id),
      ...collectMeshVertexSnaps(componentGroup, candidate, target.id),
    );
  }

  if (cats.has("anchor")) {
    allTargets.push(...collectAnchorSnaps(scene, candidate, target.id));
  }

  if (cats.has("reference")) {
    allTargets.push(
      ...collectCursorSnap(cursorMm, candidate),
      ...collectWorldOriginSnap(candidate),
    );
  }

  if (cats.has("grid")) {
    allTargets.push(...collectGridSnap(candidate, config.gridStepMm));
  }

  // Filter by per-kind threshold. Per-kind override (config.thresholdsMm[kind])
  // wins; otherwise fall back to the per-category threshold via SNAP_KIND_TO_CATEGORY,
  // then DEFAULT_THRESHOLDS_MM. The per-category override is the path the
  // smart-popover UI uses (one slider per category).
  const inRange = allTargets.filter((t) => {
    const perKind = config.thresholdsMm[t.kind];
    if (perKind !== undefined) return t.distanceMm <= perKind;
    const cat = SNAP_KIND_TO_CATEGORY[t.kind];
    const perCat = (config.thresholdsMm as Record<string, number | undefined>)[cat];
    if (perCat !== undefined) return t.distanceMm <= perCat;
    return t.distanceMm <= DEFAULT_THRESHOLDS_MM[t.kind];
  });

  if (inRange.length === 0) {
    return {
      positionLab: candidate,
      rotationLab: intent.candidateRotLab,
      snappedTo: null,
      alternatives: [],
      reasoning: "no snap target in range — using raw candidate",
      intentMetadata: { kind: "absolute", recordedAt: new Date().toISOString() },
    };
  }

  const ranked = rankByOpticalRelevance(inRange, intent, scene, target.componentId);
  const best = ranked[0];

  return {
    positionLab: best.pointLab,
    rotationLab: intent.candidateRotLab,
    snappedTo: best,
    alternatives: ranked.slice(1, 4),
    reasoning: `snapped to ${best.label} (Δ ${best.distanceMm.toFixed(1)} mm)`,
    intentMetadata: snapTargetToMetadata(best),
  };
}

/** Rank snap candidates by per-project relevance:
 *  1. If target component has an OpticalElement → beam snaps win.
 *  2. Then anchor snaps (most specific).
 *  3. Then geometry snaps (face_centroid > bbox_center > vertex > edge).
 *  4. Then reference snaps.
 *  5. Then grid (fall-through).
 *  Within tier: smaller `distanceMm` wins.
 */
export function rankByOpticalRelevance(
  targets: SnapTarget[],
  intent: PlacementIntent,
  scene: SceneSnapshot,
  componentId: string,
): SnapTarget[] {
  void intent;
  const targetIsOptical = scene.opticalElements.some((el) => el.objectId === componentId);

  const tier = (kind: SnapTargetKind): number => {
    switch (kind) {
      case "beam_along":
        return 0; // user explicitly clicked a beam — highest
      case "beam_centerline":
      case "beam_endpoint":
      case "beam_intersection":
        return targetIsOptical ? 1 : 4;
      case "anchor":
        return 2;
      case "mesh_face_centroid":
        return 3;
      case "mesh_bbox_center":
        return 3.2;
      case "mesh_vertex":
        return 3.4;
      case "mesh_edge_midpoint":
        return 3.6;
      case "object_plane":
        return 5;
      case "cursor":
        return 5.2;
      case "world_origin":
        return 5.4;
      case "grid":
        return 9;
    }
  };

  return [...targets].sort((a, b) => {
    const dt = tier(a.kind) - tier(b.kind);
    if (dt !== 0) return dt;
    return a.distanceMm - b.distanceMm;
  });
}

function snapTargetToMetadata(t: SnapTarget): PlacedRelativeTo {
  const recordedAt = new Date().toISOString();
  switch (t.kind) {
    case "beam_along":
      return {
        kind: "beam_along",
        recordedAt,
        linkId: t.ref?.linkId,
        distanceMm: t.ref?.distanceMm,
      };
    case "beam_centerline":
    case "beam_endpoint":
    case "beam_intersection":
      return { kind: "beam_centerline", recordedAt, linkId: t.ref?.linkId };
    case "anchor":
      return {
        kind: "anchor_match",
        recordedAt,
        refObjectId: t.ref?.objectId,
        refAnchorId: t.ref?.anchorId,
      };
    case "mesh_vertex":
    case "mesh_edge_midpoint":
      return {
        kind: "vertex_snap",
        recordedAt,
        refObjectId: t.ref?.objectId,
      };
    case "mesh_face_centroid":
      return {
        kind: "face_touch",
        recordedAt,
        refObjectId: t.ref?.objectId,
      };
    case "cursor":
      return { kind: "cursor", recordedAt };
    case "mesh_bbox_center":
    case "world_origin":
    case "object_plane":
    case "grid":
      return { kind: "absolute", recordedAt };
  }
}

function applyAxisLock(
  candidate: LabPoint,
  current: LabPoint,
  lock: "x" | "y" | "z" | null,
): LabPoint {
  if (lock === null) return candidate;
  return {
    x: lock === "x" ? candidate.x : current.x,
    y: lock === "y" ? candidate.y : current.y,
    z: lock === "z" ? candidate.z : current.z,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers exported for consumers (Layer 1 gizmo, Layer 6 Re-snap)
// ───────────────────────────────────────────────────────────────────────────

export function describePlacement(meta: PlacedRelativeTo): string {
  switch (meta.kind) {
    case "beam_along":
      return `${meta.distanceMm ?? "?"} mm along beam ${meta.linkId?.slice(0, 8) ?? "?"}`;
    case "beam_centerline":
      return `on centreline of beam ${meta.linkId?.slice(0, 8) ?? "?"}`;
    case "face_touch":
      return `face-touching ${meta.refObjectId?.slice(0, 8) ?? "?"}:${meta.refAnchorId ?? "?"}`;
    case "anchor_match":
      return `anchor-matched to ${meta.refObjectId?.slice(0, 8) ?? "?"}:${meta.refAnchorId ?? "?"}`;
    case "vertex_snap":
      return `vertex-snapped to ${meta.refObjectId?.slice(0, 8) ?? "?"}`;
    case "cursor":
      return "at 3D cursor";
    case "absolute":
    default:
      return "absolute coordinates";
  }
}
