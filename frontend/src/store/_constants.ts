/**
 * Sub-module of sceneStore — constant-data definitions split out to
 * keep the store file tractable. Touch-tool operations + empty scene
 * scaffolding + localStorage keys.
 *
 * sceneStore.ts re-exports the public symbols here, so consumers
 * importing `TOUCH_OPS` / `TOUCH_OP_BY_ID` from `../store/sceneStore`
 * continue to work unchanged.
 */
import type { SceneData } from "../types/digitalTwin";

// =============================================================================
// Touch tool operations (kinematic-mate coincidence picker)
// =============================================================================

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

// =============================================================================
// Empty scene scaffolding (used at store init + after destructive ops)
// =============================================================================

export const emptyScene: SceneData = {
  assets: [],
  components: [],
  objects: [],
  connections: [],
  assemblyRelations: [],
  beamPaths: [],
  deviceStates: [],
  physicsElements: [],
  opticalLinks: [],
  beamSegments: [],
  sceneViews: [],
  collections: [],
  collectionMembers: [],
  timingPrograms: [],
};

// =============================================================================
// localStorage keys (defined here so _persistence.ts and any future
// migration script share the canonical names)
// =============================================================================

export const ACTIVE_COLLECTION_STORAGE_KEY = "qmem.outliner.activeCollectionId";

// Cursor persistence — v2 stores both panels' cursors so dual-view can
// restore each panel's pivot independently. Reads from the v1 single-
// cursor key as a fallback if v2 isn't present yet.
export const TRANSFORM_CURSOR_STORAGE_KEY_V1 = "qmem.transformCursorMm.v1";
export const TRANSFORM_CURSOR_STORAGE_KEY = "qmem.transformCursorMm.v2";
export const TRANSFORM_CURSOR_HIDDEN_STORAGE_KEY = "qmem.transformCursorHidden.v1";
