import { create } from "zustand";

import {
  applyRelationOnceApi,
  autoRegisterOpticalApi,
  autoRegisterOpticalAllApi,
  createAssemblyRelationApi,
  createCollectionApi,
  createCircuitApi,
  createEmProblemApi,
  createObjectApi,
  createOpticalElementApi,
  createOpticalLinkApi,
  createComponentApi,
  createSceneViewApi,
  createSimulationRunApi,
  deleteAssemblyRelationApi,
  deleteCollectionApi,
  deleteComponentApi,
  deleteObjectApi,
  deleteOpticalElementApi,
  deleteOpticalLinkApi,
  deleteSceneViewApi,
  deleteCircuitApi,
  deleteEmProblemApi,
  deleteMeshApi,
  duplicateSceneViewApi,
  fetchCircuitsApi,
  fetchEmProblemsApi,
  fetchMeshesApi,
  fetchAllRfChainsApi,
  fetchScene,
  fetchSimulationRunApi,
  fetchSimulationRunsApi,
  importLocalComponentAssetApi,
  moveObjectToCollectionApi,
  listSceneViewsApi,
  moveCollectionApi,
  runOpticalSimulationApi,
  runOpticalTransientApi,
  unlinkObjectFromCollectionApi,
  createTimingProgramApi,
  updateTimingProgramApi,
  deleteTimingProgramApi,
  listTimingProgramsApi,
  updateDeviceStateApi,
  updateAssemblyRelationApi,
  updateAssetApi,
  updateCircuitApi,
  updateCollectionApi,
  updateComponentApi,
  updateEmProblemApi,
  updateObjectApi,
  updateOpticalElementApi,
  updateOpticalLinkApi,
  updateSceneViewApi,
  uploadComponentAssetApi,
  uploadMeshApi,
} from "../api/client";
import type {
  CollectionCreatePayload,
  CollectionUpdatePayload,
  OpticalElementApiPayload,
  OpticalLinkApiPayload,
  OpticalRunResponse,
} from "../api/client";
import type {
  Anchor,
  Asset3D,
  BeamPath,
  AssemblyRelation,
  Collection,
  CollectionMember,
  ComponentItem,
  GeometrySelector,
  ConnectionItem,
  DeviceState,
  ElementKind,
  PhysicsElement,
  OpticalLink,
  PhysicsCapability,
  RelationType,
  SceneData,
  SceneEvent,
  SceneObject,
  SceneObjectPatch,
  Circuit,
  CircuitCreatePayload,
  CircuitUpdatePayload,
  EmProblem,
  EmProblemCreatePayload,
  EmProblemUpdatePayload,
  Mesh,
  RfChainNode,
  SimulationModule,
  SimulationRunCreatePayload,
  SimulationRunV2,
  TimingProgram,
  TimingProgramCreatePayload,
  TimingProgramUpdatePayload,
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
  findFiberEndAlignmentCandidates,
  withFiberPortLabPose,
  type BeamSegmentLab,
  type FiberAlignmentCandidate,
} from "../utils/fiberAlignment";
import {
  computeSnapPositionForLink,
  validateOpticalLink,
} from "../utils/beamPlacement";
import { expandPoseToRigidGroup, patchHasPoseChange } from "../utils/rigidGroup";

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
/** Persistent fiber node shape — mirrors backend properties.fiberNodes[].
 *  posMm is required; handleInMm is null/absent for the very first node
 *  (endpoint A) and handleOutMm is null/absent for the last node (endpoint
 *  B). Interior nodes carry both handles independently (PPT-style corner
 *  anchor — drag one handle without affecting the other). */
export type FiberNodePersist = {
  posMm: [number, number, number];
  handleInMm?: [number, number, number];
  handleOutMm?: [number, number, number];
};
export type TransformPivotMode = "median" | "individual" | "cursor";
export type TransformAxis = "x" | "y" | "z";
export type LabPoint = { x: number; y: number; z: number };

// Touch-tool ops + empty scene + storage keys live in `./_constants`.
// Re-exported here for backward compatibility with consumers like
// DigitalTwinViewer / ToolbarHint / TouchCoincidencePanel that still
// import these names from `../store/sceneStore`.
export {
  TOUCH_OPS,
  TOUCH_OP_BY_ID,
  type TouchOp,
  type TouchOpId,
  type FeatureKind,
} from "./_constants";
import { emptyScene } from "./_constants";

// localStorage adapters split out to `./_persistence` so the wrappers
// (try/catch + SSR guards) live next to each other and are unit-testable.
import {
  loadActiveCollectionId,
  loadTransformCursorHidden,
  loadTransformCursorMm,
  saveActiveCollectionId,
  saveTransformCursorHidden,
  saveTransformCursorMm,
} from "./_persistence";

// Pure data helpers split out to `./_helpers`.
import {
  cloneSession,
  collectionDepths,
  findMasterCollectionId,
  freshSession,
  normalizeCollectionMembers,
  normalizeSceneData,
} from "./_helpers";

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
  /** Top-level UI mode. When in "phy-editor", App.tsx renders the PHY
   *  editor sub-page (a separate full-screen layout that hosts
   *  optical_kinds / optical_components and, in future, electrical /
   *  mechanical sub-editors) instead of the normal scene + panels. */
  editorMode: "scene" | "phy-editor";
  /** Active multiphysics module. Drives the top-bar ModuleSwitcher and
   *  which workspace App.tsx renders inside .workspace-canvas. Phase A
   *  only ships an "optics_seq" workspace; the other values flip the
   *  canvas to ``<ModulePlaceholder />``. See docs/MULTIPHYSICS_PLAN.md. */
  currentModule: SimulationModule;
  /** Recent simulation runs (newest first). Populated lazily on demand
   *  by the SolverConsole panel and kept in sync via the WS event
   *  ``simulation_run.status_changed`` (see applyEvent). */
  recentSimulationRuns: SimulationRunV2[];
  /** Phase B Electronics: list of saved SPICE circuits. The
   *  ElectronicsWorkspace populates this on mount via loadCircuits(). */
  circuits: Circuit[];
  /** Currently selected circuit in the Electronics workspace (drives
   *  netlist editor, drives Run button payload). */
  selectedCircuitId: string | null;
  /** Phase C EM: list of saved EM problems + uploaded meshes. */
  emProblems: EmProblem[];
  selectedEmProblemId: string | null;
  meshes: Mesh[];
  /** Currently active PHY editor view inside the sub-page. `null` =
   *  editor "home" (left rail visible, right pane shows a hint asking
   *  the user to pick a sub-editor). */
  phyEditorView:
    | { domain: "optical"; section: "kinds" | "components" }
    | null;
  /** Asset3D currently being edited (anchors[]). When `phyEditorView`
   *  is not the optical_components editor, this is null. */
  editingAssetId: string | null;
  /** Set by sub-editors when their in-memory drafts have unsaved
   *  changes. PhyEditor's top-bar Back button reads this to decide
   *  whether to prompt for confirmation. */
  phyEditorDirty: boolean;
  /** Phase RF.6: all RfChainNodes in the database. The 3D viewer reads
   *  this to overlay frequency-power badges above terminal devices, and
   *  AOM/EOM panels read it to display the chain output. Auto-loaded on
   *  App boot. */
  rfChains: RfChainNode[];
  /** Scrub-time playhead in nanoseconds. When `null`, the scene renders
   *  devices as configured (static state). When a number, gate state at
   *  this time overrides beam emission per the active TimingProgram
   *  bindings. */
  scrubTimeNs: number | null;
  loadRfChains: () => Promise<void>;
  setScrubTimeNs: (tNs: number | null) => void;
  setEditorMode: (mode: "scene" | "phy-editor") => void;
  setCurrentModule: (module: SimulationModule) => void;
  loadRecentSimulationRuns: (module?: SimulationModule, limit?: number) => Promise<void>;
  dispatchSimulationRun: (payload: SimulationRunCreatePayload) => Promise<SimulationRunV2>;
  loadCircuits: () => Promise<void>;
  createCircuit: (payload: CircuitCreatePayload) => Promise<Circuit>;
  updateCircuit: (id: string, patch: CircuitUpdatePayload) => Promise<Circuit>;
  deleteCircuit: (id: string) => Promise<void>;
  setSelectedCircuit: (id: string | null) => void;
  loadEmProblems: () => Promise<void>;
  createEmProblem: (payload: EmProblemCreatePayload) => Promise<EmProblem>;
  updateEmProblem: (id: string, patch: EmProblemUpdatePayload) => Promise<EmProblem>;
  deleteEmProblem: (id: string) => Promise<void>;
  setSelectedEmProblem: (id: string | null) => void;
  loadMeshes: () => Promise<void>;
  uploadMesh: (file: File, name?: string) => Promise<Mesh>;
  deleteMesh: (id: string) => Promise<void>;
  setEditingAssetId: (assetId: string | null) => void;
  setPhyEditorDirty: (dirty: boolean) => void;
  /** Open the PHY editor sub-page (no specific view selected; user
   *  picks from the left rail). */
  openPhyEditor: () => void;
  /** Close the PHY editor and return to the main scene. */
  closePhyEditor: () => void;
  /** Switch to a specific sub-editor inside the PHY editor (e.g.
   *  optical → components). When null, returns to the editor home. */
  setPhyEditorView: (
    view:
      | { domain: "optical"; section: "kinds" | "components" }
      | null,
  ) => void;
  /** Persist anchor edits for an Asset3D. Goes through the backend
   *  PUT /api/assets/{id} so other clients see the change via WS. */
  updateAssetAnchors: (
    assetId: string,
    anchors: Anchor[],
  ) => Promise<void>;
  transformPivotMode: TransformPivotMode;
  /** Per-panel cursor pivot. View-level operations (orbit pivot, the X/Y/Z
   *  editor in each viewer's overlay) read their own panel's slot. Global
   *  ops (spawn-at-cursor, AlignPanel, CursorMenu Shift+S commands) read
   *  `.left` as the primary. */
  transformCursorMm: { left: LabPoint; right: LabPoint };
  /** Per-panel visibility for the 3D cursor marker. Toggled via the
   *  hide-button in ViewerCursorEditor; persisted to localStorage. The
   *  cursor still acts as orbit pivot when hidden — only the marker mesh
   *  is suppressed. */
  transformCursorHidden: { left: boolean; right: boolean };
  setTransformPivotMode: (mode: TransformPivotMode) => void;
  setTransformCursorMm: (panel: "left" | "right", point: LabPoint) => void;
  toggleTransformCursorHidden: (panel: "left" | "right") => void;
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
  forceShowObject: (objectId: string) => void;
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
  /** Spawn a free-form text annotation at the transform cursor. Creates a
   *  fresh `text_annotation` component (driven entirely by canvas-rendered
   *  properties — no asset, no optical role) and a SceneObject pointing at
   *  it. The new object becomes the active selection so the user can edit
   *  the text content immediately in the Object panel. */
  addTextAnnotation: (text?: string) => Promise<ComponentItem>;
  /** When non-null, the viewer renders Bezier-style anchor + tangent-handle
   *  gizmos for this fiber component, dims everything else, and routes
   *  pointer events to the spline editor (drag anchor / drag handle tip /
   *  double-click tube to insert / right-click anchor to delete). */
  fiberEditingComponentId: string | null;
  enterFiberEdit: (componentId: string) => void;
  exitFiberEdit: () => void;
  /** RF-cable equivalent of `fiberEditingComponentId`. Tracks which
   *  rf_cable SceneObject's spline gizmo is currently active. Mutually
   *  exclusive with `fiberEditingComponentId` — entering one clears the
   *  other so the viewer only renders one cable's gizmo at a time. The
   *  ViewerDisplayMode "node-edit" flips this on whenever the user clicks
   *  an rf_cable in the 3D viewport. */
  rfCableEditingObjectId: string | null;
  enterRfCableEdit: (objectId: string) => void;
  exitRfCableEdit: () => void;
  /** Replace the entire node array. Used during a single drag gesture: the
   *  viewer mutates locally for live feedback then commits via this action
   *  on pointer-up. Stored on Component.properties (v1 — per-instance
   *  overrides on SceneObject.properties is a follow-up). */
  updateFiberNodes: (componentId: string, nodes: FiberNodePersist[]) => Promise<void>;
  insertFiberNode: (componentId: string, index: number, node: FiberNodePersist) => Promise<void>;
  removeFiberNode: (componentId: string, index: number) => Promise<void>;
  updateFiberRadius: (componentId: string, radiusMm: number) => Promise<void>;
  /** RF-cable analog of updateFiberNodes / insertFiberNode / removeFiberNode.
   *  All write through to `SceneObject.properties.rfCableNodes` (keyed by
   *  objectId since rf_cable geometry is always per-instance — no V1 catalog
   *  fallback like fiber had). */
  updateRfCableNodes: (
    objectId: string,
    nodes: FiberNodePersist[],
    /** When set, also remove the matching link record from
     *  `SceneObject.properties.rfCableEndpoints`. Used by node-edit's
     *  pointer-up so dragging an endpoint anchor manually escapes the
     *  logical "linked to target" mode set up by Align RF. */
    clearEndpointLink?: "A" | "B",
  ) => Promise<void>;
  /** Explicit "unlink" action: removes the link record for the given
   *  endpoint without touching `rfCableNodes`. Used by:
   *  (1) the Object panel's [Unlink] button so the user can unlink
   *      without going into node-edit mode;
   *  (2) the dangling-link auto-cleanup effect when the target
   *      SceneObject / asset / anchor goes missing. */
  clearRfCableEndpointLink: (objectId: string, end: "A" | "B") => Promise<void>;
  insertRfCableNode: (objectId: string, index: number, node: FiberNodePersist) => Promise<void>;
  removeRfCableNode: (objectId: string, index: number) => Promise<void>;
  /** Snap a fiber endpoint (A or B) to the closest beam-path segment
   *  within `toleranceMm` (default 25). Moves only the chosen endpoint
   *  anchor and adjusts its tangent handle so the connector ferrule
   *  faces along the beam (outward = -beam_propagation), keeping
   *  internal nodes untouched. Returns the fiber-to-beam offset that
   *  was zeroed out (for UI feedback) or null if no beam in range. */
  alignFiberEndToBeam: (
    componentId: string,
    end: "A" | "B",
    toleranceMm?: number,
  ) => Promise<{ offsetMm: number; beamId: string } | null>;
  /** Two-phase fiber align: phase A — list ALL beam segments within
   *  `toleranceMm` of the fiber's endpoint port (closest first), each
   *  carrying the pre-computed body-local node + handle plus the source /
   *  AOM-order / wavelength metadata the UI needs to label the picker.
   *  Used to disambiguate AOM 0/±1 orders that cluster within mm of each
   *  other downstream of a Bragg cell, or beam-splitter R+T branches that
   *  both fall inside the 25 mm tolerance window. */
  findFiberAlignmentCandidates: (
    componentId: string,
    end: "A" | "B",
    toleranceMm?: number,
  ) => Promise<FiberAlignmentCandidate[]>;
  /** Phase B: apply a specific candidate (verbatim from
   *  `findFiberAlignmentCandidates`) to the fiber's endpoint node + handle. */
  applyFiberAlignmentCandidate: (
    componentId: string,
    end: "A" | "B",
    candidate: FiberAlignmentCandidate,
  ) => Promise<void>;
  /** RF-cable equivalent: snap one end of an rf_cable to the closest
   *  rf_in / rf_out anchor on ANOTHER SceneObject within `toleranceMm`.
   *  Returns the snap distance + target name for UI feedback, or null
   *  if no port is within range. Per-instance — indexed by objectId. */
  alignRfCableEndToPort: (
    objectId: string,
    end: "A" | "B",
    toleranceMm?: number,
  ) => Promise<{ offsetMm: number; targetName: string } | null>;
  /** Two-phase rf_cable align: phase A — list ALL rf_in/rf_out targets
   *  within `toleranceMm` of the cable's endpoint port (closest first),
   *  each carrying the pre-computed body-local node + handle so phase B
   *  is just a write. Used by the UI to show a picker dropdown when
   *  several candidates cluster (e.g. AD9959's CH0..CH3 within mm). */
  findRfCableAlignmentCandidates: (
    objectId: string,
    end: "A" | "B",
    toleranceMm?: number,
  ) => Promise<import("../utils/rfCableAlignment").RfCableAlignmentResult[]>;
  /** Phase B of the two-phase align: apply a specific candidate to the
   *  cable's endpoint node + handle. Takes the result object verbatim
   *  from `findRfCableAlignmentCandidates` so no re-computation. */
  applyRfCableAlignmentCandidate: (
    objectId: string,
    end: "A" | "B",
    candidate: import("../utils/rfCableAlignment").RfCableAlignmentResult,
  ) => Promise<void>;
  /** RF link panel drag-to-connect: instantiate a fresh rf_cable
   *  SceneObject and immediately attach End A to `src` and End B to
   *  `tgt` via `applyRfCableAlignmentCandidate`. The new cable's body
   *  pose lands at the midpoint between the two ports (lab space) with
   *  identity rotation; the spline node positions get back-derived so
   *  the connector tips sit exactly on each port. Returns the new
   *  SceneObject id on success, or null when no rf_cable Component
   *  template is available in the catalog. */
  createRfCableBetweenPorts: (args: {
    srcObjectId: string;
    srcAnchorId: string;
    srcAnchorName: string;
    tgtObjectId: string;
    tgtAnchorId: string;
    tgtAnchorName: string;
  }) => Promise<string | null>;
  /** Manually set one fiber endpoint's optical-port lab pose. The user
   *  supplies the desired ferrule-tip lab position and outward direction
   *  (need not be unit-length — it's normalised internally); the action
   *  back-derives the spline node + handle so the port lands at the
   *  requested pose. Handle magnitude is preserved from the previous
   *  handle when present. Used by the Object panel's per-end
   *  x/y/z + rx/ry/rz inputs so the user can dial in port positions
   *  directly instead of going through the spline editor. */
  setFiberPortLabPose: (
    componentId: string,
    end: "A" | "B",
    targetPosLab: [number, number, number],
    targetOutwardLab: [number, number, number],
  ) => Promise<void>;
  /** Toggle which fiber endpoint is the beam-entry port for ray-tracing.
   *  `end` is the endpoint the user clicked. If it's already the entry, the
   *  setting clears (no entry — fiber doesn't participate in the trace);
   *  otherwise it becomes the entry. Stored on SceneObject.properties so
   *  the wrapper-cache key (component, asset, deviceState) stays warm —
   *  flipping entry only invalidates the per-object decoration, not the
   *  geometry. */
  toggleFiberBeamEntry: (objectId: string, end: "A" | "B") => Promise<void>;
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
  upsertOpticalElement: (payload: OpticalElementApiPayload) => Promise<PhysicsElement>;
  deleteOpticalElement: (objectId: string) => Promise<void>;
  autoRegisterOptical: (componentId: string) => Promise<PhysicsElement[]>;
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
  loadTimingPrograms: () => Promise<void>;
  createTimingProgram: (payload: TimingProgramCreatePayload) => Promise<TimingProgram>;
  updateTimingProgram: (
    programId: string,
    patch: TimingProgramUpdatePayload,
  ) => Promise<TimingProgram>;
  deleteTimingProgram: (programId: string) => Promise<void>;
  /** Merge ``patch`` into a SceneObject's DeviceState.state JSONB and PUT
   *  the whole row back (server replaces ``state`` atomically). Used by
   *  the InstrumentPowerPanel + per-object power toggle to flip
   *  ``state.power`` without clobbering co-existing keys. */
  updateDeviceState: (
    objectId: string,
    patch: Record<string, unknown>,
  ) => Promise<DeviceState>;
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
  editorMode: "scene",
  currentModule: "optics_seq",
  recentSimulationRuns: [],
  circuits: [],
  selectedCircuitId: null,
  emProblems: [],
  selectedEmProblemId: null,
  meshes: [],
  phyEditorView: null,
  editingAssetId: null,
  phyEditorDirty: false,
  rfChains: [],
  scrubTimeNs: null,
  fiberEditingComponentId: null,
  rfCableEditingObjectId: null,
  transformPivotMode: "median",
  transformCursorMm: loadTransformCursorMm(),
  transformCursorHidden: loadTransformCursorHidden(),
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

  toggleTransformCursorHidden(panel) {
    set((state) => {
      const next = { ...state.transformCursorHidden, [panel]: !state.transformCursorHidden[panel] };
      saveTransformCursorHidden(next);
      return { transformCursorHidden: next };
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

  forceShowObject(objectId) {
    set((state) => {
      const next = cloneSession(state.session);
      next.hiddenObjectIds.delete(objectId);
      next.forceVisibleObjectIds.add(objectId);
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

  async addTextAnnotation(text) {
    const initialText = (text && text.trim().length > 0) ? text : "Text";
    const component = await createComponentApi({
      name: initialText,
      componentType: "text_annotation",
      properties: {
        text: initialText,
        textColor: "#ffffff",
        bgColor: "rgba(15, 23, 42, 0.85)",
        accentColor: "#38bdf8",
        fontSizePx: 56,
        scaleMm: 80,
      },
    });
    const obj = await createObjectApi({
      componentId: component.id,
      collectionId: get().activeCollectionId,
      ...cursorSpawnPatch(get().transformCursorMm.left, get().scene.objects.length),
      visible: true,
      locked: false,
    });
    await get().loadScene();
    // Select the new object so the Object panel opens to its text editor.
    set({
      selectedComponentId: null,
      selectedObjectId: obj.id ?? null,
      selectedObjectIds: obj.id ? [obj.id] : [],
    });
    return component;
  },

  enterFiberEdit(componentId) {
    // Entering fiber edit clears any active rf_cable edit so only one
    // cable's gizmo is shown at a time (node-edit mode is single-target).
    set({ fiberEditingComponentId: componentId, rfCableEditingObjectId: null });
  },
  exitFiberEdit() {
    set({ fiberEditingComponentId: null });
  },
  enterRfCableEdit(objectId) {
    // Mirror of enterFiberEdit — clears fiber editing so only one cable's
    // gizmo is active at a time.
    set({ rfCableEditingObjectId: objectId, fiberEditingComponentId: null });
  },
  exitRfCableEdit() {
    set({ rfCableEditingObjectId: null });
  },
  async updateFiberNodes(componentId, nodes) {
    // V2 fix (2026-05-11): fiber spline geometry is per-instance, so the
    // node array lives on SceneObject.properties, NOT Component.properties.
    // The old write target (component.properties.fiberNodes) was a layer-
    // confusion bug — it mutated the catalog template, breaking all other
    // instances of the same fiber type AND leaving any per-instance face
    // anchors (output ports) un-synced because they live on the
    // SceneObject. Resolve the component → its (first) SceneObject and
    // write there. The type comment in types/digitalTwin.ts:369 already
    // states this intent ("geometry on SceneObject.properties.fiberNodes");
    // this is the implementation catching up.
    const state = get();
    const obj = state.scene.objects.find((o) => o.componentId === componentId);
    if (!obj) return;
    const nextProps = { ...(obj.properties ?? {}), fiberNodes: nodes };
    const updated = await updateObjectApi(obj.id, { properties: nextProps });
    set((s) => ({
      scene: { ...s.scene, objects: upsertById(s.scene.objects, updated) },
    }));
  },
  async insertFiberNode(componentId, index, node) {
    const state = get();
    const obj = state.scene.objects.find((o) => o.componentId === componentId);
    if (!obj) return;
    const objProps = obj.properties as { fiberNodes?: FiberNodePersist[] } | undefined;
    const compProps = state.scene.components.find((c) => c.id === componentId)?.properties as
      { fiberNodes?: FiberNodePersist[] } | undefined;
    // Prefer the per-instance fiberNodes; fall back to the legacy
    // per-component value so users who already had nodes in the old
    // location still see them when editing for the first time.
    const current = objProps?.fiberNodes ?? compProps?.fiberNodes ?? [];
    const clampedIndex = Math.max(1, Math.min(index, current.length - 1));
    const nextNodes = [...current.slice(0, clampedIndex), node, ...current.slice(clampedIndex)];
    await get().updateFiberNodes(componentId, nextNodes);
  },
  async removeFiberNode(componentId, index) {
    const state = get();
    const obj = state.scene.objects.find((o) => o.componentId === componentId);
    if (!obj) return;
    const objProps = obj.properties as { fiberNodes?: FiberNodePersist[] } | undefined;
    const compProps = state.scene.components.find((c) => c.id === componentId)?.properties as
      { fiberNodes?: FiberNodePersist[] } | undefined;
    const current = objProps?.fiberNodes ?? compProps?.fiberNodes ?? [];
    if (current.length <= 2) return; // Always keep two endpoints.
    if (index <= 0 || index >= current.length - 1) return; // Don't delete endpoints.
    const nextNodes = current.filter((_, i) => i !== index);
    await get().updateFiberNodes(componentId, nextNodes);
  },
  async updateRfCableNodes(objectId, nodes, clearEndpointLink) {
    // rf_cable geometry is always per-instance (no V1 catalog fallback), so
    // we write straight to the SceneObject indexed by `objectId`. When
    // `clearEndpointLink` is "A" or "B", the corresponding link record
    // on `rfCableEndpoints` is removed in the same write — used by
    // node-edit drag commit so a manual endpoint move escapes the
    // logical link to a target anchor (manual override beats link).
    const state = get();
    const obj = state.scene.objects.find((o) => o.id === objectId);
    if (!obj) return;
    const baseProps = (obj.properties ?? {}) as Record<string, unknown> & {
      rfCableEndpoints?: { A?: unknown; B?: unknown };
    };
    let nextEndpoints = baseProps.rfCableEndpoints;
    if (clearEndpointLink && nextEndpoints) {
      nextEndpoints = { ...nextEndpoints };
      delete nextEndpoints[clearEndpointLink];
    }
    const nextProps: Record<string, unknown> = {
      ...baseProps,
      rfCableNodes: nodes,
    };
    if (nextEndpoints !== undefined) nextProps.rfCableEndpoints = nextEndpoints;
    const updated = await updateObjectApi(obj.id, { properties: nextProps });
    set((s) => ({
      scene: { ...s.scene, objects: upsertById(s.scene.objects, updated) },
    }));
  },
  async clearRfCableEndpointLink(objectId, end) {
    // Standalone "unlink" — removes `rfCableEndpoints[end]` without
    // touching `rfCableNodes`. The stored node value at idx 0 / N-1
    // becomes the new visible position (which is what was being
    // derived from the link a moment ago, so the cable doesn't jump).
    const state = get();
    const obj = state.scene.objects.find((o) => o.id === objectId);
    if (!obj) return;
    const baseProps = (obj.properties ?? {}) as Record<string, unknown> & {
      rfCableEndpoints?: { A?: unknown; B?: unknown };
    };
    if (!baseProps.rfCableEndpoints?.[end]) return; // nothing to unlink
    const nextEndpoints = { ...baseProps.rfCableEndpoints };
    delete nextEndpoints[end];
    const nextProps: Record<string, unknown> = {
      ...baseProps,
      rfCableEndpoints: nextEndpoints,
    };
    const updated = await updateObjectApi(obj.id, { properties: nextProps });
    set((s) => ({
      scene: { ...s.scene, objects: upsertById(s.scene.objects, updated) },
    }));
  },
  async insertRfCableNode(objectId, index, node) {
    const state = get();
    const obj = state.scene.objects.find((o) => o.id === objectId);
    if (!obj) return;
    const props = obj.properties as { rfCableNodes?: FiberNodePersist[] } | undefined;
    const current = props?.rfCableNodes ?? [];
    if (current.length < 2) return;
    const clampedIndex = Math.max(1, Math.min(index, current.length - 1));
    const nextNodes = [...current.slice(0, clampedIndex), node, ...current.slice(clampedIndex)];
    await get().updateRfCableNodes(objectId, nextNodes);
  },
  async removeRfCableNode(objectId, index) {
    const state = get();
    const obj = state.scene.objects.find((o) => o.id === objectId);
    if (!obj) return;
    const props = obj.properties as { rfCableNodes?: FiberNodePersist[] } | undefined;
    const current = props?.rfCableNodes ?? [];
    if (current.length <= 2) return;
    if (index <= 0 || index >= current.length - 1) return;
    const nextNodes = current.filter((_, i) => i !== index);
    await get().updateRfCableNodes(objectId, nextNodes);
  },
  async updateFiberRadius(componentId, radiusMm) {
    // Same per-instance treatment as fiberNodes: a fiber's visual jacket
    // radius is an instance property (you can have two cables of the same
    // type with different rendered thicknesses), so write to the
    // SceneObject. Falls back gracefully — no object => no write.
    const state = get();
    const obj = state.scene.objects.find((o) => o.componentId === componentId);
    if (!obj) return;
    const nextProps = { ...(obj.properties ?? {}), radiusMm };
    const updated = await updateObjectApi(obj.id, { properties: nextProps });
    set((s) => ({
      scene: { ...s.scene, objects: upsertById(s.scene.objects, updated) },
    }));
  },
  async alignFiberEndToBeam(componentId, end, toleranceMm = 25) {
    // Back-compat shim: list candidates, apply the closest, return the
    // legacy {offsetMm, beamId} shape. New UI (FiberEditor) should call
    // findFiberAlignmentCandidates + applyFiberAlignmentCandidate so the
    // picker can disambiguate clustered AOM ±1 orders / beam-splitter
    // branches that all fall inside the 25 mm tolerance window.
    const list = await get().findFiberAlignmentCandidates(componentId, end, toleranceMm);
    if (list.length === 0) return null;
    const top = list[0];
    await get().applyFiberAlignmentCandidate(componentId, end, top);
    return { offsetMm: top.distMm, beamId: top.beamId };
  },

  async findFiberAlignmentCandidates(componentId, end, toleranceMm = 25) {
    // Two sources of candidate beam segments, both in LAB mm:
    //   (1) Legacy manually-drawn beam_paths (back-compat).
    //   (2) Live __rayTraceDebug — three.js world coords (units = 100 mm,
    //       y-up). Inverse swap: lab_x = three.x*100, lab_y = -three.z*100,
    //       lab_z = three.y*100. Skip segments emitted by this fiber.
    //
    // For trace segments we additionally:
    //   - Tag each with `aomSideband.order` so AOM ±1 orders that share
    //     the same source/emitter still register as DISTINCT candidates
    //     in the picker (otherwise the user can only land on whichever
    //     order is geometrically closest — typically 0-order — even when
    //     they want to align the fiber to +1 / −1).
    //   - Build a human-readable `displayLabel` from emitter name +
    //     source name + order + wavelength so the picker entries are
    //     intelligible.
    //   - Dedup by (emitterObjectId, aomOrder, branch) keeping the
    //     CLOSEST segment of each logical beam chain — without this, a
    //     long beam path through several optics shows up as many
    //     near-identical picker entries.
    const state = get();
    const obj = state.scene.objects.find((o) => o.componentId === componentId);
    const objProps = obj?.properties as { fiberNodes?: FiberNodePersist[] } | undefined;
    const compProps = state.scene.components.find((c) => c.id === componentId)?.properties as
      { fiberNodes?: FiberNodePersist[] } | undefined;
    const nodes = objProps?.fiberNodes ?? compProps?.fiberNodes;
    if (!nodes || nodes.length < 2) return [];

    const beamSegmentsLab: BeamSegmentLab[] = [];
    for (const beam of state.scene.beamPaths) {
      if (!beam.visible) continue;
      if (beam.points.length < 2) continue;
      for (let i = 0; i < beam.points.length - 1; i += 1) {
        beamSegmentsLab.push({
          beamId: beam.id,
          aMm: beam.points[i] as [number, number, number],
          bMm: beam.points[i + 1] as [number, number, number],
          displayLabel: `Beam ${beam.id.slice(0, 6)} · seg ${i}`,
        });
      }
    }

    type TraceSeg = {
      sourceObjectId?: string;
      emitterObjectId?: string;
      startThree?: { x: number; y: number; z: number };
      endThree?: { x: number; y: number; z: number };
      hitObjectId?: string | null;
      wavelengthNm?: number;
      branch?: string;
      aomSideband?: {
        order?: number;
      };
    };
    const traces: TraceSeg[] = ((typeof window !== "undefined"
      ? (window as unknown as { __rayTraceDebug?: TraceSeg[] }).__rayTraceDebug
      : undefined) ?? []) as TraceSeg[];
    const threeToLab = (v: { x: number; y: number; z: number }): [number, number, number] =>
      [v.x * 100, -v.z * 100, v.y * 100];
    const objectNameById = (id: string | undefined | null): string => {
      if (!id) return "?";
      const o = state.scene.objects.find((x) => x.id === id);
      return o?.name ?? id.slice(0, 6);
    };
    const formatOrder = (order: number | undefined | null): string => {
      if (order === undefined || order === null) return "";
      if (order === 0) return " 0-order";
      if (order > 0) return ` +${order}-order`;
      return ` ${order}-order`;
    };
    for (const seg of traces) {
      if (!seg.startThree || !seg.endThree) continue;
      if (obj && seg.sourceObjectId === obj.id) continue; // don't snap to own emission
      const order = seg.aomSideband?.order;
      const emitterName = objectNameById(seg.emitterObjectId);
      const sourceName = objectNameById(seg.sourceObjectId);
      const wavelengthStr =
        typeof seg.wavelengthNm === "number" ? ` @ ${seg.wavelengthNm.toFixed(0)} nm` : "";
      const sourcePart =
        seg.sourceObjectId && seg.sourceObjectId !== seg.emitterObjectId
          ? ` via ${sourceName}`
          : "";
      const displayLabel = `${emitterName}${sourcePart}${formatOrder(order)}${wavelengthStr}`;
      const beamId = `trace:${(seg.emitterObjectId ?? "?").slice(0, 8)}:o${order ?? "x"}:${(seg.sourceObjectId ?? "?").slice(0, 8)}`;
      beamSegmentsLab.push({
        beamId,
        aMm: threeToLab(seg.startThree),
        bMm: threeToLab(seg.endThree),
        displayLabel,
        emitterObjectId: seg.emitterObjectId,
        aomOrder: order ?? null,
        branch: seg.branch,
        wavelengthNm: seg.wavelengthNm,
      });
    }

    const all = findFiberEndAlignmentCandidates({
      end,
      nodes,
      pose: {
        xMm: obj?.xMm ?? 0,
        yMm: obj?.yMm ?? 0,
        zMm: obj?.zMm ?? 0,
        rxDeg: obj?.rxDeg ?? 0,
        ryDeg: obj?.ryDeg ?? 0,
        rzDeg: obj?.rzDeg ?? 0,
      },
      beamSegmentsLab,
      toleranceMm,
    });

    // Dedup by logical beam identity: a single chain through multiple
    // optics emits one segment per hop, all sharing
    // (emitterObjectId, aomOrder, branch). Keep the closest hop of each
    // chain so the picker shows one entry per beam.
    const byKey = new Map<string, FiberAlignmentCandidate>();
    for (const c of all) {
      const key = `${c.emitterObjectId ?? "?"}:o${c.aomOrder ?? "x"}:${c.branch ?? ""}:${c.beamId.startsWith("trace:") ? "trace" : c.beamId}`;
      const prev = byKey.get(key);
      if (!prev || c.distMm < prev.distMm) byKey.set(key, c);
    }
    return Array.from(byKey.values()).sort((a, b) => a.distMm - b.distMm);
  },

  async applyFiberAlignmentCandidate(componentId, end, candidate) {
    // Phase B: stitch the precomputed candidate back into the fiber's
    // node array and write through `updateFiberNodes`. Only the touched
    // endpoint's posMm + the matching handle change; the other handle on
    // this node and all interior nodes are preserved.
    const state = get();
    const obj = state.scene.objects.find((o) => o.componentId === componentId);
    const objProps = obj?.properties as { fiberNodes?: FiberNodePersist[] } | undefined;
    const compProps = state.scene.components.find((c) => c.id === componentId)?.properties as
      { fiberNodes?: FiberNodePersist[] } | undefined;
    const nodes = objProps?.fiberNodes ?? compProps?.fiberNodes;
    if (!nodes || nodes.length < 2) return;
    const idx = end === "A" ? 0 : nodes.length - 1;
    const newNode: FiberNodePersist = {
      posMm: candidate.newPosMmBody,
      handleInMm:
        end === "B"
          ? candidate.newHandleMmBody
          : nodes[idx].handleInMm
            ? ([...nodes[idx].handleInMm] as [number, number, number])
            : undefined,
      handleOutMm:
        end === "A"
          ? candidate.newHandleMmBody
          : nodes[idx].handleOutMm
            ? ([...nodes[idx].handleOutMm] as [number, number, number])
            : undefined,
    };
    const nextNodes = [...nodes];
    nextNodes[idx] = newNode;
    await get().updateFiberNodes(componentId, nextNodes);
  },

  async findRfCableAlignmentCandidates(objectId, end, toleranceMm = 25) {
    // Gather RF ports from every OTHER SceneObject (own ports skipped),
    // transform body-local → lab via the owner's pose, and delegate the
    // distance + new-node math to `findRfCableEndpointAlignmentCandidates`
    // in utils/rfCableAlignment.ts. Returns a sorted list of candidates
    // — UI auto-applies the first when length === 1 and shows a picker
    // when length >= 2 (AD9959-style clustered CH0..CH3 case).
    const state = get();
    const obj = state.scene.objects.find((o) => o.id === objectId);
    if (!obj) return [];
    const component = state.scene.components.find((c) => c.id === obj.componentId);
    if (!component) return [];
    if (component.componentType !== "rf_cable" && component.componentType !== "sma_cable") {
      return [];
    }
    const objProps = obj.properties as { rfCableNodes?: FiberNodePersist[] } | undefined;
    const lengthMm = (() => {
      const v = (component.properties as { lengthMm?: number } | undefined)?.lengthMm;
      return typeof v === "number" ? v : 150;
    })();
    const nodes: FiberNodePersist[] =
      (objProps?.rfCableNodes && objProps.rfCableNodes.length >= 2)
        ? objProps.rfCableNodes
        : [
            { posMm: [-lengthMm / 2, 0, 0] },
            { posMm: [lengthMm / 2, 0, 0] },
          ];

    type Vec3T = [number, number, number];
    const makeOwnerTransforms = (ownerPose: { xMm: number; yMm: number; zMm: number; rxDeg: number; ryDeg: number; rzDeg: number }) => {
      const rxr = (ownerPose.rxDeg * Math.PI) / 180;
      const ryr = (ownerPose.ryDeg * Math.PI) / 180;
      const rzr = (ownerPose.rzDeg * Math.PI) / 180;
      const cx = Math.cos(rxr), sxr = Math.sin(rxr);
      const cy = Math.cos(ryr), syr = Math.sin(ryr);
      const cz = Math.cos(rzr), szr = Math.sin(rzr);
      const bodyToLab = (v: Vec3T): Vec3T => {
        const x1 = cy * v[0] + syr * v[2];
        const y1 = v[1];
        const z1 = -syr * v[0] + cy * v[2];
        const x2 = x1;
        const y2 = cx * y1 - sxr * z1;
        const z2 = sxr * y1 + cx * z1;
        return [
          ownerPose.xMm + cz * x2 - szr * y2,
          ownerPose.yMm + szr * x2 + cz * y2,
          ownerPose.zMm + z2,
        ];
      };
      const bodyToLabDir = (v: Vec3T): Vec3T => {
        const x1 = cy * v[0] + syr * v[2];
        const y1 = v[1];
        const z1 = -syr * v[0] + cy * v[2];
        const x2 = x1;
        const y2 = cx * y1 - sxr * z1;
        const z2 = sxr * y1 + cx * z1;
        return [cz * x2 - szr * y2, szr * x2 + cz * y2, z2];
      };
      return { bodyToLab, bodyToLabDir };
    };

    const ports: import("../utils/rfCableAlignment").RfPortLab[] = [];
    for (const other of state.scene.objects) {
      if (other.id === objectId) continue;
      const otherComp = state.scene.components.find((c) => c.id === other.componentId);
      if (!otherComp) continue;
      const asset = otherComp.asset3dId
        ? state.scene.assets.find((a) => a.id === otherComp.asset3dId)
        : null;
      if (!asset || !Array.isArray(asset.anchors)) continue;
      const { bodyToLab, bodyToLabDir } = makeOwnerTransforms(other);
      for (const a of asset.anchors) {
        if (a.id !== "rf_in" && a.id !== "rf_out") continue;
        const posBody: Vec3T = [
          a.positionMmBodyLocal.x,
          a.positionMmBodyLocal.y,
          a.positionMmBodyLocal.z,
        ];
        const dirBody: Vec3T = a.directionBodyLocal
          ? [a.directionBodyLocal.x, a.directionBodyLocal.y, a.directionBodyLocal.z]
          : [1, 0, 0];
        ports.push({
          labPosMm: bodyToLab(posBody),
          labDirOutward: bodyToLabDir(dirBody),
          targetName: other.name,
          targetObjectId: other.id,
          targetAnchorName: a.name ?? a.id,
          targetAnchorId: a.id,
        });
      }
    }
    if (ports.length === 0) return [];

    const { findRfCableEndpointAlignmentCandidates } = await import("../utils/rfCableAlignment");
    return findRfCableEndpointAlignmentCandidates({
      endpoint: end,
      cablePose: {
        xMm: obj.xMm, yMm: obj.yMm, zMm: obj.zMm,
        rxDeg: obj.rxDeg, ryDeg: obj.ryDeg, rzDeg: obj.rzDeg,
      },
      cableNodes: nodes,
      ports,
      toleranceMm,
    });
  },

  async applyRfCableAlignmentCandidate(objectId, end, candidate) {
    // Phase B: stitch the precomputed candidate back into the rf_cable's
    // node array and write through `updateRfCableNodes`. Only the touched
    // endpoint's posMm + the matching handle change; the other handle on
    // this node and every interior node are preserved verbatim.
    const state = get();
    const obj = state.scene.objects.find((o) => o.id === objectId);
    if (!obj) return;
    const component = state.scene.components.find((c) => c.id === obj.componentId);
    if (!component) return;
    const objProps = obj.properties as { rfCableNodes?: FiberNodePersist[] } | undefined;
    const lengthMm = (() => {
      const v = (component.properties as { lengthMm?: number } | undefined)?.lengthMm;
      return typeof v === "number" ? v : 150;
    })();
    const nodes: FiberNodePersist[] =
      (objProps?.rfCableNodes && objProps.rfCableNodes.length >= 2)
        ? objProps.rfCableNodes
        : [
            { posMm: [-lengthMm / 2, 0, 0] },
            { posMm: [lengthMm / 2, 0, 0] },
          ];
    const idx = end === "A" ? 0 : nodes.length - 1;
    const newNode: FiberNodePersist = {
      posMm: candidate.newPosMmBody,
      handleInMm:
        end === "B"
          ? candidate.newHandleMmBody
          : nodes[idx].handleInMm
            ? ([...nodes[idx].handleInMm] as [number, number, number])
            : undefined,
      handleOutMm:
        end === "A"
          ? candidate.newHandleMmBody
          : nodes[idx].handleOutMm
            ? ([...nodes[idx].handleOutMm] as [number, number, number])
            : undefined,
    };
    const nextNodes = [...nodes];
    nextNodes[idx] = newNode;
    // Persist the per-end link record alongside the node update so the
    // renderer can re-derive cable End A / End B at draw time whenever
    // the target SceneObject moves — the user's "logical connection"
    // requirement (B). Stored under
    //   SceneObject.properties.rfCableEndpoints[A|B]
    // The matching node[idx].posMm + handle stay populated as a fallback
    // for when the link can't be resolved (target deleted / archived).
    const existingEndpoints = (obj.properties as { rfCableEndpoints?: Record<string, unknown> } | undefined)
      ?.rfCableEndpoints ?? {};
    const nextEndpoints = {
      ...existingEndpoints,
      [end]: {
        targetObjectId: candidate.targetObjectId,
        targetAnchorId: candidate.targetAnchorId,
        targetAnchorName: candidate.targetAnchorName,
      },
    };
    const nextProps = {
      ...(obj.properties ?? {}),
      rfCableNodes: nextNodes,
      rfCableEndpoints: nextEndpoints,
    };
    const updated = await updateObjectApi(obj.id, { properties: nextProps });
    set((s) => ({
      scene: { ...s.scene, objects: upsertById(s.scene.objects, updated) },
    }));
  },

  async createRfCableBetweenPorts(args) {
    const { srcObjectId, srcAnchorId, srcAnchorName, tgtObjectId, tgtAnchorId, tgtAnchorName } = args;
    const state = get();
    if (srcObjectId === tgtObjectId) return null;

    // 1. Find a catalog rf_cable Component to instantiate. Prefer one
    //    whose componentType is exactly "rf_cable"; fall back to
    //    "sma_cable" for legacy templates.
    const cableComponent =
      state.scene.components.find((c) => c.componentType === "rf_cable")
        ?? state.scene.components.find((c) => c.componentType === "sma_cable");
    if (!cableComponent) return null;

    // 2. Resolve each endpoint's port lab position so the new SceneObject
    //    can land at the midpoint (the spline nodes will then be re-derived
    //    via applyRfCableAlignmentCandidate; the body pose just provides
    //    a sensible centre point + rotation = identity).
    type Vec3 = [number, number, number];
    type PortResolved = {
      labPos: Vec3;
      labDir: Vec3;
      anchorPosBody: Vec3;
      anchorDirBody: Vec3;
      targetName: string;
    };
    const resolvePort = (
      objectId: string,
      anchorId: string,
      anchorName: string,
    ): PortResolved | null => {
      const obj = state.scene.objects.find((o) => o.id === objectId);
      if (!obj) return null;
      const comp = state.scene.components.find((c) => c.id === obj.componentId);
      if (!comp) return null;
      const asset = comp.asset3dId
        ? state.scene.assets.find((a) => a.id === comp.asset3dId)
        : null;
      if (!asset || !Array.isArray(asset.anchors)) return null;
      const anchor = asset.anchors.find(
        (a) => a.id === anchorId && (a.name ?? a.id) === anchorName,
      );
      if (!anchor) return null;
      const anchorPosBody: Vec3 = [
        anchor.positionMmBodyLocal.x,
        anchor.positionMmBodyLocal.y,
        anchor.positionMmBodyLocal.z,
      ];
      const anchorDirBody: Vec3 = anchor.directionBodyLocal
        ? [anchor.directionBodyLocal.x, anchor.directionBodyLocal.y, anchor.directionBodyLocal.z]
        : [1, 0, 0];
      // Body → lab using the owner's pose (Euler XYZ). Mirrors the
      // `makeOwnerTransforms` block in findRfCableAlignmentCandidates.
      const rxr = (obj.rxDeg * Math.PI) / 180;
      const ryr = (obj.ryDeg * Math.PI) / 180;
      const rzr = (obj.rzDeg * Math.PI) / 180;
      const cx = Math.cos(rxr), sxr = Math.sin(rxr);
      const cy = Math.cos(ryr), syr = Math.sin(ryr);
      const cz = Math.cos(rzr), szr = Math.sin(rzr);
      const apply = (v: Vec3, includeTranslation: boolean): Vec3 => {
        const x1 = cy * v[0] + syr * v[2];
        const y1 = v[1];
        const z1 = -syr * v[0] + cy * v[2];
        const y2 = cx * y1 - sxr * z1;
        const z2 = sxr * y1 + cx * z1;
        return [
          (includeTranslation ? obj.xMm : 0) + cz * x1 - szr * y2,
          (includeTranslation ? obj.yMm : 0) + szr * x1 + cz * y2,
          (includeTranslation ? obj.zMm : 0) + z2,
        ];
      };
      return {
        labPos: apply(anchorPosBody, true),
        labDir: apply(anchorDirBody, false),
        anchorPosBody,
        anchorDirBody,
        targetName: obj.name,
      };
    };

    const src = resolvePort(srcObjectId, srcAnchorId, srcAnchorName);
    const tgt = resolvePort(tgtObjectId, tgtAnchorId, tgtAnchorName);
    if (!src || !tgt) return null;

    // 3. Create the new cable SceneObject at the midpoint. Identity
    //    rotation — the spline nodes carry the actual end-to-end vector
    //    so the cable's body frame doesn't need to be tilted.
    const midX = (src.labPos[0] + tgt.labPos[0]) / 2;
    const midY = (src.labPos[1] + tgt.labPos[1]) / 2;
    const midZ = (src.labPos[2] + tgt.labPos[2]) / 2;
    const cableObj = await createObjectApi({
      componentId: cableComponent.id,
      collectionId: get().activeCollectionId,
      xMm: midX, yMm: midY, zMm: midZ,
      rxDeg: 0, ryDeg: 0, rzDeg: 0,
      visible: true,
      locked: false,
    } as Parameters<typeof createObjectApi>[0]);
    // Push into the store immediately so the subsequent
    // applyRfCableAlignmentCandidate calls can read the cable back from
    // get().scene.objects without waiting for the next websocket tick.
    set((s) => ({
      scene: { ...s.scene, objects: upsertById(s.scene.objects, cableObj) },
    }));

    // 4. Attach both ends via the existing align helper. We construct
    //    a synthetic candidate per end — `resolveLinkedRfCableEndpoint`
    //    in rfCableAnchorResolver.ts back-derives the body-local node +
    //    handle that puts the connector tip exactly on the target port.
    const { resolveLinkedRfCableEndpoint } = await import("../utils/rfCableAnchorResolver");
    const cablePose = {
      xMm: midX, yMm: midY, zMm: midZ,
      rxDeg: 0, ryDeg: 0, rzDeg: 0,
    };
    const buildCandidate = (
      end: "A" | "B",
      port: PortResolved,
      targetObjectId: string,
      targetAnchorId: string,
      targetAnchorName: string,
    ) => {
      const targetPose = (() => {
        const o = get().scene.objects.find((oo) => oo.id === targetObjectId);
        return {
          xMm: o?.xMm ?? 0, yMm: o?.yMm ?? 0, zMm: o?.zMm ?? 0,
          rxDeg: o?.rxDeg ?? 0, ryDeg: o?.ryDeg ?? 0, rzDeg: o?.rzDeg ?? 0,
        };
      })();
      const result = resolveLinkedRfCableEndpoint({
        endpoint: end,
        cablePose,
        targetPose,
        targetAnchorPosBodyMm: port.anchorPosBody,
        targetAnchorDirBody: port.anchorDirBody,
      });
      if (!result) return null;
      return {
        targetObjectId,
        targetAnchorId,
        targetAnchorName,
        targetName: port.targetName,
        distMm: 0,
        newPosMmBody: result.posMmBody,
        newHandleMmBody: result.handleMmBody,
      } as import("../utils/rfCableAlignment").RfCableAlignmentResult;
    };
    const candA = buildCandidate("A", src, srcObjectId, srcAnchorId, srcAnchorName);
    const candB = buildCandidate("B", tgt, tgtObjectId, tgtAnchorId, tgtAnchorName);
    if (candA) await get().applyRfCableAlignmentCandidate(cableObj.id, "A", candA);
    if (candB) await get().applyRfCableAlignmentCandidate(cableObj.id, "B", candB);
    return cableObj.id;
  },

  async alignRfCableEndToPort(objectId, end, toleranceMm = 25) {
    // Thin back-compat shim: list candidates, apply the closest, return
    // {offsetMm, targetName} in the legacy UI-facing shape. New UI should
    // call findRfCableAlignmentCandidates + applyRfCableAlignmentCandidate
    // directly so the picker can disambiguate multiple targets.
    const list = await get().findRfCableAlignmentCandidates(objectId, end, toleranceMm);
    if (list.length === 0) return null;
    const top = list[0];
    await get().applyRfCableAlignmentCandidate(objectId, end, top);
    return {
      offsetMm: top.distMm,
      targetName: `${top.targetName} · ${top.targetAnchorName}`,
    };
  },

  async setFiberPortLabPose(componentId, end, targetPosLab, targetOutwardLab) {
    const state = get();
    const obj = state.scene.objects.find((o) => o.componentId === componentId);
    const objProps = obj?.properties as { fiberNodes?: FiberNodePersist[] } | undefined;
    const compProps = state.scene.components.find((c) => c.id === componentId)?.properties as
      { fiberNodes?: FiberNodePersist[] } | undefined;
    const nodes = objProps?.fiberNodes ?? compProps?.fiberNodes;
    if (!nodes || nodes.length < 2) return;
    const nextNodes = withFiberPortLabPose({
      end,
      nodes,
      pose: {
        xMm: obj?.xMm ?? 0,
        yMm: obj?.yMm ?? 0,
        zMm: obj?.zMm ?? 0,
        rxDeg: obj?.rxDeg ?? 0,
        ryDeg: obj?.ryDeg ?? 0,
        rzDeg: obj?.rzDeg ?? 0,
      },
      targetPosLab,
      targetOutwardLab,
    });
    if (nextNodes === nodes) return;
    await get().updateFiberNodes(componentId, nextNodes);
  },

  async toggleFiberBeamEntry(objectId, end) {
    const obj = get().scene.objects.find((o) => o.id === objectId);
    if (!obj) return;
    const current = (obj.properties as { beamEntryEnd?: "A" | "B" } | undefined)?.beamEntryEnd;
    const next: "A" | "B" | null = current === end ? null : end;
    const baseProps = (obj.properties ?? {}) as Record<string, unknown>;
    const nextProps: Record<string, unknown> = { ...baseProps };
    if (next === null) {
      delete nextProps.beamEntryEnd;
    } else {
      nextProps.beamEntryEnd = next;
    }
    await get().updateSceneObject(objectId, {
      properties: nextProps as SceneObject["properties"],
    });
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

    // Rigid-group expansion: if the leading object lives in a collection
    // sub-tree where rigidTransform=true and the patch carries a pose change,
    // fan out the same world-space rigid-body transform to every group
    // member so the relative pose A↔B↔C stays fixed. See
    // utils/rigidGroup.ts for the math. Expansion is silent when no rigid
    // group applies; rejects (no-op) if any non-leading member is locked,
    // because a partial rigid move would silently break the invariant the
    // user enables rigidTransform to get.
    if (currentObject && patchHasPoseChange(safePatch)) {
      const expansion = expandPoseToRigidGroup(get().scene, currentObject, safePatch);
      if (expansion.kind === "rejectedLockedMember") {
        // eslint-disable-next-line no-console
        console.warn(
          "[rigidTransform] Move rejected — locked member(s) in rigid group:",
          expansion.lockedIds,
        );
        return;
      }
      if (expansion.kind === "group") {
        const updated = await Promise.all(
          expansion.entries.map((entry) => updateObjectApi(entry.id, entry.patch)),
        );
        set((current) => {
          const leadingObj = updated.find((o) => o.id === objectId) ?? updated[0];
          return {
            selectedObjectId: leadingObj?.id ?? objectId,
            selectedObjectIds: current.selectedObjectIds.includes(leadingObj?.id ?? objectId)
              ? current.selectedObjectIds
              : [leadingObj?.id ?? objectId],
            selectedComponentId: null,
            scene: {
              ...current.scene,
              objects: upsertObjects(current.scene.objects, updated),
            },
          };
        });
        return;
      }
      // kind === "single": fall through to the regular single-object path.
    }

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
    // Locked objects can't be removed — same protection that blocks pose
    // mutation in stripLockedTransformPatch. Silently no-op so that a
    // multi-select delete (Promise.all over deleteObject(...)) skips locked
    // members and removes only the unlocked ones, matching the user-facing
    // spec: "若 select 多個 objects 他也在其中 執行 delete 不會 delete locked
    // 的 objects". Backend also returns 409 on locked as defense-in-depth.
    const target = get().scene.objects.find((object) => object.id === objectId);
    if (target?.locked) return;
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
    const existing = get().scene.physicsElements.find((item) => item.objectId === payload.objectId);
    let element: PhysicsElement;
    if (existing) {
      const { objectId, ...patch } = payload;
      element = await updateOpticalElementApi(objectId, patch);
    } else {
      element = await createOpticalElementApi(payload);
    }
    set((state) => {
      const others = state.scene.physicsElements.filter(
        (item) => item.objectId !== element.objectId,
      );
      return {
        scene: { ...state.scene, physicsElements: [...others, element] },
      };
    });
    return element;
  },

  async deleteOpticalElement(objectId) {
    await deleteOpticalElementApi(objectId);
    set((state) => ({
      scene: {
        ...state.scene,
        physicsElements: state.scene.physicsElements.filter(
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
        const others = state.scene.physicsElements.filter(
          (item) => !incomingIds.has(item.objectId),
        );
        return {
          scene: { ...state.scene, physicsElements: [...others, ...elements] },
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
        const others = state.scene.physicsElements.filter(
          (item) => !incomingIds.has(item.objectId),
        );
        return {
          scene: {
            ...state.scene,
            physicsElements: [...others, ...result.elements],
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
    // Locked objects are frozen for organizational moves too — same model as
    // delete and pose patches. A multi-select drag in the outliner calls this
    // in a Promise.all loop; silent no-op on locked lets the unlocked
    // members reparent while locked stays put. Backend also returns 409 on
    // locked as defense-in-depth.
    const target = get().scene.objects.find((object) => object.id === objectId);
    if (target?.locked) return;
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

  async loadTimingPrograms() {
    const programs = await listTimingProgramsApi();
    set((state) => ({
      scene: { ...state.scene, timingPrograms: programs },
    }));
  },

  async createTimingProgram(payload) {
    const program = await createTimingProgramApi(payload);
    set((state) => ({
      scene: {
        ...state.scene,
        timingPrograms: [...(state.scene.timingPrograms ?? []), program],
      },
    }));
    return program;
  },

  async updateTimingProgram(programId, patch) {
    const program = await updateTimingProgramApi(programId, patch);
    set((state) => ({
      scene: {
        ...state.scene,
        timingPrograms: (state.scene.timingPrograms ?? []).map((p) =>
          p.id === programId ? program : p,
        ),
      },
    }));
    return program;
  },

  async deleteTimingProgram(programId) {
    await deleteTimingProgramApi(programId);
    set((state) => ({
      scene: {
        ...state.scene,
        timingPrograms: (state.scene.timingPrograms ?? []).filter(
          (p) => p.id !== programId,
        ),
      },
    }));
  },

  async updateDeviceState(objectId, patch) {
    const existing = get().scene.deviceStates.find((d) => d.objectId === objectId);
    const merged = { ...(existing?.state ?? {}), ...patch };
    const updated = await updateDeviceStateApi(objectId, merged);
    set((state) => ({
      scene: {
        ...state.scene,
        deviceStates: upsertDeviceState(state.scene.deviceStates, updated),
      },
    }));
    return updated;
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

  setEditorMode(mode) {
    set({ editorMode: mode });
  },

  setCurrentModule(module) {
    set({ currentModule: module });
  },

  async loadRecentSimulationRuns(module, limit = 20) {
    const runs = await fetchSimulationRunsApi(module, limit);
    set({ recentSimulationRuns: runs });
  },

  async dispatchSimulationRun(payload) {
    const run = await createSimulationRunApi(payload);
    set((state) => ({
      recentSimulationRuns: [
        run,
        ...state.recentSimulationRuns.filter((r) => r.id !== run.id),
      ].slice(0, 20),
    }));
    return run;
  },

  async loadCircuits() {
    const circuits = await fetchCircuitsApi(100);
    set((state) => {
      // Auto-select the most recent circuit if none selected.
      const next = state.selectedCircuitId ?? circuits[0]?.id ?? null;
      return { circuits, selectedCircuitId: next };
    });
  },

  async createCircuit(payload) {
    const circuit = await createCircuitApi(payload);
    set((state) => ({
      circuits: [circuit, ...state.circuits.filter((c) => c.id !== circuit.id)],
      selectedCircuitId: circuit.id,
    }));
    return circuit;
  },

  async updateCircuit(id, patch) {
    const updated = await updateCircuitApi(id, patch);
    set((state) => ({
      circuits: state.circuits.map((c) => (c.id === id ? updated : c)),
    }));
    return updated;
  },

  async deleteCircuit(id) {
    await deleteCircuitApi(id);
    set((state) => {
      const remaining = state.circuits.filter((c) => c.id !== id);
      const next =
        state.selectedCircuitId === id ? remaining[0]?.id ?? null : state.selectedCircuitId;
      return { circuits: remaining, selectedCircuitId: next };
    });
  },

  setSelectedCircuit(id) {
    set({ selectedCircuitId: id });
  },

  async loadEmProblems() {
    const ems = await fetchEmProblemsApi(100);
    set((state) => {
      const next = state.selectedEmProblemId ?? ems[0]?.id ?? null;
      return { emProblems: ems, selectedEmProblemId: next };
    });
  },

  async loadRfChains() {
    const chains = await fetchAllRfChainsApi();
    set({ rfChains: chains });
  },

  setScrubTimeNs(tNs) {
    set({ scrubTimeNs: tNs });
  },

  async createEmProblem(payload) {
    const em = await createEmProblemApi(payload);
    set((state) => ({
      emProblems: [em, ...state.emProblems.filter((e) => e.id !== em.id)],
      selectedEmProblemId: em.id,
    }));
    return em;
  },

  async updateEmProblem(id, patch) {
    const updated = await updateEmProblemApi(id, patch);
    set((state) => ({
      emProblems: state.emProblems.map((e) => (e.id === id ? updated : e)),
    }));
    return updated;
  },

  async deleteEmProblem(id) {
    await deleteEmProblemApi(id);
    set((state) => {
      const remaining = state.emProblems.filter((e) => e.id !== id);
      const next =
        state.selectedEmProblemId === id ? remaining[0]?.id ?? null : state.selectedEmProblemId;
      return { emProblems: remaining, selectedEmProblemId: next };
    });
  },

  setSelectedEmProblem(id) {
    set({ selectedEmProblemId: id });
  },

  async loadMeshes() {
    const meshes = await fetchMeshesApi(100);
    set({ meshes });
  },

  async uploadMesh(file, name) {
    const mesh = await uploadMeshApi(file, name);
    set((state) => ({ meshes: [mesh, ...state.meshes.filter((m) => m.id !== mesh.id)] }));
    return mesh;
  },

  async deleteMesh(id) {
    await deleteMeshApi(id);
    set((state) => ({ meshes: state.meshes.filter((m) => m.id !== id) }));
  },

  setEditingAssetId(assetId) {
    set({ editingAssetId: assetId });
  },

  openPhyEditor() {
    set({
      editorMode: "phy-editor",
      phyEditorView: null,
      phyEditorDirty: false,
    });
  },

  closePhyEditor() {
    set({
      editorMode: "scene",
      phyEditorView: null,
      editingAssetId: null,
      phyEditorDirty: false,
    });
  },

  setPhyEditorView(view) {
    set({ phyEditorView: view, phyEditorDirty: false });
  },

  setPhyEditorDirty(dirty) {
    set({ phyEditorDirty: dirty });
  },

  async updateAssetAnchors(assetId, anchors) {
    // Backend Phase 4 schema: positionMmBodyLocal etc. The CamelModel
    // alias_generator converts to snake_case server-side.
    const updated = await updateAssetApi(assetId, { anchors });
    set((state) => ({
      scene: {
        ...state.scene,
        assets: state.scene.assets.map((a) =>
          a.id === assetId ? (updated as Asset3D) : a,
        ),
      },
    }));
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
        case "physics_element.updated": {
          const payload = event.payload as Partial<PhysicsElement> & { deleted?: boolean; objectId?: string };
          const objectId = payload.objectId;
          if (!objectId) return state;
          if (payload.deleted) {
            return {
              scene: {
                ...scene,
                physicsElements: scene.physicsElements.filter((item) => item.objectId !== objectId),
                opticalLinks: scene.opticalLinks.filter(
                  (link) => link.fromObjectId !== objectId && link.toObjectId !== objectId,
                ),
              },
            };
          }
          const others = scene.physicsElements.filter((item) => item.objectId !== objectId);
          return {
            scene: { ...scene, physicsElements: [...others, payload as PhysicsElement] },
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
        case "simulation_run.status_changed": {
          // Multiphysics WS event. Only mutate rows we already track in
          // recentSimulationRuns; if the id is unknown we ignore — the
          // SolverConsole will pick it up the next time it refetches.
          const payload = event.payload;
          const recentSimulationRuns = state.recentSimulationRuns.map((run) =>
            run.id === payload.id
              ? {
                  ...run,
                  status: payload.status,
                  progress: payload.progress,
                  errorMessage: payload.errorMessage,
                }
              : run,
          );
          // When the row hits a terminal state, fetch the full row in the
          // background so consumers (WaveformChart etc.) get
          // resultSummary + finishedAt without polling. WS payload only
          // carries status/progress/error to keep events small.
          if (payload.status === "completed" || payload.status === "failed") {
            void fetchSimulationRunApi(payload.id)
              .then((fullRow) => {
                set((s) => ({
                  recentSimulationRuns: s.recentSimulationRuns.map((r) =>
                    r.id === fullRow.id ? fullRow : r,
                  ),
                }));
              })
              .catch(() => {
                /* swallow — UI keeps the partial row */
              });
          }
          return { recentSimulationRuns };
        }
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
          const others = programs.filter((p) => p.id !== program.id);
          return {
            scene: { ...scene, timingPrograms: [...others, program] },
          };
        }
        case "timing_program.deleted": {
          const programId = event.payload.id;
          return {
            scene: {
              ...scene,
              timingPrograms: (scene.timingPrograms ?? []).filter(
                (p) => p.id !== programId,
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
