// Snap target collectors — invoked by `engine.computePlacement` to enumerate
// candidate snap points the dragged object could land on.
//
// Conventions (see PLACEMENT_DESIGN.md §3):
//   - All input/output positions are in **lab mm** unless explicitly named *Three.
//   - `_ignoreObjectId` is the SceneObject.id of the dragged object — collectors
//     skip it so the moving element doesn't snap to itself.
//   - `_ignoreComponentId` (where present) skips per-component (used by beam
//     collectors so a moving optical element doesn't snap onto a beam it
//     itself participates in).

import * as THREE from "three";

import type { LabPoint, SceneSnapshot, SnapTarget } from "./engine";
import { threeToLabPointMm } from "../../optical/frames";

// ───────────────────────────────────────────────────────────────────────────
// Shared lab-frame vector helpers (kept local to avoid coupling to beamSnap)
// ───────────────────────────────────────────────────────────────────────────

function sub(a: LabPoint, b: LabPoint): LabPoint {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function add(a: LabPoint, b: LabPoint): LabPoint {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function scale(v: LabPoint, s: number): LabPoint {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}
function dot(a: LabPoint, b: LabPoint): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function len(v: LabPoint): number {
  return Math.hypot(v.x, v.y, v.z);
}
function distance(a: LabPoint, b: LabPoint): number {
  return len(sub(a, b));
}

function closestPointOnSegment(
  p: LabPoint,
  a: LabPoint,
  b: LabPoint,
): { point: LabPoint; t: number } {
  const ab = sub(b, a);
  const lenSq = dot(ab, ab);
  if (lenSq < 1e-9) return { point: a, t: 0 };
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / lenSq));
  return { point: add(a, scale(ab, t)), t };
}

/** Convert a THREE.js world-space position into lab mm. Wraps the
 *  unification helper to keep the existing call sites unchanged. */
function threeToLabMm(v: THREE.Vector3): LabPoint {
  return threeToLabPointMm(v);
}

// ───────────────────────────────────────────────────────────────────────────
// Beam snaps
// ───────────────────────────────────────────────────────────────────────────

/** TraceSegment subset we read off `window.__rayTraceDebug`. Kept loose so
 *  this collector doesn't import from `three/rayTrace.ts` (which would pull
 *  THREE into the bundle path of the snap engine). */
type LiveTraceSegment = {
  startThree: { x: number; y: number; z: number };
  endThree: { x: number; y: number; z: number };
  sourceObjectId: string;
  hitObjectId: string | null;
};

export function collectBeamCenterlineSnaps(
  scene: SceneSnapshot,
  candidate: LabPoint,
  ignoreComponentId: string | null,
): SnapTarget[] {
  const out: SnapTarget[] = [];
  const compNameById = new Map(scene.components.map((c) => [c.id, c.name]));
  const objNameById = new Map(scene.objects.map((o) => [o.id, o.name]));

  // PRIMARY source: live ray-traced segments (window.__rayTraceDebug). Each
  // segment's ORIGIN + DIRECTION is set by the upstream emitter / mirror's
  // own pose — independent of any downstream object's position. So when the
  // user drags an object laterally, the beam axis stays put and the snap
  // pulls the object back onto the TRUE optical axis.
  //
  // Earlier this collector built lines from `link.fromObj.position` to
  // `link.toObj.position` — that endpoint moves WITH the dragged target,
  // making the snap line a self-fulfilling prophecy and "the beam follows
  // the object". Switching to trace data fixes that.
  const traces = (typeof window !== "undefined"
    ? (window as unknown as { __rayTraceDebug?: LiveTraceSegment[] }).__rayTraceDebug
    : undefined) ?? [];
  if (traces.length > 0) {
    for (const seg of traces) {
      const sourceComponentId = scene.objects.find((o) => o.id === seg.sourceObjectId)?.componentId;
      // Skip beams emitted by the moving element itself.
      if (
        ignoreComponentId !== null &&
        sourceComponentId === ignoreComponentId
      ) {
        continue;
      }
      const a = threeToLabMm(seg.startThree as unknown as THREE.Vector3);
      const b = threeToLabMm(seg.endThree as unknown as THREE.Vector3);
      const ab = sub(b, a);
      const lenSq = dot(ab, ab);
      if (lenSq < 1e-9) continue;
      const totalMm = Math.sqrt(lenSq);
      // Project candidate onto the INFINITE forward ray (t ≥ 0 only — beams
      // don't snap behind the emitter). No upper clamp on t — the user can
      // drop the object further along the axis than the visible segment
      // reaches, which still represents valid free-space propagation.
      const tForward = Math.max(0, dot(sub(candidate, a), ab) / lenSq);
      const point = add(a, scale(ab, tForward));
      const direction = scale(ab, 1 / totalMm);
      const fromName = objNameById.get(seg.sourceObjectId)
        ?? compNameById.get(sourceComponentId ?? "")
        ?? seg.sourceObjectId.slice(0, 6);
      const toName = seg.hitObjectId
        ? (objNameById.get(seg.hitObjectId) ?? "(open)")
        : "(open)";
      out.push({
        kind: "beam_centerline",
        pointLab: point,
        directionLab: direction,
        // No linkId — this beam came from a live trace, not an
        // optical_link row. distanceMm carries arc-length along the axis.
        ref: { linkId: "", distanceMm: tForward * totalMm },
        label: `axis from ${fromName} → ${toName}`,
        distanceMm: distance(candidate, point),
      });
    }
    return out;
  }

  // FALLBACK: no trace data published yet (first render before the trace
  // ran). Use the optical_link endpoint line — same as before. This path
  // exhibits the "beam follows target" issue but only fires for one frame
  // before the trace publishes.
  const objByCompId = new Map(scene.objects.map((o) => [o.componentId, o]));
  for (const link of scene.opticalLinks) {
    if (
      ignoreComponentId !== null &&
      (link.fromObjectId === ignoreComponentId || link.toObjectId === ignoreComponentId)
    ) {
      continue;
    }
    const fromObj = objByCompId.get(link.fromObjectId);
    const toObj = objByCompId.get(link.toObjectId);
    if (!fromObj || !toObj) continue;
    const a = { x: fromObj.xMm, y: fromObj.yMm, z: fromObj.zMm };
    const b = { x: toObj.xMm, y: toObj.yMm, z: toObj.zMm };
    if (distance(a, b) < 1e-3) continue;
    const { point, t } = closestPointOnSegment(candidate, a, b);
    const fromName = compNameById.get(link.fromObjectId) ?? link.fromObjectId.slice(0, 6);
    const toName = compNameById.get(link.toObjectId) ?? link.toObjectId.slice(0, 6);
    const totalMm = distance(a, b);
    out.push({
      kind: "beam_centerline",
      pointLab: point,
      directionLab: scale(sub(b, a), 1 / totalMm),
      ref: { linkId: link.id, distanceMm: t * totalMm },
      label: `centreline of ${fromName} → ${toName}`,
      distanceMm: distance(candidate, point),
    });
  }
  return out;
}

export function collectBeamEndpointSnaps(
  scene: SceneSnapshot,
  candidate: LabPoint,
  ignoreComponentId: string | null,
): SnapTarget[] {
  const out: SnapTarget[] = [];
  const objByCompId = new Map(scene.objects.map((o) => [o.componentId, o]));
  const compNameById = new Map(scene.components.map((c) => [c.id, c.name]));

  for (const link of scene.opticalLinks) {
    if (
      ignoreComponentId !== null &&
      (link.fromObjectId === ignoreComponentId || link.toObjectId === ignoreComponentId)
    ) {
      continue;
    }
    const fromObj = objByCompId.get(link.fromObjectId);
    const toObj = objByCompId.get(link.toObjectId);
    if (!fromObj || !toObj) continue;
    const a = { x: fromObj.xMm, y: fromObj.yMm, z: fromObj.zMm };
    const b = { x: toObj.xMm, y: toObj.yMm, z: toObj.zMm };
    const fromName = compNameById.get(link.fromObjectId) ?? "?";
    const toName = compNameById.get(link.toObjectId) ?? "?";
    out.push({
      kind: "beam_endpoint",
      pointLab: a,
      ref: { linkId: link.id, distanceMm: 0, objectId: fromObj.id },
      label: `start of ${fromName} → ${toName}`,
      distanceMm: distance(candidate, a),
    });
    out.push({
      kind: "beam_endpoint",
      pointLab: b,
      ref: { linkId: link.id, distanceMm: distance(a, b), objectId: toObj.id },
      label: `end of ${fromName} → ${toName}`,
      distanceMm: distance(candidate, b),
    });
  }
  return out;
}

export function collectBeamAlongSnaps(
  scene: SceneSnapshot,
  beamProbe: { linkId: string; distanceMm: number } | undefined,
): SnapTarget[] {
  if (!beamProbe) return [];
  const link = scene.opticalLinks.find((l) => l.id === beamProbe.linkId);
  if (!link) return [];
  const objByCompId = new Map(scene.objects.map((o) => [o.componentId, o]));
  const fromObj = objByCompId.get(link.fromObjectId);
  const toObj = objByCompId.get(link.toObjectId);
  if (!fromObj || !toObj) return [];
  const a = { x: fromObj.xMm, y: fromObj.yMm, z: fromObj.zMm };
  const b = { x: toObj.xMm, y: toObj.yMm, z: toObj.zMm };
  const totalMm = distance(a, b);
  if (totalMm < 1e-3) return [];
  const t = Math.max(0, Math.min(1, beamProbe.distanceMm / totalMm));
  const point = add(a, scale(sub(b, a), t));
  return [
    {
      kind: "beam_along",
      pointLab: point,
      directionLab: scale(sub(b, a), 1 / totalMm),
      ref: { linkId: link.id, distanceMm: beamProbe.distanceMm },
      label: `${beamProbe.distanceMm.toFixed(1)} mm along beam`,
      distanceMm: 0, // user explicitly chose this — always preferred
    },
  ];
}

export function collectBeamIntersectionSnaps(
  scene: SceneSnapshot,
  candidate: LabPoint,
): SnapTarget[] {
  const out: SnapTarget[] = [];
  const objByCompId = new Map(scene.objects.map((o) => [o.componentId, o]));
  const links = scene.opticalLinks
    .map((link) => {
      const f = objByCompId.get(link.fromObjectId);
      const t = objByCompId.get(link.toObjectId);
      if (!f || !t) return null;
      return {
        id: link.id,
        a: { x: f.xMm, y: f.yMm, z: f.zMm },
        b: { x: t.xMm, y: t.yMm, z: t.zMm },
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  for (let i = 0; i < links.length; i++) {
    for (let j = i + 1; j < links.length; j++) {
      const ix = nearestPointBetweenSegments(links[i].a, links[i].b, links[j].a, links[j].b);
      if (!ix) continue;
      out.push({
        kind: "beam_intersection",
        pointLab: ix.midpoint,
        ref: { linkId: links[i].id }, // stash one of the two — re-snap will not preserve exact same intent
        label: `intersection of two beams (gap ${ix.gapMm.toFixed(1)} mm)`,
        distanceMm: distance(candidate, ix.midpoint),
      });
    }
  }
  return out;
}

/** For two skew line segments (in 3D), find the closest pair of points
 * (one on each) and return their midpoint + the gap between them. */
function nearestPointBetweenSegments(
  p0: LabPoint,
  p1: LabPoint,
  q0: LabPoint,
  q1: LabPoint,
): { midpoint: LabPoint; gapMm: number } | null {
  const d1 = sub(p1, p0);
  const d2 = sub(q1, q0);
  const r = sub(p0, q0);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  const c = dot(d1, r);
  const b = dot(d1, d2);
  const denom = a * e - b * b;
  if (denom < 1e-9) return null; // parallel
  const s = Math.max(0, Math.min(1, (b * f - c * e) / denom));
  const t = Math.max(0, Math.min(1, (a * f - b * c) / denom));
  const pa = add(p0, scale(d1, s));
  const pb = add(q0, scale(d2, t));
  return { midpoint: scale(add(pa, pb), 0.5), gapMm: distance(pa, pb) };
}

// ───────────────────────────────────────────────────────────────────────────
// Geometry snaps (require componentGroup with loaded meshes)
// ───────────────────────────────────────────────────────────────────────────
//
// Unit conversion: meshes live in THREE units (1 unit = 100 mm). All collectors
// here read THREE world positions and convert to lab mm via threeToLabMm
// before returning targets, so the engine sees a consistent lab-mm interface.

export function collectMeshVertexSnaps(
  componentGroup: THREE.Group,
  candidate: LabPoint,
  ignoreObjectId: string | null,
): SnapTarget[] {
  componentGroup.updateMatrixWorld(true);
  const out: SnapTarget[] = [];
  const candidateThree = new THREE.Vector3(candidate.x / 100, candidate.z / 100, -candidate.y / 100);

  componentGroup.traverse((node) => {
    if (!(node as THREE.Mesh).isMesh) return;
    const mesh = node as THREE.Mesh;
    if (!mesh.geometry?.attributes?.position) return;
    const objectId = String(mesh.userData?.objectId ?? "");
    if (ignoreObjectId !== null && objectId === ignoreObjectId) return;
    const componentId = String(mesh.userData?.componentId ?? "");

    const pos = mesh.geometry.attributes.position;
    // Sub-sample large meshes (e.g. 14k-vertex BB1-E03) to keep this O(<1000)
    // per call. Step is chosen so we visit ~512 vertices regardless of size.
    const step = Math.max(1, Math.floor(pos.count / 512));
    const tmp = new THREE.Vector3();
    let bestDistSq = Infinity;
    let bestPoint: THREE.Vector3 | null = null;

    for (let i = 0; i < pos.count; i += step) {
      tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      tmp.applyMatrix4(mesh.matrixWorld);
      const d2 = tmp.distanceToSquared(candidateThree);
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        bestPoint = tmp.clone();
      }
    }
    if (bestPoint) {
      const lab = threeToLabMm(bestPoint);
      out.push({
        kind: "mesh_vertex",
        pointLab: lab,
        ref: { objectId, componentId },
        label: `vertex of ${mesh.name || componentId.slice(0, 6)}`,
        distanceMm: distance(candidate, lab),
      });
    }
  });

  return out;
}

export function collectMeshFaceCentroidSnaps(
  componentGroup: THREE.Group,
  candidate: LabPoint,
  ignoreObjectId: string | null,
): SnapTarget[] {
  componentGroup.updateMatrixWorld(true);
  const out: SnapTarget[] = [];
  const candidateThree = new THREE.Vector3(candidate.x / 100, candidate.z / 100, -candidate.y / 100);

  componentGroup.traverse((node) => {
    if (!(node as THREE.Mesh).isMesh) return;
    const mesh = node as THREE.Mesh;
    const geom = mesh.geometry;
    if (!geom?.attributes?.position) return;
    const objectId = String(mesh.userData?.objectId ?? "");
    if (ignoreObjectId !== null && objectId === ignoreObjectId) return;
    const componentId = String(mesh.userData?.componentId ?? "");

    geom.computeBoundingBox();
    if (!geom.boundingBox) return;
    // Use 6 face centers of the world bbox as an inexpensive proxy for
    // "front face centroid". Per-triangle scan would be 14k iterations,
    // overkill for the snap candidate selection.
    const bbox = geom.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    const min = bbox.min;
    const max = bbox.max;
    const center = bbox.getCenter(new THREE.Vector3());
    const faces = [
      { p: new THREE.Vector3(max.x, center.y, center.z), label: "+X face", n: new THREE.Vector3(1, 0, 0) },
      { p: new THREE.Vector3(min.x, center.y, center.z), label: "−X face", n: new THREE.Vector3(-1, 0, 0) },
      { p: new THREE.Vector3(center.x, max.y, center.z), label: "+Y face", n: new THREE.Vector3(0, 1, 0) },
      { p: new THREE.Vector3(center.x, min.y, center.z), label: "−Y face", n: new THREE.Vector3(0, -1, 0) },
      { p: new THREE.Vector3(center.x, center.y, max.z), label: "+Z face", n: new THREE.Vector3(0, 0, 1) },
      { p: new THREE.Vector3(center.x, center.y, min.z), label: "−Z face", n: new THREE.Vector3(0, 0, -1) },
    ];
    let bestDistSq = Infinity;
    let bestFace: (typeof faces)[number] | null = null;
    for (const f of faces) {
      const d2 = f.p.distanceToSquared(candidateThree);
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        bestFace = f;
      }
    }
    if (bestFace) {
      const lab = threeToLabMm(bestFace.p);
      out.push({
        kind: "mesh_face_centroid",
        pointLab: lab,
        directionLab: { x: bestFace.n.x, y: -bestFace.n.z, z: bestFace.n.y },
        ref: { objectId, componentId, anchorId: bestFace.label },
        label: `${bestFace.label} of ${mesh.name || componentId.slice(0, 6)}`,
        distanceMm: distance(candidate, lab),
      });
    }
  });

  return out;
}

export function collectMeshEdgeMidpointSnaps(
  _componentGroup: THREE.Group,
  _candidate: LabPoint,
  _ignoreObjectId: string | null,
): SnapTarget[] {
  // Edge midpoints aren't materially different from vertex snaps when meshes
  // are dense. Skip in v1 — vertex snap covers the use case. Easy to add
  // later if a user finds a case where this matters.
  return [];
}

export function collectMeshBboxCenterSnaps(
  componentGroup: THREE.Group,
  candidate: LabPoint,
  ignoreObjectId: string | null,
): SnapTarget[] {
  componentGroup.updateMatrixWorld(true);
  // One per top-level object (the wrapper Group, since Layer 1 wrapper-centers
  // each asset). We aggregate per-component world bbox then take its center.
  const byComp = new Map<string, { box: THREE.Box3; objectId: string; name: string }>();

  componentGroup.traverse((node) => {
    if (!(node as THREE.Mesh).isMesh) return;
    const mesh = node as THREE.Mesh;
    const componentId = String(mesh.userData?.componentId ?? "");
    if (!componentId) return;
    const objectId = String(mesh.userData?.objectId ?? "");
    if (ignoreObjectId !== null && objectId === ignoreObjectId) return;
    if (!mesh.geometry?.boundingBox) mesh.geometry?.computeBoundingBox?.();
    if (!mesh.geometry?.boundingBox) return;
    const box = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    const existing = byComp.get(componentId);
    if (existing) existing.box.union(box);
    else byComp.set(componentId, { box, objectId, name: mesh.name });
  });

  const out: SnapTarget[] = [];
  for (const [componentId, { box, objectId, name }] of byComp) {
    const center = box.getCenter(new THREE.Vector3());
    const lab = threeToLabMm(center);
    out.push({
      kind: "mesh_bbox_center",
      pointLab: lab,
      ref: { objectId, componentId },
      label: `centre of ${name || componentId.slice(0, 6)}`,
      distanceMm: distance(candidate, lab),
    });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Anchor snaps (asset-defined named anchors)
// ───────────────────────────────────────────────────────────────────────────

export function collectAnchorSnaps(
  scene: SceneSnapshot,
  candidate: LabPoint,
  ignoreObjectId: string | null,
): SnapTarget[] {
  const out: SnapTarget[] = [];
  const compById = new Map(scene.components.map((c) => [c.id, c]));
  const assetById = new Map(scene.assets.map((a) => [a.id, a]));

  for (const obj of scene.objects) {
    if (ignoreObjectId !== null && obj.id === ignoreObjectId) continue;
    const comp = compById.get(obj.componentId);
    if (!comp?.asset3dId) continue;
    const asset = assetById.get(comp.asset3dId);
    const anchors = (asset as { anchors?: Array<{ id: string; positionMmBodyLocal?: { x: number; y: number; z: number } }> } | undefined)?.anchors;
    if (!anchors?.length) continue;
    for (const anchor of anchors) {
      const lp = anchor.positionMmBodyLocal;
      if (!lp) continue;
      // Apply the SceneObject's lab-frame pose to anchor's local position.
      const world = applyLabPose(lp, obj);
      out.push({
        kind: "anchor",
        pointLab: world,
        ref: { objectId: obj.id, componentId: obj.componentId, anchorId: anchor.id },
        label: `anchor "${anchor.id}" of ${comp.name}`,
        distanceMm: distance(candidate, world),
      });
    }
  }
  return out;
}

/** Apply a SceneObject's lab-frame pose (translation + Rz·Rx·Ry rotation,
 * matching the convention used elsewhere in the project) to a local point. */
function applyLabPose(
  local: { x: number; y: number; z: number },
  obj: { xMm: number; yMm: number; zMm: number; rxDeg: number; ryDeg: number; rzDeg: number },
): LabPoint {
  const rx = (obj.rxDeg * Math.PI) / 180;
  const ry = (obj.ryDeg * Math.PI) / 180;
  const rz = (obj.rzDeg * Math.PI) / 180;
  // Ry
  let x = local.x * Math.cos(ry) + local.z * Math.sin(ry);
  let y = local.y;
  let z = -local.x * Math.sin(ry) + local.z * Math.cos(ry);
  // Rx
  const y1 = y * Math.cos(rx) - z * Math.sin(rx);
  const z1 = y * Math.sin(rx) + z * Math.cos(rx);
  y = y1;
  z = z1;
  // Rz
  const x2 = x * Math.cos(rz) - y * Math.sin(rz);
  const y2 = x * Math.sin(rz) + y * Math.cos(rz);
  x = x2;
  y = y2;
  return { x: x + obj.xMm, y: y + obj.yMm, z: z + obj.zMm };
}

// ───────────────────────────────────────────────────────────────────────────
// Reference snaps (cursor, world origin)
// ───────────────────────────────────────────────────────────────────────────

export function collectCursorSnap(
  cursor: LabPoint | undefined,
  candidate: LabPoint,
): SnapTarget[] {
  if (!cursor) return [];
  return [
    {
      kind: "cursor",
      pointLab: cursor,
      ref: {},
      label: "3D cursor",
      distanceMm: distance(candidate, cursor),
    },
  ];
}

export function collectWorldOriginSnap(candidate: LabPoint): SnapTarget[] {
  const origin = { x: 0, y: 0, z: 0 };
  return [
    {
      kind: "world_origin",
      pointLab: origin,
      ref: {},
      label: "lab origin",
      distanceMm: distance(candidate, origin),
    },
  ];
}

// ───────────────────────────────────────────────────────────────────────────
// Grid snap (fall-through)
// ───────────────────────────────────────────────────────────────────────────

export function collectGridSnap(candidate: LabPoint, gridStepMm: number): SnapTarget[] {
  if (gridStepMm <= 0) return [];
  const round = (v: number) => Math.round(v / gridStepMm) * gridStepMm;
  const snapped = { x: round(candidate.x), y: round(candidate.y), z: round(candidate.z) };
  return [
    {
      kind: "grid",
      pointLab: snapped,
      ref: { distanceMm: gridStepMm },
      label: `${gridStepMm} mm grid`,
      distanceMm: distance(candidate, snapped),
    },
  ];
}
