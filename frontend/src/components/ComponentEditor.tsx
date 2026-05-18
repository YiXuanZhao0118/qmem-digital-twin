/**
 * ComponentEditor ??sub-editor inside the PHY editor. Edits the
 * anchor geometry (Asset.anchors[]) of a single 3D model (Layer 2 in
 * the four-layer model). Hosted by `<PhyEditor>` when the left-rail
 * navigation is at "Optical ??Components".
 *
 * Layout:
 *   ??????????????砂??????????????????????????砂??????????????? *   ??COMPONENTS ??  3D VIEWPORT (wire)    ?? INSPECTOR  ?? *   ??(with fn)  ??  anchors + gizmo       ?? + kind     ?? *   ??           ??                        ?? contract   ?? *   ??????????????氯??????????????????????????氯??????????????? *
 * Editing flow:
 *   1. User clicks component in left list ??editor focuses on its Asset3D
 *   2. Mesh loads (wireframe edges only), anchors render as colored
 *      spheres at their `positionMmBodyLocal` (Z-up mm body-local).
 *   3. Click a sphere ??TransformControls 3-axis arrows; drag updates
 *      *local* anchor draft state.
 *   4. Inspector lets user edit id (whitelist dropdown), xMm/yMm/zMm,
 *      apertureMm, or delete the anchor; "+" adds a new one.
 *   5. Save ??PUT /api/assets/:id { anchors: [...] }.
 *
 * Back navigation lives in the parent <PhyEditor>'s top bar.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

import { useSceneStore } from "../store/sceneStore";
import type { Anchor, Asset3D, ComponentItem, ElementKind } from "../types/digitalTwin";
import { loadAssetObject, type FiberNode } from "../three/loadAsset";
import { FIBER_FERRULE_TIP_MM } from "../utils/fiberAnchorResolver";
import { mmToThree, threeToMm } from "../optical/frames";
import {
  EDITABLE_ANCHOR_IDS,
  KIND_REGISTRY,
  getKindContract,
  kindsWithEditableAnchors,
  type AnchorId,
  type KindContract,
} from "../kinds/_registry";
import { componentTypeToElementKind } from "../utils/elementDefaults";
import {
  COMPONENT_ANCHOR_CONTRACTS,
  anchorMatchesTemplate,
  getAnchorContractFor,
  type AnchorTemplate,
} from "./componentAnchorContracts";
import { computeBraggTiltAxisFromRfDirectionBodyLocal } from "../optical/kinds/aom/physics";
// Inspector face-section components — extracted into a sibling file so
// they can be reused and reviewed independently of the main editor.
// Six "simple" sections live there; the three complex ones
// (TaperedAmplifier / FiberPatchCable / Aom) stay in this file because
// they pull in physics helpers and state hooks that aren't worth
// dragging through the import boundary yet.
import {
  ConnectorTypeField,
  ApertureShapeFields,
  EditableAnchorFields,
  MirrorFaceSection,
  LensFaceSection,
  LaserSourceFaceSection,
  WaveplateFaceSection,
  BeamSplitterFaceSection,
} from "./component_editor/AnchorFaceSections";

/** Map an AnchorId to a stable hue/colour for the marker sphere. Picks
 *  the same colour every time so the user builds visual habits. */
function anchorColour(id: string): number {
  switch (id) {
    case "intercept_in":
    case "in":
    case "seed":
      return 0x22c55e;          // green ??input port
    case "intercept_out":
    case "out":
      return 0xef4444;          // red ??output port
    case "intercept_face":
      return 0x3b82f6;          // blue ??reflective face
    case "optical_anchor":
      return 0xa855f7;          // purple
    case "center":
      return 0xfacc15;          // yellow
    // RF ports get an amber accent so they're visually distinct from
    // optical (green/red) ports. Matches .physics-panel-rf chrome.
    case "rf_in":
      return 0xfbbf24;          // light amber ??RF input
    case "rf_out":
      return 0xf59e0b;          // amber ??RF output
    case "aperture":
      return 0xfb923c;          // orange ??horn aperture face
    default:
      return 0xf97316;          // orange ??bbox face anchors etc.
  }
}

/** Simple anchor draft state: the editor mutates this in-memory; only
 *  the Save button promotes it to the store + backend. */
type AnchorDraft = Anchor & { __key: string };

function freshKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

function anchorToDraft(a: Anchor): AnchorDraft {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    positionMmBodyLocal: { ...a.positionMmBodyLocal },
    directionBodyLocal: a.directionBodyLocal ? { ...a.directionBodyLocal } : undefined,
    apertureMm: a.apertureMm,
    // Rectangular aperture (PBS / BS diagonal plane). Pre-fix bug: these
    // were dropped here, so `Width = 36 mm` saved correctly to the
    // backend but on the next load the draft re-initialised to the
    // 2*apertureMm fallback — the user saw the value revert and
    // concluded "Save failed" when it had actually persisted.
    apertureWidthMm: a.apertureWidthMm,
    apertureHeightMm: a.apertureHeightMm,
    apertureShape: a.apertureShape,
    // Fiber-port tracking flag (preserve through save/load round-trip).
    derivedFromFiberEndpoint: a.derivedFromFiberEndpoint,
    // RF / TTL connector gender — same load-path bug as `apertureWidthMm`
    // above: leaving this out lets Save persist the value to the backend
    // but the dropdown re-initialises to "— unset —" on next open.
    connectorType: a.connectorType,
    fastAxisDegBodyLocal: a.fastAxisDegBodyLocal,
    __key: freshKey(),
  };
}

function draftToAnchor(d: AnchorDraft): Anchor {
  const { __key: _, ...anchor } = d;
  return anchor;
}

type FiberEnd = "A" | "B";
type FiberSlowAxis = "x" | "y" | "z";
type FiberSlowAxisDraft = { endA: FiberSlowAxis; endB: FiberSlowAxis };

// Canonical ferrule housing length lives in fiberAnchorResolver.ts. Re-
// export here under the legacy name so existing call sites keep working
// after centralising the constant.
const DEFAULT_FIBER_FERRULE_TIP_MM = FIBER_FERRULE_TIP_MM;

function normalizeVec3(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const mag = Math.hypot(v.x, v.y, v.z);
  if (mag < 1e-9) return { x: 0, y: 1, z: 0 };
  return { x: v.x / mag, y: v.y / mag, z: v.z / mag };
}

function fiberNodesForComponent(component: ComponentItem): FiberNode[] {
  const raw = (component.properties as { fiberNodes?: FiberNode[] } | undefined)?.fiberNodes;
  if (Array.isArray(raw) && raw.length >= 2) return raw;
  return [
    { posMm: [0, 0, 50], handleOutMm: [100, 0, 0] },
    { posMm: [300, 0, 50], handleInMm: [-100, 0, 0] },
  ];
}

function fiberEndpointOutwardLab(nodes: FiberNode[], end: FiberEnd): { x: number; y: number; z: number } {
  const idx = end === "A" ? 0 : nodes.length - 1;
  const neighbourIdx = end === "A" ? 1 : nodes.length - 2;
  const node = nodes[idx];
  const neighbour = nodes[neighbourIdx];
  const handle = end === "A" ? node.handleOutMm : node.handleInMm;
  if (handle && handle[0] ** 2 + handle[1] ** 2 + handle[2] ** 2 > 1e-9) {
    return normalizeVec3({ x: -handle[0], y: -handle[1], z: -handle[2] });
  }
  return normalizeVec3({
    x: node.posMm[0] - neighbour.posMm[0],
    y: node.posMm[1] - neighbour.posMm[1],
    z: node.posMm[2] - neighbour.posMm[2],
  });
}

function fiberEndSpecFromComponent(
  component: ComponentItem,
  end: FiberEnd,
): { polish?: string; polishAngleDeg?: number } {
  const override = (component.properties as
    | {
        fiberKindParamsOverride?: {
          endA?: { polish?: string; polishAngleDeg?: number };
          endB?: { polish?: string; polishAngleDeg?: number };
        };
      }
    | undefined)?.fiberKindParamsOverride;
  const spec = end === "A" ? override?.endA : override?.endB;
  return {
    polish: spec?.polish,
    polishAngleDeg: spec?.polishAngleDeg,
  };
}

function fiberPolishedNormalBodyLocal(
  component: ComponentItem,
  end: FiberEnd,
  outward: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const spec = fiberEndSpecFromComponent(component, end);
  const rawAngle =
    typeof spec.polishAngleDeg === "number" && Number.isFinite(spec.polishAngleDeg)
      ? spec.polishAngleDeg
      : spec.polish === "APC"
        ? 8
        : 0;
  if (Math.abs(rawAngle) < 1e-6) return outward;
  // APC is a real slanted emission face in the connector model, not a
  // face perpendicular to the ferrule axis. Preserve the stored sign so
  // the helper ring matches the actual model geometry convention.
  const theta = (rawAngle * Math.PI) / 180;
  const localNormalThree = new THREE.Vector3(0, Math.cos(theta), Math.sin(theta)).normalize();
  const outwardThree = new THREE.Vector3(outward.x, outward.z, -outward.y);
  if (outwardThree.lengthSq() < 1e-12) return outward;
  outwardThree.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    outwardThree,
  );
  const normalThree = localNormalThree.applyQuaternion(q).normalize();
  return normalizeVec3({
    x: normalThree.x,
    y: -normalThree.z,
    z: normalThree.y,
  });
}

function fiberDefaultPortAnchor(component: ComponentItem, end: FiberEnd): Omit<AnchorDraft, "__key"> {
  const nodes = fiberNodesForComponent(component);
  const idx = end === "A" ? 0 : nodes.length - 1;
  const outward = fiberEndpointOutwardLab(nodes, end);
  const normal = fiberPolishedNormalBodyLocal(component, end, outward);
  const base = nodes[idx].posMm;
  return {
    id: end === "A" ? "intercept_in" : "intercept_out",
    // Stored coords are the snapshot of "where the port would be if the
    // spline stayed in its current shape" — kept as fallback for tools
    // that don't yet honour `derivedFromFiberEndpoint`. The marker below
    // is the live source of truth for renderers / ray-tracer / solver
    // that DO honour it.
    positionMmBodyLocal: {
      x: base[0] + outward.x * DEFAULT_FIBER_FERRULE_TIP_MM,
      y: base[1] + outward.y * DEFAULT_FIBER_FERRULE_TIP_MM,
      z: base[2] + outward.z * DEFAULT_FIBER_FERRULE_TIP_MM,
    },
    directionBodyLocal: normal,
    apertureMm: 2.5,
    // Mark the port as "tracks the fiber endpoint" — when the user drags
    // the spline endpoint in solid view, consumers that go through
    // `utils/fiberAnchorResolver` re-derive the port's body-local pose
    // from the current spline rather than reading the stored snapshot
    // above. New fiber anchors default to derived; users can clear this
    // field to pin the port at a fixed body-local position.
    derivedFromFiberEndpoint: end,
  };
}

function fiberSlowAxisFromComponent(
  component: ComponentItem | null,
  opticalParams: unknown,
): FiberSlowAxisDraft {
  const override = (component?.properties as
    | {
        fiberKindParamsOverride?: {
          endA?: { slowAxisAxisBodyLocal?: unknown; slowAxisDegInBodyFrame?: number };
          endB?: { slowAxisAxisBodyLocal?: unknown; slowAxisDegInBodyFrame?: number };
        };
      }
    | undefined)?.fiberKindParamsOverride;
  const params = opticalParams as
    | {
        endA?: { slowAxisAxisBodyLocal?: unknown; slowAxisDegInBodyFrame?: number };
        endB?: { slowAxisAxisBodyLocal?: unknown; slowAxisDegInBodyFrame?: number };
      }
    | undefined;
  return {
    endA: fiberSlowAxisFromUnknown(
      override?.endA?.slowAxisAxisBodyLocal ??
      params?.endA?.slowAxisAxisBodyLocal ??
      override?.endA?.slowAxisDegInBodyFrame ??
      params?.endA?.slowAxisDegInBodyFrame ??
      "x",
    ),
    endB: fiberSlowAxisFromUnknown(
      override?.endB?.slowAxisAxisBodyLocal ??
      params?.endB?.slowAxisAxisBodyLocal ??
      override?.endB?.slowAxisDegInBodyFrame ??
      params?.endB?.slowAxisDegInBodyFrame ??
      "x",
    ),
  };
}

function fiberSlowAxisFromUnknown(value: unknown): FiberSlowAxis {
  if (value === "x" || value === "y" || value === "z") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const folded = ((value % 180) + 180) % 180;
    return Math.abs(folded - 90) < 45 ? "z" : "x";
  }
  return "x";
}

function fiberSlowAxisToLegacyDeg(axis: FiberSlowAxis): number {
  if (axis === "z") return 90;
  return 0;
}

function fiberSlowAxisVectorThree(axis: FiberSlowAxis): THREE.Vector3 {
  if (axis === "y") return new THREE.Vector3(0, 0, -1);
  if (axis === "z") return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(1, 0, 0);
}

/** Given a raycast hit on a mesh, find the visual "face" the user
 *  meant ??i.e. the connected cluster of coplanar triangles around the
 *  hit triangle ??and return its centroid + average normal in
 *  body-local Z-up mm.
 *
 *  Algorithm:
 *    1. Look up the hit triangle's three vertex indices in the mesh's
 *       BufferGeometry.
 *    2. Build edge ??adjacent-triangles map for the whole geometry.
 *    3. BFS from the hit triangle, expanding to neighbours whose
 *       face-normal aligns with the hit normal within 5簞 (cos > 0.996).
 *    4. Average the cluster's vertex positions to get a centroid in
 *       mesh-local space.
 *    5. Apply mesh.matrixWorld ??wrapper-local-inverse to land in the
 *       wrapper's three.js Y-up frame.
 *    6. Axis-swap to body-local Z-up mm.
 *
 *  Returns null when the hit is malformed (no face, no positions). */
function computeCoplanarFace(
  hit: THREE.Intersection,
  wrapper: THREE.Object3D,
): {
  posMm: { x: number; y: number; z: number };
  dirBodyLocal: { x: number; y: number; z: number };
  /** Boundary-edge endpoints in WRAPPER-LOCAL three.js Y-up units, ready
   *  to feed into a `LineSegments` BufferGeometry for outline rendering.
   *  Each consecutive pair = one edge. */
  outlinePointsWrapperThree: number[];
  /** The actual coplanar mesh triangles hit in WRAPPER-LOCAL three.js
   *  Y-up units. Each consecutive triple of vertices = one triangle.
   *  This is used for the yellow hover fill so the preview is the same
   *  wireframe face the user clicked, not a synthetic helper plane. */
  faceTrianglesWrapperThree: number[];
} | null {
  if (!hit.face || !hit.object) return null;
  const mesh = hit.object as THREE.Mesh;
  const rawGeometry = mesh.geometry as THREE.BufferGeometry | undefined;
  if (!rawGeometry) return null;

  // Phase-7-mirror-pick fix: STLLoader returns non-indexed BufferGeometry,
  // where every triangle owns 3 unique vertex indices. Without merging,
  // edge-adjacency BFS finds NO neighbours (no two triangles ever share
  // a vertex index) and the cluster collapses to a single triangle ??  // the user sees a tiny yellow triangle instead of the disc face.
  // Run mergeVertices() with a tight position tolerance to dedupe and
  // produce an indexed geometry where edges genuinely link triangles.
  // mergeVertices preserves triangle order, so `hit.faceIndex` (read
  // from the original raycast) still points at the same physical
  // triangle in the merged geometry.
  let geometry: THREE.BufferGeometry;
  try {
    geometry = rawGeometry.index ? rawGeometry : mergeVertices(rawGeometry, 1e-6);
  } catch {
    geometry = rawGeometry;
  }

  const positions = geometry.getAttribute("position") as
    | THREE.BufferAttribute
    | undefined;
  if (!positions) return null;
  const indexAttr = geometry.getIndex();
  const triCount = indexAttr ? indexAttr.count / 3 : positions.count / 3;
  if (triCount === 0) return null;

  // Helper: get vertex index for the i-th vertex of triangle t.
  const triVertIdx = (t: number, k: 0 | 1 | 2): number =>
    indexAttr ? indexAttr.getX(t * 3 + k) : t * 3 + k;

  // Helper: triangle face normal in mesh-local space.
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const triNormal = (t: number): THREE.Vector3 => {
    va.fromBufferAttribute(positions, triVertIdx(t, 0));
    vb.fromBufferAttribute(positions, triVertIdx(t, 1));
    vc.fromBufferAttribute(positions, triVertIdx(t, 2));
    ab.subVectors(vb, va);
    ac.subVectors(vc, va);
    return new THREE.Vector3().crossVectors(ab, ac).normalize();
  };

  // Locate the hit triangle by matching `hit.face.a/b/c` (these are
  // ALREADY in the index/attribute space). Three.js sets `hit.faceIndex`
  // when it can ??prefer that.
  let startTri = -1;
  if (typeof hit.faceIndex === "number") {
    startTri = hit.faceIndex;
  } else {
    const hitA = hit.face.a;
    const hitB = hit.face.b;
    const hitC = hit.face.c;
    for (let t = 0; t < triCount; t++) {
      if (
        triVertIdx(t, 0) === hitA &&
        triVertIdx(t, 1) === hitB &&
        triVertIdx(t, 2) === hitC
      ) {
        startTri = t;
        break;
      }
    }
  }
  if (startTri < 0) return null;

  const startNormal = triNormal(startTri).clone();

  // Build edge-to-tri map (each edge shared by typically 1 or 2 tris).
  const edgeKey = (u: number, v: number): string =>
    u < v ? `${u}_${v}` : `${v}_${u}`;
  const edgeToTris = new Map<string, number[]>();
  for (let t = 0; t < triCount; t++) {
    const a = triVertIdx(t, 0);
    const b = triVertIdx(t, 1);
    const c = triVertIdx(t, 2);
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const k = edgeKey(u, v);
      const list = edgeToTris.get(k);
      if (list) list.push(t);
      else edgeToTris.set(k, [t]);
    }
  }

  // BFS, accept neighbours whose normal is within 5簞 of the start.
  const COS_THRESHOLD = Math.cos((5 * Math.PI) / 180);
  const visited = new Set<number>();
  const cluster: number[] = [];
  const queue: number[] = [startTri];
  while (queue.length > 0) {
    const t = queue.shift() as number;
    if (visited.has(t)) continue;
    visited.add(t);
    const n = triNormal(t);
    if (n.dot(startNormal) < COS_THRESHOLD) continue;
    cluster.push(t);
    const a = triVertIdx(t, 0);
    const b = triVertIdx(t, 1);
    const c = triVertIdx(t, 2);
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const list = edgeToTris.get(edgeKey(u, v));
      if (!list) continue;
      for (const nb of list) {
        if (nb !== t && !visited.has(nb)) queue.push(nb);
      }
    }
  }
  if (cluster.length === 0) return null;

  // Centroid: average of unique vertex positions in mesh-local space.
  const usedVerts = new Set<number>();
  for (const t of cluster) {
    usedVerts.add(triVertIdx(t, 0));
    usedVerts.add(triVertIdx(t, 1));
    usedVerts.add(triVertIdx(t, 2));
  }
  const centroidLocal = new THREE.Vector3();
  for (const v of usedVerts) {
    centroidLocal.x += positions.getX(v);
    centroidLocal.y += positions.getY(v);
    centroidLocal.z += positions.getZ(v);
  }
  centroidLocal.divideScalar(usedVerts.size);

  // Mesh-local ??world.
  mesh.updateMatrixWorld(true);
  const centroidWorld = centroidLocal.clone().applyMatrix4(mesh.matrixWorld);
  // World ??wrapper-local (three Y-up).
  wrapper.updateMatrixWorld(true);
  const wrapperInv = wrapper.matrixWorld.clone().invert();
  const centroidWrapper = centroidWorld.clone().applyMatrix4(wrapperInv);

  // Normal: mesh-local ??world (rotation only) ??wrapper-local.
  const normalWorld = startNormal
    .clone()
    .transformDirection(mesh.matrixWorld)
    .normalize();
  const normalWrapper = normalWorld
    .clone()
    .transformDirection(wrapperInv)
    .normalize();

  // Wrapper Y-up ??body Z-up (matches frames.ts threeToLab convention).
  const posMm = {
    x: threeToMm(centroidWrapper.x),
    y: threeToMm(-centroidWrapper.z),
    z: threeToMm(centroidWrapper.y),
  };
  const dirBodyLocal = {
    x: normalWrapper.x,
    y: -normalWrapper.z,
    z: normalWrapper.y,
  };

  // Boundary edges: edges that belong to exactly ONE triangle in the
  // cluster (interior edges are shared by two cluster triangles, so
  // they appear twice). Output flat number[] in wrapper-local Y-up.
  const clusterSet = new Set(cluster);
  const edgeUsage = new Map<string, number>();
  const edgeEndpoints = new Map<string, [number, number]>();
  for (const t of cluster) {
    const a = triVertIdx(t, 0);
    const b = triVertIdx(t, 1);
    const c = triVertIdx(t, 2);
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const k = edgeKey(u, v);
      edgeUsage.set(k, (edgeUsage.get(k) ?? 0) + 1);
      if (!edgeEndpoints.has(k)) edgeEndpoints.set(k, [u, v]);
    }
  }
  void clusterSet; // (kept for symmetry; usage map already only counts cluster tris)

  const outlinePointsWrapperThree: number[] = [];
  const faceTrianglesWrapperThree: number[] = [];
  const tmpVec = new THREE.Vector3();
  for (const t of cluster) {
    for (const idx of [
      triVertIdx(t, 0),
      triVertIdx(t, 1),
      triVertIdx(t, 2),
    ]) {
      tmpVec.fromBufferAttribute(positions, idx);
      tmpVec.applyMatrix4(mesh.matrixWorld).applyMatrix4(wrapperInv);
      faceTrianglesWrapperThree.push(tmpVec.x, tmpVec.y, tmpVec.z);
    }
  }
  for (const [k, count] of edgeUsage) {
    if (count !== 1) continue;
    const ep = edgeEndpoints.get(k);
    if (!ep) continue;
    for (const v of ep) {
      tmpVec.fromBufferAttribute(positions, v);
      tmpVec.applyMatrix4(mesh.matrixWorld).applyMatrix4(wrapperInv);
      outlinePointsWrapperThree.push(tmpVec.x, tmpVec.y, tmpVec.z);
    }
  }

  return {
    posMm,
    dirBodyLocal,
    outlinePointsWrapperThree,
    faceTrianglesWrapperThree,
  };
}

// =============================================================================
// 3D viewport hook ??owns its own Three.js scene + renderer + controls
// =============================================================================

type FacePreview = {
  faceTrianglesWrapperThree: number[];
};

interface ViewportHandle {
  /** Re-render anchor markers from the given draft list. Called whenever
   *  drafts change. */
  syncAnchors: (drafts: AnchorDraft[], selectedKey: string | null) => void;
  /** Attach the gizmo to the marker matching `selectedKey` (or detach
   *  when null). */
  attachGizmoTo: (selectedKey: string | null) => void;
  /** Render a yellow outline around a picked face. Pass an empty array
   *  to clear. Points come from `computeCoplanarFace`'s
   *  `outlinePointsWrapperThree` ??wrapper-local three Y-up, flat
   *  [x,y,z, x,y,z, ...] with consecutive pairs forming each edge. */
  setFaceHighlight: (pointsWrapperThree: number[]) => void;
  /** Render the actual hovered/picked mesh face triangles in yellow.
   *  The data comes from the same wireframe face raycast that supplies
   *  the outline, so preview and committed face stay identical. */
  setFacePreview: (preview: FacePreview | null) => void;
  /** When true, the SELECTED anchor's direction arrow renders in BOTH
   *  +d and ? (= bi-convex lens optical axis: light passes through
   *  either way). Default false. */
  setBidirectional: (value: boolean) => void;
  /** Render a translucent yellow rectangle representing the implied
   *  diagonal interface inside a beam-splitter cube. Pass `null` to
   *  hide. `centerMm` and `normalBodyLocal` are in body-local Z-up.
   *  `widthMm` ? `heightMm` set the rectangle's full dimensions in
   *  the plane perpendicular to `normalBodyLocal`. */
  setInterfacePlane: (
    plane: {
      centerMm: { x: number; y: number; z: number };
      normalBodyLocal: { x: number; y: number; z: number };
      widthMm: number;
      heightMm: number;
    } | null,
  ) => void;
  /** AOM-only: render an orange arrow at the midpoint of intercept_in
   *  and intercept_out, pointing along ??_body = b??璽 (= the auto-derived
   *  Bragg rotation axis used by the 3D-view align). Pass `null` to
   *  hide. Caller must compute b? from anchor drafts itself; only the
   *  unit-vector tilt axis + pivot are passed in body-local Z-up.
   *  This sync intentionally lives separately from `syncAnchors` so
   *  rebuild doesn't fight the anchor markers' own update path. */
  setAomTiltAxis: (
    info: {
      pivotMmBodyLocal: { x: number; y: number; z: number };
      tiltUnitBodyLocal: { x: number; y: number; z: number };
      lengthHintMm: number;
    } | null,
  ) => void;
  /** Fiber-only: render cyan PM slow-axis rods at End A / End B. */
  setFiberSlowAxes: (axes: FiberSlowAxisDraft | null) => void;
  dispose: () => void;
}

function useViewport(
  mountRef: React.RefObject<HTMLDivElement>,
  component: ComponentItem | null,
  asset: Asset3D | undefined,
  onAnchorDrag: (key: string, posMm: { x: number; y: number; z: number }) => void,
  onAnchorClick: (key: string) => void,
  pickFaceModeRef: React.MutableRefObject<boolean>,
  onPickFace: (
    posMm: { x: number; y: number; z: number },
    dirBodyLocal: { x: number; y: number; z: number },
    outlinePointsWrapperThree: number[],
    faceTrianglesWrapperThree: number[],
    anchorId?: string,
  ) => void,
  onPbsCubeClick: (
    anchorName: string,
    posMmBodyLocal: { x: number; y: number; z: number },
    dirBodyLocal: { x: number; y: number; z: number },
  ) => void,
): ViewportHandle | null {
  const [handle, setHandle] = useState<ViewportHandle | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !component) return;
    const viewportComponent = component;

    let cancelled = false;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#ffffff");
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 10, 7);
    scene.add(dir);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 200);
    camera.position.set(2, 1.5, 2);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const gizmo = new TransformControls(camera, renderer.domElement);
    gizmo.size = 0.7;
    // Newer three.js (~r170+) split TransformControls from Object3D ??the
    // helper geometry comes from `.getHelper()`. Older versions still treat
    // the controls themselves as an Object3D. Match the fallback pattern in
    // src/three/placement/gizmo.ts so we work on either.
    let gizmoHelper: THREE.Object3D | null = null;
    const helperFn = (gizmo as unknown as { getHelper?: () => THREE.Object3D }).getHelper;
    if (typeof helperFn === "function") {
      gizmoHelper = helperFn.call(gizmo);
      scene.add(gizmoHelper);
    } else {
      scene.add(gizmo as unknown as THREE.Object3D);
    }
    gizmo.addEventListener("dragging-changed", (event) => {
      controls.enabled = !event.value;
    });

    const wrapper = new THREE.Group();
    wrapper.name = "edit-target";
    scene.add(wrapper);
    const markerGroup = new THREE.Group();
    markerGroup.name = "anchor-markers";
    scene.add(markerGroup);
    const fiberSlowAxisGroup = new THREE.Group();
    fiberSlowAxisGroup.name = "fiber-slow-axis-markers";
    markerGroup.add(fiberSlowAxisGroup);
    const fiberHoleRingGroup = new THREE.Group();
    fiberHoleRingGroup.name = "fiber-hole-rings";
    markerGroup.add(fiberHoleRingGroup);

    let raycaster = new THREE.Raycaster();
    let pointer = new THREE.Vector2();
    const markerByKey = new Map<string, THREE.Mesh>();

    // Mesh-only bbox span, populated AFTER the GLB loads. Used to size
    // sphere markers, sprite labels, and direction arrows so they stay
    // proportional to the actual mesh ??not to a fallback span of 1
    // (which would render markers ~10? the mesh size for a 25 mm
    // BB1-E03 disc and obscure the wireframe entirely).
    let meshSpan: number | null = null;
    // Last syncAnchors arguments ??kept so we can re-render markers
    // once meshSpan becomes available after the async GLB load.
    let lastSyncDrafts: AnchorDraft[] = [];
    let lastSyncSelected: string | null = null;
    // When true, the direction arrow on the selected anchor renders in
    // BOTH directions (= bi-convex lens optical axis, light passes
    // through either way). Set externally via setBidirectional().
    let bidirectional = false;
    const isFiberViewport = component.componentType === "fiber";
    let fiberSlowAxisAngles: FiberSlowAxisDraft | null = null;

    const onClick = (event: MouseEvent) => {
      // Skip if the gizmo is currently grabbing ??TransformControls
      // mousedown propagates to the canvas and we don't want to
      // re-trigger selection on drop.
      if (!gizmo.enabled) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      if (pickFaceModeRef.current) {
        // Pick-face mode: raycast against the loaded mesh (NOT markers
        // and NOT the editor wireframe edges). Use the hit triangle's
        // coplanar cluster to find the visual face center + normal,
        // then convert wrapper Y-up local ??body Z-up mm.
        const meshes: THREE.Mesh[] = [];
        wrapper.traverse((o) => {
          if (
            (o as THREE.Mesh).isMesh &&
            !o.userData.__editorWire &&
            !o.userData.__anchorKey
          ) {
            meshes.push(o as THREE.Mesh);
          }
        });
        const hits = raycaster.intersectObjects(meshes, false);
        if (hits.length > 0) {
          const hit = hits[0];
          const result = computeCoplanarFace(hit, wrapper);
          if (result) {
            setFacePreview({
              faceTrianglesWrapperThree: result.faceTrianglesWrapperThree,
            });
            onPickFace(
              result.posMm,
              result.dirBodyLocal,
              result.outlinePointsWrapperThree,
              result.faceTrianglesWrapperThree,
            );
            return;
          }
        }
        if (isFiberViewport) {
          const ringHits = raycaster.intersectObjects(fiberHoleRingGroup.children, false);
          if (ringHits.length > 0) {
            const ring = ringHits[0].object as THREE.Mesh;
            const pos = ring.userData.__fiberHolePosMm as
              | { x: number; y: number; z: number }
              | undefined;
            const dir = ring.userData.__fiberHoleDirBodyLocal as
              | { x: number; y: number; z: number }
              | undefined;
            const anchorId = ring.userData.__fiberHoleAnchorId as string | undefined;
            if (pos && dir && anchorId) {
              setFaceHighlight([]);
              setFacePreview(null);
              onPickFace(pos, dir, [], [], anchorId);
              return;
            }
          }
        }
        setFaceHighlight([]);
        setFacePreview(null);
        return;
      }

      const hits = raycaster.intersectObjects([...markerByKey.values()], false);
      if (hits.length > 0) {
        const key = hits[0].object.userData.__anchorKey as string;
        onAnchorClick(key);
        return;
      }

      // PBS cube fallback: clicking the visible PBS cube in an isolator
      // selects the corresponding anchor (front_pbs / back_pbs). Cubes carry
      // __pbsAnchorName + body-local pose in userData; outer handler creates
      // the anchor draft if it doesn't exist yet, then selects it.
      const pbsHits = raycaster.intersectObjects(wrapper.children, true);
      for (const hit of pbsHits) {
        let p: THREE.Object3D | null = hit.object;
        while (p && !p.userData.__pbsAnchorName) p = p.parent;
        if (p && p.userData.__pbsAnchorName) {
          const name = p.userData.__pbsAnchorName as string;
          const pos = p.userData.__pbsPosMmBodyLocal as { x: number; y: number; z: number } | undefined;
          const dir = p.userData.__pbsDirBodyLocal as { x: number; y: number; z: number } | undefined;
          if (pos && dir) {
            onPbsCubeClick(name, pos, dir);
            return;
          }
        }
      }
    };
    renderer.domElement.addEventListener("click", onClick);

    // Hover preview while in pick-face mode: re-run coplanar BFS on
    // mousemove and paint the picked face's boundary in yellow live, so
    // the user can see exactly which face will be committed before
    // clicking. Throttle via rAF to keep BFS off the input thread. Once
    // the user clicks, pickFaceModeRef.current flips false and this
    // handler short-circuits, leaving whatever final highlight the
    // click committed (or the outer component re-pushes via
    // setFaceHighlight).
    let hoverPending = false;
    const onMouseMove = (event: MouseEvent) => {
      if (!pickFaceModeRef.current) return;
      if (hoverPending) return;
      hoverPending = true;
      requestAnimationFrame(() => {
        hoverPending = false;
        if (!pickFaceModeRef.current) return;
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const meshes: THREE.Mesh[] = [];
        wrapper.traverse((o) => {
          if (
            (o as THREE.Mesh).isMesh &&
            !o.userData.__editorWire &&
            !o.userData.__anchorKey
          ) {
            meshes.push(o as THREE.Mesh);
          }
        });
        const hits = raycaster.intersectObjects(meshes, false);
        const result = hits.length > 0 ? computeCoplanarFace(hits[0], wrapper) : null;
        if (result) {
          fiberHoleRingGroup.children.forEach((child) => child.scale.setScalar(1));
          setFaceHighlight(result.outlinePointsWrapperThree);
          setFacePreview({
            faceTrianglesWrapperThree: result.faceTrianglesWrapperThree,
          });
        } else {
          if (isFiberViewport) {
            const ringHits = raycaster.intersectObjects(fiberHoleRingGroup.children, false);
            fiberHoleRingGroup.children.forEach((child) => {
              child.scale.setScalar(child === ringHits[0]?.object ? 1.18 : 1);
            });
            if (ringHits.length > 0) {
              setFaceHighlight([]);
              setFacePreview(null);
              return;
            }
          }
          setFaceHighlight([]);
          setFacePreview(null);
        }
      });
    };
    renderer.domElement.addEventListener("pointermove", onMouseMove);

    // Auto-fit camera + frame the model after we know the bbox.
    function frameModel(target: THREE.Object3D) {
      const bbox = new THREE.Box3().setFromObject(target);
      if (bbox.isEmpty()) return;
      const size = bbox.getSize(new THREE.Vector3());
      const center = bbox.getCenter(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z) * 1.4;
      camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.8, radius));
      camera.lookAt(center);
      camera.near = Math.max(0.001, radius / 200);
      camera.far = Math.max(50, radius * 50);
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
    }

    // Wireframe overlay — same shader pattern as DigitalTwinViewer.tsx
    // addWireframeOutline. Drawn in a contrasting cyan so it pops on the
    // dark editor background.
    //
    // Knock-back is done on a CLONE of each mesh's material, not the
    // original. Several procedural primitives (DDS chassis brass / Teflon
    // / cable jacket / SMA connectors — see `ddsBrassMat`,
    // `ddsTeflonWhiteMat`, `ddsCableBlackMat`, `ddsCableTanMat`,
    // `ddsBlackInsetMat` in `three/loadAsset.ts`) share a single module-
    // scoped material instance across every mesh that uses them. Mutating
    // that singleton's opacity in-place leaks back to every other object
    // in the main scene — cables, AD9959 PCBs, anything with an SMA
    // connector — and they all render at opacity 0.18 after the user
    // returns from PHY editor. Cloning here gives the editor its own
    // per-mesh material that never touches the singletons.
    function applyWireframe(target: THREE.Object3D) {
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x67e8f9,
        transparent: true,
        opacity: 0.85,
        depthTest: true,
        depthWrite: false,
      });
      target.traverse((child) => {
        if (!(child instanceof THREE.Mesh) || !child.geometry) return;
        if (child.userData?.__editorWire) return;
        if (child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          const cloned = mats.map((m) => {
            if (!("opacity" in m && "transparent" in m)) return m;
            const c = m.clone();
            (c as THREE.Material & { opacity: number; transparent: boolean }).transparent = true;
            (c as THREE.Material & { opacity: number; transparent: boolean }).opacity = 0.18;
            return c;
          });
          child.material = Array.isArray(child.material) ? cloned : cloned[0];
        }
        const edges = new THREE.EdgesGeometry(child.geometry, 30);
        const lines = new THREE.LineSegments(edges, lineMat);
        lines.userData.__editorWire = true;
        child.add(lines);
      });
    }

    // Load the GLB / primitive into the wrapper.
    loadAssetObject(component, asset, undefined).then((obj) => {
      if (cancelled) return;
      wrapper.add(obj);
      applyWireframe(obj);
      frameModel(wrapper);
      // Now that geometry exists, measure it ONCE (markers excluded ??      // we measure `obj` directly, not `wrapper`, so previously-added
      // markers don't inflate the span) and re-render markers so they
      // come out mesh-proportional instead of using the bootstrap
      // fallback of span = 1.
      const meshBox = new THREE.Box3().setFromObject(obj);
      if (!meshBox.isEmpty()) {
        meshSpan = Math.max(
          meshBox.max.x - meshBox.min.x,
          meshBox.max.y - meshBox.min.y,
          meshBox.max.z - meshBox.min.z,
        );
      }
      // Refresh any markers that were placed before geometry loaded.
      syncAnchors(lastSyncDrafts, lastSyncSelected);
    });

    // Animate
    let raf = 0;
    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    onResize();
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    // Build a sprite label ??same pattern as the AOM ABC markers.
    function makeLabel(text: string, colour: number, sphereRadius: number): THREE.Sprite {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 96;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
        const radius = 12;
        ctx.beginPath();
        ctx.moveTo(radius, 0);
        ctx.arcTo(canvas.width, 0, canvas.width, canvas.height, radius);
        ctx.arcTo(canvas.width, canvas.height, 0, canvas.height, radius);
        ctx.arcTo(0, canvas.height, 0, 0, radius);
        ctx.arcTo(0, 0, canvas.width, 0, radius);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = `#${colour.toString(16).padStart(6, "0")}`;
        ctx.font = "bold 38px 'Inter', 'Segoe UI', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.anisotropy = 4;
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }),
      );
      sprite.scale.set(sphereRadius * 8, sphereRadius * 3, 1);
      sprite.position.set(0, sphereRadius * 2.5, 0);
      sprite.renderOrder = 1001;
      sprite.userData.__anchorLabel = true;
      return sprite;
    }

    function disposeNode(node: THREE.Object3D) {
      node.traverse((o) => {
        if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
        if ((o as THREE.Mesh).material) {
          const m = (o as THREE.Mesh).material;
          const mats = Array.isArray(m) ? m : [m];
          for (const mat of mats) {
            const sm = mat as THREE.Material & { map?: THREE.Texture };
            if (sm.map) sm.map.dispose();
            mat.dispose();
          }
        }
      });
    }

    function renderFiberSlowAxes() {
      for (const child of [...fiberSlowAxisGroup.children]) {
        fiberSlowAxisGroup.remove(child);
        disposeNode(child);
      }
      if (!isFiberViewport || !fiberSlowAxisAngles) return;
      const slowMat = new THREE.MeshBasicMaterial({
        color: 0x66d9ff,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      });
      const labelMat = (text: string) => {
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 96;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "rgba(8, 47, 73, 0.82)";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "#66d9ff";
          ctx.font = "bold 32px 'Inter', 'Segoe UI', sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 1);
        }
        const tex = new THREE.CanvasTexture(canvas);
        tex.anisotropy = 4;
        return new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          depthTest: false,
          depthWrite: false,
        });
      };
      const rodLength = mmToThree(12);
      const rodRadius = mmToThree(0.28);
      const addAxis = (draft: AnchorDraft | undefined, axisName: FiberSlowAxis, label: string) => {
        if (!draft) return;
        const p = draft.positionMmBodyLocal;
        const base = new THREE.Vector3(
          mmToThree(p.x),
          mmToThree(p.z),
          mmToThree(-p.y),
        );
        const n = draft.directionBodyLocal
          ? new THREE.Vector3(
              draft.directionBodyLocal.x,
              draft.directionBodyLocal.z,
              -draft.directionBodyLocal.y,
            )
          : new THREE.Vector3(0, 0, 1);
        if (n.lengthSq() > 1e-12) base.addScaledVector(n.normalize(), mmToThree(1.2));
        const axis = fiberSlowAxisVectorThree(axisName).normalize();
        const rod = new THREE.Mesh(
          new THREE.CylinderGeometry(rodRadius, rodRadius, rodLength, 10),
          slowMat.clone(),
        );
        rod.position.copy(base);
        rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
        rod.renderOrder = 1002;
        fiberSlowAxisGroup.add(rod);

        const tipA = new THREE.Mesh(
          new THREE.SphereGeometry(rodRadius * 2.2, 10, 8),
          slowMat.clone(),
        );
        tipA.position.copy(base).addScaledVector(axis, rodLength / 2);
        tipA.renderOrder = 1003;
        fiberSlowAxisGroup.add(tipA);
        const tipB = tipA.clone();
        tipB.material = slowMat.clone();
        tipB.position.copy(base).addScaledVector(axis, -rodLength / 2);
        fiberSlowAxisGroup.add(tipB);

        const sprite = new THREE.Sprite(labelMat(label));
        sprite.position.copy(base).addScaledVector(axis, rodLength * 0.7);
        sprite.position.y += mmToThree(3);
        sprite.scale.set(mmToThree(18), mmToThree(6), 1);
        sprite.renderOrder = 1004;
        fiberSlowAxisGroup.add(sprite);
      };
      addAxis(lastSyncDrafts.find((d) => d.id === "intercept_in"), fiberSlowAxisAngles.endA, "A slow");
      addAxis(lastSyncDrafts.find((d) => d.id === "intercept_out"), fiberSlowAxisAngles.endB, "B slow");
      slowMat.dispose();
    }

    function renderFiberHoleRings() {
      for (const child of [...fiberHoleRingGroup.children]) {
        fiberHoleRingGroup.remove(child);
        disposeNode(child);
      }
      if (!isFiberViewport) return;
      const addRing = (end: FiberEnd, draft: AnchorDraft | undefined, label: string) => {
        if (!draft) return;
        const target = fiberDefaultPortAnchor(viewportComponent, end);
        const p = target.positionMmBodyLocal;
        const dir = target.directionBodyLocal ?? draft.directionBodyLocal ?? { x: 0, y: 1, z: 0 };
        const n = new THREE.Vector3(dir.x, dir.z, -dir.y);
        if (n.lengthSq() < 1e-12) n.set(0, 0, 1);
        n.normalize();
        const aperture = Math.max(0.8, draft.apertureMm ?? 2.5);
        const inner = mmToThree(aperture * 0.48);
        const outer = mmToThree(aperture * 0.68);
        const hitRadius = Math.max(outer * 2.2, mmToThree(5));
        const position = new THREE.Vector3(mmToThree(p.x), mmToThree(p.z), mmToThree(-p.y));
        position.addScaledVector(n, mmToThree(0.25));
        const orientation = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          n,
        );
        const metadata = {
          __fiberHoleAnchorId: draft.id,
          __fiberHolePosMm: p,
          __fiberHoleDirBodyLocal: dir,
          __fiberHoleLabel: label,
        };
        // Visible aperture ring: what the user sees.
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(inner, outer, 48),
          new THREE.MeshBasicMaterial({
            color: 0xfacc15,
            transparent: true,
            opacity: 0.92,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false,
          }),
        );
        ring.position.copy(position);
        ring.quaternion.copy(orientation);
        ring.renderOrder = 1005;
        Object.assign(ring.userData, metadata);
        fiberHoleRingGroup.add(ring);

        // Invisible hit disk: makes clicking the hole center forgiving.
        const hitDisk = new THREE.Mesh(
          new THREE.CircleGeometry(hitRadius, 48),
          new THREE.MeshBasicMaterial({
            color: 0xfacc15,
            transparent: true,
            opacity: 0.02,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false,
          }),
        );
        hitDisk.position.copy(position);
        hitDisk.quaternion.copy(orientation);
        hitDisk.renderOrder = 1004;
        hitDisk.userData.__fiberHoleHitDisk = true;
        Object.assign(hitDisk.userData, metadata);
        fiberHoleRingGroup.add(hitDisk);
      };
      addRing("A", lastSyncDrafts.find((d) => d.id === "intercept_in"), "End A hole");
      addRing("B", lastSyncDrafts.find((d) => d.id === "intercept_out"), "End B hole");
    }

    // === Public handle API ===

    const syncAnchors = (drafts: AnchorDraft[], selectedKey: string | null) => {
      // Stash for the post-load re-render (see loadAssetObject.then).
      lastSyncDrafts = drafts;
      lastSyncSelected = selectedKey;
      // Remove markers that are no longer in drafts
      const liveKeys = new Set(drafts.map((d) => d.__key));
      for (const [key, mesh] of [...markerByKey.entries()]) {
        if (!liveKeys.has(key)) {
          markerGroup.remove(mesh);
          mesh.traverse((o) => {
            if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
            if ((o as THREE.Mesh).material) {
              const m = (o as THREE.Mesh).material;
              const mats = Array.isArray(m) ? m : [m];
              for (const mat of mats) {
                const sm = mat as THREE.Material & { map?: THREE.Texture };
                if (sm.map) sm.map.dispose();
                mat.dispose();
              }
            }
          });
          markerByKey.delete(key);
        }
      }
      // Mesh-proportional marker size. If the GLB hasn't loaded yet
      // (meshSpan still null), defer to a tiny fallback ??we'll get
      // re-called from the load callback with the real value.
      const span = meshSpan ?? 0.05;
      const markerScale = isFiberViewport ? 0.45 : 1;
      // 20× shrunk from the previous mesh-proportional sizing (0.025 →
      // 0.00125 factor and matching floor reductions). Matches the
      // lab-viewer marker shrink so anchor dots are subtle pinpricks
      // rather than obscuring the geometry behind them.
      const sphereRadius = Math.max(
        isFiberViewport ? 0.0000225 : 0.00005,
        span * 0.00125 * markerScale,
      );
      const arrowSpanFactor = isFiberViewport ? 0.13 : 0.3;

      for (const d of drafts) {
        let mesh = markerByKey.get(d.__key);
        const colour = anchorColour(d.id);
        if (!mesh) {
          mesh = new THREE.Mesh(
            new THREE.SphereGeometry(sphereRadius, 24, 16),
            new THREE.MeshBasicMaterial({
              color: colour,
              depthTest: false,
              depthWrite: false,
              transparent: true,
              opacity: isFiberViewport ? 0 : 0.95,
            }),
          );
          mesh.userData.__anchorKey = d.__key;
          mesh.userData.__markerRadius = sphereRadius;
          mesh.renderOrder = 1000;
          mesh.add(makeLabel(d.id, colour, sphereRadius));
          markerGroup.add(mesh);
          markerByKey.set(d.__key, mesh);
        } else if (Math.abs((Number(mesh.userData.__markerRadius) || 0) - sphereRadius) > 1e-6) {
          mesh.geometry.dispose();
          mesh.geometry = new THREE.SphereGeometry(sphereRadius, 24, 16);
          for (const child of [...mesh.children]) {
            if (!child.userData.__anchorLabel) continue;
            mesh.remove(child);
            const sprite = child as THREE.Sprite;
            sprite.material.map?.dispose();
            sprite.material.dispose();
          }
          mesh.userData.__markerRadius = sphereRadius;
          mesh.add(makeLabel(d.id, colour, sphereRadius));
        }
        // Body-local Z-up mm ??three.js Y-up units. (Phase 4: BodyLocal
        // and Lab share axis convention ??same conversion as labMmToThree.)
        const p = d.positionMmBodyLocal;
        mesh.position.set(mmToThree(p.x), mmToThree(p.z), mmToThree(-p.y));
        // Highlight the selected one
        const mat = mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = isFiberViewport ? 0 : d.__key === selectedKey ? 1.0 : 0.7;

        // Refresh the direction arrow: drop any prior arrow child, then
        // re-add if the draft has a directionBodyLocal vector. The arrow
        // visualises the face normal so the user can see "beams from
        // this side reflect; from the other side don't".
        for (const child of [...mesh.children]) {
          if (child.userData.__directionArrow) {
            mesh.remove(child);
            (child as THREE.ArrowHelper).dispose?.();
          }
        }
        if (d.directionBodyLocal) {
          const dB = d.directionBodyLocal;
          // Body-local Z-up direction ??three Y-up direction (no scaling).
          const dThree = new THREE.Vector3(dB.x, dB.z, -dB.y);
          if (dThree.lengthSq() > 1e-12) {
            dThree.normalize();
            // Keep fiber port markers compact; connector faces are only
            // a few mm across, so the default arrow would obscure them.
            const arrowLen = Math.max(sphereRadius * 4, span * arrowSpanFactor);
            const directions = bidirectional && d.__key === selectedKey
              ? [dThree, dThree.clone().negate()]
              : [dThree];
            for (const dir of directions) {
              const arrow = new THREE.ArrowHelper(
                dir,
                new THREE.Vector3(0, 0, 0),
                arrowLen,
                colour,
                arrowLen * (isFiberViewport ? 0.22 : 0.28),
                arrowLen * (isFiberViewport ? 0.14 : 0.18),
              );
              arrow.userData.__directionArrow = true;
              arrow.traverse((c) => {
                const m = (c as THREE.Mesh | THREE.Line).material as THREE.Material | THREE.Material[] | undefined;
                if (!m) return;
                const mats = Array.isArray(m) ? m : [m];
                for (const mm of mats) {
                  (mm as THREE.Material & { depthTest?: boolean; depthWrite?: boolean }).depthTest = false;
                  (mm as THREE.Material & { depthTest?: boolean; depthWrite?: boolean }).depthWrite = false;
                  mm.transparent = true;
                }
              });
              mesh.add(arrow);
            }
          }
        }
      }
      renderFiberSlowAxes();
      renderFiberHoleRings();
    };

    const setBidirectional = (value: boolean) => {
      if (bidirectional === value) return;
      bidirectional = value;
      // Re-render markers so the arrow re-builds with the new mode.
      syncAnchors(lastSyncDrafts, lastSyncSelected);
    };

    const attachGizmoTo = (selectedKey: string | null) => {
      if (!selectedKey) {
        gizmo.detach();
        return;
      }
      const mesh = markerByKey.get(selectedKey);
      if (!mesh) {
        gizmo.detach();
        return;
      }
      gizmo.attach(mesh);
    };

    // Yellow face-outline overlay for the picked face. Held as a single
    // LineSegments object whose geometry is rebuilt on each call. Lives
    // as a sibling of the wrapper so it inherits no transform ??points
    // arrive already in wrapper-local Y-up.
    const faceHighlight = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: 0xfacc15,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      }),
    );
    faceHighlight.renderOrder = 999;
    faceHighlight.visible = false;
    wrapper.add(faceHighlight);

    const setFaceHighlight = (pointsWrapperThree: number[]) => {
      if (pointsWrapperThree.length === 0) {
        faceHighlight.visible = false;
        return;
      }
      const arr = new Float32Array(pointsWrapperThree);
      faceHighlight.geometry.dispose();
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      faceHighlight.geometry = geom;
      faceHighlight.visible = true;
    };

    // Yellow face preview fill. The geometry is rebuilt from the actual
    // coplanar mesh triangles under the cursor, so the highlighted patch
    // is the same wireframe face the user clicks.
    const facePreviewFill = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0xfacc15,
        transparent: true,
        opacity: 0.32,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      }),
    );
    facePreviewFill.renderOrder = 1000;
    facePreviewFill.visible = false;
    wrapper.add(facePreviewFill);

    const setFacePreview = (preview: FacePreview | null) => {
      const points = preview?.faceTrianglesWrapperThree ?? [];
      if (points.length < 9) {
        facePreviewFill.visible = false;
        return;
      }
      const arr = new Float32Array(points);
      facePreviewFill.geometry.dispose();
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      facePreviewFill.geometry = geom;
      facePreviewFill.visible = true;
    };

    // Translucent yellow plane rectangle representing the implied
    // diagonal interface of a beam-splitter cube. Sibling of wrapper
    // so it inherits no transform; we position/orient it manually.
    const interfacePlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xfacc15,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      }),
    );
    interfacePlane.renderOrder = 998;
    interfacePlane.visible = false;
    wrapper.add(interfacePlane);

    const setInterfacePlane = (
      plane: {
        centerMm: { x: number; y: number; z: number };
        normalBodyLocal: { x: number; y: number; z: number };
        widthMm: number;
        heightMm: number;
      } | null,
    ) => {
      if (!plane) {
        interfacePlane.visible = false;
        return;
      }
      // body-local Z-up mm ??wrapper Y-up three units
      interfacePlane.position.set(
        mmToThree(plane.centerMm.x),
        mmToThree(plane.centerMm.z),
        mmToThree(-plane.centerMm.y),
      );
      const dThree = new THREE.Vector3(
        plane.normalBodyLocal.x,
        plane.normalBodyLocal.z,
        -plane.normalBodyLocal.y,
      );
      if (dThree.lengthSq() < 1e-12) {
        interfacePlane.visible = false;
        return;
      }
      dThree.normalize();
      // Rotate from default plane normal (+Z) to dThree. The plane's
      // base geometry is unit-sized (1?1) so width/height become the
      // scale factors directly (in three.js units).
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        dThree,
      );
      interfacePlane.quaternion.copy(q);
      interfacePlane.scale.set(
        mmToThree(plane.widthMm),
        mmToThree(plane.heightMm),
        1,
      );
      interfacePlane.visible = true;
    };

    gizmo.addEventListener("objectChange", () => {
      const target = gizmo.object as THREE.Mesh | undefined;
      if (!target) return;
      const key = target.userData.__anchorKey as string | undefined;
      if (!key) return;
      // three.js Y-up units ??body-local Z-up mm. Inverse of labMmToThree
      // for the BodyLocal frame.
      const tx = target.position.x;
      const ty = target.position.y;
      const tz = target.position.z;
      onAnchorDrag(key, {
        x: threeToMm(tx),
        y: threeToMm(-tz),
        z: threeToMm(ty),
      });
    });

    // AOM tilt-axis arrow ??single ArrowHelper held in the wrapper so
    // it shares all transforms with the anchor markers. Caller computes
    // (pivot, ??_body, lengthHint) externally so this scope stays kind-
    // agnostic; we only know how to render. `setAomTiltAxis(null)`
    // detaches the helper.
    let aomTiltArrow: THREE.ArrowHelper | null = null;
    const setAomTiltAxis = (
      info: {
        pivotMmBodyLocal: { x: number; y: number; z: number };
        tiltUnitBodyLocal: { x: number; y: number; z: number };
        lengthHintMm: number;
      } | null,
    ) => {
      if (aomTiltArrow) {
        wrapper.remove(aomTiltArrow);
        aomTiltArrow.dispose?.();
        aomTiltArrow = null;
      }
      if (!info) return;
      const pivotThree = new THREE.Vector3(
        mmToThree(info.pivotMmBodyLocal.x),
        mmToThree(info.pivotMmBodyLocal.z),
        mmToThree(-info.pivotMmBodyLocal.y),
      );
      const dirThree = new THREE.Vector3(
        info.tiltUnitBodyLocal.x,
        info.tiltUnitBodyLocal.z,
        -info.tiltUnitBodyLocal.y,
      );
      if (dirThree.lengthSq() < 1e-12) return;
      dirThree.normalize();
      const arrowLen = Math.max(0.05, mmToThree(info.lengthHintMm));
      const arrow = new THREE.ArrowHelper(
        dirThree,
        pivotThree,
        arrowLen,
        0xf97316,
        arrowLen * 0.25,
        arrowLen * 0.15,
      );
      arrow.traverse((c) => {
        const m = (c as THREE.Mesh | THREE.Line).material as
          | THREE.Material
          | THREE.Material[]
          | undefined;
        if (!m) return;
        const mats = Array.isArray(m) ? m : [m];
        for (const mat of mats) {
          (mat as THREE.Material & { depthTest?: boolean; depthWrite?: boolean }).depthTest = false;
          (mat as THREE.Material & { depthTest?: boolean; depthWrite?: boolean }).depthWrite = false;
          mat.transparent = true;
        }
      });
      arrow.renderOrder = 1001;
      wrapper.add(arrow);
      aomTiltArrow = arrow;
    };

    const setFiberSlowAxes = (axes: FiberSlowAxisDraft | null) => {
      fiberSlowAxisAngles = axes;
      renderFiberSlowAxes();
    };

    setHandle({
      syncAnchors,
      attachGizmoTo,
      setFaceHighlight,
      setFacePreview,
      setBidirectional,
      setInterfacePlane,
      setAomTiltAxis,
      setFiberSlowAxes,
      dispose: () => {
        // handled by the cleanup below
      },
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("click", onClick);
      renderer.domElement.removeEventListener("pointermove", onMouseMove);
      gizmo.detach();
      gizmo.dispose();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }
      scene.traverse((o) => {
        if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose?.();
        if ((o as THREE.Mesh).material) {
          const m = (o as THREE.Mesh).material;
          const mats = Array.isArray(m) ? m : [m];
          mats.forEach((mat) => {
            const sm = mat as THREE.Material & { map?: THREE.Texture };
            if (sm.map) sm.map.dispose();
            mat.dispose();
          });
        }
      });
      setHandle(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [component?.id, asset?.id]);

  return handle;
}


// =============================================================================
// Tapered Amplifier inspector: dual-anchor (INPUT + OUTPUT) status +
// editable fields for each. Anti-parallel health badge surfaces when
// the two directions diverge from opposite ??that's almost always a
// data error since light has to physically pass through the chip.
// Per-instance physics (drive current, ASE / gain tables, mode
// matching) lives in TaperedAmplifierAdjustControls in the main
// scene panel ??NOT edited here.
// =============================================================================

function TaperedAmplifierFaceSection({
  inDraft,
  outDraft,
  selectedAnchorKey,
  setSelectedAnchorKey,
  updateDraft,
}: {
  inDraft: AnchorDraft | null;
  outDraft: AnchorDraft | null;
  selectedAnchorKey: string | null;
  setSelectedAnchorKey: (k: string | null) => void;
  updateDraft: (key: string, patch: Partial<AnchorDraft>) => void;
}) {
  if (!inDraft || !outDraft) {
    return (
      <div className="component-editor-section">
        <div className="component-editor-section-title">TA ports</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          No anchor available - load a component with an Asset3D first.
        </div>
      </div>
    );
  }

  const dotIO =
    inDraft.directionBodyLocal && outDraft.directionBodyLocal
      ? inDraft.directionBodyLocal.x * outDraft.directionBodyLocal.x +
        inDraft.directionBodyLocal.y * outDraft.directionBodyLocal.y +
        inDraft.directionBodyLocal.z * outDraft.directionBodyLocal.z
      : null;

  const portBlock = (
    label: string,
    sublabel: string,
    draft: AnchorDraft,
    accentColour: string,
  ) => {
    const isSelected = draft.__key === selectedAnchorKey;
    return (
      <div
        className={
          "component-editor-anchor-row" + (isSelected ? " is-active" : "")
        }
        style={{
          flexDirection: "column",
          alignItems: "stretch",
          padding: "6px 8px",
          marginTop: 6,
          borderLeft: `2px solid ${accentColour}`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            cursor: "pointer",
          }}
          onClick={() => setSelectedAnchorKey(draft.__key)}
        >
          <strong style={{ color: accentColour, fontSize: 13 }}>{label}</strong>
          <span style={{ fontSize: 10, opacity: 0.6, fontFamily: "monospace" }}>
            {sublabel}
          </span>
        </div>
        <div className="mirror-face-status" style={{ marginTop: 4, marginBottom: 4 }}>
          <span style={{ opacity: 0.65 }}>
            ({draft.positionMmBodyLocal.x.toFixed(2)},{" "}
            {draft.positionMmBodyLocal.y.toFixed(2)},{" "}
            {draft.positionMmBodyLocal.z.toFixed(2)}) mm
          </span>
          {draft.directionBodyLocal && (
            <span style={{ opacity: 0.65, marginLeft: 6 }}>
              n=({draft.directionBodyLocal.x.toFixed(2)},{" "}
              {draft.directionBodyLocal.y.toFixed(2)},{" "}
              {draft.directionBodyLocal.z.toFixed(2)})
            </span>
          )}
        </div>
        <EditableAnchorFields
          draft={draft}
          updateDraft={updateDraft}
          showDirection={true}
          showAperture={false}
          apertureMode="scalar"
        />
      </div>
    );
  };

  return (
    <div className="component-editor-section">
      <div className="component-editor-section-title">TA ports</div>
      {portBlock("INPUT", "intercept_in", inDraft, "#4ade80")}
      {portBlock("OUTPUT", "intercept_out", outDraft, "#f87171")}
      {dotIO !== null && (
        <div className="mirror-face-status" style={{ marginTop: 8 }}>
          <span style={{ opacity: 0.85, fontSize: 12 }}>
            INPUT-OUTPUT angle:{" "}
            <strong>
              {((Math.acos(Math.max(-1, Math.min(1, dotIO))) * 180) / Math.PI).toFixed(1)} deg
            </strong>{" "}
            <span style={{ opacity: 0.6, fontSize: 11 }}>
              (dot = {dotIO.toFixed(3)})
            </span>
          </span>
        </div>
      )}
      <p className="mirror-face-hint">
        Both directions are <strong>OUTWARD face normals</strong> (point
        away from the chip body). Light enters along
        -intercept_in.directionBodyLocal (= INTO the body) and exits
        along +intercept_out.directionBodyLocal. For straight-through
        chips the two arrows are anti-parallel; for side-output / shaped
        TAs they can be at any angle (e.g. 90 deg for side-coupled chips).
      </p>
      <p className="mirror-face-hint">
        TA chip behaviour - input mode profile (waist X/Y, M2),
        polarization preference, output mode profile, ASE / gain tables,
        drive current - lives in the per-instance{" "}
        <code>kindParams</code> and is edited in the main scene
        TaperedAmplifierAdjustControls panel, not here.
      </p>
    </div>
  );
}

// =============================================================================
// Fiber patch cable panel: edits the two geometric end faces, plus the
// PM slow axis per connector. This is an unsigned axis (X/Y/Z), not a
// signed direction; +X and -X are the same slow axis. The face normal is
// the optical port normal; the slow axis is intentionally separate, like Waveplate's
// face pick vs. fast-axis direction control.
// =============================================================================

function FiberPatchCableFaceSection({
  inDraft,
  outDraft,
  selectedAnchorKey,
  setSelectedAnchorKey,
  updateDraft,
  slowAxisDraft,
  setSlowAxisDraft,
  onUseHoleCenter,
}: {
  inDraft: AnchorDraft | null;
  outDraft: AnchorDraft | null;
  selectedAnchorKey: string | null;
  setSelectedAnchorKey: (key: string) => void;
  updateDraft: (key: string, patch: Partial<AnchorDraft>) => void;
  slowAxisDraft: FiberSlowAxisDraft;
  setSlowAxisDraft: (patch: Partial<FiberSlowAxisDraft>) => void;
  onUseHoleCenter: (end: FiberEnd) => void;
}) {
  if (!inDraft || !outDraft) {
    return (
      <div className="component-editor-section">
        <div className="component-editor-section-title">Fiber ports</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          No fiber port anchors available.
        </div>
      </div>
    );
  }

  const axisButton = (
    end: FiberEnd,
    axis: FiberSlowAxis,
    activeAxis: FiberSlowAxis,
    patchKey: keyof FiberSlowAxisDraft,
  ) => (
    <button
      key={`${end}-${axis}`}
      type="button"
      className={
        "editor-viewport-side-btn" +
        (activeAxis === axis ? " is-active" : "")
      }
      onClick={() => setSlowAxisDraft({ [patchKey]: axis })}
      title={`Set End ${end} PM slow axis to connector ${axis.toUpperCase()} axis.`}
    >
      {axis.toUpperCase()}
    </button>
  );

  const portBlock = (
    label: string,
    end: FiberEnd,
    draft: AnchorDraft,
    colour: string,
    slowAxis: FiberSlowAxis,
    patchKey: keyof FiberSlowAxisDraft,
  ) => (
    <div
      className={
        "component-editor-anchor-row" +
        (draft.__key === selectedAnchorKey ? " is-active" : "")
      }
      style={{ marginTop: 8, alignItems: "flex-start" }}
    >
      <button
        type="button"
        className="component-editor-anchor-handle"
        onClick={() => setSelectedAnchorKey(draft.__key)}
        style={{ background: colour }}
        title={`Select ${label}`}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <strong>{label}</strong>
          <code style={{ fontSize: 11 }}>{draft.id}</code>
          {draft.directionBodyLocal && (
            <span style={{ fontSize: 11, opacity: 0.7 }}>
              normal ({draft.directionBodyLocal.x.toFixed(2)},{" "}
              {draft.directionBodyLocal.y.toFixed(2)},{" "}
              {draft.directionBodyLocal.z.toFixed(2)})
            </span>
          )}
        </div>
        <EditableAnchorFields
          draft={draft}
          updateDraft={updateDraft}
          showDirection={true}
          showAperture={false}
          apertureMode="scalar"
        />
        <button
          type="button"
          className="secondary-button component-editor-pick-face"
          style={{ marginTop: 8 }}
          onClick={() => onUseHoleCenter(end)}
          title={`Set End ${end} to the ferrule hole center. Use this when the optical aperture is an empty hole with no mesh face to click.`}
        >
          Use End {end} hole center
        </button>
        <div className="editor-viewport-side-row" style={{ marginTop: 8 }}>
          <span className="editor-viewport-side-label">Slow axis:</span>
          {axisButton(end, "x", slowAxis, patchKey)}
          {axisButton(end, "y", slowAxis, patchKey)}
          {axisButton(end, "z", slowAxis, patchKey)}
        </div>
      </div>
    </div>
  );

  return (
    <div className="component-editor-section">
      <div className="component-editor-section-title">Fiber ports</div>
      {portBlock("END A", "A", inDraft, "#4ade80", slowAxisDraft.endA, "endA")}
      {portBlock("END B", "B", outDraft, "#f87171", slowAxisDraft.endB, "endB")}
      <p className="mirror-face-hint">
        Pick each connector face when the aperture has a mesh face. Click the
        yellow aperture ring when the optical aperture is an empty ferrule
        opening. The PM slow axis is stored separately as an unsigned
        connector-frame polarization axis.
      </p>
    </div>
  );
}

// =============================================================================
// AOM dual-port panel: edits intercept_in / intercept_out (both with
// required apertureMm) and shows the derived Bragg-interaction point
// (midpoint of the two anchors). The pivot is purely computed ??when
// the user aligns in the main scene panel, the body rotates around
// this point so the entry/exit ports stay symmetric to the crystal.
//
// What is NOT edited here: acousticAxisBodyLocal,
// braggTiltAxisDegLab, diffractionOrder, RF drive power. Those are
// per-INSTANCE kindParams (vary across SceneObjects sharing the same
// asset) and live in PhysicsElementPanel's AomAdjustControls.
// =============================================================================

function AomFaceSection({
  inDraft,
  outDraft,
  rfInDraft,
  selectedAnchorKey,
  setSelectedAnchorKey,
  updateDraft,
  acousticAxisBodyLocal,
  rfDirectionBodyLocal,
  onRfDirectionChange,
  domain,
}: {
  inDraft: AnchorDraft | null;
  outDraft: AnchorDraft | null;
  rfInDraft: AnchorDraft | null;
  selectedAnchorKey: string | null;
  setSelectedAnchorKey: (k: string | null) => void;
  updateDraft: (key: string, patch: Partial<AnchorDraft>) => void;
  acousticAxisBodyLocal: { x: number; y: number; z: number } | null;
  rfDirectionBodyLocal: { x: number; y: number; z: number };
  onRfDirectionChange: (dir: { x: number; y: number; z: number }) => void;
  // PHY Editor tab the user entered AOM from. "optical" hides RF_IN
  // edit surfaces; "rf" hides intercept_in/out + Bragg + acoustic axis.
  // Same SceneObject, partitioned editing surface per domain.
  domain: "optical" | "rf";
}) {
  const showOptical = domain === "optical";
  const showRf = domain === "rf";

  // RF-only branch: when the user entered AOM from the RF tab, the
  // editor only exposes the physical RF connector (rf_in). intercept_in /
  // intercept_out and the Bragg / acoustic-axis picker stay on the
  // Optical tab — same SceneObject, partitioned editing surface.
  if (showRf) {
    if (!rfInDraft) {
      return (
        <div className="component-editor-section">
          <div className="component-editor-section-title">
            AOM RF drive port
          </div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            <code>rf_in</code> anchor is missing — the kind contract should
            auto-create it. Re-open this component or check the contract
            registry.
          </div>
        </div>
      );
    }
    const isSelected = rfInDraft.__key === selectedAnchorKey;
    const accent = "#b7791f";
    return (
      <div className="component-editor-section">
        <div className="component-editor-section-title">
          AOM RF drive port
        </div>
        <div
          className={
            "component-editor-anchor-row" + (isSelected ? " is-active" : "")
          }
          style={{
            flexDirection: "column",
            alignItems: "stretch",
            padding: "6px 8px",
            marginTop: 6,
            borderLeft: `2px solid ${accent}`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              cursor: "pointer",
            }}
            onClick={() => setSelectedAnchorKey(rfInDraft.__key)}
          >
            <strong style={{ color: accent, fontSize: 13 }}>
              RF_IN (SMA jack)
            </strong>
            <span
              style={{ fontSize: 10, opacity: 0.6, fontFamily: "monospace" }}
            >
              rf_in
            </span>
          </div>
          <div
            className="mirror-face-status"
            style={{ marginTop: 4, marginBottom: 4 }}
          >
            <span style={{ opacity: 0.65 }}>
              ({rfInDraft.positionMmBodyLocal.x.toFixed(2)},{" "}
              {rfInDraft.positionMmBodyLocal.y.toFixed(2)},{" "}
              {rfInDraft.positionMmBodyLocal.z.toFixed(2)}) mm
            </span>
            {rfInDraft.directionBodyLocal && (
              <span style={{ opacity: 0.65, marginLeft: 8 }}>
                n=(
                {rfInDraft.directionBodyLocal.x.toFixed(2)},{" "}
                {rfInDraft.directionBodyLocal.y.toFixed(2)},{" "}
                {rfInDraft.directionBodyLocal.z.toFixed(2)}
                )
              </span>
            )}
          </div>
          <EditableAnchorFields
            draft={rfInDraft}
            updateDraft={updateDraft}
            showDirection={true}
            showConnectorType={true}
            apertureMode="scalar"
          />
          <p
            className="mirror-face-hint"
            style={{ marginTop: 4, fontSize: 11 }}
          >
            Position = SMA jack centre on the AOM driver housing.
            Direction = OUTWARD face normal (the way a mating cable plug
            slides on). Click <strong>"Pick RF_IN face"</strong> in the
            viewport toolbar to BFS-detect the face from the mesh.
          </p>
        </div>
      </div>
    );
  }

  // Optical branch — needs both optical ports.
  if (!inDraft || !outDraft) {
    return (
      <div className="component-editor-section">
        <div className="component-editor-section-title">AOM optical ports</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          Both <code>intercept_in</code> and <code>intercept_out</code>{" "}
          must exist. Use the dropdown above to add the missing port - align needs both to disambiguate entry vs exit.
        </div>
      </div>
    );
  }

  const midpoint = {
    x: (inDraft.positionMmBodyLocal.x + outDraft.positionMmBodyLocal.x) / 2,
    y: (inDraft.positionMmBodyLocal.y + outDraft.positionMmBodyLocal.y) / 2,
    z: (inDraft.positionMmBodyLocal.z + outDraft.positionMmBodyLocal.z) / 2,
  };
  const portSep = Math.hypot(
    outDraft.positionMmBodyLocal.x - inDraft.positionMmBodyLocal.x,
    outDraft.positionMmBodyLocal.y - inDraft.positionMmBodyLocal.y,
    outDraft.positionMmBodyLocal.z - inDraft.positionMmBodyLocal.z,
  );
  // V2: aperture is per-instance now, so the "aperture matched / differ"
  // status display has been dropped from the PHY Editor. Per-port
  // apertures are inspected on the Object panel instead.
  const portBlock = (
    label: string,
    sublabel: string,
    draft: AnchorDraft,
    accentColour: string,
  ) => {
    const isSelected = draft.__key === selectedAnchorKey;
    return (
      <div
        className={
          "component-editor-anchor-row" + (isSelected ? " is-active" : "")
        }
        style={{
          flexDirection: "column",
          alignItems: "stretch",
          padding: "6px 8px",
          marginTop: 6,
          borderLeft: `2px solid ${accentColour}`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            cursor: "pointer",
          }}
          onClick={() => setSelectedAnchorKey(draft.__key)}
        >
          <strong style={{ color: accentColour, fontSize: 13 }}>{label}</strong>
          <span style={{ fontSize: 10, opacity: 0.6, fontFamily: "monospace" }}>
            {sublabel}
          </span>
        </div>
        <div className="mirror-face-status" style={{ marginTop: 4, marginBottom: 4 }}>
          <span style={{ opacity: 0.65 }}>
            ({draft.positionMmBodyLocal.x.toFixed(2)},{" "}
            {draft.positionMmBodyLocal.y.toFixed(2)},{" "}
            {draft.positionMmBodyLocal.z.toFixed(2)}) mm
          </span>
          {/* V2: per-port aperture moved to the Object panel
              (objects.properties.anchorBindings[].payload.aperture). */}
        </div>
        <EditableAnchorFields
          draft={draft}
          updateDraft={updateDraft}
          showDirection={false}
          apertureMode="scalar"
        />
      </div>
    );
  };

  return (
    <div className="component-editor-section">
      <div className="component-editor-section-title">AOM optical ports</div>
      {portBlock("INTERCEPT_IN", "intercept_in", inDraft, "#4ade80")}
      {portBlock("INTERCEPT_OUT", "intercept_out", outDraft, "#f87171")}
      {/* RF Drive Port (rf_in anchor) intentionally NOT rendered here —
          it's edited from the RF tab via the RF-only branch above. Same
          SceneObject, partitioned editing surface per tab. */}
      <div
        className="mirror-face-status"
        style={{
          marginTop: 10,
          padding: "6px 8px",
          background: "rgba(250, 204, 21, 0.10)",
          borderLeft: "2px solid #facc15",
        }}
      >
        <strong style={{ color: "#facc15", fontSize: 12 }}>
          Bragg interaction point (auto)
        </strong>
        <div style={{ opacity: 0.85, fontSize: 11, marginTop: 4 }}>
          ({midpoint.x.toFixed(2)}, {midpoint.y.toFixed(2)}, {midpoint.z.toFixed(2)}) mm - midpoint of intercept_in / intercept_out. Align rotates the body
          around this point.
        </div>
        <div style={{ opacity: 0.7, fontSize: 11, marginTop: 4 }}>
          port separation: <strong>{portSep.toFixed(2)} mm</strong>
          {acousticAxisBodyLocal && (
            <>
              {" | "}acoustic axis (read-only):{" "}
              <code style={{ fontSize: 10 }}>
                ({acousticAxisBodyLocal.x.toFixed(2)},{" "}
                {acousticAxisBodyLocal.y.toFixed(2)},{" "}
                {acousticAxisBodyLocal.z.toFixed(2)})
              </code>
            </>
          )}
        </div>
      </div>
      <p className="mirror-face-hint">
        Both ports require <strong>apertureMm</strong> set - the active
        (Bragg-mode) aperture in mm. Align uses these to (a) refuse if
        either is missing, (b) detect ambiguous beam geometry when both
        ports are within one aperture of the same beam point, and (c)
        warn when the upstream beam waist exceeds the entry aperture
        (will clip).
      </p>

      {/* Bragg tilt-axis angle ??1-DoF user choice CONSTRAINED to the
          plane perpendicular to the port-to-port axis (b?). The 帢
          parameterisation is body-local so the visual + numeric
          relationship to the model stays stable across SceneObject
          rotations. For the MT80 frame, 帢=270簞 points ?? along body?
          (perpendicular to the outline drawing). Runtime degeneracy
          depends on the acoustic axis and is flagged below. */}
      <div
        style={{
          marginTop: 10,
          padding: "6px 8px",
          background: "rgba(249, 115, 22, 0.10)",
          borderLeft: "2px solid #f97316",
        }}
      >
        <strong style={{ color: "#f97316", fontSize: 12 }}>
          RF signal input direction (orange arrow derives Bragg tilt)
        </strong>
        <div className="mirror-adjust-row" style={{ marginTop: 6 }}>
          {[
            { label: "RF -X", dir: { x: -1, y: 0, z: 0 }, hint: "MT80 default: RF/acoustic input direction body -X" },
            { label: "RF +X", dir: { x: 1, y: 0, z: 0 }, hint: "Opposite RF/acoustic direction" },
            { label: "RF +Z", dir: { x: 0, y: 0, z: 1 }, hint: "RF/acoustic direction body +Z" },
            { label: "RF -Z", dir: { x: 0, y: 0, z: -1 }, hint: "RF/acoustic direction body -Z" },
          ].map((preset) => {
            const active =
              Math.abs(rfDirectionBodyLocal.x - preset.dir.x) < 1e-6 &&
              Math.abs(rfDirectionBodyLocal.y - preset.dir.y) < 1e-6 &&
              Math.abs(rfDirectionBodyLocal.z - preset.dir.z) < 1e-6;
            return (
              <button
                key={preset.label}
                type="button"
                className={active ? "primary-button" : "secondary-button"}
                onClick={() => onRfDirectionChange(preset.dir)}
                style={{ minWidth: 68 }}
                title={preset.hint}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <div className="mirror-face-status" style={{ marginTop: 6 }}>
          RF direction:{" "}
          <code style={{ fontSize: 10 }}>
            ({rfDirectionBodyLocal.x.toFixed(2)}, {" "}
            {rfDirectionBodyLocal.y.toFixed(2)}, {" "}
            {rfDirectionBodyLocal.z.toFixed(2)})
          </code>
          {" -> "}tilt axis = RF x b
        </div>
        {(() => {
          const bx = outDraft.positionMmBodyLocal.x - inDraft.positionMmBodyLocal.x;
          const by = outDraft.positionMmBodyLocal.y - inDraft.positionMmBodyLocal.y;
          const bz = outDraft.positionMmBodyLocal.z - inDraft.positionMmBodyLocal.z;
          const bMag = Math.hypot(bx, by, bz);
          if (bMag < 1e-6) return null;
          const tilt = computeBraggTiltAxisFromRfDirectionBodyLocal(
            { x: bx / bMag, y: by / bMag, z: bz / bMag },
            rfDirectionBodyLocal,
          );
          if (!tilt) {
            return (
              <div style={{ marginTop: 6, fontSize: 11, color: "#f87171" }}>
                RF direction is parallel to the port-to-port optical axis; Bragg tilt cannot be derived.
              </div>
            );
          }
          return (
            <div style={{ marginTop: 6, fontSize: 11, opacity: 0.75 }}>
              Derived tilt axis:{" "}
              <code style={{ fontSize: 10 }}>
                ({tilt.x.toFixed(2)}, {tilt.y.toFixed(2)}, {tilt.z.toFixed(2)})
              </code>
            </div>
          );
        })()}
        <p style={{ fontSize: 11, opacity: 0.75, marginTop: 6 }}>
          {"For the MT80 frame, RF -X with b=intercept_in -> intercept_out"}
          gives derived tilt axis body -Z, matching the perpendicular-to-page
          Bragg rocking axis.
        </p>
      </div>

      <p className="mirror-face-hint">
        Other AOM physics - acoustic axis, RF drive power, diffraction
        order - are <em>per-instance</em> and edited in the scene's AOM
        Adjust Controls panel, not here. To override the rotation pivot
        from the auto-midpoint (rare; only for asymmetric AOMs), set
        <code> kindParams.braggInteractionPointMmBodyLocal</code> on the
        instance.
      </p>
    </div>
  );
}


// =============================================================================
// Main editor component
// =============================================================================


// Anchor IDs that are RF / coax ports. The PHY Editor's tab filter (and
// the 3D marker palette) treats these as the "RF surface" of a kind —
// independent of the kind's primary domain. AOM is the canonical hybrid:
// optically a passive nonlinear element (intercept_in / intercept_out),
// but it also takes an RF drive cable (rf_in) — so it appears in BOTH
// the Optical and RF Components tabs after this 2026-05-13 change.
const RF_ANCHOR_IDS_SET: ReadonlySet<string> = new Set([
  "rf_in",
  "rf_out",
  // TTL / digital-control input on the body of a kind that's
  // structurally an RF device (rf_switch's 4th SMA jack). Listed here
  // so a kind with rf_in + rf_out + ttl_in still resolves ONLY to the
  // RF tab — without this the Optical-tab filter ("any anchor not in
  // this set") would catch ttl_in and double-list rf_switch in both
  // tabs.
  "ttl_in",
  "aperture",
]);

/** Subset of RF_ANCHOR_IDS_SET that physically lives on a coaxial connector
 *  (and therefore has a meaningful SMA/BNC × M/F gender). `aperture` is
 *  excluded — it's a radiating face on horn_antenna, not a connector. */
const RF_CONNECTOR_ANCHOR_IDS: ReadonlySet<string> = new Set([
  "rf_in",
  "rf_out",
  "ttl_in",
]);

function kindAnchorIds(kind: ElementKind): readonly string[] {
  const c = KIND_REGISTRY[kind as keyof typeof KIND_REGISTRY];
  if (!c) return [];
  return [...c.requiredAnchors, ...c.optionalAnchors];
}

const KINDS_WITH_RF_ANCHORS: ReadonlySet<string> = new Set(
  (Object.keys(KIND_REGISTRY) as ElementKind[]).filter((k) =>
    kindAnchorIds(k).some((id) => RF_ANCHOR_IDS_SET.has(id)),
  ),
);

const KINDS_WITH_OPTICAL_ANCHORS: ReadonlySet<string> = new Set(
  (Object.keys(KIND_REGISTRY) as ElementKind[]).filter((k) =>
    kindAnchorIds(k).some((id) => !RF_ANCHOR_IDS_SET.has(id)),
  ),
);

export function ComponentEditor({ domain = "optical" }: { domain?: "optical" | "rf" } = {}) {
  const scene = useSceneStore((s) => s.scene);
  const editingAssetId = useSceneStore((s) => s.editingAssetId);
  const selectedComponentId = useSceneStore((s) => s.selectedComponentId);
  const setEditingAssetId = useSceneStore((s) => s.setEditingAssetId);
  const selectComponent = useSceneStore((s) => s.selectComponent);
  const updateAssetAnchors = useSceneStore((s) => s.updateAssetAnchors);
  const updateComponent = useSceneStore((s) => s.updateComponent);
  const setPhyEditorDirty = useSceneStore((s) => s.setPhyEditorDirty);

  const componentsWithFunction = useMemo(() => {
    // Phase 7.4 follow-up: switched from `kindsWithFunction` (alignVariant
    // filter) to `kindsWithEditableAnchors` so laser_source — which has
    // no align action but DOES need an editable `out` anchor for the
    // emission origin + direction — appears in the PHY Editor list.
    // Fiber is added explicitly even though it has no static anchors —
    // its endpoints come from the editable Bezier spline. The selected-
    // fiber path renders a kind-specific inspector below instead of the
    // anchor 3D viewport.
    const enabledKinds = new Set<string>([...kindsWithEditableAnchors(), "fiber"]);
    return scene.components.filter((c) => {
      const kind = componentTypeToElementKind(c.componentType);
      if (kind == null || !enabledKinds.has(kind)) return false;
      // Anchor-based tab routing (Phase RF.cable follow-up, 2026-05-13):
      // RF tab = kinds whose contract has any rf_in/rf_out/aperture
      // anchor; Optical tab = kinds whose contract has any non-RF
      // anchor. Hybrid kinds like AOM (intercept_in/out + rf_in) appear
      // in BOTH tabs. Fiber is added explicitly to enabledKinds above
      // (its anchors come from Component.fiberAnchors, not KIND_REGISTRY)
      // and falls on the Optical side via KINDS_WITH_OPTICAL_ANCHORS.
      if (domain === "rf") return KINDS_WITH_RF_ANCHORS.has(kind);
      return KINDS_WITH_OPTICAL_ANCHORS.has(kind);
    });
  }, [scene.components, domain]);

  // Group by ElementKind for the left list
  const groupedComponents = useMemo(() => {
    const map = new Map<string, ComponentItem[]>();
    for (const c of componentsWithFunction) {
      const kind = componentTypeToElementKind(c.componentType);
      if (!kind) continue;
      const list = map.get(kind) ?? [];
      list.push(c);
      map.set(kind, list);
    }
    return map;
  }, [componentsWithFunction]);

  const selectedComponent = useMemo(
    () => scene.components.find((c) => c.id === selectedComponentId) ?? null,
    [scene.components, selectedComponentId],
  );
  const editedAsset = useMemo(
    () => scene.assets.find((a) => a.id === editingAssetId),
    [scene.assets, editingAssetId],
  );
  const kindContract: KindContract | null = useMemo(() => {
    if (!selectedComponent) return null;
    return getKindContract(componentTypeToElementKind(selectedComponent.componentType));
  }, [selectedComponent]);
  // Unified per-component anchor contract for AUTO-FILL: identity (id +
  // name + count) is sourced from the contract. Per-component-type
  // overrides win (e.g. AD9959's 4 SMA ports distinguished by name);
  // otherwise falls back to KIND_REGISTRY's required + optional anchors
  // (id only). PHY Editor uses this list to auto-create missing anchors
  // on load. Always an array (possibly empty) so callers can iterate
  // unconditionally.
  const lockedAnchorContract: AnchorTemplate[] = useMemo(
    () => getAnchorContractFor(selectedComponent?.componentType),
    [selectedComponent?.componentType],
  );
  // Per-component-type HARD LOCK (CH0..CH3 fixed on AD9959, etc.). When
  // true, the anchor inspector hides "+ Add" / "Delete" and replaces the
  // id `<select>` with a read-only `<code>` showing id · name —
  // position/direction stay editable for STL-alignment dragging. Optical
  // kinds with only a KIND_REGISTRY contract stay soft-locked (existing
  // behaviour: free edits + validation badges).
  const isAnchorIdentityHardLocked = useMemo(
    () =>
      selectedComponent != null &&
      COMPONENT_ANCHOR_CONTRACTS[selectedComponent.componentType] != null,
    [selectedComponent],
  );
  // Mirror & dichroic-mirror get a streamlined "single face" UX ??  // there is exactly one anchor (intercept_face) and no list / +Add /
  // delete UI; the user just picks the reflective face on the 3D mesh
  // and chooses which side reflects via +/??buttons.
  const isMirrorKind =
    kindContract?.kind === "mirror" || kindContract?.kind === "dichroic_mirror";
  // Lens shares mirror's "single anchor + 3D pick" backbone but with
  // two sub-modes: PLANO-CONVEX (pick the flat face ??arrow then auto-
  // points INTO the body, i.e. toward the convex side) and BI-CONVEX
  // (no flat face to pick ??snap anchor to the body centre and choose
  // X/Y/Z as the optical axis; the arrow renders bidirectional).
  const isLensKind =
    kindContract?.kind === "lens_biconvex" ||
    kindContract?.kind === "lens_plano_convex" ||
    kindContract?.kind === "lens_cylindrical";
  // Waveplate also single-face: pick the flat face (sets intercept_in
  // position), and X/Y/Z buttons set directionBodyLocal as the fast-
  // axis. Per-instance fast-axis ROTATION around the beam stays in
  // kindParams.fastAxisDegBeamLocal (edited in the main scene panel).
  const isWaveplateKind = kindContract?.kind === "waveplate";
  // 2026-05-09: fiber joined the standard anchor model. Endpoints still come
  // from the Bezier spline, but the optical PORT positions (intercept_in /
  // intercept_out) live as anchors stored on Component.properties.fiberAnchors
  // (because fiber has no Asset3D — see kind-contract comment in
  // kinds/_registry.ts).
  const isFiberKind = kindContract?.kind === "fiber";
  const selectedFiberObject = useMemo(() => {
    if (!isFiberKind || !selectedComponent) return null;
    return scene.objects.find((o) => o.componentId === selectedComponent.id) ?? null;
  }, [isFiberKind, selectedComponent, scene.objects]);
  const selectedFiberElement = useMemo(() => {
    if (!selectedFiberObject) return null;
    return scene.physicsElements.find((e) => e.objectId === selectedFiberObject.id) ?? null;
  }, [selectedFiberObject, scene.physicsElements]);
  /** Anchor editing is enabled when there's an Asset3D (the usual case) OR
   *  the component is a fiber (anchors live on Component.properties). */
  const canEditAnchors = !!editedAsset || (isFiberKind && !!selectedComponent);
  /** Anchor source for the drafts loader. Returns the array of stored
   *  Anchor records — for fiber it's `Component.properties.fiberAnchors`,
   *  otherwise `editedAsset.anchors`. */
  const sourceAnchorsLength: number = isFiberKind
    ? (((selectedComponent?.properties as { fiberAnchors?: unknown[] } | undefined)?.fiberAnchors)?.length ?? 0)
    : (editedAsset?.anchors?.length ?? 0);
  // PBS / BS are a cube of two right-angle prisms cemented along the
  // diagonal. The interface (= the cement plane) lives INSIDE the
  // cube, so the user can't pick it from the wireframe directly ??  // instead we let them snap-to-cube-centre + click one of 6 diagonal
  // direction buttons. PBS vs BS is asset-template metadata
  // (Component.properties.beamSplitterType ??Phase 2; for now we
  // infer from kindParams.polarizing).
  const isBeamSplitterKind = kindContract?.kind === "beam_splitter";
  // Tapered Amplifier is the first DUAL-ANCHOR kind: separate INPUT
  // and OUTPUT face anchors, both face-pickable from the wireframe,
  // both with rectangular apertures (chip TA waveguide). The two
  // direction vectors should be anti-parallel (light enters INPUT,
  // exits OUTPUT through the body) ??health check badge in the
  // inspector flags violations.
  const isTaperedAmplifierKind = kindContract?.kind === "tapered_amplifier";
  // AOM is dual-anchor (intercept_in / intercept_out, both with
  // apertureMm) plus a derived "Bragg interaction point" pivot at the
  // midpoint of the two ports. The inspector echoes the pivot back so
  // users see immediately where the body will rock around when align
  // applies the braggTiltAxisDegLab rotation.
  const isAomKind = kindContract?.kind === "aom";
  // Laser source is single-anchor (the `out` emission point, with both
  // position and direction). Pick a face on the laser body to set
  // emission origin + outward normal, or type exact values below. No
  // generic anchor-list UI — the user only ever needs to define this
  // one anchor.
  const isLaserSourceKind = kindContract?.kind === "laser_source";
  const isSingleFaceKind =
    isMirrorKind || isLensKind || isWaveplateKind || isBeamSplitterKind || isLaserSourceKind;
  // Combined flag for "kind has a dedicated editor UX" ??hides the
  // generic anchor-list / Selected coordinate-grid UI in the right
  // pane. Single-face kinds + TA + AOM all qualify.
  const hasCustomEditorUX = isSingleFaceKind || isTaperedAmplifierKind || isAomKind || isFiberKind;
  const singleFaceAnchorId = isMirrorKind
    ? "intercept_face"
    : isLaserSourceKind
      ? "out"
      : "intercept_in";

  // Anchor drafts ??local state, only flushed to backend on Save.
  const [drafts, setDrafts] = useState<AnchorDraft[]>([]);
  const [selectedAnchorKey, setSelectedAnchorKey] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fiberSlowAxisDraft, setFiberSlowAxisDraftState] = useState<FiberSlowAxisDraft>({
    endA: "x",
    endB: "x",
  });

  // Reload drafts whenever the editing asset (or, for fiber, the selected
  // component) changes.
  useEffect(() => {
    // Fiber path: load drafts from Component.properties.fiberAnchors. Defaults
    // for intercept_in / intercept_out (= ferrule tip in connector body-local
    // mm) are seeded if missing so the user always sees the two ports listed.
    if (isFiberKind && selectedComponent) {
      const fa =
        ((selectedComponent.properties as { fiberAnchors?: Anchor[] } | undefined)
          ?.fiberAnchors ?? []) as Anchor[];
      let initial = fa.map(anchorToDraft);
      if (!initial.some((d) => d.id === "intercept_in")) {
        initial = [
          ...initial,
          {
            ...fiberDefaultPortAnchor(selectedComponent, "A"),
            __key: freshKey(),
          },
        ];
      }
      if (!initial.some((d) => d.id === "intercept_out")) {
        initial = [
          ...initial,
          {
            ...fiberDefaultPortAnchor(selectedComponent, "B"),
            __key: freshKey(),
          },
        ];
      }
      setDrafts(initial);
      setSelectedAnchorKey(initial.find((d) => d.id === "intercept_in")?.__key ?? null);
      setFiberSlowAxisDraftState(
        fiberSlowAxisFromComponent(selectedComponent, selectedFiberElement?.kindParams),
      );
      setDirty(false);
      setErrorMsg(null);
      return;
    }
    if (!editedAsset) {
      setDrafts([]);
      setSelectedAnchorKey(null);
      setDirty(false);
      return;
    }
    let initial = (editedAsset.anchors ?? []).map(anchorToDraft);
    // For single-face kinds, ensure the canonical anchor draft always
    // exists so the dedicated UX always has something to bind to.
    //   mirror / dichroic_mirror      ??intercept_face
    //   lens / waveplate / beam_splitter ??intercept_in
    if (isSingleFaceKind && !initial.some((d) => d.id === singleFaceAnchorId)) {
      // Per-kind default direction:
      //   beam_splitter: +X+Y diagonal (Thorlabs PBS / BS cube orientation)
      //   laser_source : +X (canonical emission direction along body +X)
      //   others       : undefined (user picks face → BFS-computed normal)
      const defaultDir = isBeamSplitterKind
        ? { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 }
        : isLaserSourceKind
          ? { x: 1, y: 0, z: 0 }
          : undefined;
      // For laser_source, try to migrate the legacy "+x" auto-bbox
      // anchor into the editable "out" anchor so user-set position +
      // direction survives on first open. Without this, the user opens
      // a laser asset that has only "+x" and sees "out" at body
      // origin / +X — losing whatever the +x anchor was pointing at.
      const legacyPlusX = isLaserSourceKind
        ? initial.find((d) => d.id === "+x")
        : undefined;
      initial = [
        ...initial,
        {
          id: singleFaceAnchorId as "intercept_face" | "intercept_in" | "out",
          positionMmBodyLocal: legacyPlusX
            ? { ...legacyPlusX.positionMmBodyLocal }
            : { x: 0, y: 0, z: 0 },
          directionBodyLocal: legacyPlusX?.directionBodyLocal ?? defaultDir,
          apertureMm: legacyPlusX?.apertureMm ?? 12.5,
          __key: freshKey(),
        },
      ];
    }
    // For TA, ensure BOTH intercept_in and intercept_out drafts exist.
    // Defaults: INPUT face on body ? (light enters), OUTPUT on body
    // +X (amplified beam exits). Both directions are OUTWARD face
    // normals, so anti-parallel = (-1,0,0) vs (+1,0,0). User picks
    // each face on the 3D wireframe to set actual positions.
    if (isTaperedAmplifierKind) {
      if (!initial.some((d) => d.id === "intercept_in")) {
        initial = [
          ...initial,
          {
            id: "intercept_in",
            positionMmBodyLocal: { x: 0, y: 0, z: 0 },
            directionBodyLocal: { x: -1, y: 0, z: 0 },
            apertureMm: 12.5,
            __key: freshKey(),
          },
        ];
      }
      if (!initial.some((d) => d.id === "intercept_out")) {
        initial = [
          ...initial,
          {
            id: "intercept_out",
            positionMmBodyLocal: { x: 0, y: 0, z: 0 },
            directionBodyLocal: { x: 1, y: 0, z: 0 },
            apertureMm: 12.5,
            __key: freshKey(),
          },
        ];
      }
    }
    // For AOM, ensure BOTH ports exist. Defaults are bodyLength-aware
    // (Blender Y axis = optical axis), aperture default = 0.75 mm
    // (= MT80 active aperture / 2 ??most common AOM in this project).
    // Migration 0021 already populates these for existing rows; this
    // block only fires for assets without anchors yet.
    if (isAomKind) {
      if (!initial.some((d) => d.id === "intercept_in")) {
        initial = [
          ...initial,
          {
            id: "intercept_in",
            positionMmBodyLocal: { x: 0, y: -10, z: 0 },
            directionBodyLocal: { x: 0, y: 1, z: 0 },
            apertureMm: 0.75,
            __key: freshKey(),
          },
        ];
      }
      if (!initial.some((d) => d.id === "intercept_out")) {
        initial = [
          ...initial,
          {
            id: "intercept_out",
            positionMmBodyLocal: { x: 0, y: 10, z: 0 },
            directionBodyLocal: { x: 0, y: -1, z: 0 },
            apertureMm: 0.75,
            __key: freshKey(),
          },
        ];
      }
    }
    // Generic contract-driven auto-fill: ensure every anchor declared in
    // the locked contract is present in `initial`. Runs AFTER kind-specific
    // auto-fills (TA / AOM / single-face) so their per-port defaults
    // (aperture, direction) take priority; this loop only catches the
    // anchors those blocks don't seed (per-component overrides like
    // AD9959's 7 SMA ports, or simple optical kinds whose KIND_REGISTRY
    // contract isn't already covered by a special-case block above).
    for (const tpl of lockedAnchorContract) {
      const already = initial.some((d) => anchorMatchesTemplate(d, tpl));
      if (already) continue;
      initial = [
        ...initial,
        {
          id: tpl.id,
          name: tpl.name,
          positionMmBodyLocal: tpl.positionMmBodyLocal ?? { x: 0, y: 0, z: 0 },
          directionBodyLocal: tpl.directionBodyLocal,
          __key: freshKey(),
        },
      ];
    }
    setDrafts(initial);
    // Auto-select the canonical anchor so the inspector + viewport
    // overlay bind immediately without an extra click. TA / AOM both
    // pick intercept_in by default (gizmo attaches to that marker;
    // user can click the OUTPUT marker to switch).
    const auto = isSingleFaceKind
      ? initial.find((d) => d.id === singleFaceAnchorId)?.__key ?? null
      : (isTaperedAmplifierKind || isAomKind)
        ? initial.find((d) => d.id === "intercept_in")?.__key ?? null
        : null;
    setSelectedAnchorKey(auto);
    setDirty(false);
    setErrorMsg(null);
    setAomRfDirectionDraft(null);
  }, [
    editedAsset?.id,
    editedAsset?.anchors?.length,
    isSingleFaceKind,
    isTaperedAmplifierKind,
    isAomKind,
    isBeamSplitterKind,
    singleFaceAnchorId,
    isFiberKind,
    selectedComponent?.id,
    selectedFiberElement?.id,
    sourceAnchorsLength,
    lockedAnchorContract,
  ]);

  // Mirror local dirty state into the store so the PhyEditor wrapper's
  // top-bar Back button can prompt before unmounting us.
  useEffect(() => {
    setPhyEditorDirty(dirty);
    return () => setPhyEditorDirty(false);
  }, [dirty, setPhyEditorDirty]);

  const viewportRef = useRef<HTMLDivElement>(null);

  // Pick-face mode: when true, the next click in the 3D viewport
  // raycasts against the loaded mesh (not against marker spheres) and
  // sets the selected anchor's position + direction from the hit face.
  // Lives in a ref so the viewport's click handler always sees the
  // current value without forcing a viewport rebuild.
  const [pickFaceMode, setPickFaceMode] = useState(false);
  const pickFaceModeRef = useRef(false);
  useEffect(() => {
    pickFaceModeRef.current = pickFaceMode;
  }, [pickFaceMode]);

  // Anchor ID that the next face-pick should write to. Single-face
  // kinds don't need this (selectedAnchorKey already tracks the only
  // anchor), but TA's dual-anchor flow uses it: clicking the "Pick
  // INPUT" button sets target = "intercept_in", "Pick OUTPUT" sets
  // target = "intercept_out". When null, handlePickFace falls back
  // to selectedAnchorKey.
  const [pickFaceTarget, setPickFaceTarget] = useState<string | null>(null);
  const [aomRfDirectionDraft, setAomRfDirectionDraft] = useState<{ x: number; y: number; z: number } | null>(null);

  // ESC cancels pick mode anywhere on the page.
  useEffect(() => {
    if (!pickFaceMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickFaceMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickFaceMode]);

  const handleAnchorDrag = (key: string, posMm: { x: number; y: number; z: number }) => {
    setDrafts((prev) =>
      prev.map((d) =>
        d.__key === key ? { ...d, positionMmBodyLocal: posMm } : d,
      ),
    );
    setDirty(true);
  };

  // Lens-only sub-mode: PLANO-CONVEX (default ??pick the flat face)
  // or BI-CONVEX (no flat face; snap to body centre + pick axis).
  // Local-only UI state; not persisted (lens type is asset-level
  // metadata that ideally lives in Component.properties.lensType later).
  const [lensMode, setLensMode] = useState<"plano" | "bi">("plano");

  // Picked-face outline points (in wrapper-local three Y-up). Live state
  // only ??not persisted on the anchor. Cleared when component changes
  // or when the user explicitly resets.
  const [pickedOutline, setPickedOutline] = useState<number[]>([]);
  const [pickedFacePreview, setPickedFacePreview] = useState<FacePreview | null>(null);
  // The natural BFS-computed normal (the side facing the click). Stored
  // separately so the +/- side buttons can flip without losing the
  // original orientation.
  const [pickedNormal, setPickedNormal] = useState<{
    x: number;
    y: number;
    z: number;
  } | null>(null);

  const handlePickFace = (
    posMm: { x: number; y: number; z: number },
    dirBodyLocal: { x: number; y: number; z: number },
    outlinePointsWrapperThree: number[],
    faceTrianglesWrapperThree: number[],
    pickedAnchorId?: string,
  ) => {
    // Resolve which draft to update: prefer pickFaceTarget (explicit
    // anchor ID for multi-anchor kinds like TA), fall back to
    // selectedAnchorKey (single-anchor kinds where selection auto-
    // tracks the canonical anchor).
    const targetDraft = pickedAnchorId
      ? drafts.find((d) => d.id === pickedAnchorId)
      : pickFaceTarget
      ? drafts.find((d) => d.id === pickFaceTarget)
      : drafts.find((d) => d.__key === selectedAnchorKey);
    if (!targetDraft) {
      setPickFaceMode(false);
      setPickFaceTarget(null);
      return;
    }
    const targetKey = targetDraft.__key;
    // Per-kind direction semantics:
    //   Mirror: directionBodyLocal = OUTWARD normal of reflective face
    //           (which side reflects). Keep the BFS-computed normal.
    //   Lens:   directionBodyLocal = OPTICAL AXIS (light into body, i.e.
    //           toward the convex side). FLIP the BFS normal.
    //   Waveplate: directionBodyLocal = FAST AXIS, set independently
    //           via X/Y/Z buttons ??face pick only contributes the
    //           POSITION, the previous fast-axis (if any) is preserved.
    //   TA:     directionBodyLocal = OUTWARD face normal (same as
    //           mirror) ??light enters INPUT in -dir, exits OUTPUT
    //           in +dir.
    let finalDir = dirBodyLocal;
    if (isLensKind) {
      finalDir = { x: -dirBodyLocal.x, y: -dirBodyLocal.y, z: -dirBodyLocal.z };
    } else if (isWaveplateKind) {
      const cur = targetDraft.directionBodyLocal;
      // If the user already set a fast-axis, keep it. Otherwise default
      // to body +X so the X/Y/Z buttons have a definite starting point.
      finalDir = cur ?? { x: 1, y: 0, z: 0 };
    }
    setDrafts((prev) =>
      prev.map((d) =>
        d.__key === targetKey
          ? { ...d, positionMmBodyLocal: posMm, directionBodyLocal: finalDir }
          : d,
      ),
    );
    setPickedOutline(outlinePointsWrapperThree);
    setPickedNormal(finalDir);
    setPickedFacePreview({
      faceTrianglesWrapperThree,
    });
    setDirty(true);
    setPickFaceMode(false);
    setPickFaceTarget(null);
  };

  // Lens bi-convex flow: place anchor at the loaded mesh's bbox centre
  // and let the user pick which body axis is the optical axis. We need
  // the wrapper's mesh bbox; expose a small helper that walks the
  // viewport's hosted mesh (the editor's separate scene). Since
  // useViewport doesn't expose the bbox directly, we re-compute here
  // using the same loadAssetObject path the editor uses internally.
  const handleSnapBodyCenter = () => {
    if (!selectedAnchorKey || !editedAsset) return;
    // Use Three's Box3 over the wrapper child mesh group hosted in our
    // viewport. Easiest: rely on the published `meshSpan` proxy by
    // reading positions in body-local from the asset's existing
    // `intercept_face` / origin if any. But the simplest, robust path:
    // anchor at body local origin. Most lens GLBs are authored with
    // the body centre at the origin already.
    setDrafts((prev) =>
      prev.map((d) =>
        d.__key === selectedAnchorKey
          ? {
              ...d,
              positionMmBodyLocal: { x: 0, y: 0, z: 0 },
              // Default optical axis = body +X. User then picks which
              // axis by clicking one of the X/Y/Z preset buttons.
              directionBodyLocal: d.directionBodyLocal ?? { x: 1, y: 0, z: 0 },
            }
          : d,
      ),
    );
    // Bi-convex doesn't use a single picked face ??clear the outline
    // and the cached pickedNormal so the +/- side buttons hide.
    setPickedOutline([]);
    setPickedNormal(null);
    setPickedFacePreview(null);
    setDirty(true);
  };

  const handleLensAxis = (axis: "x" | "y" | "z") => {
    if (!selectedAnchorKey) return;
    const dir =
      axis === "x"
        ? { x: 1, y: 0, z: 0 }
        : axis === "y"
          ? { x: 0, y: 1, z: 0 }
          : { x: 0, y: 0, z: 1 };
    setDrafts((prev) =>
      prev.map((d) =>
        d.__key === selectedAnchorKey ? { ...d, directionBodyLocal: dir } : d,
      ),
    );
    setDirty(true);
  };

  /** Set the BS coating-normal to one of the 6 face-aligned cube
   *  diagonals. `pair` chooses which two axes are in the diagonal,
   *  `sign` flips the diagonal's other axis component. e.g.
   *  ("xy", "+") ??(0.707, 0.707, 0); ("xy", "-") ??(0.707, -0.707, 0). */
  const handleBSDiagonal = (
    pair: "xy" | "xz" | "yz",
    sign: "+" | "-",
  ) => {
    if (!selectedAnchorKey) return;
    const s = sign === "+" ? 1 : -1;
    const dir =
      pair === "xy"
        ? { x: Math.SQRT1_2, y: s * Math.SQRT1_2, z: 0 }
        : pair === "xz"
          ? { x: Math.SQRT1_2, y: 0, z: s * Math.SQRT1_2 }
          : { x: 0, y: Math.SQRT1_2, z: s * Math.SQRT1_2 };
    setDrafts((prev) =>
      prev.map((d) =>
        d.__key === selectedAnchorKey ? { ...d, directionBodyLocal: dir } : d,
      ),
    );
    setDirty(true);
  };

  const handleBSFlip = () => {
    if (!selectedAnchorKey) return;
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.__key !== selectedAnchorKey || !d.directionBodyLocal) return d;
        return {
          ...d,
          directionBodyLocal: {
            x: -d.directionBodyLocal.x,
            y: -d.directionBodyLocal.y,
            z: -d.directionBodyLocal.z,
          },
        };
      }),
    );
    setDirty(true);
  };

  const setFiberSlowAxisDraft = (patch: Partial<FiberSlowAxisDraft>) => {
    setFiberSlowAxisDraftState((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  };

  // useViewport's `useEffect` only re-fires on (component, asset) change,
  // so it captures `handlePickFace` once per component-load and never
  // sees later renders' fresh closures over selectedAnchorKey. Without
  // this ref, the click handler would call the FIRST render's
  // handlePickFace (where selectedAnchorKey was still null because the
  // auto-select effect hadn't run yet), it would early-return on the
  // null check, and the pick would never commit. The ref pattern below
  // hands the current render's handlePickFace to the click handler at
  // call time.
  const handlePickFaceRef = useRef(handlePickFace);
  handlePickFaceRef.current = handlePickFace;
  const stablePickFaceCallback = useRef(
    (
      posMm: { x: number; y: number; z: number },
      dirBodyLocal: { x: number; y: number; z: number },
      outline: number[],
      triangles: number[],
      anchorId?: string,
    ) => handlePickFaceRef.current(posMm, dirBodyLocal, outline, triangles, anchorId),
  ).current;

  // PBS cube click in 3D preview: select the matching front_pbs / back_pbs
  // anchor draft, or auto-create it at the cube's current body-local pose if
  // missing. Uses a ref to capture the latest drafts (same closure-stability
  // pattern as handlePickFaceRef above) since useViewport re-fires only on
  // (component, asset) change.
  const handlePbsCubeClickRef = useRef<
    (n: string, p: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }) => void
  >(() => {});
  handlePbsCubeClickRef.current = (anchorName, posMm, dirBody) => {
    const existing = drafts.find((d) => d.id === anchorName);
    if (existing) {
      setSelectedAnchorKey(existing.__key);
      return;
    }
    const next: AnchorDraft = {
      id: anchorName as AnchorDraft["id"],
      positionMmBodyLocal: { x: posMm.x, y: posMm.y, z: posMm.z },
      directionBodyLocal: { x: dirBody.x, y: dirBody.y, z: dirBody.z },
      apertureMm: 4,
      __key: freshKey(),
    };
    setDrafts((prev) => [...prev, next]);
    setSelectedAnchorKey(next.__key);
    setDirty(true);
  };
  const stablePbsCubeCallback = useRef(
    (n: string, p: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }) =>
      handlePbsCubeClickRef.current(n, p, d),
  ).current;

  const viewportHandle = useViewport(
    viewportRef,
    selectedComponent,
    editedAsset,
    handleAnchorDrag,
    setSelectedAnchorKey,
    pickFaceModeRef,
    stablePickFaceCallback,
    stablePbsCubeCallback,
  );

  const selectedDraft = drafts.find((d) => d.__key === selectedAnchorKey) ?? null;

  // Push anchor changes into the viewport
  useEffect(() => {
    if (!viewportHandle) return;
    // Hide legacy ±-axis auto-bbox anchors (`+x`, `-x`, `+y`, `-y`, `+z`,
    // `-z`) from the viewport markers. They're still in `drafts` so the
    // save round-trips them, but they shouldn't show up as visible
    // arrows / spheres — the user can't edit them (excluded from the
    // anchor-id dropdown via EDITABLE_ANCHOR_IDS) and rendering them
    // alongside the user-editable anchor (e.g. laser's `out`) makes
    // the viewport ambiguous (which arrow is "the" emission direction?).
    const editableSet = new Set<string>(EDITABLE_ANCHOR_IDS);
    const visibleDrafts = drafts.filter((d) => editableSet.has(d.id));
    viewportHandle.syncAnchors(visibleDrafts, selectedAnchorKey);
    viewportHandle.attachGizmoTo(selectedAnchorKey);
    viewportHandle.setFaceHighlight(pickedOutline);
    if (!pickFaceMode) viewportHandle.setFacePreview(pickedFacePreview);
    // Bi-convex lens ??render both directions of the optical axis.
    viewportHandle.setBidirectional(isLensKind && lensMode === "bi");
    viewportHandle.setFiberSlowAxes(isFiberKind ? fiberSlowAxisDraft : null);
    // Beam-splitter ??render the implied diagonal interface as a
    // translucent yellow rectangle so the user sees what the ray-
    // tracer is going to use as the splitting plane. Use rectangular
    // dimensions when set; fall back to 2?apertureMm ? 2?apertureMm
    // (square) for legacy anchors.
    if (isBeamSplitterKind && selectedDraft?.directionBodyLocal) {
      const fallback = (selectedDraft.apertureMm ?? 12.5) * 2;
      const widthMm = selectedDraft.apertureWidthMm ?? fallback;
      const heightMm = selectedDraft.apertureHeightMm ?? fallback;
      viewportHandle.setInterfacePlane({
        centerMm: selectedDraft.positionMmBodyLocal,
        normalBodyLocal: selectedDraft.directionBodyLocal,
        widthMm,
        heightMm,
      });
    } else {
      viewportHandle.setInterfacePlane(null);
    }
    // AOM tilt-axis arrow ??uses ??(帢) = cos(帢)繚礙? + sin(帢)繚礙??where 礙?
    // is body+X projected onto ??b?. Decoupled from 璽 (Phase 7.3): the
    // arrow direction depends only on b? + 帢, so PHY Editor presets
    // map predictably (帢=0簞?ody+X, 帢=90簞?ody+Z, etc. for typical
    // b?=body+Y). Hidden for non-AOM kinds and when ports are missing.
    if (isAomKind) {
      const inDraft = drafts.find((d) => d.id === "intercept_in");
      const outDraft = drafts.find((d) => d.id === "intercept_out");
      const compProps = (selectedComponent?.properties ?? {}) as {
        rfPropagationDirectionBodyLocal?: number[];
        rfPropagationDirectionLocal?: number[];
        acousticAxisBodyLocal?: number[];
        acousticAxisLocal?: number[];
      };
      const rfArr =
        aomRfDirectionDraft
          ? [aomRfDirectionDraft.x, aomRfDirectionDraft.y, aomRfDirectionDraft.z]
          : compProps.rfPropagationDirectionBodyLocal ??
            compProps.rfPropagationDirectionLocal ??
            compProps.acousticAxisBodyLocal ??
            compProps.acousticAxisLocal ??
            [-1, 0, 0];
      const rfDirection = Array.isArray(rfArr) && rfArr.length >= 3
        ? { x: Number(rfArr[0]) || 0, y: Number(rfArr[1]) || 0, z: Number(rfArr[2]) || 0 }
        : { x: -1, y: 0, z: 0 };
      if (inDraft && outDraft) {
        const inP = inDraft.positionMmBodyLocal;
        const outP = outDraft.positionMmBodyLocal;
        const bx = outP.x - inP.x, by = outP.y - inP.y, bz = outP.z - inP.z;
        const bMag = Math.hypot(bx, by, bz);
        if (bMag > 1e-6) {
          // 璽-independent ??(帢): only b? + 帢 needed. acousticAxisBodyLocal
          // is irrelevant to the arrow direction, only to the runtime
          // degeneracy warning (computed in AomFaceSection).
          const tilt = computeBraggTiltAxisFromRfDirectionBodyLocal(
            { x: bx / bMag, y: by / bMag, z: bz / bMag },
            rfDirection,
          );
          if (tilt) {
            viewportHandle.setAomTiltAxis({
              pivotMmBodyLocal: {
                x: (inP.x + outP.x) / 2,
                y: (inP.y + outP.y) / 2,
                z: (inP.z + outP.z) / 2,
              },
              tiltUnitBodyLocal: tilt,
              lengthHintMm: bMag * 0.6,
            });
          } else {
            viewportHandle.setAomTiltAxis(null);
          }
        } else {
          viewportHandle.setAomTiltAxis(null);
        }
      } else {
        viewportHandle.setAomTiltAxis(null);
      }
    } else {
      viewportHandle.setAomTiltAxis(null);
    }
  }, [
    viewportHandle,
    drafts,
    selectedAnchorKey,
    pickedOutline,
    pickedFacePreview,
    pickFaceMode,
    isLensKind,
    lensMode,
    isFiberKind,
    fiberSlowAxisDraft,
    isBeamSplitterKind,
    isAomKind,
    selectedComponent,
    selectedDraft,
    aomRfDirectionDraft,
  ]);

  // Clear the highlight + cached normal when the editing target changes
  // (otherwise the previous component's outline would briefly show on
  // the next one until the user picks again).
  useEffect(() => {
    setPickedOutline([]);
    setPickedNormal(null);
    setPickedFacePreview(null);
  }, [editedAsset?.id, selectedComponent?.id]);

  // === Inspector handlers ===

  const updateDraft = (key: string, patch: Partial<AnchorDraft>) => {
    setDrafts((prev) => prev.map((d) => (d.__key === key ? { ...d, ...patch } : d)));
    setDirty(true);
  };

  const useFiberHoleCenter = (end: FiberEnd) => {
    if (!selectedComponent) return;
    const anchorId = end === "A" ? "intercept_in" : "intercept_out";
    const target = drafts.find((d) => d.id === anchorId);
    if (!target) return;
    const hole = fiberDefaultPortAnchor(selectedComponent, end);
    setDrafts((prev) =>
      prev.map((d) =>
        d.__key === target.__key
          ? {
              ...d,
              positionMmBodyLocal: hole.positionMmBodyLocal,
              directionBodyLocal: hole.directionBodyLocal,
              apertureMm: hole.apertureMm,
            }
          : d,
      ),
    );
    setSelectedAnchorKey(target.__key);
    setPickFaceMode(false);
    setPickFaceTarget(null);
    setPickedOutline([]);
    setPickedNormal(null);
    setPickedFacePreview(null);
    setDirty(true);
  };

  const addAnchor = () => {
    if (!canEditAnchors) return;
    // Identity hard-lock (2026-05-13): only per-component-type registry
    // hits (AD9959 etc.) get full identity lock. Optical kinds (mirror,
    // AOM, …) with only a KIND_REGISTRY contract keep their soft-lock
    // UX. This code path is unreachable when the UI hides "+ Add" but
    // kept as a defensive guard against keyboard / external callers.
    if (isAnchorIdentityHardLocked) return;
    const used = new Set(drafts.map((d) => d.id));
    const required = kindContract?.requiredAnchors ?? [];
    const optional = kindContract?.optionalAnchors ?? [];
    // Try required first; if all required are present, take the next
    // missing optional anchor; only fall back to "intercept_in" when both
    // lists are empty or fully populated. This makes "+ Add" on a fresh
    // laser_source default to "out" (the emission anchor) instead of
    // "intercept_in".
    const missingRequired = required.find((id) => !used.has(id));
    const missingOptional = optional.find((id) => !used.has(id));
    const id: AnchorId = missingRequired ?? missingOptional ?? "intercept_in";
    const next: AnchorDraft = {
      id,
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      apertureMm: 12.5,
      __key: freshKey(),
    };
    setDrafts((prev) => [...prev, next]);
    setSelectedAnchorKey(next.__key);
    setDirty(true);
  };

  const deleteAnchor = (key: string) => {
    // Identity hard-lock (2026-05-13): same defensive guard as addAnchor.
    if (isAnchorIdentityHardLocked) return;
    setDrafts((prev) => prev.filter((d) => d.__key !== key));
    if (selectedAnchorKey === key) setSelectedAnchorKey(null);
    setDirty(true);
  };

  const handleSave = async () => {
    if (!editedAsset && !(isFiberKind && selectedComponent)) return;
    // V2: aperture editing moved to the per-object panel
    // (objects.properties.anchorBindings[].payload.aperture). The PHY
    // Editor save no longer enforces apertureMm on the asset anchor —
    // the asset value is just a default seed. Per-instance aperture
    // validation lives in the Object panel's AOM align flow.
    // AOM-specific geometric guards (mirror what runtime alignToLaser
    // checks). Catch the two ways a save could pass aperture validation
    // but still leave align unable to proceed:
    //   (a) intercept_in and intercept_out coincide ??b? degenerate
    //   (b) acousticAxisBodyLocal ??b?              ??b??璽 = 0
    // Without this fail-fast, the user would round-trip back to the
    // scene, hit Align AOM, and only THEN see the error.
    if (kindContract?.kind === "aom") {
      const inDraft = drafts.find((d) => d.id === "intercept_in");
      const outDraft = drafts.find((d) => d.id === "intercept_out");
      if (inDraft && outDraft) {
        const dx = outDraft.positionMmBodyLocal.x - inDraft.positionMmBodyLocal.x;
        const dy = outDraft.positionMmBodyLocal.y - inDraft.positionMmBodyLocal.y;
        const dz = outDraft.positionMmBodyLocal.z - inDraft.positionMmBodyLocal.z;
        const sep = Math.hypot(dx, dy, dz);
        if (sep < 1e-3) {
          setErrorMsg(
            "Save blocked: intercept_in and intercept_out coincide (port separation < 0.001 mm). " +
            "Move one of the anchors so the body axis is well-defined.",
          );
          return;
        }
        const compProps = (selectedComponent?.properties ?? {}) as {
          acousticAxisBodyLocal?: number[];
          acousticAxisLocal?: number[];
        };
        const aArr =
          compProps.acousticAxisBodyLocal ?? compProps.acousticAxisLocal ?? [-1, 0, 0];
        if (Array.isArray(aArr) && aArr.length >= 3) {
          const ax = Number(aArr[0]) || 0;
          const ay = Number(aArr[1]) || 0;
          const az = Number(aArr[2]) || 0;
          const aMag = Math.hypot(ax, ay, az);
          if (aMag > 1e-6 && sep > 1e-6) {
            const buX = dx / sep, buY = dy / sep, buZ = dz / sep;
            const auX = ax / aMag, auY = ay / aMag, auZ = az / aMag;
            const tx = buY * auZ - buZ * auY;
            const ty = buZ * auX - buX * auZ;
            const tz = buX * auY - buY * auX;
            if (Math.hypot(tx, ty, tz) < 1e-3) {
              setErrorMsg(
                "Save blocked: body axis (port-to-port) is parallel to the acoustic axis " +
                "(component.properties.acousticAxisBodyLocal). Bragg geometry is degenerate. " +
                "Either rotate the ports off the acoustic axis or update the component's " +
                "acousticAxisBodyLocal so it points perpendicular to the optical path.",
              );
              return;
            }
          }
        }
      }
    }
    setSaving(true);
    setErrorMsg(null);
    try {
      // Fiber path: anchors live on Component.properties.fiberAnchors since
      // there's no Asset3D. Also stop here — no AOM-specific RF-direction
      // postlude applies to fiber.
      if (isFiberKind && selectedComponent) {
        const inDraft = drafts.find((d) => d.id === "intercept_in");
        const outDraft = drafts.find((d) => d.id === "intercept_out");
        const props = selectedComponent.properties ?? {};
        const fiberOverride = (props as {
          fiberKindParamsOverride?: {
            endA?: Record<string, unknown>;
            endB?: Record<string, unknown>;
            [key: string]: unknown;
          };
        }).fiberKindParamsOverride ?? {};
        await updateComponent(selectedComponent.id, {
          properties: {
            ...props,
            fiberAnchors: drafts.map(draftToAnchor),
            fiberKindParamsOverride: {
              ...fiberOverride,
              endA: {
                ...(fiberOverride.endA ?? {}),
                ...(inDraft ? { facePositionMmBodyLocal: inDraft.positionMmBodyLocal } : {}),
                slowAxisAxisBodyLocal: fiberSlowAxisDraft.endA,
                slowAxisDegInBodyFrame: fiberSlowAxisToLegacyDeg(fiberSlowAxisDraft.endA),
              },
              endB: {
                ...(fiberOverride.endB ?? {}),
                ...(outDraft ? { facePositionMmBodyLocal: outDraft.positionMmBodyLocal } : {}),
                slowAxisAxisBodyLocal: fiberSlowAxisDraft.endB,
                slowAxisDegInBodyFrame: fiberSlowAxisToLegacyDeg(fiberSlowAxisDraft.endB),
              },
            },
          },
        });
        setDirty(false);
        setPhyEditorDirty(false);
        return;
      }
      if (!editedAsset) return;
      await updateAssetAnchors(editedAsset.id, drafts.map(draftToAnchor));
      if (
        kindContract?.kind === "aom" &&
        selectedComponent &&
        aomRfDirectionDraft != null
      ) {
        await updateComponent(selectedComponent.id, {
          properties: {
            ...(selectedComponent.properties ?? {}),
            acousticAxisBodyLocal: [
              aomRfDirectionDraft.x,
              aomRfDirectionDraft.y,
              aomRfDirectionDraft.z,
            ],
            rfPropagationDirectionBodyLocal: [
              aomRfDirectionDraft.x,
              aomRfDirectionDraft.y,
              aomRfDirectionDraft.z,
            ],
          },
        });
      }
      setAomRfDirectionDraft(null);
      setDirty(false);
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handlePickComponent = (c: ComponentItem) => {
    if (dirty) {
      const ok = window.confirm(
        "You have unsaved anchor changes. Discard and switch component?",
      );
      if (!ok) return;
    }
    selectComponent(c.id);
    setEditingAssetId(c.asset3dId ?? null);
  };

  // === Validation badges ===

  const presentIds = new Set(drafts.map((d) => d.id));
  const missingRequired = (kindContract?.requiredAnchors ?? []).filter((id) => !presentIds.has(id));
  const missingOptional = (kindContract?.optionalAnchors ?? []).filter((id) => !presentIds.has(id));
  const dirRequiredIds = new Set(kindContract?.anchorsNeedingDirection ?? []);
  const draftsMissingDirection = drafts.filter(
    (d) => dirRequiredIds.has(d.id as never) && !d.directionBodyLocal,
  );
  const selectedNeedsDirection =
    selectedDraft != null && dirRequiredIds.has(selectedDraft.id as never);
  const fastAxisRequiredIds = new Set(kindContract?.anchorsNeedingFastAxis ?? []);
  const selectedNeedsFastAxis =
    selectedDraft != null && fastAxisRequiredIds.has(selectedDraft.id as never);
  // V2: aperture is per-instance now; the PHY Editor no longer
  // surfaces a "missing apertureMm" warning. Per-object aperture is
  // edited in the Object panel.
  const draftsMissingAperture: typeof drafts = [];

  return (
    <div className="component-editor">
      {/* Sub-bar: editing context + Save (Back lives in PhyEditor) */}
      <div className="component-editor-subbar">
        <div className="component-editor-title">
          <strong>{domain === "rf" ? "RF" : "Optical"} / Components</strong>
          {selectedComponent && (
            <span style={{ opacity: 0.7, marginLeft: 8 }}>
              - {selectedComponent.name}
              {editedAsset ? ` (asset: ${editedAsset.name})` : " (no asset)"}
            </span>
          )}
        </div>
        <div className="component-editor-actions">
          {dirty && <span style={{ color: "#fbbf24", marginRight: 8 }}>Unsaved</span>}
          {errorMsg && <span style={{ color: "#f87171", marginRight: 8 }}>{errorMsg}</span>}
          <button
            type="button"
            className="primary-button"
            onClick={handleSave}
            disabled={!canEditAnchors || saving || !dirty}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {/* Three columns */}
      <div className="component-editor-body">
        {/* LEFT: components-with-function list */}
        <aside className="component-editor-left">
          <div className="component-editor-left-header">Components with function</div>
          {[...groupedComponents.entries()].map(([kind, items]) => {
            const contract = KIND_REGISTRY[kind as keyof typeof KIND_REGISTRY];
            return (
              <div key={kind} className="component-editor-group">
                <div className="component-editor-group-title">
                  {contract?.displayName ?? kind}
                  <span style={{ opacity: 0.6, marginLeft: 6 }}>{items.length}</span>
                </div>
                {items.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={
                      "component-editor-item" +
                      (c.id === selectedComponentId ? " is-active" : "")
                    }
                    onClick={() => handlePickComponent(c)}
                  >
                    {c.name}
                    {!c.asset3dId && (
                      <span style={{ color: "#f87171", marginLeft: 6 }}>- no asset</span>
                    )}
                  </button>
                ))}
              </div>
            );
          })}
        </aside>

        {/* CENTER: 3D viewport (or fiber inspector for fiber kind) */}
        <div className="component-editor-viewport">
          {isFiberKind && selectedComponent && (
            <div
              className="component-editor-overlay"
              style={{
                padding: "8px 10px",
                fontSize: 12,
                lineHeight: 1.4,
                maxWidth: 320,
                pointerEvents: "none",
              }}
            >
              <strong>Fiber: {selectedComponent.name}</strong>
              <div style={{ opacity: 0.75, marginTop: 2 }}>
                Pick End A/B connector faces on the procedural cable mesh.
              </div>
              {selectedFiberElement && (
                <div style={{ opacity: 0.55, fontSize: 11, marginTop: 4 }}>
                  PhysicsElement object {selectedFiberObject?.id?.slice(0, 8)}...
                </div>
              )}
            </div>
          )}
          {!selectedComponent && (
            <div className="component-editor-empty">
              Pick a component on the left to start editing its anchor geometry.
            </div>
          )}
          <div
            ref={viewportRef}
            className={
              "component-editor-canvas" +
              (pickFaceMode ? " is-pick-mode" : "")
            }
          />

          {/* Viewport-overlay tools (mirrors the main scene's
              `viewer-tools-pie` pattern: action buttons sit ON TOP of
              the 3D canvas instead of in the side panel, so the user
              can stay focused on the model). For mirror kinds we show
              a single big "Pick face" toggle + (after pick) two side
              buttons +/??that flip the normal. */}
          {isMirrorKind && selectedComponent && editedAsset && (
            <div className="editor-viewport-tools" role="group" aria-label="Mirror face tools">
              <button
                type="button"
                className={
                  "editor-viewport-tool editor-viewport-pick" +
                  (pickFaceMode ? " is-active" : "")
                }
                onClick={() => setPickFaceMode((v) => !v)}
                title={
                  pickFaceMode
                    ? "Cancel face-pick (or press ESC). Currently waiting for a click on the mesh."
                    : "Click a face on the wireframe to snap the reflective face anchor here."
                }
              >
                {pickFaceMode
                  ? "Click a face (ESC)"
                  : pickedOutline.length > 0
                    ? "Pick a different face"
                    : "Pick reflective face"}
              </button>

              {pickedOutline.length > 0 && pickedNormal && (
                <div className="editor-viewport-side-row">
                  <span className="editor-viewport-side-label">Reflective side:</span>
                  <button
                    type="button"
                    className={
                      "editor-viewport-side-btn" +
                      ((() => {
                        if (!selectedDraft?.directionBodyLocal) return "";
                        const d = selectedDraft.directionBodyLocal;
                        const dot = pickedNormal.x * d.x + pickedNormal.y * d.y + pickedNormal.z * d.z;
                        return dot >= 0 ? " is-active" : "";
                      })())
                    }
                    onClick={() => {
                      if (!selectedDraft) return;
                      updateDraft(selectedDraft.__key, {
                        directionBodyLocal: { ...pickedNormal },
                      });
                    }}
                    title="Reflective coating is on the side facing the camera at pick time."
                  >
                    + this side
                  </button>
                  <button
                    type="button"
                    className={
                      "editor-viewport-side-btn" +
                      ((() => {
                        if (!selectedDraft?.directionBodyLocal) return "";
                        const d = selectedDraft.directionBodyLocal;
                        const dot = pickedNormal.x * d.x + pickedNormal.y * d.y + pickedNormal.z * d.z;
                        return dot < 0 ? " is-active" : "";
                      })())
                    }
                    onClick={() => {
                      if (!selectedDraft) return;
                      updateDraft(selectedDraft.__key, {
                        directionBodyLocal: {
                          x: -pickedNormal.x,
                          y: -pickedNormal.y,
                          z: -pickedNormal.z,
                        },
                      });
                    }}
                    title="Reflective coating is on the opposite side."
                  >
                    Other side
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Lens overlay: mode toggle (Plano-Convex / Bi-Convex) +
              mode-specific actions. Plano reuses the pick-face flow
              (with arrow auto-flipped to point INTO body). Bi-Convex
              snaps anchor to body centre and lets the user pick the
              optical axis (X/Y/Z). */}
          {isLensKind && selectedComponent && editedAsset && (
            <div className="editor-viewport-tools" role="group" aria-label="Lens face tools">
              <div className="editor-viewport-mode-row">
                <span className="editor-viewport-side-label">Lens type:</span>
                <button
                  type="button"
                  className={
                    "editor-viewport-side-btn" +
                    (lensMode === "plano" ? " is-active" : "")
                  }
                  onClick={() => setLensMode("plano")}
                  title="Plano-Convex: one flat face + one curved face. Pick the flat face on the wireframe."
                >
                  Plano-Convex
                </button>
                <button
                  type="button"
                  className={
                    "editor-viewport-side-btn" +
                    (lensMode === "bi" ? " is-active" : "")
                  }
                  onClick={() => {
                    setLensMode("bi");
                    setPickFaceMode(false);
                  }}
                  title="Bi-Convex: both faces curved. Snap anchor to body centre and pick optical axis."
                >
                  Bi-Convex
                </button>
              </div>

              {lensMode === "plano" && (
                <>
                  <button
                    type="button"
                    className={
                      "editor-viewport-tool editor-viewport-pick" +
                      (pickFaceMode ? " is-active" : "")
                    }
                    onClick={() => setPickFaceMode((v) => !v)}
                    title={
                      pickFaceMode
                        ? "Cancel face-pick (or press ESC)."
                        : "Click the FLAT face on the wireframe. The arrow will auto-point toward the convex side."
                    }
                  >
                    {pickFaceMode
                      ? "Click the flat face (ESC)"
                      : pickedOutline.length > 0
                        ? "Pick a different face"
                        : "Pick flat face"}
                  </button>

                  {pickedOutline.length > 0 && pickedNormal && (
                    <div className="editor-viewport-side-row">
                      <span className="editor-viewport-side-label">Light goes:</span>
                      <button
                        type="button"
                        className={
                          "editor-viewport-side-btn" +
                          ((() => {
                            if (!selectedDraft?.directionBodyLocal) return "";
                            const d = selectedDraft.directionBodyLocal;
                            const dot = pickedNormal.x * d.x + pickedNormal.y * d.y + pickedNormal.z * d.z;
                            return dot >= 0 ? " is-active" : "";
                          })())
                        }
                        onClick={() => {
                          if (!selectedDraft) return;
                          updateDraft(selectedDraft.__key, {
                            directionBodyLocal: { ...pickedNormal },
                          });
                        }}
                        title="Light propagates toward the convex side (default after pick)."
                      >
                        + into body
                      </button>
                      <button
                        type="button"
                        className={
                          "editor-viewport-side-btn" +
                          ((() => {
                            if (!selectedDraft?.directionBodyLocal) return "";
                            const d = selectedDraft.directionBodyLocal;
                            const dot = pickedNormal.x * d.x + pickedNormal.y * d.y + pickedNormal.z * d.z;
                            return dot < 0 ? " is-active" : "";
                          })())
                        }
                        onClick={() => {
                          if (!selectedDraft) return;
                          updateDraft(selectedDraft.__key, {
                            directionBodyLocal: {
                              x: -pickedNormal.x,
                              y: -pickedNormal.y,
                              z: -pickedNormal.z,
                            },
                          });
                        }}
                        title="Use the lens backward; light goes the other way."
                      >
                        Out of body
                      </button>
                    </div>
                  )}
                </>
              )}

              {lensMode === "bi" && (
                <>
                  <button
                    type="button"
                    className="editor-viewport-tool editor-viewport-pick"
                    onClick={handleSnapBodyCenter}
                    title="Place anchor at the lens body centre (0,0,0 in body-local)."
                  >
                    Snap to body centre
                  </button>

                  <div className="editor-viewport-side-row">
                    <span className="editor-viewport-side-label">Optical axis:</span>
                    {(["x", "y", "z"] as const).map((axis) => {
                      const active =
                        selectedDraft?.directionBodyLocal &&
                        Math.abs(selectedDraft.directionBodyLocal[axis]) > 0.5 &&
                        Math.abs(
                          selectedDraft.directionBodyLocal[axis === "x" ? "y" : axis === "y" ? "z" : "x"],
                        ) < 0.1;
                      return (
                        <button
                          key={axis}
                          type="button"
                          className={
                            "editor-viewport-side-btn" + (active ? " is-active" : "")
                          }
                          onClick={() => handleLensAxis(axis)}
                          title={`Optical axis along body ${axis.toUpperCase()}.`}
                        >
                          {axis.toUpperCase()}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Beam-splitter / PBS overlay: pick the cube's diagonal
              cement plane. Interface is INSIDE the cube so we can't
              raycast it on the wireframe ??instead, snap to body
              centre + click one of 6 face-aligned diagonal buttons,
              with a Flip button to reverse the coating normal. The
              translucent yellow plane visualisation in the viewport
              shows the implied interface. */}
          {isBeamSplitterKind && selectedComponent && editedAsset && (
            <div className="editor-viewport-tools" role="group" aria-label="Beam splitter cube tools">
              <button
                type="button"
                className="editor-viewport-tool editor-viewport-pick"
                onClick={handleSnapBodyCenter}
                title="Place anchor at the cube body centre (0,0,0 in body-local)."
              >
                Snap to cube centre
              </button>

              <div className="editor-viewport-side-row">
                <span className="editor-viewport-side-label">XY plane:</span>
                <button
                  type="button"
                  className="editor-viewport-side-btn"
                  onClick={() => handleBSDiagonal("xy", "+")}
                  title="Diagonal normal = (X+Y)/sqrt(2)"
                >
                  +X+Y
                </button>
                <button
                  type="button"
                  className="editor-viewport-side-btn"
                  onClick={() => handleBSDiagonal("xy", "-")}
                  title="Diagonal normal = (X-Y)/sqrt(2)"
                >
                  +X-Y
                </button>
              </div>
              <div className="editor-viewport-side-row">
                <span className="editor-viewport-side-label">XZ plane:</span>
                <button
                  type="button"
                  className="editor-viewport-side-btn"
                  onClick={() => handleBSDiagonal("xz", "+")}
                  title="Diagonal normal = (X+Z)/sqrt(2)"
                >
                  +X+Z
                </button>
                <button
                  type="button"
                  className="editor-viewport-side-btn"
                  onClick={() => handleBSDiagonal("xz", "-")}
                  title="Diagonal normal = (X-Z)/sqrt(2)"
                >
                  +X-Z
                </button>
              </div>
              <div className="editor-viewport-side-row">
                <span className="editor-viewport-side-label">YZ plane:</span>
                <button
                  type="button"
                  className="editor-viewport-side-btn"
                  onClick={() => handleBSDiagonal("yz", "+")}
                  title="Diagonal normal = (Y+Z)/sqrt(2)"
                >
                  +Y+Z
                </button>
                <button
                  type="button"
                  className="editor-viewport-side-btn"
                  onClick={() => handleBSDiagonal("yz", "-")}
                  title="Diagonal normal = (Y-Z)/sqrt(2)"
                >
                  +Y-Z
                </button>
                <button
                  type="button"
                  className="editor-viewport-side-btn"
                  onClick={handleBSFlip}
                  title="Negate the current direction (= flip which side reflects vs. transmits)."
                  disabled={!selectedDraft?.directionBodyLocal}
                >
                  Flip
                </button>
              </div>
            </div>
          )}

          {/* Laser-source overlay: pick exit face (sets out.position +
              out.directionBodyLocal = OUTWARD normal) + X/Y/Z preset
              direction buttons for cases where the laser body is just a
              cube without a distinct exit face. */}
          {isLaserSourceKind && selectedComponent && editedAsset && (
            <div className="editor-viewport-tools" role="group" aria-label="Laser source tools">
              <button
                type="button"
                className={
                  "editor-viewport-tool editor-viewport-pick" +
                  (pickFaceMode ? " is-active" : "")
                }
                onClick={() => setPickFaceMode((v) => !v)}
                title={
                  pickFaceMode
                    ? "Cancel face-pick (or press ESC)."
                    : "Click the exit face on the wireframe to set the emission point + direction (= OUTWARD face normal)."
                }
              >
                {pickFaceMode
                  ? "Click the exit face (ESC)"
                  : pickedOutline.length > 0
                    ? "Pick a different face"
                    : "Pick exit face"}
              </button>

              <div className="editor-viewport-side-row">
                <span className="editor-viewport-side-label">Direction:</span>
                {(["x", "y", "z"] as const).map((axis) => {
                  const active =
                    selectedDraft?.directionBodyLocal &&
                    Math.abs(selectedDraft.directionBodyLocal[axis]) > 0.5 &&
                    Math.abs(
                      selectedDraft.directionBodyLocal[axis === "x" ? "y" : axis === "y" ? "z" : "x"],
                    ) < 0.1;
                  return (
                    <button
                      key={axis}
                      type="button"
                      className={
                        "editor-viewport-side-btn" + (active ? " is-active" : "")
                      }
                      onClick={() => handleLensAxis(axis)}
                      title={`Light exits along body +${axis.toUpperCase()}.`}
                    >
                      +{axis.toUpperCase()}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Waveplate overlay: pick flat face (sets intercept_in
              position) + X/Y/Z fast-axis buttons (set directionBodyLocal). */}
          {isWaveplateKind && selectedComponent && editedAsset && (
            <div className="editor-viewport-tools" role="group" aria-label="Waveplate face tools">
              <button
                type="button"
                className={
                  "editor-viewport-tool editor-viewport-pick" +
                  (pickFaceMode ? " is-active" : "")
                }
                onClick={() => setPickFaceMode((v) => !v)}
                title={
                  pickFaceMode
                    ? "Cancel face-pick (or press ESC)."
                    : "Click the flat face on the wireframe to set the intercept_in position. The fast-axis direction is set separately via X/Y/Z below."
                }
              >
                {pickFaceMode
                  ? "Click the flat face (ESC)"
                  : pickedOutline.length > 0
                    ? "Pick a different face"
                    : "Pick flat face"}
              </button>

              <div className="editor-viewport-side-row">
                <span className="editor-viewport-side-label">Fast axis:</span>
                {(["x", "y", "z"] as const).map((axis) => {
                  const active =
                    selectedDraft?.directionBodyLocal &&
                    Math.abs(selectedDraft.directionBodyLocal[axis]) > 0.5 &&
                    Math.abs(
                      selectedDraft.directionBodyLocal[axis === "x" ? "y" : axis === "y" ? "z" : "x"],
                    ) < 0.1;
                  return (
                    <button
                      key={axis}
                      type="button"
                      className={
                        "editor-viewport-side-btn" + (active ? " is-active" : "")
                      }
                      onClick={() => handleLensAxis(axis)}
                      title={`Fast axis along body ${axis.toUpperCase()}.`}
                    >
                      {axis.toUpperCase()}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tapered Amplifier overlay: dual-anchor flow. Two pick
              buttons select which port (INPUT vs OUTPUT) the next
              face-pick should write to; selectedAnchorKey moves with
              the active button so the gizmo attaches to the right
              marker. Anti-parallel health badge below shows whether
              INPUT and OUTPUT directions are opposite (light path
              physically passes through the body). */}
          {isTaperedAmplifierKind && selectedComponent && editedAsset && (() => {
            const inDraft = drafts.find((d) => d.id === "intercept_in");
            const outDraft = drafts.find((d) => d.id === "intercept_out");
            const dotIO =
              inDraft?.directionBodyLocal && outDraft?.directionBodyLocal
                ? inDraft.directionBodyLocal.x * outDraft.directionBodyLocal.x +
                  inDraft.directionBodyLocal.y * outDraft.directionBodyLocal.y +
                  inDraft.directionBodyLocal.z * outDraft.directionBodyLocal.z
                : null;
            const startPick = (anchorId: "intercept_in" | "intercept_out") => {
              const t = drafts.find((d) => d.id === anchorId);
              if (t) setSelectedAnchorKey(t.__key);
              setPickFaceTarget(anchorId);
              setPickFaceMode(true);
            };
            return (
              <div className="editor-viewport-tools" role="group" aria-label="TA port tools">
                <button
                  type="button"
                  className={
                    "editor-viewport-tool editor-viewport-pick" +
                    (pickFaceMode && pickFaceTarget === "intercept_in" ? " is-active" : "")
                  }
                  onClick={() => {
                    if (pickFaceMode && pickFaceTarget === "intercept_in") {
                      setPickFaceMode(false);
                      setPickFaceTarget(null);
                    } else {
                      startPick("intercept_in");
                    }
                  }}
                  title="Click the INPUT face on the wireframe; this is where seed light enters the chip."
                >
                  {pickFaceMode && pickFaceTarget === "intercept_in"
                    ? "Click INPUT face (ESC)"
                    : "Pick INPUT face"}
                </button>
                <button
                  type="button"
                  className={
                    "editor-viewport-tool editor-viewport-pick" +
                    (pickFaceMode && pickFaceTarget === "intercept_out" ? " is-active" : "")
                  }
                  onClick={() => {
                    if (pickFaceMode && pickFaceTarget === "intercept_out") {
                      setPickFaceMode(false);
                      setPickFaceTarget(null);
                    } else {
                      startPick("intercept_out");
                    }
                  }}
                  title="Click the OUTPUT face on the wireframe; this is where amplified light exits."
                >
                  {pickFaceMode && pickFaceTarget === "intercept_out"
                    ? "Click OUTPUT face (ESC)"
                    : "Pick OUTPUT face"}
                </button>
                {dotIO !== null && (
                  <div className="editor-viewport-side-row">
                    <span className="editor-viewport-side-label">IN-OUT angle:</span>
                    <span
                      style={{
                        fontSize: 11,
                        opacity: 0.85,
                        fontFamily: "'Menlo', 'Consolas', monospace",
                      }}
                    >
                      {((Math.acos(Math.max(-1, Math.min(1, dotIO))) * 180) / Math.PI).toFixed(1)} deg
                      {" "}
                      <span style={{ opacity: 0.6 }}>
                        (dot = {dotIO.toFixed(3)})
                      </span>
                    </span>
                  </div>
                )}
              </div>
            );
          })()}

          {/* AOM overlay: dual-port flow, same pattern as TA. Click
              "Pick INTERCEPT_IN face" then click the input cap of the
              wireframe ??the BFS coplanar face detector sets that
              anchor's position to the centroid + direction to the
              outward normal. Same for INTERCEPT_OUT. The midpoint of
              the two anchors becomes the auto Bragg-rotation pivot
              (shown in the inspector). */}
          {isAomKind && selectedComponent && editedAsset && (() => {
            const inDraftLocal = drafts.find((d) => d.id === "intercept_in");
            const outDraftLocal = drafts.find((d) => d.id === "intercept_out");
            const rfInDraftLocal = drafts.find((d) => d.id === "rf_in");
            const startAomPick = (
              anchorId: "intercept_in" | "intercept_out" | "rf_in",
            ) => {
              const t = drafts.find((d) => d.id === anchorId);
              if (t) setSelectedAnchorKey(t.__key);
              setPickFaceTarget(anchorId);
              setPickFaceMode(true);
            };
            return (
              <div className="editor-viewport-tools" role="group" aria-label="AOM port tools">
                {/* Optical-tab buttons: intercept_in / intercept_out
                    picks. Hidden on the RF tab where the user only edits
                    the SMA connector. */}
                {domain !== "rf" && (
                  <button
                    type="button"
                    className={
                      "editor-viewport-tool editor-viewport-pick" +
                      (pickFaceMode && pickFaceTarget === "intercept_in" ? " is-active" : "")
                    }
                    onClick={() => {
                      if (pickFaceMode && pickFaceTarget === "intercept_in") {
                        setPickFaceMode(false);
                        setPickFaceTarget(null);
                      } else {
                        startAomPick("intercept_in");
                      }
                    }}
                    title="Click the AOM input aperture face on the wireframe (the closed-edge polygon BFS picks coplanar triangles; centroid sets intercept_in.position, outward normal sets directionBodyLocal)."
                    disabled={!inDraftLocal}
                  >
                    {pickFaceMode && pickFaceTarget === "intercept_in"
                      ? "Click INTERCEPT_IN face (ESC)"
                      : "Pick INTERCEPT_IN face"}
                  </button>
                )}
                {domain !== "rf" && (
                  <button
                    type="button"
                    className={
                      "editor-viewport-tool editor-viewport-pick" +
                      (pickFaceMode && pickFaceTarget === "intercept_out" ? " is-active" : "")
                    }
                    onClick={() => {
                      if (pickFaceMode && pickFaceTarget === "intercept_out") {
                        setPickFaceMode(false);
                        setPickFaceTarget(null);
                      } else {
                        startAomPick("intercept_out");
                      }
                    }}
                    title="Click the AOM output aperture face on the wireframe."
                    disabled={!outDraftLocal}
                  >
                    {pickFaceMode && pickFaceTarget === "intercept_out"
                      ? "Click INTERCEPT_OUT face (ESC)"
                      : "Pick INTERCEPT_OUT face"}
                  </button>
                )}
                {/* RF-tab button: only the SMA RF connector pick. Hidden
                    on the Optical tab. */}
                {domain === "rf" && (
                  <button
                    type="button"
                    className={
                      "editor-viewport-tool editor-viewport-pick" +
                      (pickFaceMode && pickFaceTarget === "rf_in" ? " is-active" : "")
                    }
                    onClick={() => {
                      if (pickFaceMode && pickFaceTarget === "rf_in") {
                        setPickFaceMode(false);
                        setPickFaceTarget(null);
                      } else {
                        startAomPick("rf_in");
                      }
                    }}
                    title="Click the SMA / coax RF connector face on the AOM driver housing. BFS picks the coplanar polygon, centroid sets rf_in.position, outward normal sets directionBodyLocal (the way a mating cable plug slides on — convention: all rf_in / rf_out point outward)."
                    disabled={!rfInDraftLocal}
                  >
                    {pickFaceMode && pickFaceTarget === "rf_in"
                      ? "Click RF_IN face (ESC)"
                      : "Pick RF_IN face"}
                  </button>
                )}
              </div>
            );
          })()}

          {/* Fiber overlay: procedural cable has no Asset3D row, but
              loadAssetObject renders the cable + connector meshes here, so
              face-picking works the same way as TA. PM slow-axis buttons use
              the Waveplate-style direction picker, stored separately from
              the port face normal. */}
          {isFiberKind && selectedComponent && (() => {
            const inDraftLocal = drafts.find((d) => d.id === "intercept_in");
            const outDraftLocal = drafts.find((d) => d.id === "intercept_out");
            const activeEnd: FiberEnd =
              selectedDraft?.id === "intercept_out" ? "B" : "A";
            const activeSlowAxis =
              activeEnd === "A" ? fiberSlowAxisDraft.endA : fiberSlowAxisDraft.endB;
            const activeKey: keyof FiberSlowAxisDraft = activeEnd === "A" ? "endA" : "endB";
            const startFiberPick = (anchorId: "intercept_in" | "intercept_out") => {
              const t = drafts.find((d) => d.id === anchorId);
              if (t) setSelectedAnchorKey(t.__key);
              setPickFaceTarget(anchorId);
              setPickFaceMode(true);
            };
            const axisButton = (axis: FiberSlowAxis) => (
              <button
                key={axis}
                type="button"
                className={
                  "editor-viewport-side-btn" +
                  (activeSlowAxis === axis ? " is-active" : "")
                }
                onClick={() => setFiberSlowAxisDraft({ [activeKey]: axis })}
                title={`Set End ${activeEnd} PM slow axis to connector ${axis.toUpperCase()} axis.`}
              >
                {axis.toUpperCase()}
              </button>
            );
            return (
              <div className="editor-viewport-tools" role="group" aria-label="Fiber port tools">
                <button
                  type="button"
                  className={
                    "editor-viewport-tool editor-viewport-pick" +
                    (pickFaceMode && pickFaceTarget === "intercept_in" ? " is-active" : "")
                  }
                  onClick={() => {
                    if (pickFaceMode && pickFaceTarget === "intercept_in") {
                      setPickFaceMode(false);
                      setPickFaceTarget(null);
                    } else {
                      startFiberPick("intercept_in");
                    }
                  }}
                  title="Click the End A connector face on the fiber mesh."
                  disabled={!inDraftLocal}
                >
                  {pickFaceMode && pickFaceTarget === "intercept_in"
                    ? "Click End A face (ESC)"
                    : "Pick End A face"}
                </button>
                <button
                  type="button"
                  className="editor-viewport-tool"
                  onClick={() => useFiberHoleCenter("A")}
                  title="Click the yellow End A aperture ring in the viewport, or press this button to use the computed ferrule hole center."
                  disabled={!inDraftLocal}
                >
                  End A ring
                </button>
                <button
                  type="button"
                  className={
                    "editor-viewport-tool editor-viewport-pick" +
                    (pickFaceMode && pickFaceTarget === "intercept_out" ? " is-active" : "")
                  }
                  onClick={() => {
                    if (pickFaceMode && pickFaceTarget === "intercept_out") {
                      setPickFaceMode(false);
                      setPickFaceTarget(null);
                    } else {
                      startFiberPick("intercept_out");
                    }
                  }}
                  title="Click the End B connector face on the fiber mesh."
                  disabled={!outDraftLocal}
                >
                  {pickFaceMode && pickFaceTarget === "intercept_out"
                    ? "Click End B face (ESC)"
                    : "Pick End B face"}
                </button>
                <button
                  type="button"
                  className="editor-viewport-tool"
                  onClick={() => useFiberHoleCenter("B")}
                  title="Click the yellow End B aperture ring in the viewport, or press this button to use the computed ferrule hole center."
                  disabled={!outDraftLocal}
                >
                  End B ring
                </button>
                <div className="editor-viewport-side-row">
                  <span className="editor-viewport-side-label">
                    End {activeEnd} slow axis:
                  </span>
                  {axisButton("x")}
                  {axisButton("y")}
                  {axisButton("z")}
                </div>
              </div>
            );
          })()}

          {selectedComponent && !editedAsset && !isFiberKind && (
            <div className="component-editor-overlay">
              This component has no Asset3D attached - anchor editing requires a 3D model.
            </div>
          )}
        </div>

        {/* RIGHT: inspector + kind contract viewer */}
        <aside className="component-editor-right">
          {kindContract && (
            <div className="component-editor-section">
              <div className="component-editor-section-title">Kind contract</div>
              <div className="component-editor-kind-summary">
                <strong>{kindContract.displayName}</strong>
                <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                  {kindContract.alignSummary}
                </div>
                <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
                  Variant: <code>{kindContract.alignVariant}</code> |
                  Tolerance: {kindContract.alignToleranceMm} mm
                </div>
              </div>
              <div className="component-editor-validation">
                <div>
                  <strong>Required:</strong>{" "}
                  {kindContract.requiredAnchors.length === 0 ? (
                    <span style={{ opacity: 0.6 }}>(none)</span>
                  ) : (
                    kindContract.requiredAnchors.map((id) => (
                      <span
                        key={id}
                        className={
                          "anchor-badge " +
                          (presentIds.has(id) ? "anchor-badge-ok" : "anchor-badge-missing")
                        }
                      >
                        {presentIds.has(id) ? "OK" : "MISS"} {id}
                      </span>
                    ))
                  )}
                </div>
                {kindContract.optionalAnchors.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <strong>Optional:</strong>{" "}
                    {kindContract.optionalAnchors.map((id) => (
                      <span
                        key={id}
                        className={
                          "anchor-badge " +
                          (presentIds.has(id) ? "anchor-badge-ok" : "anchor-badge-optional")
                        }
                      >
                        {presentIds.has(id) ? "OK" : "OPT"} {id}
                      </span>
                    ))}
                  </div>
                )}
                {missingRequired.length > 0 && (
                  <div style={{ marginTop: 6, color: "#f87171", fontSize: 12 }}>
                    {missingRequired.length} required anchor(s) missing; align will not work.
                  </div>
                )}
                {draftsMissingDirection.length > 0 && (
                  <div style={{ marginTop: 6, color: "#f87171", fontSize: 12 }}>
                    {draftsMissingDirection.length} anchor(s) need a normal direction:{" "}
                    {draftsMissingDirection.map((d) => d.id).join(", ")}
                  </div>
                )}
                {draftsMissingAperture.length > 0 && (
                  <div style={{ marginTop: 6, color: "#f87171", fontSize: 12 }}>
                    {draftsMissingAperture.length} anchor(s) need apertureMm &gt; 0:{" "}
                    {draftsMissingAperture.map((d) => d.id).join(", ")}
                  </div>
                )}
                {missingRequired.length === 0 &&
                  draftsMissingDirection.length === 0 &&
                  draftsMissingAperture.length === 0 &&
                  missingOptional.length === 0 && (
                  <div style={{ marginTop: 6, color: "#4ade80", fontSize: 12 }}>
                    All expected anchors present.
                  </div>
                )}
              </div>
            </div>
          )}

          {isMirrorKind && (
            <MirrorFaceSection
              draft={selectedDraft}
              hasOutline={pickedOutline.length > 0}
              updateDraft={updateDraft}
            />
          )}

          {isLensKind && (
            <LensFaceSection
              draft={selectedDraft}
              hasOutline={pickedOutline.length > 0}
              lensMode={lensMode}
              updateDraft={updateDraft}
            />
          )}

          {isWaveplateKind && (
            <WaveplateFaceSection
              draft={selectedDraft}
              hasOutline={pickedOutline.length > 0}
              updateDraft={updateDraft}
            />
          )}

          {isLaserSourceKind && (
            <LaserSourceFaceSection
              draft={selectedDraft}
              hasOutline={pickedOutline.length > 0}
              updateDraft={updateDraft}
            />
          )}

          {isTaperedAmplifierKind && (
            <TaperedAmplifierFaceSection
              inDraft={drafts.find((d) => d.id === "intercept_in") ?? null}
              outDraft={drafts.find((d) => d.id === "intercept_out") ?? null}
              selectedAnchorKey={selectedAnchorKey}
              setSelectedAnchorKey={setSelectedAnchorKey}
              updateDraft={updateDraft}
            />
          )}

          {isFiberKind && (
            <FiberPatchCableFaceSection
              inDraft={drafts.find((d) => d.id === "intercept_in") ?? null}
              outDraft={drafts.find((d) => d.id === "intercept_out") ?? null}
              selectedAnchorKey={selectedAnchorKey}
              setSelectedAnchorKey={setSelectedAnchorKey}
              updateDraft={updateDraft}
              slowAxisDraft={fiberSlowAxisDraft}
              setSlowAxisDraft={setFiberSlowAxisDraft}
              onUseHoleCenter={useFiberHoleCenter}
            />
          )}

          {isAomKind && (() => {
            // Acoustic axis is asset/component metadata (not anchor-level)
            // ??read from Component.properties.acousticAxisBodyLocal so
            // the inspector can echo it back read-only. This is the same
            // value the per-instance kindParams default to (see backend
            // default_kind_params_for_component).
            const compProps = (selectedComponent?.properties ?? {}) as {
              acousticAxisBodyLocal?: number[];
              acousticAxisLocal?: number[];
              rfPropagationDirectionBodyLocal?: number[];
              rfPropagationDirectionLocal?: number[];
            };
            const arr =
              compProps.rfPropagationDirectionBodyLocal ??
              compProps.rfPropagationDirectionLocal ??
              compProps.acousticAxisBodyLocal ??
              compProps.acousticAxisLocal;
            const acousticAxis =
              Array.isArray(arr) && arr.length === 3 && arr.every((v) => typeof v === "number")
                ? { x: arr[0], y: arr[1], z: arr[2] }
                : null;
            const liveRfDirection = aomRfDirectionDraft ?? acousticAxis ?? { x: -1, y: 0, z: 0 };
            return (
              <AomFaceSection
                inDraft={drafts.find((d) => d.id === "intercept_in") ?? null}
                outDraft={drafts.find((d) => d.id === "intercept_out") ?? null}
                rfInDraft={drafts.find((d) => d.id === "rf_in") ?? null}
                selectedAnchorKey={selectedAnchorKey}
                setSelectedAnchorKey={setSelectedAnchorKey}
                updateDraft={updateDraft}
                acousticAxisBodyLocal={acousticAxis}
                rfDirectionBodyLocal={liveRfDirection}
                onRfDirectionChange={(dir) => {
                  setAomRfDirectionDraft(dir);
                  setDirty(true);
                }}
                domain={domain}
              />
            );
          })()}

          {isBeamSplitterKind && (() => {
            // Infer PBS vs BS from the FIRST scene-instance kindParams
            // of this asset/component. Phase 2 will replace this with
            // Component.properties.beamSplitterType ??for now reading
            // kindParams.polarizing keeps the editor honest about
            // whatever the user has set elsewhere.
            const firstInst = scene.objects.find((o) => o.componentId === selectedComponent?.id);
            const el = firstInst
              ? scene.physicsElements.find((e) => e.objectId === firstInst.id)
              : null;
            const kp = (el?.kindParams ?? {}) as {
              polarizing?: boolean;
              splitRatioTransmitted?: number;
            };
            const bsType: "pbs" | "bs" = kp.polarizing === false ? "bs" : "pbs";
            return (
              <BeamSplitterFaceSection
                draft={selectedDraft}
                hasOutline={pickedOutline.length > 0}
                bsType={bsType}
                splitRatio={kp.splitRatioTransmitted}
                updateDraft={updateDraft}
              />
            );
          })()}

          {!hasCustomEditorUX && (
          <div className="component-editor-section">
            <div className="component-editor-section-title">
              Anchors ({drafts.length})
              <span
                style={{ marginLeft: "auto", fontSize: 11, opacity: 0.6 }}
                title="Anchor identity (id + name + count) is locked by the component's contract. Drag the position / direction to align with the 3D mesh."
              >
                identity locked
              </span>
            </div>
            {drafts.length === 0 && (
              <div style={{ fontSize: 12, opacity: 0.6, padding: "6px 0" }}>
                No anchors declared in this component's contract.
              </div>
            )}
            {drafts.map((d) => (
              <div
                key={d.__key}
                className={
                  "component-editor-anchor-row" +
                  (d.__key === selectedAnchorKey ? " is-active" : "")
                }
              >
                <button
                  type="button"
                  className="component-editor-anchor-handle"
                  onClick={() => setSelectedAnchorKey(d.__key)}
                  style={{
                    background: `#${anchorColour(d.id).toString(16).padStart(6, "0")}`,
                  }}
                  title={`Select ${d.id}${d.name ? ` (${d.name})` : ""}`}
                />
                <code
                  className="component-editor-input"
                  onClick={() => setSelectedAnchorKey(d.__key)}
                  style={{
                    flex: 1,
                    cursor: "pointer",
                    padding: "4px 8px",
                    background: "rgba(255,255,255,0.04)",
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                  title="Locked by component contract — edit position / direction below."
                >
                  {d.id}
                  {d.name ? <span style={{ opacity: 0.7 }}> · {d.name}</span> : null}
                </code>
              </div>
            ))}
          </div>
          )}

          {!hasCustomEditorUX && selectedDraft && (
            <div className="component-editor-section">
              <div className="component-editor-section-title">
                Selected: <code>{selectedDraft.id}</code>
              </div>
              <div className="component-editor-coord-grid">
                {(["x", "y", "z"] as const).map((axis) => (
                  <label key={axis} className="component-editor-coord">
                    <span>{axis.toUpperCase()} (mm, body-local Z-up)</span>
                    <input
                      type="number"
                      step={0.5}
                      value={selectedDraft.positionMmBodyLocal[axis].toFixed(3)}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v)) return;
                        updateDraft(selectedDraft.__key, {
                          positionMmBodyLocal: {
                            ...selectedDraft.positionMmBodyLocal,
                            [axis]: v,
                          },
                        });
                      }}
                    />
                  </label>
                ))}
              </div>
              {/* RF / TTL / Trigger anchors don't have a meaningful optical
                  aperture — they're coax connector face centres. Hide the
                  Aperture (mm) field for those anchor ids so the inspector
                  only shows it where it actually means something
                  (optical / mechanical apertures). */}
              {!(
                selectedDraft.id === "rf_in" ||
                selectedDraft.id === "rf_out" ||
                selectedDraft.id === "ttl_in" ||
                selectedDraft.id === "trigger_in"
              ) && (
                <ApertureShapeFields draft={selectedDraft} updateDraft={updateDraft} />
              )}

              <button
                type="button"
                className={
                  "secondary-button component-editor-pick-face" +
                  (pickFaceMode ? " is-active" : "")
                }
                onClick={() => setPickFaceMode((v) => !v)}
                title={
                  pickFaceMode
                    ? "Cancel face-picking (or press ESC). Currently waiting for a click on a face."
                    : "Switch to face-picking mode. Then click any face on the 3D mesh; the anchor's position + normal direction will snap to that face's center."
                }
              >
                {pickFaceMode
                  ? "Click a face (ESC to cancel)"
                  : "Pick face on 3D"}
              </button>

              {selectedNeedsDirection && (
                <div className="component-editor-direction">
                  <div className="component-editor-section-title" style={{ marginTop: 10 }}>
                    Normal direction (body-local)
                    {!selectedDraft.directionBodyLocal && (
                      <span className="anchor-badge anchor-badge-missing" style={{ marginLeft: 8 }}>
                        missing
                      </span>
                    )}
                  </div>
                  <p style={{ fontSize: 11, opacity: 0.7, marginTop: 0, marginBottom: 6 }}>
                    For a {kindContract?.displayName.toLowerCase()}, the
                    reflective face has a side that catches the beam. The
                    normal points OUT of that side. Beams hitting from the
                    opposite side pass through (or just don't reflect).
                  </p>
                  <div className="component-editor-coord-grid">
                    {(["x", "y", "z"] as const).map((axis) => (
                      <label key={axis} className="component-editor-coord">
                        <span>n{axis.toUpperCase()}</span>
                        <input
                          type="number"
                          step={0.1}
                          value={(selectedDraft.directionBodyLocal?.[axis] ?? 0).toFixed(3)}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (!Number.isFinite(v)) return;
                            const cur = selectedDraft.directionBodyLocal ?? { x: 0, y: 0, z: 0 };
                            updateDraft(selectedDraft.__key, {
                              directionBodyLocal: { ...cur, [axis]: v },
                            });
                          }}
                        />
                      </label>
                    ))}
                  </div>
                  <div className="component-editor-direction-presets">
                    {([
                      ["+X", { x: 1, y: 0, z: 0 }],
                      ["-X", { x: -1, y: 0, z: 0 }],
                      ["+Y", { x: 0, y: 1, z: 0 }],
                      ["-Y", { x: 0, y: -1, z: 0 }],
                      ["+Z", { x: 0, y: 0, z: 1 }],
                      ["-Z", { x: 0, y: 0, z: -1 }],
                    ] as const).map(([label, dir]) => (
                      <button
                        key={label}
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          updateDraft(selectedDraft.__key, { directionBodyLocal: { ...dir } })
                        }
                      >
                        {label}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="secondary-button"
                      title="Normalise to a unit vector (preserves direction, sets length to 1)"
                      onClick={() => {
                        const d = selectedDraft.directionBodyLocal;
                        if (!d) return;
                        const len = Math.hypot(d.x, d.y, d.z);
                        if (len < 1e-9) return;
                        updateDraft(selectedDraft.__key, {
                          directionBodyLocal: { x: d.x / len, y: d.y / len, z: d.z / len },
                        });
                      }}
                      disabled={!selectedDraft.directionBodyLocal}
                    >
                      Unit
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      title="Remove the direction (becomes undefined again)"
                      onClick={() =>
                        updateDraft(selectedDraft.__key, { directionBodyLocal: undefined })
                      }
                      disabled={!selectedDraft.directionBodyLocal}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}

              {RF_CONNECTOR_ANCHOR_IDS.has(selectedDraft.id) && (
                <ConnectorTypeField draft={selectedDraft} updateDraft={updateDraft} />
              )}

              {selectedNeedsFastAxis && (
                <div className="component-editor-direction">
                  <div className="component-editor-section-title" style={{ marginTop: 10 }}>
                    Fast-axis angle (body-local, deg)
                  </div>
                  <p style={{ fontSize: 11, opacity: 0.7, marginTop: 0, marginBottom: 6 }}>
                    Asset-level fast-axis angle of the crystal cut, in
                    body-local beam coordinates. Per-instance rotation
                    around the beam axis is layered on top via the
                    Object panel knob; effective Jones-frame angle =
                    this + instance rotation.
                  </p>
                  <label className="component-editor-coord">
                    <span>deg</span>
                    <input
                      type="number"
                      step={1}
                      value={selectedDraft.fastAxisDegBodyLocal ?? 0}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v)) return;
                        updateDraft(selectedDraft.__key, { fastAxisDegBodyLocal: v });
                      }}
                    />
                  </label>
                </div>
              )}

              <p style={{ fontSize: 11, opacity: 0.65, marginTop: 6 }}>
                Drag the gizmo arrows in 3D to move this anchor, or type
                exact coordinates above. Position is in body-local
                Z-up mm (Phase 4 schema).
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
