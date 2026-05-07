import { create } from "zustand";

import {
  applyRelationOnceApi,
  autoRegisterOpticalApi,
  autoRegisterOpticalAllApi,
  createAssemblyRelationApi,
  createCollectionApi,
  createObjectApi,
  createOpticalElementApi,
  createOpticalLinkApi,
  createComponentApi,
  createSceneViewApi,
  deleteAssemblyRelationApi,
  deleteCollectionApi,
  deleteComponentApi,
  deleteObjectApi,
  deleteOpticalElementApi,
  deleteOpticalLinkApi,
  deleteSceneViewApi,
  duplicateSceneViewApi,
  fetchScene,
  importLocalComponentAssetApi,
  moveObjectToCollectionApi,
  listSceneViewsApi,
  moveCollectionApi,
  runOpticalSimulationApi,
  runOpticalTransientApi,
  unlinkObjectFromCollectionApi,
  upsertTimingProgramApi,
  deleteTimingProgramApi,
  updateAssemblyRelationApi,
  updateCollectionApi,
  updateComponentApi,
  updateObjectApi,
  updateOpticalElementApi,
  updateOpticalLinkApi,
  updateSceneViewApi,
  uploadComponentAssetApi,
} from "../api/client";
import type {
  CollectionCreatePayload,
  CollectionUpdatePayload,
  OpticalElementApiPayload,
  OpticalLinkApiPayload,
  OpticalRunResponse,
} from "../api/client";
import type {
  BeamPath,
  AssemblyRelation,
  Collection,
  CollectionMember,
  ComponentItem,
  GeometrySelector,
  ConnectionItem,
  DeviceState,
  ElementKind,
  OpticalElement,
  OpticalLink,
  PhysicsCapability,
  RelationType,
  SceneData,
  SceneEvent,
  SceneObject,
  SceneObjectPatch,
  TimingProgram,
  TimingProgramUpsert,
  TransientRunRequest,
  TransientRunResponse,
} from "../types/digitalTwin";
import {
  DEFAULT_OVERLAY_FLAGS,
  EMPTY_SESSION_VISIBILITY,
  type OverlayFlags,
  type OverlayKind,
  type SceneView,
  type SceneViewCreatePayload,
  type SceneViewUpdatePayload,
  type SessionVisibilityState,
  type ViewFilterExpr,
} from "../types/visibility";
import {
  loadActiveViewId,
  loadOverlayFlagsFromStorage,
  saveActiveViewId,
  saveOverlayFlagsToStorage,
} from "../utils/visibilityStorage";
// Visibility helpers are no longer used here directly — selection is decoupled
// from visibility (see selectComponent/selectObject). Saved-view creation
// computes its own per-instance visibility inline. EXCEPTION:
// `toggleSessionHiddenObject` reads the live collection cascade so it can
// distinguish "user toggling a normally-visible object off" from "user
// force-showing an object whose collection is hidden".
import { computeVisibleCollectionIds } from "../utils/visibility";
import {
  computeSnapPositionForLink,
  validateOpticalLink,
} from "../utils/beamPlacement";

type RelationDraftTarget = {
  objectAId: string;
  objectBId: string;
  anchorAId: string;
  anchorBId: string;
} | null;

type ObjectSelectionOptions = {
  additive?: boolean;
};

type LoadStatus = "idle" | "loading" | "ready" | "error";
type SocketStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";
export type TransformPivotMode = "median" | "individual" | "cursor";
export type TransformAxis = "x" | "y" | "z";
export type LabPoint = { x: number; y: number; z: number };

/** Touch tool operations. Each one is a 2-step picking flow with strict
 *  expectations on what kind of feature the user picks first and second.
 *  See FaceTouchOp definition in handleFaceTouchClick for the math. */
export type TouchOpId = "vv" | "ve" | "vf" | "ee" | "ef" | "ff";
export type FeatureKind = "vertex" | "edge" | "face";
export type TouchOp = {
  id: TouchOpId;
  firstKind: FeatureKind;
  secondKind: FeatureKind;
  /** UI label e.g. "Vertex → Vertex" */
  label: string;
  /** Compact button label e.g. "V·V" */
  shortLabel: string;
  /** One-line description shown in the toolbar tooltip + hint bar. */
  description: string;
};

export const TOUCH_OPS: ReadonlyArray<TouchOp> = [
  { id: "vv", firstKind: "vertex", secondKind: "vertex", label: "Vertex → Vertex", shortLabel: "V·V", description: "two vertices coincide" },
  { id: "ve", firstKind: "vertex", secondKind: "edge",   label: "Vertex → Edge",   shortLabel: "V·E", description: "vertex coincides with edge midpoint" },
  { id: "vf", firstKind: "vertex", secondKind: "face",   label: "Vertex → Face",   shortLabel: "V·F", description: "vertex coincides with face click point" },
  { id: "ee", firstKind: "edge",   secondKind: "edge",   label: "Edge → Edge",     shortLabel: "E·E", description: "edge midpoints coincide; edges must be parallel" },
  { id: "ef", firstKind: "edge",   secondKind: "face",   label: "Edge → Face",     shortLabel: "E·F", description: "edge midpoint coincides with face point; edge must be parallel to face" },
  { id: "ff", firstKind: "face",   secondKind: "face",   label: "Face → Face",     shortLabel: "F·F", description: "B's face lands on A's plane along normal; faces must be parallel" },
];

export const TOUCH_OP_BY_ID: Record<TouchOpId, TouchOp> = Object.fromEntries(
  TOUCH_OPS.map((op) => [op.id, op]),
) as Record<TouchOpId, TouchOp>;

const emptyScene: SceneData = {
  assets: [],
  components: [],
  objects: [],
  connections: [],
  assemblyRelations: [],
  beamPaths: [],
  deviceStates: [],
  opticalElements: [],
  opticalLinks: [],
  beamSegments: [],
  sceneViews: [],
  collections: [],
  collectionMembers: [],
  timingPrograms: [],
};

const ACTIVE_COLLECTION_STORAGE_KEY = "qmem.outliner.activeCollectionId";
// Cursor persistence — v2 stores both panels' cursors so dual-view can
// restore each panel's pivot independently. Reads from the v1 single-cursor
// key as a fallback if v2 isn't present yet.
const TRANSFORM_CURSOR_STORAGE_KEY_V1 = "qmem.transformCursorMm.v1";
const TRANSFORM_CURSOR_STORAGE_KEY = "qmem.transformCursorMm.v2";

type LabPointLite = { x: number; y: number; z: number };

function sanitizeLabPoint(p: Partial<LabPointLite> | null | undefined): LabPointLite {
  return {
    x: typeof p?.x === "number" && Number.isFinite(p.x) ? p.x : 0,
    y: typeof p?.y === "number" && Number.isFinite(p.y) ? p.y : 0,
    z: typeof p?.z === "number" && Number.isFinite(p.z) ? p.z : 0,
  };
}

function loadTransformCursorMm(): { left: LabPointLite; right: LabPointLite } {
  if (typeof window === "undefined") return { left: { x: 0, y: 0, z: 0 }, right: { x: 0, y: 0, z: 0 } };
  try {
    const rawV2 = window.localStorage.getItem(TRANSFORM_CURSOR_STORAGE_KEY);
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as Partial<{ left: LabPointLite; right: LabPointLite }>;
      return { left: sanitizeLabPoint(parsed.left), right: sanitizeLabPoint(parsed.right) };
    }
    // Fallback to legacy single-cursor key — seed both panels with the same
    // value so existing sessions don't lose their pinned pivot.
    const rawV1 = window.localStorage.getItem(TRANSFORM_CURSOR_STORAGE_KEY_V1);
    if (rawV1) {
      const seed = sanitizeLabPoint(JSON.parse(rawV1) as Partial<LabPointLite>);
      return { left: seed, right: seed };
    }
  } catch {
    // ignore parse errors — fall through to defaults
  }
  return { left: { x: 0, y: 0, z: 0 }, right: { x: 0, y: 0, z: 0 } };
}

function saveTransformCursorMm(value: { left: LabPointLite; right: LabPointLite }): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TRANSFORM_CURSOR_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore quota / availability errors
  }
}

function loadActiveCollectionId(): string | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(ACTIVE_COLLECTION_STORAGE_KEY);
  return value && value.length > 0 ? value : null;
}

function saveActiveCollectionId(value: string | null): void {
  if (typeof window === "undefined") return;
  if (value) window.localStorage.setItem(ACTIVE_COLLECTION_STORAGE_KEY, value);
  else window.localStorage.removeItem(ACTIVE_COLLECTION_STORAGE_KEY);
}

function findMasterCollectionId(collections: Collection[] | undefined): string | null {
  if (!collections) return null;
  for (const collection of collections) {
    if (collection.parentId === null) return collection.id;
  }
  return null;
}

function collectionDepths(collections: Collection[] | undefined): Map<string, number> {
  const byId = new Map((collections ?? []).map((collection) => [collection.id, collection]));
  const cache = new Map<string, number>();
  const depthOf = (collectionId: string, seen = new Set<string>()): number => {
    const cached = cache.get(collectionId);
    if (cached !== undefined) return cached;
    if (seen.has(collectionId)) return 0;
    const collection = byId.get(collectionId);
    if (!collection?.parentId) {
      cache.set(collectionId, 0);
      return 0;
    }
    const depth = depthOf(collection.parentId, new Set([...seen, collectionId])) + 1;
    cache.set(collectionId, depth);
    return depth;
  };
  for (const collection of collections ?? []) depthOf(collection.id);
  return cache;
}

function normalizeCollectionMembers(
  collections: Collection[] | undefined,
  members: CollectionMember[] | undefined,
): CollectionMember[] {
  const depths = collectionDepths(collections);
  const collectionIds = new Set((collections ?? []).map((collection) => collection.id));
  const byObject = new Map<string, CollectionMember>();
  const score = (member: CollectionMember) => ({
    depth: depths.get(member.collectionId) ?? 0,
    addedAt: member.addedAt ? Date.parse(member.addedAt) || 0 : 0,
    sortOrder: member.sortOrder,
    collectionId: member.collectionId,
  });
  const isBetter = (candidate: CollectionMember, current: CollectionMember): boolean => {
    const a = score(candidate);
    const b = score(current);
    if (a.depth !== b.depth) return a.depth > b.depth;
    if (a.addedAt !== b.addedAt) return a.addedAt > b.addedAt;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder > b.sortOrder;
    return a.collectionId > b.collectionId;
  };

  for (const member of members ?? []) {
    if (!collectionIds.has(member.collectionId)) continue;
    const current = byObject.get(member.objectId);
    if (!current || isBetter(member, current)) {
      byObject.set(member.objectId, member);
    }
  }

  return Array.from(byObject.values()).sort((a, b) => {
    const collectionCompare = a.collectionId.localeCompare(b.collectionId);
    if (collectionCompare !== 0) return collectionCompare;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return (a.addedAt ?? "").localeCompare(b.addedAt ?? "");
  });
}

function normalizeSceneData(scene: SceneData): SceneData {
  return {
    ...scene,
    collectionMembers: normalizeCollectionMembers(scene.collections, scene.collectionMembers),
  };
}

function cloneSession(state: SessionVisibilityState): SessionVisibilityState {
  return {
    hiddenObjectIds: new Set(state.hiddenObjectIds),
    hiddenBeamPathIds: new Set(state.hiddenBeamPathIds),
    hiddenLinkIds: new Set(state.hiddenLinkIds),
    hiddenRelationIds: new Set(state.hiddenRelationIds),
    soloObjectIds: state.soloObjectIds ? new Set(state.soloObjectIds) : null,
    soloIncludeNeighbors: state.soloIncludeNeighbors,
    forceVisibleObjectIds: new Set(state.forceVisibleObjectIds ?? []),
    forceVisibleCollectionIds: new Set(state.forceVisibleCollectionIds ?? []),
  };
}

function freshSession(): SessionVisibilityState {
  return cloneSession(EMPTY_SESSION_VISIBILITY);
}

type SceneStore = {
  scene: SceneData;
  previewObjectTransforms: Record<string, Partial<Pick<SceneObject, "xMm" | "yMm" | "zMm" | "rxDeg" | "ryDeg" | "rzDeg">>>;
  relationDraftTarget: RelationDraftTarget;
  loadStatus: LoadStatus;
  socketStatus: SocketStatus;
  error?: string;
  selectedComponentId: string | null;
  selectedObjectId: string | null;
  selectedObjectIds: string[];
  selectedRelationId: string | null;
  transformPivotMode: TransformPivotMode;
  /** Per-panel cursor pivot. View-level operations (orbit pivot, the X/Y/Z
   *  editor in each viewer's overlay) read their own panel's slot. Global
   *  ops (spawn-at-cursor, AlignPanel, CursorMenu Shift+S commands) read
   *  `.left` as the primary. */
  transformCursorMm: { left: LabPoint; right: LabPoint };
  setTransformPivotMode: (mode: TransformPivotMode) => void;
  setTransformCursorMm: (panel: "left" | "right", point: LabPoint) => void;
  alignSelectedObjectsToCursor: () => Promise<void>;
  moveSelectedOriginsToCursor: () => Promise<void>;
  rotateSelectedObjectsAroundCursor: (axis: TransformAxis, degrees: number) => Promise<void>;
  scaleSelectedObjectsAroundCursor: (factor: number) => Promise<void>;
  // ─── Visibility (L1 / L2 / L3) ──────────────────────────────────────────────
  overlayFlags: OverlayFlags;
  session: SessionVisibilityState;
  activeViewId: string | null;
  setOverlayFlag: (kind: OverlayKind, visible: boolean) => void;
  setOverlayFlags: (next: Partial<OverlayFlags>) => void;
  toggleOverlayFlag: (kind: OverlayKind) => void;
  resetOverlayFlags: () => void;
  // Visibility is per-instance only. Component-level catalog rows that need
  // to hide/solo "this component" should expand to its objects in the panel
  // and call the object-level actions below.
  hideObjectInSession: (objectId: string) => void;
  showObjectInSession: (objectId: string) => void;
  toggleSessionHiddenObject: (objectId: string) => void;
  setObjectsHiddenInSession: (objectIds: string[], hidden: boolean) => void;
  toggleSessionHiddenBeamPath: (beamPathId: string) => void;
  toggleSessionHiddenLink: (linkId: string) => void;
  toggleSessionHiddenRelation: (relationId: string) => void;
  clearSessionHidden: () => void;
  soloObject: (objectId: string) => void;
  toggleSoloObject: (objectId: string) => void;
  setSoloObjects: (objectIds: string[] | null) => void;
  exitSolo: () => void;
  setSoloIncludeNeighbors: (value: boolean) => void;
  showAllHidden: () => void;
  setActiveView: (viewId: string | null) => void;
  reloadSceneViews: () => Promise<void>;
  createSceneView: (payload: SceneViewCreatePayload) => Promise<SceneView>;
  updateSceneView: (viewId: string, patch: SceneViewUpdatePayload) => Promise<SceneView>;
  deleteSceneView: (viewId: string) => Promise<void>;
  duplicateSceneView: (viewId: string) => Promise<SceneView>;
  createViewFromCurrentVisibility: (name: string) => Promise<SceneView>;
  loadScene: () => Promise<void>;
  createComponent: (name: string, componentType: string) => Promise<ComponentItem>;
  uploadComponentAsset: (payload: {
    file: File;
    name: string;
    componentType: string;
    brand?: string;
    model?: string;
    unit?: "mm" | "m";
    scaleFactor?: number;
  }) => Promise<ComponentItem>;
  importLocalComponentAsset: (payload: {
    sourcePath: string;
    name?: string;
    componentType: string;
    brand?: string;
    model?: string;
    unit?: "mm" | "m";
    scaleFactor?: number;
  }) => Promise<ComponentItem>;
  ensureObjectForComponent: (componentId: string) => Promise<void>;
  updateComponent: (componentId: string, patch: Partial<Pick<ComponentItem, "name" | "properties">>) => Promise<void>;
  deleteComponent: (componentId: string) => Promise<void>;
  createAssemblyRelation: (payload: {
    name: string;
    relationType: RelationType;
    objectAId: string;
    objectBId: string;
    selectorA?: GeometrySelector;
    selectorB?: GeometrySelector;
    offsetMm?: number | null;
    angleDeg?: number | null;
    properties?: Record<string, unknown>;
  }) => Promise<AssemblyRelation>;
  updateAssemblyRelation: (
    relationId: string,
    patch: Partial<Omit<AssemblyRelation, "id" | "createdAt" | "updatedAt">>,
  ) => Promise<AssemblyRelation>;
  deleteAssemblyRelation: (relationId: string) => Promise<void>;
  applyRelationOnce: (relationId: string) => Promise<SceneObject | null>;
  updateSceneObject: (objectId: string, patch: SceneObjectPatch) => Promise<void>;
  deleteObject: (objectId: string) => Promise<void>;
  setComponentCapabilities: (
    componentId: string,
    capabilities: PhysicsCapability[],
  ) => Promise<void>;
  upsertOpticalElement: (payload: OpticalElementApiPayload) => Promise<OpticalElement>;
  deleteOpticalElement: (objectId: string) => Promise<void>;
  autoRegisterOptical: (componentId: string) => Promise<OpticalElement[]>;
  autoRegisterOpticalAll: () => Promise<{ createdCount: number; scanned: number }>;
  createOpticalLink: (payload: OpticalLinkApiPayload) => Promise<OpticalLink>;
  updateOpticalLink: (
    linkId: string,
    patch: Partial<Pick<OpticalLinkApiPayload, "freeSpaceMm" | "properties">>,
  ) => Promise<OpticalLink>;
  deleteOpticalLink: (linkId: string) => Promise<void>;
  runOpticalSimulation: () => Promise<OpticalRunResponse>;
  runOpticalTransient: (payload: TransientRunRequest) => Promise<TransientRunResponse>;
  lastTransientRun: TransientRunResponse | null;
  // ─── Beam-scope probe (set by clicking a beam segment in the viewer) ──
  scopeProbe:
    | {
        sourceComponentId: string;
        zMm: number;
        pointThree: { x: number; y: number; z: number };
        /** Cumulative power-factor of the clicked segment relative to the
         *  source emitter's nominal power. 1.0 = full power (no upstream
         *  loss/split); after a 50/50 PBS this is 0.5; after a lens with
         *  transmission=0.99 it's 0.99·(prev). The scope multiplies this by
         *  laser.nominalPowerMw to display the actual segment power. */
        powerFactor: number;
        /** Jones polarisation [Re(Ex), Im(Ex), Re(Ey), Im(Ey)] at the
         *  clicked segment — already accounts for upstream waveplate /
         *  polarizer / PBS transformations. */
        polarization: [number, number, number, number];
      }
    | null;
  setScopeProbe: (
    probe: {
      sourceComponentId: string;
      zMm: number;
      pointThree: { x: number; y: number; z: number };
      powerFactor: number;
      polarization: [number, number, number, number];
    } | null,
  ) => void;
  // ─── Placement system ─────────────────────────────────────────────────
  gizmoOrientation: "global" | "local" | "beam";
  /** Per-panel gizmo mode (Translate / Rotate / Scale). Each viewer reads
   *  its own slot so dual-view can show e.g. translate gizmo on the left
   *  and rotate gizmo on the right for the same selection. */
  gizmoMode: { left: "translate" | "rotate" | "scale"; right: "translate" | "rotate" | "scale" };
  snapEnabled: boolean;
  snapCategories: ("beam" | "geometry" | "anchor" | "reference" | "grid")[];
  snapThresholdsMm: Record<string, number>;
  snapGridStepMm: number;
  /** Set by gizmo during drag; consumed by SnapOverlay for visual feedback. */
  lastPlacementResult: import("../three/placement/engine").PlacementResult | null;
  // ─── Face-touch tool (wireframe-only relation) ────────────────────────
  /** Active toolbar tool. "select" is the default (gizmo + click selection).
   * "face-touch" intercepts viewer clicks to move one object so its clicked
   * face lands on another object's clicked face — only valid when both faces
   * are already parallel. */
  /** Viewport layout — single canvas vs side-by-side dual canvases. Each
   *  panel keeps its own camera and display mode. */
  viewMode: "single" | "dual";
  setViewMode: (mode: "single" | "dual") => void;
  /** Per-panel display mode. In single view, only `left` is used. */
  displayMode: { left: "wireframe" | "rendered"; right: "wireframe" | "rendered" };
  setDisplayMode: (panel: "left" | "right", mode: "wireframe" | "rendered") => void;
  activeTool: "select" | "face-touch";
  /** Which of the 6 touch operations is active. Each op specifies what kind
   *  of feature the user picks first and second:
   *    vv = vertex → vertex
   *    ve = vertex → edge   (B's edge midpoint coincides with A's vertex)
   *    vf = vertex → face   (B's face point coincides with A's vertex)
   *    ee = edge   → edge   (midpoints coincide, edges parallel)
   *    ef = edge   → face   (B's face point coincides with A's edge midpoint;
   *                          edge must be parallel to face plane)
   *    ff = face   → face   (B's face lands on A's plane along normal,
   *                          preserves lateral position; faces parallel)
   */
  faceTouchOp: TouchOpId;
  /** Direction of the snap — which of the two clicked objects MOVES.
   *    "a-to-b": the FIRST-clicked object (A) moves so its anchor coincides
   *              with the second-clicked anchor (B). Matches the visual
   *              arrow naming of the op (e.g. "Vertex → Vertex" reads as
   *              "vertex of A snaps to vertex of B").
   *    "b-to-a": the SECOND-clicked object (B) moves to A. Default.
   *  Both directions are available for every op (vv / ve / vf / ee / ef /
   *  ff). Toggled from the pie-chart overlay's centre button. */
  faceTouchDirection: "a-to-b" | "b-to-a";
  /** First-feature memo while a touch operation is in progress.
   *  - kind="face": needs a parallel second face → translates to coplanar
   *  - kind="edge": picks the closest mesh edge to the click; second click
   *    must also be an edge → translates so midpoints coincide
   *  - kind="vertex": picks the closest mesh vertex; second click must also
   *    be a vertex → translates so vertices coincide
   */
  faceTouchPending:
    | {
        kind: "face" | "edge" | "vertex";
        objectId: string;
        /** World-space (lab mm) anchor point: vertex pos / edge midpoint /
         *  face hit-point. */
        pointMm: { x: number; y: number; z: number };
        /** World-space outward unit normal — face: face normal; edge:
         *  perpendicular to edge along the triangle's normal; vertex: any. */
        normal: { x: number; y: number; z: number };
        /** Face: size of disc highlight. Edge: length of the picked edge
         *  segment. Vertex: 0 (uses fixed dot size). */
        sizeMm: number;
        /** Edge-only: the two endpoint positions (lab mm) so the second-pick
         *  can compare directions and the highlight can render the segment. */
        edgeEndpointsMm?: [
          { x: number; y: number; z: number },
          { x: number; y: number; z: number },
        ];
      }
    | null;
  /** Transient toast for the user when a face-touch action fails (e.g. not
   * parallel). Auto-cleared by the consumer after a few seconds. */
  faceTouchError: string | null;
  /** After both A and B picks pass alignment, we DON'T immediately commit —
   *  instead we stash the preview here so the TouchCoincidencePanel can
   *  expose the residual DOFs (slide along edge, slide on face plane) to
   *  the user. Apply commits via updateSceneObject + clears this; Cancel
   *  just clears.
   *  - drivenOriginalPos = where B was BEFORE the touch (so Cancel reverts)
   *  - du, dv = current panel-driven offsets in feature-local mm
   *  - uAxis/vAxis = unit basis vectors in lab frame; null entries when DOF
   *    isn't applicable (e.g. dv/vAxis are null for 1-DOF ops). */
  faceTouchPreview:
    | {
        op: TouchOpId;
        a: NonNullable<SceneStore["faceTouchPending"]>;
        b: NonNullable<SceneStore["faceTouchPending"]>;
        drivenObjectId: string;
        drivenOriginalPos: { xMm: number; yMm: number; zMm: number };
        /** Default coincide offset (B → A) before any DOF tweaks. */
        baseOffset: { dx: number; dy: number; dz: number };
        /** DOF basis vectors in lab frame (unit). */
        uAxis: { x: number; y: number; z: number } | null;
        vAxis: { x: number; y: number; z: number } | null;
        /** User-driven DOF offsets in mm. */
        du: number;
        dv: number;
      }
    | null;
  setActiveTool: (tool: "select" | "face-touch") => void;
  setFaceTouchOp: (op: TouchOpId) => void;
  setFaceTouchDirection: (dir: "a-to-b" | "b-to-a") => void;
  setFaceTouchPending: (pending: SceneStore["faceTouchPending"]) => void;
  setFaceTouchPreview: (preview: SceneStore["faceTouchPreview"]) => void;
  /** Update only the du/dv fields of the current preview (live slider). */
  setFaceTouchPreviewDof: (du: number, dv: number) => void;
  setFaceTouchError: (msg: string | null) => void;
  // beamPlacementPreview removed — Beam Placement panel is gone. Per-object
  // "Snap to beam" runs synchronously off a button click; no preview state.
  setGizmoOrientation: (orientation: "global" | "local" | "beam") => void;
  setGizmoMode: (panel: "left" | "right", mode: "translate" | "rotate" | "scale") => void;
  setSnapEnabled: (enabled: boolean) => void;
  toggleSnapCategory: (category: "beam" | "geometry" | "anchor" | "reference" | "grid") => void;
  /** Per-category snap distance in mm. Keys are SnapCategory; the engine
   * maps each category to its constituent SnapTargetKinds and uses this
   * value as the threshold for all kinds in that category. */
  setSnapThresholdMm: (category: "beam" | "geometry" | "anchor" | "reference", thresholdMm: number) => void;
  setSnapGridStepMm: (step: number) => void;
  setLastPlacementResult: (result: import("../three/placement/engine").PlacementResult | null) => void;
  // ─── Collections (Outliner) ────────────────────────────────────────────────
  activeCollectionId: string | null;
  setActiveCollection: (collectionId: string | null) => void;
  createCollection: (payload: CollectionCreatePayload) => Promise<Collection>;
  updateCollection: (
    collectionId: string,
    patch: CollectionUpdatePayload,
  ) => Promise<Collection>;
  toggleCollectionVisibility: (collectionId: string) => Promise<void>;
  deleteCollection: (collectionId: string) => Promise<void>;
  moveCollection: (
    collectionId: string,
    payload: { parentId: string | null; sortOrder?: number | null },
  ) => Promise<Collection>;
  moveObjectToCollection: (collectionId: string, objectId: string) => Promise<void>;
  unlinkObjectFromCollection: (collectionId: string, objectId: string) => Promise<void>;
  upsertTimingProgram: (
    objectId: string,
    payload: TimingProgramUpsert,
  ) => Promise<TimingProgram>;
  deleteTimingProgram: (objectId: string) => Promise<void>;
  selectComponent: (componentId: string | null) => void;
  selectObject: (objectId: string | null, options?: ObjectSelectionOptions) => void;
  /** Batch-set the selected object list. Used by marquee selection in the
   * outliner and "select all in collection" double-click. Active becomes the
   * first id (or null when empty). */
  setSelectedObjects: (objectIds: string[]) => void;
  selectRelation: (relationId: string | null) => void;
  previewObjectTransform: (
    objectId: string,
    transform: Partial<Pick<SceneObject, "xMm" | "yMm" | "zMm" | "rxDeg" | "ryDeg" | "rzDeg">>,
  ) => void;
  clearPreviewObjectTransform: (objectId?: string) => void;
  setRelationDraftTarget: (target: RelationDraftTarget) => void;
  applyEvent: (event: SceneEvent) => void;
  setSocketStatus: (status: SocketStatus) => void;
};

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  return items.map((item) => (item.id === next.id ? next : item));
}

function upsertObject(items: SceneObject[], next: SceneObject): SceneObject[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}

function upsertObjects(items: SceneObject[], nextItems: SceneObject[]): SceneObject[] {
  return nextItems.reduce((current, item) => upsertObject(current, item), items);
}

function upsertDeviceState(items: DeviceState[], next: DeviceState): DeviceState[] {
  const index = items.findIndex((item) => item.objectId === next.objectId);
  if (index === -1) return [...items, next];
  return items.map((item) => (item.objectId === next.objectId ? next : item));
}

function withoutRelationsForObjects(relations: AssemblyRelation[], objectIds: Set<string>): AssemblyRelation[] {
  return relations.filter(
    (relation) => !objectIds.has(relation.objectAId) && !objectIds.has(relation.objectBId),
  );
}

function nextObjectOffset(count: number): SceneObjectPatch {
  return {
    xMm: -700 + ((count * 140) % 1400),
    yMm: -420 + Math.floor(count / 10) * 140,
    zMm: 70,
    rzDeg: 0,
    visible: true,
    locked: false,
  };
}

function cursorSpawnPatch(cursor: LabPoint, count: number): SceneObjectPatch {
  return {
    ...nextObjectOffset(count),
    xMm: cursor.x,
    yMm: cursor.y,
    zMm: cursor.z,
  };
}

const OBJECT_TRANSFORM_PATCH_KEYS = ["xMm", "yMm", "zMm", "rxDeg", "ryDeg", "rzDeg"] as const;

function stripLockedTransformPatch(object: SceneObject | undefined, patch: SceneObjectPatch): SceneObjectPatch | null {
  const lockedAtUpdateStart = object?.locked === true;
  const lockingNow = patch.locked === true;
  if (!lockedAtUpdateStart && !lockingNow) return patch;

  let stripped = false;
  const next: SceneObjectPatch = { ...patch };
  for (const key of OBJECT_TRANSFORM_PATCH_KEYS) {
    if (key in next) {
      delete next[key];
      stripped = true;
    }
  }
  if (!stripped) return patch;
  return Object.keys(next).length > 0 ? next : null;
}

function selectedTransformObjects(state: SceneStore): SceneObject[] {
  const ids = state.selectedObjectIds.length > 0
    ? state.selectedObjectIds
    : state.selectedObjectId
      ? [state.selectedObjectId]
      : [];
  const idSet = new Set(ids);
  return state.scene.objects.filter((object) => idSet.has(object.id) && !object.locked);
}

function vecProperty(value: unknown): LabPoint {
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return {
      x: typeof source.x === "number" && Number.isFinite(source.x) ? source.x : 0,
      y: typeof source.y === "number" && Number.isFinite(source.y) ? source.y : 0,
      z: typeof source.z === "number" && Number.isFinite(source.z) ? source.z : 0,
    };
  }
  return { x: 0, y: 0, z: 0 };
}

function objectOriginOffset(object: SceneObject): LabPoint {
  return vecProperty(object.properties?.originOffsetMm);
}

function objectScale(object: SceneObject): number {
  const value = object.properties?.objectScale;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

function rotateVectorAroundAxis(vector: LabPoint, axis: TransformAxis, degrees: number): LabPoint {
  const angle = (degrees * Math.PI) / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  if (axis === "x") {
    return { x: vector.x, y: vector.y * c - vector.z * s, z: vector.y * s + vector.z * c };
  }
  if (axis === "y") {
    return { x: vector.x * c + vector.z * s, y: vector.y, z: -vector.x * s + vector.z * c };
  }
  return { x: vector.x * c - vector.y * s, y: vector.x * s + vector.y * c, z: vector.z };
}

function inverseRotateObjectVector(vector: LabPoint, object: SceneObject): LabPoint {
  const rx = (object.rxDeg * Math.PI) / 180;
  const ry = (object.ryDeg * Math.PI) / 180;
  const rz = (object.rzDeg * Math.PI) / 180;

  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  const x1 = vector.x * cz + vector.y * sz;
  const y1 = -vector.x * sz + vector.y * cz;
  const z1 = vector.z;

  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const x2 = x1;
  const y2 = y1 * cx + z1 * sx;
  const z2 = -y1 * sx + z1 * cx;

  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  return {
    x: x2 * cy - z2 * sy,
    y: y2,
    z: x2 * sy + z2 * cy,
  };
}

function isComponentLocked(component?: ComponentItem): boolean {
  return component?.properties?.locked === true;
}

export const useSceneStore = create<SceneStore>((set, get) => ({
  scene: emptyScene,
  previewObjectTransforms: {},
  relationDraftTarget: null,
  loadStatus: "idle",
  socketStatus: "idle",
  selectedComponentId: null,
  selectedObjectId: null,
  selectedObjectIds: [],
  selectedRelationId: null,
  transformPivotMode: "median",
  transformCursorMm: loadTransformCursorMm(),
  overlayFlags: loadOverlayFlagsFromStorage(),
  session: freshSession(),
  activeViewId: loadActiveViewId(),
  activeCollectionId: loadActiveCollectionId(),

  setTransformPivotMode(mode) {
    set({ transformPivotMode: mode });
  },

  setTransformCursorMm(panel, point) {
    set((state) => {
      const next = { ...state.transformCursorMm, [panel]: point };
      saveTransformCursorMm(next);
      return { transformCursorMm: next };
    });
  },

  async alignSelectedObjectsToCursor() {
    const state = get();
    const targets = selectedTransformObjects(state);
    if (targets.length === 0) return;
    const cursor = state.transformCursorMm.left;
    const updated = await Promise.all(
      targets.map((object) =>
        updateObjectApi(object.id, {
          xMm: cursor.x,
          yMm: cursor.y,
          zMm: cursor.z,
        }),
      ),
    );
    set((current) => ({
      scene: {
        ...current.scene,
        objects: upsertObjects(current.scene.objects, updated),
      },
    }));
  },

  async moveSelectedOriginsToCursor() {
    const state = get();
    const targets = selectedTransformObjects(state);
    if (targets.length === 0) return;
    const cursor = state.transformCursorMm.left;
    const updated = await Promise.all(
      targets.map((object) => {
        const scale = objectScale(object);
        const offset = objectOriginOffset(object);
        const deltaWorld = {
          x: object.xMm - cursor.x,
          y: object.yMm - cursor.y,
          z: object.zMm - cursor.z,
        };
        const deltaLocal = inverseRotateObjectVector(deltaWorld, object);
        const nextOriginOffset = {
          x: offset.x + deltaLocal.x / scale,
          y: offset.y + deltaLocal.y / scale,
          z: offset.z + deltaLocal.z / scale,
        };
        return updateObjectApi(object.id, {
          xMm: cursor.x,
          yMm: cursor.y,
          zMm: cursor.z,
          properties: {
            ...(object.properties ?? {}),
            originOffsetMm: nextOriginOffset,
          },
        });
      }),
    );
    set((current) => ({
      scene: {
        ...current.scene,
        objects: upsertObjects(current.scene.objects, updated),
      },
    }));
  },

  async rotateSelectedObjectsAroundCursor(axis, degrees) {
    if (!Number.isFinite(degrees) || degrees === 0) return;
    const state = get();
    const targets = selectedTransformObjects(state);
    if (targets.length === 0) return;
    const cursor = state.transformCursorMm.left;
    const updated = await Promise.all(
      targets.map((object) => {
        const rotated = rotateVectorAroundAxis(
          {
            x: object.xMm - cursor.x,
            y: object.yMm - cursor.y,
            z: object.zMm - cursor.z,
          },
          axis,
          degrees,
        );
        const rotationPatch =
          axis === "x"
            ? { rxDeg: object.rxDeg + degrees }
            : axis === "y"
              ? { ryDeg: object.ryDeg + degrees }
              : { rzDeg: object.rzDeg + degrees };
        return updateObjectApi(object.id, {
          xMm: cursor.x + rotated.x,
          yMm: cursor.y + rotated.y,
          zMm: cursor.z + rotated.z,
          ...rotationPatch,
        });
      }),
    );
    set((current) => ({
      scene: {
        ...current.scene,
        objects: upsertObjects(current.scene.objects, updated),
      },
    }));
  },

  async scaleSelectedObjectsAroundCursor(factor) {
    if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return;
    const state = get();
    const targets = selectedTransformObjects(state);
    if (targets.length === 0) return;
    const cursor = state.transformCursorMm.left;
    const updated = await Promise.all(
      targets.map((object) => {
        const nextScale = Math.max(0.001, objectScale(object) * factor);
        return updateObjectApi(object.id, {
          xMm: cursor.x + (object.xMm - cursor.x) * factor,
          yMm: cursor.y + (object.yMm - cursor.y) * factor,
          zMm: cursor.z + (object.zMm - cursor.z) * factor,
          properties: {
            ...(object.properties ?? {}),
            objectScale: nextScale,
          },
        });
      }),
    );
    set((current) => ({
      scene: {
        ...current.scene,
        objects: upsertObjects(current.scene.objects, updated),
      },
    }));
  },

  setOverlayFlag(kind, visible) {
    set((state) => {
      const next = { ...state.overlayFlags, [kind]: visible };
      saveOverlayFlagsToStorage(next);
      return { overlayFlags: next };
    });
  },

  setOverlayFlags(partial) {
    set((state) => {
      const next = { ...state.overlayFlags, ...partial };
      saveOverlayFlagsToStorage(next);
      return { overlayFlags: next };
    });
  },

  toggleOverlayFlag(kind) {
    set((state) => {
      const next = { ...state.overlayFlags, [kind]: !state.overlayFlags[kind] };
      saveOverlayFlagsToStorage(next);
      return { overlayFlags: next };
    });
  },

  resetOverlayFlags() {
    set(() => {
      saveOverlayFlagsToStorage(DEFAULT_OVERLAY_FLAGS);
      return { overlayFlags: { ...DEFAULT_OVERLAY_FLAGS } };
    });
  },

  hideObjectInSession(objectId) {
    set((state) => {
      const next = cloneSession(state.session);
      next.hiddenObjectIds.add(objectId);
      return { session: next };
    });
  },

  showObjectInSession(objectId) {
    set((state) => {
      const next = cloneSession(state.session);
      next.hiddenObjectIds.delete(objectId);
      return { session: next };
    });
  },

  toggleSessionHiddenObject(objectId) {
    set((state) => {
      const next = cloneSession(state.session);
      // 4-state interaction with the collection cascade:
      //   1. Object visible normally → hide (add to hiddenObjectIds).
      //   2. Object session-hidden → unhide (remove from hiddenObjectIds).
      //   3. Object hidden because parent COLLECTION is hidden → user
      //      clicked the eye to force-show: add to forceVisibleObjectIds
      //      (overrides the collection cascade in isObjectVisible).
      //   4. Object force-shown → user clicks eye again to hide:
      //      remove from forceVisibleObjectIds (back to cascade default).
      // We figure out which path by checking the live cascade state.
      const visibleCollIds = computeVisibleCollectionIds(
        state.scene.collections ?? [],
        next.forceVisibleCollectionIds,
      );
      const memberships = (state.scene.collectionMembers ?? []).filter((m) => m.objectId === objectId);
      const cascadeShows = memberships.length === 0
        ? true
        : memberships.some((m) => visibleCollIds.has(m.collectionId));
      if (next.forceVisibleObjectIds.has(objectId)) {
        // Path 4
        next.forceVisibleObjectIds.delete(objectId);
      } else if (!cascadeShows && !next.hiddenObjectIds.has(objectId)) {
        // Path 3 — collection cascade is hiding it; force-show.
        next.forceVisibleObjectIds.add(objectId);
      } else if (next.hiddenObjectIds.has(objectId)) {
        // Path 2
        next.hiddenObjectIds.delete(objectId);
      } else {
        // Path 1
        next.hiddenObjectIds.add(objectId);
      }
      return { session: next };
    });
  },

  setObjectsHiddenInSession(objectIds, hidden) {
    if (objectIds.length === 0) return;
    set((state) => {
      const next = cloneSession(state.session);
      for (const id of objectIds) {
        if (hidden) next.hiddenObjectIds.add(id);
        else next.hiddenObjectIds.delete(id);
      }
      return { session: next };
    });
  },

  toggleSessionHiddenBeamPath(beamPathId) {
    set((state) => {
      const next = cloneSession(state.session);
      if (next.hiddenBeamPathIds.has(beamPathId)) next.hiddenBeamPathIds.delete(beamPathId);
      else next.hiddenBeamPathIds.add(beamPathId);
      return { session: next };
    });
  },

  toggleSessionHiddenLink(linkId) {
    set((state) => {
      const next = cloneSession(state.session);
      if (next.hiddenLinkIds.has(linkId)) next.hiddenLinkIds.delete(linkId);
      else next.hiddenLinkIds.add(linkId);
      return { session: next };
    });
  },

  toggleSessionHiddenRelation(relationId) {
    set((state) => {
      const next = cloneSession(state.session);
      if (next.hiddenRelationIds.has(relationId)) next.hiddenRelationIds.delete(relationId);
      else next.hiddenRelationIds.add(relationId);
      return { session: next };
    });
  },

  clearSessionHidden() {
    set((state) => {
      const next = cloneSession(state.session);
      next.hiddenObjectIds.clear();
      next.hiddenBeamPathIds.clear();
      next.hiddenLinkIds.clear();
      next.hiddenRelationIds.clear();
      return { session: next };
    });
  },

  soloObject(objectId) {
    set((state) => {
      const next = cloneSession(state.session);
      next.soloObjectIds = new Set([objectId]);
      return { session: next };
    });
  },

  toggleSoloObject(objectId) {
    set((state) => {
      const next = cloneSession(state.session);
      const current = next.soloObjectIds;
      if (current && current.has(objectId) && current.size === 1) {
        next.soloObjectIds = null;
      } else if (current) {
        const updated = new Set(current);
        if (updated.has(objectId)) updated.delete(objectId);
        else updated.add(objectId);
        next.soloObjectIds = updated.size === 0 ? null : updated;
      } else {
        next.soloObjectIds = new Set([objectId]);
      }
      return { session: next };
    });
  },

  setSoloObjects(objectIds) {
    set((state) => {
      const next = cloneSession(state.session);
      if (!objectIds || objectIds.length === 0) {
        next.soloObjectIds = null;
      } else {
        next.soloObjectIds = new Set(objectIds);
      }
      return { session: next };
    });
  },

  exitSolo() {
    set((state) => {
      const next = cloneSession(state.session);
      next.soloObjectIds = null;
      return { session: next };
    });
  },

  setSoloIncludeNeighbors(value) {
    set((state) => {
      const next = cloneSession(state.session);
      next.soloIncludeNeighbors = value;
      return { session: next };
    });
  },

  showAllHidden() {
    set((state) => {
      const next = freshSession();
      next.soloIncludeNeighbors = state.session.soloIncludeNeighbors;
      saveActiveViewId(null);
      return { session: next, activeViewId: null };
    });
  },

  setActiveView(viewId) {
    saveActiveViewId(viewId);
    set({ activeViewId: viewId });
  },

  async reloadSceneViews() {
    try {
      const views = await listSceneViewsApi();
      set((state) => ({ scene: { ...state.scene, sceneViews: views } }));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("Failed to reload scene views", error);
    }
  },

  async createSceneView(payload) {
    const view = await createSceneViewApi(payload);
    set((state) => ({
      scene: {
        ...state.scene,
        sceneViews: upsertById(state.scene.sceneViews ?? [], view),
      },
    }));
    return view;
  },

  async updateSceneView(viewId, patch) {
    const view = await updateSceneViewApi(viewId, patch);
    set((state) => ({
      scene: {
        ...state.scene,
        sceneViews: upsertById(state.scene.sceneViews ?? [], view),
      },
    }));
    return view;
  },

  async deleteSceneView(viewId) {
    await deleteSceneViewApi(viewId);
    set((state) => ({
      activeViewId: state.activeViewId === viewId ? null : state.activeViewId,
      scene: {
        ...state.scene,
        sceneViews: (state.scene.sceneViews ?? []).filter((v) => v.id !== viewId),
      },
    }));
    if (get().activeViewId === null) saveActiveViewId(null);
  },

  async duplicateSceneView(viewId) {
    const view = await duplicateSceneViewApi(viewId);
    set((state) => ({
      scene: {
        ...state.scene,
        sceneViews: upsertById(state.scene.sceneViews ?? [], view),
      },
    }));
    return view;
  },

  async createViewFromCurrentVisibility(name) {
    const state = get();
    // A component is "currently visible" if at least one of its scene
    // objects passes the per-instance visibility gates (visible flag +
    // session hide). Saved views still target component templates, so we
    // surface the parent componentId here.
    const visibleComponentIds: string[] = [];
    for (const component of state.scene.components) {
      const objs = state.scene.objects.filter((o) => o.componentId === component.id);
      if (objs.length === 0) continue;
      const anyVisible = objs.some(
        (o) => o.visible && !state.session.hiddenObjectIds.has(o.id),
      );
      if (anyVisible) visibleComponentIds.push(component.id);
    }
    const filterExpr: ViewFilterExpr = {
      type: "component_ids",
      values: visibleComponentIds,
    };
    return await get().createSceneView({
      name,
      filterKind: "leaf",
      filterExpr,
      color: "#0f766e",
    });
  },

  async loadScene() {
    set({ loadStatus: "loading", error: undefined });
    try {
      const scene = normalizeSceneData(await fetchScene());
      const currentObjectId = get().selectedObjectId;
      const currentObjectIds = get().selectedObjectIds;
      const currentComponentId = get().selectedComponentId;
      const selectedObjectCandidate = currentObjectId
        ? scene.objects.find((object) => object.id === currentObjectId)
        : undefined;
      const selectedObject = selectedObjectCandidate;
      const selectedComponentCandidate = currentComponentId
        ? scene.components.find((component) => component.id === currentComponentId)
        : undefined;
      const selectedComponent = selectedComponentCandidate;
      const fallbackObject = selectedComponent ? undefined : selectedObject ?? scene.objects[0];
      const sceneObjectIds = new Set(scene.objects.map((object) => object.id));
      const validObjectIds = currentObjectIds.filter((id) => sceneObjectIds.has(id));
      const nextSelectedObjectIds = selectedComponent
        ? []
        : validObjectIds.length > 0
          ? validObjectIds
          : fallbackObject
            ? [fallbackObject.id]
            : [];
      const nextSelectedObjectId =
        selectedComponent
          ? null
          : currentObjectId && nextSelectedObjectIds.includes(currentObjectId)
            ? currentObjectId
            : nextSelectedObjectIds[0] ?? null;

      const persistedViewId = get().activeViewId;
      const sceneViews = scene.sceneViews ?? [];
      let activeViewId = persistedViewId && sceneViews.some((v) => v.id === persistedViewId)
        ? persistedViewId
        : null;
      if (activeViewId === null) {
        const defaultView = sceneViews.find((v) => v.isDefault);
        if (defaultView) activeViewId = defaultView.id;
      }
      saveActiveViewId(activeViewId);

      const persistedCollectionId = get().activeCollectionId;
      const sceneCollections = scene.collections ?? [];
      let activeCollectionId =
        persistedCollectionId && sceneCollections.some((c) => c.id === persistedCollectionId)
          ? persistedCollectionId
          : findMasterCollectionId(sceneCollections);
      saveActiveCollectionId(activeCollectionId);

      set({
        scene,
        loadStatus: "ready",
        selectedObjectId: nextSelectedObjectId,
        selectedObjectIds: nextSelectedObjectIds,
        selectedComponentId: selectedComponent?.id ?? null,
        activeViewId,
        activeCollectionId,
      });
    } catch (error) {
      set({
        loadStatus: "error",
        error: error instanceof Error ? error.message : "Failed to load scene",
      });
    }
  },

  async createComponent(name, componentType) {
    const component = await createComponentApi({
      name,
      componentType,
      properties: { geometry: componentType },
    });
    const obj = await createObjectApi({
      componentId: component.id,
      collectionId: get().activeCollectionId,
      ...cursorSpawnPatch(get().transformCursorMm.left,get().scene.objects.length),
    });
    await get().loadScene();
    set({ selectedComponentId: component.id, selectedObjectId: null, selectedObjectIds: [] });
    return component;
  },

  async importLocalComponentAsset(payload) {
    const component = await importLocalComponentAssetApi(payload);
    const obj = await createObjectApi({
      componentId: component.id,
      collectionId: get().activeCollectionId,
      ...cursorSpawnPatch(get().transformCursorMm.left,get().scene.objects.length),
      visible: true,
      locked: false,
    });
    await get().loadScene();
    set({ selectedComponentId: component.id, selectedObjectId: null, selectedObjectIds: [] });
    return component;
  },

  async uploadComponentAsset(payload) {
    const component = await uploadComponentAssetApi(payload);
    const obj = await createObjectApi({
      componentId: component.id,
      collectionId: get().activeCollectionId,
      ...cursorSpawnPatch(get().transformCursorMm.left,get().scene.objects.length),
      visible: true,
      locked: false,
    });
    await get().loadScene();
    set({ selectedComponentId: component.id, selectedObjectId: null, selectedObjectIds: [] });
    return component;
  },

  async ensureObjectForComponent(componentId) {
    const scene = get().scene;
    const obj = await createObjectApi({
      componentId,
      collectionId: get().activeCollectionId,
      ...cursorSpawnPatch(get().transformCursorMm.left,scene.objects.length),
      visible: true,
      locked: false,
    });
    set((state) => ({
      selectedComponentId: null,
      selectedObjectId: obj.id ?? null,
      selectedObjectIds: obj.id ? [obj.id] : [],
      scene: {
        ...state.scene,
        objects: upsertObject(state.scene.objects, obj),
      },
    }));
  },

  async updateComponent(componentId, patch) {
    const component = await updateComponentApi(componentId, patch);
    set((state) => ({
      selectedComponentId: component.id,
      scene: {
        ...state.scene,
        components: upsertById(state.scene.components, component),
      },
    }));
  },

  async deleteComponent(componentId) {
    const component = get().scene.components.find((item) => item.id === componentId);
    if (isComponentLocked(component)) return;
    await deleteComponentApi(componentId);
    set((state) => {
      const nextComponents = state.scene.components.filter((component) => component.id !== componentId);
      const removedObjectIds = new Set(
        state.scene.objects.filter((object) => object.componentId === componentId).map((object) => object.id),
      );
      const nextObjects = state.scene.objects.filter((object) => object.componentId !== componentId);
      const fallbackObject = nextObjects[0];
      const fallbackComponent =
        nextComponents.find((component) => component.id === fallbackObject?.componentId) ?? nextComponents[0];
      const nextObjectIdSet = new Set(nextObjects.map((object) => object.id));
      const activeWasRemoved = state.selectedObjectId ? removedObjectIds.has(state.selectedObjectId) : false;
      const survivingSelectedIds = state.selectedObjectIds.filter((id) => nextObjectIdSet.has(id));
      if (
        !activeWasRemoved &&
        state.selectedObjectId &&
        nextObjectIdSet.has(state.selectedObjectId) &&
        !survivingSelectedIds.includes(state.selectedObjectId)
      ) {
        survivingSelectedIds.unshift(state.selectedObjectId);
      }
      const nextSelectedObjectIds =
        survivingSelectedIds.length > 0
          ? survivingSelectedIds
          : activeWasRemoved && fallbackObject
            ? [fallbackObject.id]
            : [];
      return {
        selectedObjectId: activeWasRemoved ? nextSelectedObjectIds[0] ?? null : state.selectedObjectId,
        selectedObjectIds: nextSelectedObjectIds,
        selectedComponentId:
          state.selectedComponentId === componentId ? fallbackComponent?.id ?? null : state.selectedComponentId,
        scene: {
          ...state.scene,
          components: nextComponents,
          objects: nextObjects,
          // Per-object endpoints (alembic 0015): drop anything that references
          // an object we just removed.
          beamPaths: state.scene.beamPaths.filter(
            (beamPath) =>
              !(beamPath.sourceObjectId && removedObjectIds.has(beamPath.sourceObjectId)) &&
              !(beamPath.targetObjectId && removedObjectIds.has(beamPath.targetObjectId)),
          ),
          connections: state.scene.connections.filter(
            (connection) =>
              !removedObjectIds.has(connection.fromObjectId) &&
              !removedObjectIds.has(connection.toObjectId),
          ),
          assemblyRelations: withoutRelationsForObjects(state.scene.assemblyRelations, removedObjectIds),
          deviceStates: state.scene.deviceStates.filter((item) => !removedObjectIds.has(item.objectId)),
        },
      };
    });
  },

  async createAssemblyRelation(payload) {
    const relation = await createAssemblyRelationApi(payload);
    const scene = normalizeSceneData(await fetchScene());

    set({
      selectedRelationId: relation.id,
      scene: {
        ...scene,
        assemblyRelations: upsertById(scene.assemblyRelations, relation),
      },
    });

    return relation;
  },

  async updateAssemblyRelation(relationId, patch) {
    const relation = await updateAssemblyRelationApi(relationId, patch);
    const scene = normalizeSceneData(await fetchScene());
    set({
      scene: {
        ...scene,
        assemblyRelations: upsertById(scene.assemblyRelations, relation),
      },
    });
    return relation;
  },

  async deleteAssemblyRelation(relationId) {
    await deleteAssemblyRelationApi(relationId);
    set((state) => ({
      selectedRelationId: state.selectedRelationId === relationId ? null : state.selectedRelationId,
      scene: {
        ...state.scene,
        assemblyRelations: state.scene.assemblyRelations.filter((relation) => relation.id !== relationId),
      },
    }));
  },

  async applyRelationOnce(relationId) {
    const driven = await applyRelationOnceApi(relationId);
    set((state) => ({
      selectedRelationId: state.selectedRelationId === relationId ? null : state.selectedRelationId,
      scene: {
        ...state.scene,
        assemblyRelations: state.scene.assemblyRelations.filter((r) => r.id !== relationId),
        objects: driven ? upsertObject(state.scene.objects, driven) : state.scene.objects,
      },
    }));
    return driven;
  },

  async updateSceneObject(objectId, patch) {
    // Object lock is enforced here before any pose patch reaches the API.
    // The previous P4 cascade
    // (auto-deleting links that became geometrically broken by pose change)
    // was removed when the Beam Placement panel was retired — broken links
    // now just show a warning badge in the OE panel and the user manages
    // them manually.
    const currentObject = get().scene.objects.find((object) => object.id === objectId);
    const safePatch = stripLockedTransformPatch(currentObject, patch);
    if (!safePatch) return;
    const obj = await updateObjectApi(objectId, safePatch);
    set((current) => ({
      selectedObjectId: obj.id ?? objectId,
      selectedObjectIds: current.selectedObjectIds.includes(obj.id ?? objectId)
        ? current.selectedObjectIds
        : [obj.id ?? objectId],
      selectedComponentId: null,
      scene: {
        ...current.scene,
        objects: upsertObject(current.scene.objects, obj),
      },
    }));
  },

  async deleteObject(objectId) {
    await deleteObjectApi(objectId);
    set((state) => {
      const nextObjects = state.scene.objects.filter((object) => object.id !== objectId);
      const fallback = nextObjects[0];
      const nextObjectIdSet = new Set(nextObjects.map((object) => object.id));
      const remainingSelectedIds = state.selectedObjectIds.filter((id) => id !== objectId && nextObjectIdSet.has(id));
      const activeWasDeleted = state.selectedObjectId === objectId;
      const nextSelectedObjectIds =
        remainingSelectedIds.length > 0
          ? remainingSelectedIds
          : activeWasDeleted && fallback
            ? [fallback.id]
            : [];
      return {
        selectedObjectId: activeWasDeleted ? nextSelectedObjectIds[0] ?? null : state.selectedObjectId,
        selectedObjectIds: nextSelectedObjectIds,
        selectedComponentId:
          activeWasDeleted ? fallback?.componentId ?? null : state.selectedComponentId,
        scene: {
          ...state.scene,
          objects: nextObjects,
          assemblyRelations: state.scene.assemblyRelations.filter(
            (relation) => relation.objectAId !== objectId && relation.objectBId !== objectId,
          ),
        },
      };
    });
  },

  async setComponentCapabilities(componentId, capabilities) {
    const updated = await updateComponentApi(componentId, { physicsCapabilities: capabilities } as Partial<ComponentItem>);
    set((state) => ({
      scene: { ...state.scene, components: upsertById(state.scene.components, updated) },
    }));
  },

  async upsertOpticalElement(payload) {
    const existing = get().scene.opticalElements.find((item) => item.objectId === payload.objectId);
    let element: OpticalElement;
    if (existing) {
      const { objectId, ...patch } = payload;
      element = await updateOpticalElementApi(objectId, patch);
    } else {
      element = await createOpticalElementApi(payload);
    }
    set((state) => {
      const others = state.scene.opticalElements.filter(
        (item) => item.objectId !== element.objectId,
      );
      return {
        scene: { ...state.scene, opticalElements: [...others, element] },
      };
    });
    return element;
  },

  async deleteOpticalElement(objectId) {
    await deleteOpticalElementApi(objectId);
    set((state) => ({
      scene: {
        ...state.scene,
        opticalElements: state.scene.opticalElements.filter(
          (item) => item.objectId !== objectId,
        ),
        opticalLinks: state.scene.opticalLinks.filter(
          (link) => link.fromObjectId !== objectId && link.toObjectId !== objectId,
        ),
      },
    }));
  },

  async autoRegisterOptical(componentId) {
    const elements = await autoRegisterOpticalApi(componentId);
    if (elements.length > 0) {
      set((state) => {
        const incomingIds = new Set(elements.map((e) => e.objectId));
        const others = state.scene.opticalElements.filter(
          (item) => !incomingIds.has(item.objectId),
        );
        return {
          scene: { ...state.scene, opticalElements: [...others, ...elements] },
        };
      });
    }
    return elements;
  },

  async autoRegisterOpticalAll() {
    const result = await autoRegisterOpticalAllApi();
    if (result.createdCount > 0) {
      set((state) => {
        const incomingIds = new Set(result.elements.map((item) => item.objectId));
        const others = state.scene.opticalElements.filter(
          (item) => !incomingIds.has(item.objectId),
        );
        return {
          scene: {
            ...state.scene,
            opticalElements: [...others, ...result.elements],
          },
        };
      });
    }
    return { createdCount: result.createdCount, scanned: result.scanned };
  },

  async createOpticalLink(payload) {
    const link = await createOpticalLinkApi(payload);
    set((state) => ({
      scene: { ...state.scene, opticalLinks: [...state.scene.opticalLinks, link] },
    }));
    // Snap-to-axis: translate the to-object so its intercept point sits
    // exactly on the from-object's beam axis. Skipped when validator says
    // the link is already on-axis (avoid jitter from rounding) or when
    // geometry can't be resolved.
    try {
      const sceneNow = get().scene;
      const validation = validateOpticalLink(link, sceneNow);
      if (validation.status !== "ok") {
        const snap = computeSnapPositionForLink(
          link.fromObjectId,
          link.fromPort,
          link.toObjectId,
          link.toPort,
          sceneNow,
        );
        if (snap) {
          await get().updateSceneObject(link.toObjectId, {
            xMm: snap.xMm,
            yMm: snap.yMm,
            zMm: snap.zMm,
          });
        }
      }
    } catch (err) {
      // Snap failures shouldn't block link creation — log and move on.
      // eslint-disable-next-line no-console
      console.warn("[snap] failed to align to-object after createOpticalLink", err);
    }
    return link;
  },

  async updateOpticalLink(linkId, patch) {
    const link = await updateOpticalLinkApi(linkId, patch);
    set((state) => ({
      scene: { ...state.scene, opticalLinks: upsertById(state.scene.opticalLinks, link) },
    }));
    return link;
  },

  async deleteOpticalLink(linkId) {
    // Plain link removal — no auto-displace anymore. The previous P6
    // pushed the freed to-object 50 mm sideways to keep it off the
    // (former) axis; that was tied to the Suggested-links workflow,
    // which has been retired.
    await deleteOpticalLinkApi(linkId);
    set((state) => ({
      scene: {
        ...state.scene,
        opticalLinks: state.scene.opticalLinks.filter((l) => l.id !== linkId),
      },
    }));
  },

  async runOpticalSimulation() {
    return await runOpticalSimulationApi();
  },

  lastTransientRun: null,

  async runOpticalTransient(payload) {
    const response = await runOpticalTransientApi(payload);
    set({ lastTransientRun: response });
    return response;
  },

  scopeProbe: null,
  setScopeProbe(probe) {
    set({ scopeProbe: probe });
  },

  // ─── Placement system (see docs/PLACEMENT_DESIGN.md) ────────────────────
  gizmoOrientation: "global",
  gizmoMode: { left: "translate", right: "translate" },
  // Snap UI was removed — engine still exists for gizmo "absolute landing"
  // path, but with snapEnabled=false it short-circuits to identity. Keep
  // snapCategories empty so even if some legacy code-path flips snapEnabled
  // back on, the engine has nothing to consider.
  snapEnabled: false,
  snapCategories: [],
  // Per-category snap thresholds (mm). Defaults match Layer 0 engine
  // DEFAULT_THRESHOLDS_MM but exposed per-category so the popover can
  // surface 4 sliders instead of N kind-level ones.
  snapThresholdsMm: { beam: 25, geometry: 10, anchor: 5, reference: 30 },
  snapGridStepMm: 10,
  lastPlacementResult: null,
  setGizmoOrientation(orientation) {
    set({ gizmoOrientation: orientation });
  },
  setGizmoMode(panel, mode) {
    set((state) => ({ gizmoMode: { ...state.gizmoMode, [panel]: mode } }));
  },
  setSnapEnabled(enabled) {
    set({ snapEnabled: enabled });
  },
  toggleSnapCategory(category) {
    set((state) => {
      const has = state.snapCategories.includes(category);
      return {
        snapCategories: has
          ? state.snapCategories.filter((c) => c !== category)
          : [...state.snapCategories, category],
      };
    });
  },
  setSnapGridStepMm(step) {
    set({ snapGridStepMm: step });
  },
  setSnapThresholdMm(category, thresholdMm) {
    set((state) => ({
      snapThresholdsMm: { ...state.snapThresholdsMm, [category]: thresholdMm },
    }));
  },

  viewMode: "single",
  setViewMode(mode) {
    set({ viewMode: mode });
  },
  displayMode: { left: "rendered", right: "wireframe" },
  setDisplayMode(panel, mode) {
    // Switching the changed panel out of wireframe cancels any in-flight
    // face-touch operation that was being driven from a wireframe canvas.
    set((state) => ({
      displayMode: { ...state.displayMode, [panel]: mode },
      ...(mode !== "wireframe" && state.activeTool === "face-touch"
        ? {
            activeTool: "select" as const,
            faceTouchPending: null,
            faceTouchPreview: null,
            faceTouchError: null,
          }
        : {}),
    }));
  },
  activeTool: "select",
  faceTouchOp: "vv",
  faceTouchDirection: "b-to-a",
  faceTouchPending: null,
  faceTouchPreview: null,
  faceTouchError: null,
  setActiveTool(tool) {
    set({
      activeTool: tool,
      faceTouchPending: null,
      faceTouchPreview: null,
      faceTouchError: null,
    });
  },
  setFaceTouchOp(op) {
    // Switching op clears any in-progress pick / preview — each op is a
    // strict 2-step flow with fixed first/second feature kinds.
    set({
      faceTouchOp: op,
      faceTouchPending: null,
      faceTouchPreview: null,
      faceTouchError: null,
    });
  },
  setFaceTouchDirection(dir) {
    set({
      faceTouchDirection: dir,
      faceTouchPending: null,
      faceTouchPreview: null,
      faceTouchError: null,
    });
  },
  setFaceTouchPending(pending) {
    set({ faceTouchPending: pending });
  },
  setFaceTouchPreview(preview) {
    set({ faceTouchPreview: preview });
  },
  setFaceTouchPreviewDof(du, dv) {
    set((state) => {
      if (!state.faceTouchPreview) return {};
      return { faceTouchPreview: { ...state.faceTouchPreview, du, dv } };
    });
  },
  setFaceTouchError(msg) {
    set({ faceTouchError: msg });
  },
  setLastPlacementResult(result) {
    set({ lastPlacementResult: result });
  },

  setActiveCollection(collectionId) {
    saveActiveCollectionId(collectionId);
    set({ activeCollectionId: collectionId });
  },

  async createCollection(payload) {
    const collection = await createCollectionApi(payload);
    set((state) => ({
      scene: {
        ...state.scene,
        collections: upsertById(state.scene.collections ?? [], collection),
      },
    }));
    return collection;
  },

  async updateCollection(collectionId, patch) {
    const collection = await updateCollectionApi(collectionId, patch);
    set((state) => ({
      scene: {
        ...state.scene,
        collections: upsertById(state.scene.collections ?? [], collection),
      },
    }));
    return collection;
  },

  async toggleCollectionVisibility(collectionId) {
    const state = get();
    const collections = state.scene.collections ?? [];
    const target = collections.find((collection) => collection.id === collectionId);
    if (!target) return;

    const currentlyVisible = computeVisibleCollectionIds(
      collections,
      state.session.forceVisibleCollectionIds ?? new Set(),
    ).has(collectionId);

    if (currentlyVisible) {
      const collection = await updateCollectionApi(collectionId, { visible: false });
      set((current) => {
        const nextSession = cloneSession(current.session);
        nextSession.forceVisibleCollectionIds.delete(collectionId);
        return {
          session: nextSession,
          scene: {
            ...current.scene,
            collections: upsertById(current.scene.collections ?? [], collection),
          },
        };
      });
      return;
    }

    const collection = target.visible
      ? target
      : await updateCollectionApi(collectionId, { visible: true });

    set((current) => {
      const nextCollections = upsertById(current.scene.collections ?? [], collection);
      const nextSession = cloneSession(current.session);
      nextSession.forceVisibleCollectionIds.delete(collectionId);
      const visibleWithoutOverride = computeVisibleCollectionIds(
        nextCollections,
        nextSession.forceVisibleCollectionIds,
      );
      if (!visibleWithoutOverride.has(collectionId)) {
        nextSession.forceVisibleCollectionIds.add(collectionId);
      }
      return {
        session: nextSession,
        scene: {
          ...current.scene,
          collections: nextCollections,
        },
      };
    });
  },

  async deleteCollection(collectionId) {
    await deleteCollectionApi(collectionId);
    set((state) => {
      const nextCollections = (state.scene.collections ?? []).filter(
        (c) => c.id !== collectionId,
      );
      const nextActive =
        state.activeCollectionId === collectionId
          ? findMasterCollectionId(nextCollections)
          : state.activeCollectionId;
      const nextSession = cloneSession(state.session);
      nextSession.forceVisibleCollectionIds.delete(collectionId);
      saveActiveCollectionId(nextActive);
      return {
        activeCollectionId: nextActive,
        session: nextSession,
        scene: {
          ...state.scene,
          collections: nextCollections,
          collectionMembers: (state.scene.collectionMembers ?? []).filter(
            (m) => m.collectionId !== collectionId,
          ),
        },
      };
    });
  },

  async moveCollection(collectionId, payload) {
    const collection = await moveCollectionApi(collectionId, payload);
    set((state) => ({
      scene: {
        ...state.scene,
        collections: upsertById(state.scene.collections ?? [], collection),
      },
    }));
    return collection;
  },

  async moveObjectToCollection(collectionId, objectId) {
    const member = await moveObjectToCollectionApi(collectionId, objectId);
    set((state) => {
      const others = (state.scene.collectionMembers ?? []).filter(
        (m) => m.objectId !== objectId,
      );
      return {
        scene: {
          ...state.scene,
          collectionMembers: [...others, member],
        },
      };
    });
  },

  async unlinkObjectFromCollection(collectionId, objectId) {
    await unlinkObjectFromCollectionApi(collectionId, objectId);
    // Server may have re-attached the object to Master to preserve the
    // "every object lives in at least one collection" invariant. Reload to
    // reconcile cleanly rather than guess.
    await get().loadScene();
  },

  async upsertTimingProgram(objectId, payload) {
    const program = await upsertTimingProgramApi(objectId, payload);
    set((state) => {
      const existing = state.scene.timingPrograms ?? [];
      const others = existing.filter((p) => p.objectId !== objectId);
      return {
        scene: { ...state.scene, timingPrograms: [...others, program] },
      };
    });
    return program;
  },

  async deleteTimingProgram(objectId) {
    await deleteTimingProgramApi(objectId);
    set((state) => ({
      scene: {
        ...state.scene,
        timingPrograms: (state.scene.timingPrograms ?? []).filter(
          (p) => p.objectId !== objectId,
        ),
      },
    }));
  },

  selectComponent(componentId) {
    // Selection is decoupled from visibility — Outliner / catalog / search
    // can pick anything regardless of whether it's currently rendered, the
    // same way Blender lets you select hidden items from the outliner.
    set({
      selectedComponentId: componentId,
      selectedObjectId: null,
      selectedObjectIds: [],
      selectedRelationId: null,
    });
  },

  selectObject(objectId, options) {
    // Same as selectComponent above — never silently reject. A user trying
    // to flip "visible" back on for a hidden object needs to be able to
    // select it first.
    set((state) => {
      if (!objectId) {
        return options?.additive
          ? {}
          : {
              selectedObjectId: null,
              selectedObjectIds: [],
              selectedComponentId: null,
              selectedRelationId: null,
            };
      }

      if (options?.additive) {
        const isSelected = state.selectedObjectIds.includes(objectId);
        const selectedObjectIds = isSelected
          ? state.selectedObjectIds.filter((id) => id !== objectId)
          : [...state.selectedObjectIds, objectId];
        return {
          selectedObjectId: isSelected ? selectedObjectIds[selectedObjectIds.length - 1] ?? null : objectId,
          selectedObjectIds,
          selectedComponentId: null,
          selectedRelationId: null,
        };
      }

      return {
        selectedObjectId: objectId,
        selectedObjectIds: [objectId],
        selectedComponentId: null,
        selectedRelationId: null,
      };
    });
  },

  setSelectedObjects(objectIds) {
    const unique = Array.from(new Set(objectIds));
    set({
      selectedObjectIds: unique,
      selectedObjectId: unique[0] ?? null,
      selectedComponentId: null,
      selectedRelationId: null,
    });
  },

  selectRelation(relationId) {
    set({ selectedRelationId: relationId });
  },

  previewObjectTransform(objectId, transform) {
    const object = get().scene.objects.find((item) => item.id === objectId);
    if (object?.locked) return;
    set((state) => ({
      previewObjectTransforms: {
        ...state.previewObjectTransforms,
        [objectId]: transform,
      },
    }));
  },

  clearPreviewObjectTransform(objectId) {
    set((state) => {
      if (!objectId) return { previewObjectTransforms: {} };
      const next = { ...state.previewObjectTransforms };
      delete next[objectId];
      return { previewObjectTransforms: next };
    });
  },

  setRelationDraftTarget(relationDraftTarget) {
    set({ relationDraftTarget });
  },

  applyEvent(event) {
    if (event.type === "scene.reload") {
      void get().loadScene();
      return;
    }
    if (event.type === "scene.connected" || event.type === "pong") return;

    set((state) => {
      const scene = state.scene;
      switch (event.type) {
        case "component.created":
        case "component.updated":
          return {
            scene: {
              ...scene,
              components: upsertById(scene.components, event.payload),
            },
          };
        case "component.deleted": {
          const componentId = event.payload.componentId ?? event.payload.id;
          const removedObjectIds = new Set(
            scene.objects.filter((item) => item.componentId === componentId).map((item) => item.id),
          );
          const nextObjects = scene.objects.filter((item) => item.componentId !== componentId);
          const nextObjectIdSet = new Set(nextObjects.map((item) => item.id));
          const activeWasRemoved = state.selectedObjectId ? removedObjectIds.has(state.selectedObjectId) : false;
          const nextSelectedObjectIds = state.selectedObjectIds.filter((id) => nextObjectIdSet.has(id));
          return {
            selectedComponentId:
              state.selectedComponentId === componentId ? null : state.selectedComponentId,
            selectedObjectId: activeWasRemoved ? nextSelectedObjectIds[0] ?? null : state.selectedObjectId,
            selectedObjectIds: nextSelectedObjectIds,
            scene: {
              ...scene,
              components: scene.components.filter((item) => item.id !== componentId),
              objects: nextObjects,
              // Per-object endpoints (alembic 0015): drop refs that pointed
              // at any of the just-removed object instances.
              beamPaths: scene.beamPaths.filter(
                (item) =>
                  !(item.sourceObjectId && removedObjectIds.has(item.sourceObjectId)) &&
                  !(item.targetObjectId && removedObjectIds.has(item.targetObjectId)),
              ),
              connections: scene.connections.filter(
                (item) =>
                  !removedObjectIds.has(item.fromObjectId) &&
                  !removedObjectIds.has(item.toObjectId),
              ),
              assemblyRelations: withoutRelationsForObjects(scene.assemblyRelations, removedObjectIds),
              deviceStates: scene.deviceStates.filter(
                (item) => !removedObjectIds.has(item.objectId),
              ),
            },
          };
        }
        case "object.updated":
          return {
            selectedObjectId:
              state.selectedComponentId === event.payload.componentId && !state.selectedObjectId
                ? event.payload.id ?? null
                : state.selectedObjectId,
            selectedObjectIds:
              state.selectedComponentId === event.payload.componentId && !state.selectedObjectId && event.payload.id
                ? [event.payload.id]
                : state.selectedObjectIds,
            scene: {
              ...scene,
              objects: upsertObject(scene.objects, event.payload),
            },
          };
        case "object.deleted": {
          const objectId = event.payload.objectId ?? event.payload.id;
          const nextObjects = scene.objects.filter((item) => item.id !== objectId);
          const fallback = nextObjects[0];
          const nextObjectIdSet = new Set(nextObjects.map((item) => item.id));
          const remainingSelectedIds = state.selectedObjectIds.filter((id) => id !== objectId && nextObjectIdSet.has(id));
          const activeWasDeleted = state.selectedObjectId === objectId;
          const nextSelectedObjectIds =
            remainingSelectedIds.length > 0
              ? remainingSelectedIds
              : activeWasDeleted && fallback
                ? [fallback.id]
                : [];
          return {
            selectedObjectId: activeWasDeleted ? nextSelectedObjectIds[0] ?? null : state.selectedObjectId,
            selectedObjectIds: nextSelectedObjectIds,
            selectedComponentId:
              activeWasDeleted ? fallback?.componentId ?? null : state.selectedComponentId,
            scene: {
              ...scene,
              objects: nextObjects,
              assemblyRelations: scene.assemblyRelations.filter(
                (relation) => relation.objectAId !== objectId && relation.objectBId !== objectId,
              ),
            },
          };
        }
        case "assembly_relation.updated":
          return {
            scene: {
              ...scene,
              assemblyRelations: event.payload.deleted
                ? scene.assemblyRelations.filter((item) => item.id !== event.payload.id)
                : upsertById(scene.assemblyRelations, event.payload as AssemblyRelation),
            },
          };
        case "beam_path.updated":
          return {
            scene: {
              ...scene,
              beamPaths: event.payload.deleted
                ? scene.beamPaths.filter((item) => item.id !== event.payload.id)
                : upsertById(scene.beamPaths, event.payload as BeamPath),
            },
          };
        case "connection.updated":
          return {
            scene: {
              ...scene,
              connections: event.payload.deleted
                ? scene.connections.filter((item) => item.id !== event.payload.id)
                : upsertById(scene.connections, event.payload as ConnectionItem),
            },
          };
        case "device_state.updated":
          return {
            scene: {
              ...scene,
              deviceStates: upsertDeviceState(scene.deviceStates, event.payload),
            },
          };
        case "optical_element.updated": {
          const payload = event.payload as Partial<OpticalElement> & { deleted?: boolean; objectId?: string };
          const objectId = payload.objectId;
          if (!objectId) return state;
          if (payload.deleted) {
            return {
              scene: {
                ...scene,
                opticalElements: scene.opticalElements.filter((item) => item.objectId !== objectId),
                opticalLinks: scene.opticalLinks.filter(
                  (link) => link.fromObjectId !== objectId && link.toObjectId !== objectId,
                ),
              },
            };
          }
          const others = scene.opticalElements.filter((item) => item.objectId !== objectId);
          return {
            scene: { ...scene, opticalElements: [...others, payload as OpticalElement] },
          };
        }
        case "optical_link.updated": {
          const payload = event.payload as Partial<OpticalLink> & { deleted?: boolean; id?: string };
          if (payload.deleted && payload.id) {
            return {
              scene: {
                ...scene,
                opticalLinks: scene.opticalLinks.filter((item) => item.id !== payload.id),
              },
            };
          }
          if (!payload.id) return state;
          return {
            scene: { ...scene, opticalLinks: upsertById(scene.opticalLinks, payload as OpticalLink) },
          };
        }
        case "optical_simulation.completed":
          // Currently advisory only; UI listens via runOpticalSimulation return value.
          return state;
        case "scene_view.updated": {
          const payload = event.payload as Partial<SceneView> & { id?: string; deleted?: boolean };
          const sceneViews = scene.sceneViews ?? [];
          if (payload.deleted && payload.id) {
            return {
              activeViewId: state.activeViewId === payload.id ? null : state.activeViewId,
              scene: {
                ...scene,
                sceneViews: sceneViews.filter((view) => view.id !== payload.id),
              },
            };
          }
          if (!payload.id) return state;
          return {
            scene: {
              ...scene,
              sceneViews: upsertById(sceneViews, payload as SceneView),
            },
          };
        }
        case "collection.updated": {
          const payload = event.payload as Partial<Collection> & { id?: string; deleted?: boolean };
          const collections = scene.collections ?? [];
          if (payload.deleted && payload.id) {
            const nextCollections = collections.filter((c) => c.id !== payload.id);
            const nextActive =
              state.activeCollectionId === payload.id
                ? findMasterCollectionId(nextCollections)
                : state.activeCollectionId;
            const nextSession = cloneSession(state.session);
            nextSession.forceVisibleCollectionIds.delete(payload.id);
            saveActiveCollectionId(nextActive);
            return {
              activeCollectionId: nextActive,
              session: nextSession,
              scene: {
                ...scene,
                collections: nextCollections,
                collectionMembers: (scene.collectionMembers ?? []).filter(
                  (m) => m.collectionId !== payload.id,
                ),
              },
            };
          }
          if (!payload.id) return state;
          return {
            scene: {
              ...scene,
              collections: upsertById(collections, payload as Collection),
            },
          };
        }
        case "collection_member.updated": {
          const payload = event.payload as {
            collectionId?: string;
            objectId?: string;
            sortOrder?: number;
            deleted?: boolean;
            resetToMaster?: boolean;
          };
          const collectionId = payload.collectionId;
          const objectId = payload.objectId;
          const memberships = scene.collectionMembers ?? [];
          if (payload.resetToMaster && objectId) {
            const masterId = findMasterCollectionId(scene.collections);
            const filtered = memberships.filter((m) => m.objectId !== objectId);
            if (masterId) {
              return {
                scene: {
                  ...scene,
                  collectionMembers: [
                    ...filtered,
                    {
                      collectionId: masterId,
                      objectId,
                      sortOrder: 0,
                      addedAt: new Date().toISOString(),
                    },
                  ],
                },
              };
            }
            return { scene: { ...scene, collectionMembers: filtered } };
          }
          if (payload.deleted && collectionId && objectId) {
            return {
              scene: {
                ...scene,
                collectionMembers: memberships.filter(
                  (m) => !(m.collectionId === collectionId && m.objectId === objectId),
                ),
              },
            };
          }
          if (!collectionId || !objectId) return state;
          const next: CollectionMember = {
            collectionId,
            objectId,
            sortOrder: payload.sortOrder ?? 0,
            addedAt: new Date().toISOString(),
          };
          const others = memberships.filter(
            (m) => m.objectId !== objectId,
          );
          return {
            scene: { ...scene, collectionMembers: [...others, next] },
          };
        }
        case "timing_program.updated": {
          const program = event.payload;
          const programs = scene.timingPrograms ?? [];
          const others = programs.filter((p) => p.objectId !== program.objectId);
          return {
            scene: { ...scene, timingPrograms: [...others, program] },
          };
        }
        case "timing_program.deleted": {
          const objectId = event.payload.objectId;
          return {
            scene: {
              ...scene,
              timingPrograms: (scene.timingPrograms ?? []).filter(
                (p) => p.objectId !== objectId,
              ),
            },
          };
        }
        default:
          return state;
      }
    });
  },

  setSocketStatus(socketStatus) {
    set({ socketStatus });
  },
}));

// Dev hook: expose the store on window so playwright/console eval can
// inspect/mutate state without dealing with Vite module-singleton splits.
if (typeof window !== "undefined") {
  (window as unknown as { __sceneStore?: typeof useSceneStore }).__sceneStore = useSceneStore;
}
