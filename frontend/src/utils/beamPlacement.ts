// Beam placement: enumerate all segments in the optical tree (rooted at
// laser sources) and resolve a (fromComponentId, fromPort, offsetMm) tuple
// to a 3D lab-mm position. Handles:
//   - Closed segments (link from A → B): straightforward lerp.
//   - Open segments (after a leaf component): direction computed from
//     geometry: laser/TA emit local +Z; mirror reflects incoming; lens etc.
//     pass through.
//   - Negative offsets: walk upstream along the tree, single parent per
//     component (PBS gets multiple OUTPUTS but still one INPUT, so walking
//     back is unambiguous). Hard floor at any component without an upstream
//     link (the laser_source root).
//   - Positive offsets exceeding closed segment length: clamp to segment end.

import type {
  Asset3D,
  ComponentItem,
  OpticalElement,
  OpticalLink,
  SceneData,
  SceneObject,
} from "../types/digitalTwin";
import { bodyLocalDirToLabDir, threeToLabPointMm } from "../optical/frames";
import { getMirrorNormalBodyLocal } from "./v2Bindings";

export type Vec3 = { x: number; y: number; z: number };

export type BeamSegmentSummary = {
  /** Unique key for the dropdown (fromObjectId + fromPort, optionally
   *  with bridge marker so collapsed segments don't collide with real
   *  ones). All ids are SceneObject ids (per-object optical chain). */
  key: string;
  fromObjectId: string;
  fromPort: string;
  /** null = open-ended (no downstream object yet). */
  toObjectId: string | null;
  toPort: string | null;
  startLab: Vec3;
  /** null for open segments. */
  endLab: Vec3 | null;
  /** Unit vector in lab frame; for closed segments points from start to
   *  end, for open segments computed from geometry. */
  directionUnit: Vec3;
  /** null = ∞ (open segment). */
  lengthMm: number | null;
  /** Optical element kinds at start / end for label rendering. */
  fromKindLabel: string;
  toKindLabel: string | null;
  /** Human-readable label, e.g. "Laser → Mirror1 (458 mm)". */
  label: string;
  /** When set, this segment is a CLOSED VIRTUAL BRIDGE: the target object
   *  is being moved within a chain, and this segment skips over it (e.g.
   *  A→B→C with target=B becomes virtual A→C). The resolver uses this
   *  object as the geometry's downstream endpoint instead of the
   *  underlying link's toObjectId. */
  bridgedViaObjectId?: string;
  /** When true, this is an OPEN VIRTUAL BRIDGE: target has upstream input
   *  but no downstream output, so lifting it leaves the upstream's beam
   *  continuing past target's old position to infinity. The directionUnit
   *  is frozen at the time the segment was enumerated (vector from
   *  upstream toward target's original position). */
  bridgedOpen?: boolean;
};

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

const v3sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const v3dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const v3cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const v3len = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
const v3norm = (v: Vec3): Vec3 => {
  const l = v3len(v);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l, z: v.z / l } : { x: 0, y: 0, z: 1 };
};
const v3scale = (v: Vec3, s: number): Vec3 => ({ x: v.x * s, y: v.y * s, z: v.z * s });
const v3add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const v3lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

/** Reflect direction d̂ off a surface with unit normal n̂ (pointing outward). */
const reflect = (d: Vec3, n: Vec3): Vec3 => {
  const dn = v3dot(d, n);
  return { x: d.x - 2 * dn * n.x, y: d.y - 2 * dn * n.y, z: d.z - 2 * dn * n.z };
};

/** Rotate a body-local Z-up vector into lab Z-up frame using the
 *  SceneObject's Euler triple. Phase 3 of the schema unification:
 *  delegates to `sceneObjectToQuaternion` (via `bodyLocalDirToLabDir`)
 *  so this function and the renderer's `applyObjectTransform` share the
 *  exact same rotation. The previous body-rolled implementation
 *  (`R = Rz·Ry·Rx`, extrinsic XYZ) silently disagreed with the renderer
 *  for any SceneObject with two or more non-zero Euler components — a
 *  ~37 % positional error on a unit vector at (rxDeg, ryDeg, rzDeg) =
 *  (30°, 45°, 60°). Now both paths fall through one quaternion. */
export function rotateLocalToLab(v: Vec3, rxDeg: number, ryDeg: number, rzDeg: number): Vec3 {
  return bodyLocalDirToLabDir(v, { rxDeg, ryDeg, rzDeg } as SceneObject);
}

const objectPosLab = (obj: SceneObject): Vec3 => ({ x: obj.xMm, y: obj.yMm, z: obj.zMm });

/** Lab-frame position the beam ACTUALLY starts from for an emitter
 *  (laser_source / tapered_amplifier). Includes the asset's "+x" / "out"
 *  anchor offset so the beam-placement axis lines up with the rendered
 *  ray (which uses the same anchor in opticalBeams.ts:emissionFromObject).
 *
 *  For non-emitters, returns the object's body-center position — passive
 *  elements (mirror, lens, …) don't have a body-relative emission point.
 */
function beamStartPosLab(obj: SceneObject, scene: SceneData): Vec3 {
  const el = scene.opticalElements.find((e) => e.objectId === obj.id);
  if (!el || (el.elementKind !== "laser_source" && el.elementKind !== "tapered_amplifier")) {
    return objectPosLab(obj);
  }
  const component = scene.components.find((c) => c.id === obj.componentId);
  const asset = component?.asset3dId
    ? scene.assets.find((a) => a.id === component.asset3dId)
    : undefined;
  const anchor = asset?.anchors?.find((a) => a.id === "+x" || a.id === "out");
  if (!anchor?.positionMmBodyLocal) return objectPosLab(obj);
  const off = rotateLocalToLab(
    { x: anchor.positionMmBodyLocal.x, y: anchor.positionMmBodyLocal.y, z: anchor.positionMmBodyLocal.z },
    obj.rxDeg,
    obj.ryDeg,
    obj.rzDeg,
  );
  return { x: obj.xMm + off.x, y: obj.yMm + off.y, z: obj.zMm + off.z };
}

/** Default mirror thickness when the asset doesn't carry one. Mirrors the
 *  constant used in beamAnchor.ts to keep the two layers consistent. */
const DEFAULT_MIRROR_THICKNESS_MM = 6;

/** Look up the mirror / dichroic surface normal in LOCAL frame. Source
 *  precedence (matches beamAnchor.ts to avoid divergence):
 *   1. Asset anchor with id "optical_anchor" + directionBodyLocal
 *   2. kindParams.normalLocal (DB default for mirror = [1, 0, 0])
 *   3. null — caller falls back to "no reflection direction available"
 *
 *  Inlined here rather than imported from beamAnchor.ts because beamAnchor
 *  already imports from this module, and Vite would error on the cycle.
 */
function mirrorNormalLocal(obj: SceneObject, scene: SceneData): Vec3 | null {
  // V2 Phase 2 (alembic 0028) precedence:
  //   1. objects.properties.anchorBindings[opticalSurface].payload.normalBodyLocal
  //   2. asset's `optical_anchor` directionBodyLocal (CAD default)
  //   3. null — caller falls back to "no reflection direction available"
  const v2 = getMirrorNormalBodyLocal(obj);
  if (v2) {
    const len = Math.hypot(v2[0], v2[1], v2[2]);
    if (len > 1e-9) return { x: v2[0] / len, y: v2[1] / len, z: v2[2] / len };
  }
  const component = scene.components.find((c) => c.id === obj.componentId);
  const asset = component?.asset3dId
    ? scene.assets.find((a) => a.id === component.asset3dId)
    : undefined;
  const optical = asset?.anchors?.find((a) => a.id === "optical_anchor");
  if (optical?.directionBodyLocal) {
    const d = optical.directionBodyLocal;
    const len = Math.hypot(d.x, d.y, d.z);
    if (len > 1e-9) return { x: d.x / len, y: d.y / len, z: d.z / len };
  }
  return null;
}

/** Lab-frame position of the reflective face (mirror) or intercept anchor
 *  for an object — what the rendered ray-tracer actually hits. Falls back
 *  to body center when the element has no reflective surface concept.
 */
function reflectivePosLab(obj: SceneObject, scene: SceneData): Vec3 {
  const el = scene.opticalElements.find((e) => e.objectId === obj.id);
  if (!el) return objectPosLab(obj);
  if (el.elementKind === "laser_source" || el.elementKind === "tapered_amplifier") {
    return beamStartPosLab(obj, scene);
  }
  // Asset's optical_anchor (offset in local frame).
  const component = scene.components.find((c) => c.id === obj.componentId);
  const asset = component?.asset3dId
    ? scene.assets.find((a) => a.id === component.asset3dId)
    : undefined;
  const optical = asset?.anchors?.find((a) => a.id === "optical_anchor");
  if (optical?.positionMmBodyLocal) {
    const off = rotateLocalToLab(
      { x: optical.positionMmBodyLocal.x, y: optical.positionMmBodyLocal.y, z: optical.positionMmBodyLocal.z },
      obj.rxDeg,
      obj.ryDeg,
      obj.rzDeg,
    );
    return { x: obj.xMm + off.x, y: obj.yMm + off.y, z: obj.zMm + off.z };
  }
  // Mirror kind default — face = body + normalLocal * thickness/2.
  if (el.elementKind === "mirror" || el.elementKind === "dichroic_mirror") {
    const n = mirrorNormalLocal(obj, scene);
    if (n) {
      const half = DEFAULT_MIRROR_THICKNESS_MM / 2;
      const off = rotateLocalToLab(
        { x: n.x * half, y: n.y * half, z: n.z * half },
        obj.rxDeg,
        obj.ryDeg,
        obj.rzDeg,
      );
      return { x: obj.xMm + off.x, y: obj.yMm + off.y, z: obj.zMm + off.z };
    }
  }
  return objectPosLab(obj);
}

/** Find the OBJECT's outgoing-beam direction at a specific output port,
 *  computed from geometry. Returns null when the direction can't be
 *  determined (e.g. object is mid-chain with no input link, or its
 *  optical-element kind isn't modelled yet). All ids are SceneObject ids
 *  (per-object optical chain — alembic 0014). */
function computeOutgoingDirection(
  objectId: string,
  fromPort: string,
  scene: SceneData,
): Vec3 | null {
  const obj = scene.objects.find((o) => o.id === objectId);
  const el = scene.opticalElements.find((e) => e.objectId === objectId);
  if (!obj || !el) return null;

  const rotated = (vLocal: Vec3) =>
    rotateLocalToLab(vLocal, obj.rxDeg, obj.ryDeg, obj.rzDeg);

  // Emitters: pull the emission direction from the asset's "+x" / "out"
  // anchor so the placement-panel agrees with the actual ray-traced beam
  // (opticalBeams.ts:emissionFromObject reads the same anchor). Fall back
  // to local +X (the lab convention for asset anchors), then to local +Z
  // for legacy assets that pre-date the anchor convention.
  if (el.elementKind === "laser_source" || el.elementKind === "tapered_amplifier") {
    const component = scene.components.find((c) => c.id === obj.componentId);
    const asset = component?.asset3dId
      ? scene.assets.find((a) => a.id === component.asset3dId)
      : undefined;
    const anchor = asset?.anchors?.find((a) => a.id === "+x" || a.id === "out");
    const localDir = anchor?.directionBodyLocal
      ?? { x: 1, y: 0, z: 0 };
    return v3norm(rotated(localDir));
  }

  // Find the incoming link to this object. Beam comes from there.
  const inLink = scene.opticalLinks.find((l) => l.toObjectId === objectId);
  if (!inLink) return null;
  const inObj = scene.objects.find((o) => o.id === inLink.fromObjectId);
  if (!inObj) return null;
  // Use ANCHOR positions (matches the rendered ray's actual emission origin
  // → mirror face center) — body-center math diverges from the renderer when
  // an asset's optical anchor is offset (e.g. mirror reflective face sits at
  // +halfThickness in front of the body origin).
  const incoming = v3norm(v3sub(reflectivePosLab(obj, scene), reflectivePosLab(inObj, scene)));

  // Mirror: reflect about face normal sourced from asset's optical_anchor
  // directionBodyLocal, falling back to kindParams.normalLocal. Same precedence
  // as beamAnchor.ts:mirrorNormalLab so the placement panel agrees with
  // every other consumer of the mirror's surface normal.
  if (el.elementKind === "mirror") {
    const nLocal = mirrorNormalLocal(obj, scene);
    if (!nLocal) return null;
    const nLab = v3norm(rotated(nLocal));
    return v3norm(reflect(incoming, nLab));
  }

  // Pass-through elements (lenses, AOM, EOM, waveplate, etc.) — outgoing
  // direction same as incoming.
  const passThrough = new Set([
    "lens_spherical",
    "lens_cylindrical",
    "waveplate",
    "polarizer",
    "isolator",
    "aom",
    "eom",
    "nonlinear_crystal",
    "saturable_absorber",
    "fiber_coupler",
  ]);
  if (passThrough.has(el.elementKind)) return incoming;

  // Branching elements (beam_splitter, pbs, dichroic_mirror): each output
  // port is either transmitted (pass-through) or reflected (off front face).
  // Heuristic on port id since the codebase has no fixed convention yet:
  //   contains "trans" / starts with "t" / "out_t"  → pass-through
  //   contains "refl"  / starts with "r" / "out_r"  → reflected
  // Falls back to dichroic-default-reflected vs splitter-default-transmitted.
  const branching = new Set(["beam_splitter", "pbs", "dichroic_mirror"]);
  if (branching.has(el.elementKind)) {
    const portLow = fromPort.toLowerCase();
    const isTrans = /trans|^t$|out_t/.test(portLow);
    const isRefl = /refl|^r$|out_r/.test(portLow);
    const treatAsTransmitted = isTrans
      ? true
      : isRefl
        ? false
        : el.elementKind !== "dichroic_mirror"; // splitters default trans; dichroics default refl
    if (treatAsTransmitted) return incoming;
    const nLocal = mirrorNormalLocal(obj, scene);
    if (!nLocal) return null;
    const nLab = v3norm(rotated(nLocal));
    return v3norm(reflect(incoming, nLab));
  }

  // Unknown element — refuse, caller falls back to disable.
  return null;
}

/** Default open-segment placement length so the dropdown shows something
 *  useful when the leaf has no downstream. Used only for label hint and
 *  initial offset suggestion in the panel. */
const OPEN_SEGMENT_DEFAULT_PREVIEW_MM = 200;

/** Enumerate every segment in the optical tree:
 *   - One per existing optical_link (closed)
 *   - One per (object, output port) pair with NO outgoing link (open)
 *     AND we can compute the outgoing direction from geometry
 *
 *  When `excludeTargetObjId` is provided (the user is repositioning that
 *  object), segments where target is an endpoint are filtered out, AND if
 *  target sits mid-chain (1 incoming + 1 outgoing link) a virtual BRIDGE
 *  segment is added from upstream → downstream so the user can see
 *  "where else can target sit if I lift it out of the chain".
 *
 *  All ids are SceneObject ids — per-object optical chain (alembic 0014).
 */
export function enumerateBeamSegments(
  scene: SceneData,
  excludeTargetObjId: string | null = null,
  validations?: Map<string, LinkValidation>,
): BeamSegmentSummary[] {
  // Hide closed-segment / closed-bridge entries that come from a physically
  // invalid link — the user shouldn't be offered a placement axis that
  // doesn't actually exist. Open segments (no underlying link) are
  // unaffected. Caller may pass `undefined` to skip the filter.
  const isLinkValid = (linkId: string): boolean => {
    if (!validations) return true;
    const v = validations.get(linkId);
    return !v || v.status !== "broken";
  };
  const objsById = new Map<string, SceneObject>(scene.objects.map((o) => [o.id, o]));
  const elByObj = new Map<string, OpticalElement>(
    scene.opticalElements.map((e) => [e.objectId, e]),
  );
  const compById = new Map(scene.components.map((c) => [c.id, c]));

  // Each scene object has its own display name; fall back to component
  // name then short id. The label shows OBJECT names so two BB1 mirrors
  // ("Mirror" vs "test") read distinctly even though they share a Component.
  const labelFor = (objId: string): string => {
    const o = objsById.get(objId);
    if (o?.name?.trim()) return o.name.trim();
    if (o) {
      const c = compById.get(o.componentId);
      if (c?.componentName?.trim() || c?.name?.trim()) {
        return c.componentName?.trim() || c.name?.trim() || objId.slice(0, 6);
      }
    }
    return objId.slice(0, 6);
  };

  const segments: BeamSegmentSummary[] = [];

  // Closed segments: one per optical_link
  for (const link of scene.opticalLinks) {
    // Skip if target is either endpoint — those will be replaced by a
    // virtual bridge below (when target has both an in and an out link).
    if (excludeTargetObjId && (link.fromObjectId === excludeTargetObjId || link.toObjectId === excludeTargetObjId)) {
      continue;
    }
    // Skip physically broken links so the user isn't offered a fictional
    // placement axis. (clipping is still surfaced — only outright miss
    // is filtered.)
    if (!isLinkValid(link.id)) continue;
    const fromObj = objsById.get(link.fromObjectId);
    const toObj = objsById.get(link.toObjectId);
    if (!fromObj || !toObj) continue;
    // Beam starts from the EMITTER's anchor (laser/TA only) — passive
    // elements fall back to body center.
    const startLab = beamStartPosLab(fromObj, scene);
    const endLab = objectPosLab(toObj);
    const delta = v3sub(endLab, startLab);
    const lengthMm = v3len(delta);
    const directionUnit = lengthMm > 1e-6 ? v3norm(delta) : { x: 0, y: 0, z: 1 };
    const fromKind = elByObj.get(link.fromObjectId)?.elementKind ?? "?";
    const toKind = elByObj.get(link.toObjectId)?.elementKind ?? "?";
    segments.push({
      key: `${link.fromObjectId}|${link.fromPort}`,
      fromObjectId: link.fromObjectId,
      fromPort: link.fromPort,
      toObjectId: link.toObjectId,
      toPort: link.toPort,
      startLab,
      endLab,
      directionUnit,
      lengthMm,
      fromKindLabel: fromKind,
      toKindLabel: toKind,
      label: `${labelFor(link.fromObjectId)} → ${labelFor(link.toObjectId)} (${lengthMm.toFixed(1)} mm)`,
    });
  }

  // Virtual bridges. When the user is moving target X out of position, every
  // existing link touching X gets filtered above; we re-add segments showing
  // "what the beam path would look like if X were lifted out". Coverage:
  //   - N in × M out (M ≥ 1): one CLOSED bridge per (in,out) pair → N×M bridges
  //   - N in + 0 out: one OPEN bridge per incoming → upstream beam continues
  //                    past where X sat, infinite. Direction frozen from
  //                    upstream → X's original position so it doesn't drift
  //                    while the user drags X live.
  //   - 0 in + anything: nothing to bridge (no upstream to extend); fall
  //                       through to other segments unfiltered.
  if (excludeTargetObjId) {
    const inLinks = scene.opticalLinks.filter((l) => l.toObjectId === excludeTargetObjId);
    const outLinks = scene.opticalLinks.filter((l) => l.fromObjectId === excludeTargetObjId);
    const targetObj = objsById.get(excludeTargetObjId);
    const bridgedName = labelFor(excludeTargetObjId);

    if (inLinks.length > 0 && outLinks.length > 0) {
      for (const inLink of inLinks) {
        // Skip bridges where the upstream link is itself broken — the beam
        // never reached target, so "lifting target out" is meaningless.
        if (!isLinkValid(inLink.id)) continue;
        for (const outLink of outLinks) {
          if (!isLinkValid(outLink.id)) continue;
          const fromObj = objsById.get(inLink.fromObjectId);
          const toObj = objsById.get(outLink.toObjectId);
          if (!fromObj || !toObj) continue;
          const startLab = beamStartPosLab(fromObj, scene);
          const endLab = objectPosLab(toObj);
          const delta = v3sub(endLab, startLab);
          const lengthMm = v3len(delta);
          const directionUnit = lengthMm > 1e-6 ? v3norm(delta) : { x: 0, y: 0, z: 1 };
          const fromKind = elByObj.get(inLink.fromObjectId)?.elementKind ?? "?";
          const toKind = elByObj.get(outLink.toObjectId)?.elementKind ?? "?";
          // Branch annotation only useful when target had >1 outgoing
          const branchTag = outLinks.length > 1 ? ` [${outLink.fromPort}→${outLink.toPort}]` : "";
          segments.push({
            key: `${inLink.fromObjectId}|${inLink.fromPort}|bridge|${outLink.toObjectId}|${outLink.toPort}`,
            fromObjectId: inLink.fromObjectId,
            fromPort: inLink.fromPort,
            toObjectId: outLink.toObjectId,
            toPort: outLink.toPort,
            startLab,
            endLab,
            directionUnit,
            lengthMm,
            fromKindLabel: fromKind,
            toKindLabel: toKind,
            label: `${labelFor(inLink.fromObjectId)} → ${labelFor(outLink.toObjectId)} (${lengthMm.toFixed(1)} mm, bridged via ${bridgedName}${branchTag})`,
            bridgedViaObjectId: outLink.toObjectId,
          });
        }
      }
    } else if (inLinks.length > 0 && targetObj) {
      // Open bridge: target had upstream(s) but no downstream. Beam continues
      // past target's old slot to infinity along the original incoming axis.
      for (const inLink of inLinks) {
        if (!isLinkValid(inLink.id)) continue;
        const fromObj = objsById.get(inLink.fromObjectId);
        if (!fromObj) continue;
        const startLab = beamStartPosLab(fromObj, scene);
        const targetPos = objectPosLab(targetObj);
        const delta = v3sub(targetPos, startLab);
        const dist = v3len(delta);
        const directionUnit = dist > 1e-6 ? v3norm(delta) : { x: 0, y: 0, z: 1 };
        const fromKind = elByObj.get(inLink.fromObjectId)?.elementKind ?? "?";
        segments.push({
          key: `${inLink.fromObjectId}|${inLink.fromPort}|bridge-open|${excludeTargetObjId}`,
          fromObjectId: inLink.fromObjectId,
          fromPort: inLink.fromPort,
          toObjectId: null,
          toPort: null,
          startLab,
          endLab: null,
          directionUnit,
          lengthMm: null,
          fromKindLabel: fromKind,
          toKindLabel: null,
          label: `${labelFor(inLink.fromObjectId)} → (open, ∞, lifting ${bridgedName})`,
          bridgedOpen: true,
        });
      }
    }
  }

  // Open segments: each (object, output port) that has no outgoing link
  // AND for which we can compute the outgoing direction from geometry.
  //
  // When a target is being moved, we DON'T treat links going INTO that
  // target as "using" the upstream's output port — the user is lifting
  // the target out, so the upstream's natural axis should also become
  // available as an option (alongside the bridged-open frozen axis).
  // That gives the user a choice between "slide along my pre-existing
  // placement axis" (bridged-open) and "switch to the actual rendered
  // emission axis" (natural open).
  const usedOutputs = new Set(
    scene.opticalLinks
      .filter((l) => !excludeTargetObjId || l.toObjectId !== excludeTargetObjId)
      .map((l) => `${l.fromObjectId}|${l.fromPort}`),
  );
  for (const el of scene.opticalElements) {
    if (excludeTargetObjId && el.objectId === excludeTargetObjId) continue;
    const obj = objsById.get(el.objectId);
    if (!obj) continue;
    for (const port of el.outputPorts) {
      const key = `${el.objectId}|${port.portId}`;
      if (usedOutputs.has(key)) continue;
      const dir = computeOutgoingDirection(el.objectId, port.portId, scene);
      if (!dir) continue;
      segments.push({
        key,
        fromObjectId: el.objectId,
        fromPort: port.portId,
        toObjectId: null,
        toPort: null,
        startLab: beamStartPosLab(obj, scene),
        endLab: null,
        directionUnit: dir,
        lengthMm: null,
        fromKindLabel: el.elementKind,
        toKindLabel: null,
        label: `${labelFor(el.objectId)} → (open, ∞)`,
      });
    }
  }

  return segments;
}

/** Walk back up the tree from `startObjId`, consuming `remainingMm`. If
 *  we hit an object with no upstream link (the laser_source root), clamp
 *  there. Returns the lab-mm position. All ids are SceneObject ids. */
function walkUpstream(
  startObjId: string,
  remainingMm: number,
  scene: SceneData,
): Vec3 {
  const objsById = new Map<string, SceneObject>(scene.objects.map((o) => [o.id, o]));
  let cur = startObjId;
  let remaining = remainingMm;
  while (remaining > 0) {
    const parentLink = scene.opticalLinks.find((l) => l.toObjectId === cur);
    if (!parentLink) {
      const obj = objsById.get(cur);
      return obj ? objectPosLab(obj) : ZERO;
    }
    const parentObj = objsById.get(parentLink.fromObjectId);
    const curObj = objsById.get(cur);
    if (!parentObj || !curObj) return ZERO;
    const parentPos = objectPosLab(parentObj);
    const curPos = objectPosLab(curObj);
    const segLen = v3len(v3sub(curPos, parentPos));
    if (remaining <= segLen) {
      return v3lerp(parentPos, curPos, segLen > 1e-9 ? (segLen - remaining) / segLen : 0);
    }
    remaining -= segLen;
    cur = parentLink.fromObjectId;
  }
  const obj = objsById.get(cur);
  return obj ? objectPosLab(obj) : ZERO;
}

/** Resolve (fromObjectId, fromPort, offsetMm[, bridge metadata]) to a
 *  lab-mm beam position.
 *
 *  Bridge metadata:
 *   - `bridgedViaObjectId`: closed bridge — segment endpoint is THIS object
 *     (the target was lifted out of an A→target→C chain so the segment
 *     becomes A→C).
 *   - `bridgedOpen` + `bridgedDirection`: open bridge — target had upstream
 *     but no downstream; segment extends from upstream past target's old
 *     position toward infinity along the FROZEN direction (passed in to
 *     avoid feedback loops as the user drags target along the segment).
 *
 *  Returns null when the segment can't be located. All ids are SceneObject ids. */
export function resolveBeamPosition(
  meta: {
    fromObjectId: string;
    fromPort: string;
    offsetMm: number;
    bridgedViaObjectId?: string;
    bridgedOpen?: boolean;
    bridgedDirection?: Vec3;
  },
  scene: SceneData,
): Vec3 | null {
  const fromObj = scene.objects.find((o) => o.id === meta.fromObjectId);
  if (!fromObj) return null;
  // For an emitter source, "from" is the anchor offset, not the body
  // center, so the resolved position lines up with the rendered beam.
  const fromPos = beamStartPosLab(fromObj, scene);

  if (meta.offsetMm < 0) {
    return walkUpstream(meta.fromObjectId, -meta.offsetMm, scene);
  }

  if (meta.bridgedViaObjectId) {
    const bridgeToObj = scene.objects.find((o) => o.id === meta.bridgedViaObjectId);
    if (!bridgeToObj) return null;
    const endPos = objectPosLab(bridgeToObj);
    const segLen = v3len(v3sub(endPos, fromPos));
    if (segLen < 1e-9) return fromPos;
    const clampedOffset = Math.min(meta.offsetMm, segLen);
    return v3lerp(fromPos, endPos, clampedOffset / segLen);
  }

  if (meta.bridgedOpen && meta.bridgedDirection) {
    return v3add(fromPos, v3scale(v3norm(meta.bridgedDirection), meta.offsetMm));
  }

  const link = scene.opticalLinks.find(
    (l) => l.fromObjectId === meta.fromObjectId && l.fromPort === meta.fromPort,
  );

  if (link) {
    const toObj = scene.objects.find((o) => o.id === link.toObjectId);
    if (!toObj) return null;
    const endPos = objectPosLab(toObj);
    const segLen = v3len(v3sub(endPos, fromPos));
    if (segLen < 1e-9) return fromPos;
    const clampedOffset = Math.min(meta.offsetMm, segLen);
    return v3lerp(fromPos, endPos, clampedOffset / segLen);
  }

  const dir = computeOutgoingDirection(meta.fromObjectId, meta.fromPort, scene);
  if (!dir) return null;
  return v3add(fromPos, v3scale(dir, meta.offsetMm));
}

/** Live incoming beam direction at the resolved position (for aperture
 *  check). All ids are SceneObject ids. */
export function resolveIncomingDirection(
  meta: {
    fromObjectId: string;
    fromPort: string;
    offsetMm: number;
    bridgedViaObjectId?: string;
    bridgedOpen?: boolean;
    bridgedDirection?: Vec3;
  },
  scene: SceneData,
): Vec3 | null {
  if (meta.offsetMm >= 0) {
    // Closed bridge: direction follows from upstream to bridged endpoint.
    if (meta.bridgedViaObjectId) {
      const fromObj = scene.objects.find((o) => o.id === meta.fromObjectId);
      const toObj = scene.objects.find((o) => o.id === meta.bridgedViaObjectId);
      if (!fromObj || !toObj) return null;
      return v3norm(v3sub(objectPosLab(toObj), objectPosLab(fromObj)));
    }
    // Open bridge: direction is frozen at segment-pick time.
    if (meta.bridgedOpen && meta.bridgedDirection) {
      return v3norm(meta.bridgedDirection);
    }
    const link = scene.opticalLinks.find(
      (l) => l.fromObjectId === meta.fromObjectId && l.fromPort === meta.fromPort,
    );
    if (link) {
      const fromObj = scene.objects.find((o) => o.id === meta.fromObjectId);
      const toObj = scene.objects.find((o) => o.id === link.toObjectId);
      if (!fromObj || !toObj) return null;
      return v3norm(v3sub(objectPosLab(toObj), objectPosLab(fromObj)));
    }
    return computeOutgoingDirection(meta.fromObjectId, meta.fromPort, scene);
  }
  // Negative offset case: walk back to find which parent segment we landed on.
  let cur = meta.fromObjectId;
  let remaining = -meta.offsetMm;
  while (remaining > 0) {
    const parentLink = scene.opticalLinks.find((l) => l.toObjectId === cur);
    if (!parentLink) return null;
    const parentObj = scene.objects.find((o) => o.id === parentLink.fromObjectId);
    const curObj = scene.objects.find((o) => o.id === cur);
    if (!parentObj || !curObj) return null;
    const parentPos = objectPosLab(parentObj);
    const curPos = objectPosLab(curObj);
    const segLen = v3len(v3sub(curPos, parentPos));
    if (remaining <= segLen) {
      return v3norm(v3sub(curPos, parentPos));
    }
    remaining -= segLen;
    cur = parentLink.fromObjectId;
  }
  return null;
}

// =============================================================================
// Optical-link physical validation
// =============================================================================
//
// Each optical_link describes a chain edge "the beam emerging from
// from-object's output port reaches to-object's input port". Whether that
// edge is *physically realizable* depends on geometry — the user can rotate
// a mirror so its reflected ray no longer aims at the supposed downstream
// object, or move a target so the beam misses its clear aperture entirely.
//
// The validator walks each link, computes the actual beam axis emerging
// from the source side, and measures the closest approach to the target's
// intercept geometry. Status is one of:
//
//   - "ok"       → axis hits within aperture
//   - "clipping" → axis hits within 2× aperture (beam clipped, partial)
//   - "broken"   → axis misses outside 2× aperture (no beam reaches target)
//
// The result is purely diagnostic — it doesn't modify any data. UI uses
// it to render warnings, filter beam-placement segments, and offer a
// "Disconnect" affordance.

export type LinkValidationStatus = "ok" | "clipping" | "broken";

export type LinkValidation = {
  status: LinkValidationStatus;
  reason: string;
  /** Perpendicular distance from beam axis to target's intercept point (mm). */
  missDistanceMm: number;
  /** Aperture used as the threshold (mm). */
  apertureMm: number;
};

/** Default aperture when an asset has no anchor-declared aperture and we
 *  can't infer one from bbox. 12.5 mm = 1" optic radius, a reasonable lab
 *  default. */
const DEFAULT_APERTURE_MM = 12.5;

/** Find the lab-frame intercept point for the to-side of a link, plus the
 *  aperture radius to compare against. Order of preference:
 *   1. Asset anchor whose id matches `toPort` exactly.
 *   2. Asset anchor with a known intercept-style id ("in", "intercept_in",
 *      "intercept_face", "seed").
 *   3. Body center + DEFAULT_APERTURE_MM. */
function findInterceptPoint(
  toObjectId: string,
  toPort: string,
  scene: SceneData,
): { posLab: Vec3; apertureMm: number; source: "anchor" | "body" } {
  const obj = scene.objects.find((o) => o.id === toObjectId);
  const fallback = obj
    ? { posLab: objectPosLab(obj), apertureMm: DEFAULT_APERTURE_MM, source: "body" as const }
    : { posLab: { x: 0, y: 0, z: 0 }, apertureMm: DEFAULT_APERTURE_MM, source: "body" as const };
  if (!obj) return fallback;

  const component: ComponentItem | undefined = scene.components.find(
    (c) => c.id === obj.componentId,
  );
  const asset: Asset3D | undefined = component?.asset3dId
    ? scene.assets.find((a) => a.id === component.asset3dId)
    : undefined;
  if (!asset?.anchors?.length) return fallback;

  const candidates = [toPort, "in", "intercept_in", "intercept_face", "seed"];
  for (const wantedId of candidates) {
    const anchor = asset.anchors.find((a) => a.id === wantedId);
    if (anchor?.positionMmBodyLocal) {
      const localOffset = rotateLocalToLab(
        {
          x: anchor.positionMmBodyLocal.x,
          y: anchor.positionMmBodyLocal.y,
          z: anchor.positionMmBodyLocal.z,
        },
        obj.rxDeg,
        obj.ryDeg,
        obj.rzDeg,
      );
      const apertureRaw = (anchor as unknown as { apertureMm?: number }).apertureMm;
      const aperture =
        typeof apertureRaw === "number" && apertureRaw > 0 ? apertureRaw : DEFAULT_APERTURE_MM;
      return {
        posLab: {
          x: obj.xMm + localOffset.x,
          y: obj.yMm + localOffset.y,
          z: obj.zMm + localOffset.z,
        },
        apertureMm: aperture,
        source: "anchor",
      };
    }
  }
  return fallback;
}

/** Compute the beam axis (origin + unit direction in lab frame) emerging
 *  from a given object's output port. Returns null when the direction is
 *  undefined (e.g. mid-chain mirror with no incoming beam). */
export function beamAxisFromObjectPort(
  objectId: string,
  fromPort: string,
  scene: SceneData,
): { origin: Vec3; direction: Vec3 } | null {
  const obj = scene.objects.find((o) => o.id === objectId);
  if (!obj) return null;
  const direction = computeOutgoingDirection(objectId, fromPort, scene);
  if (!direction) return null;
  const origin = beamStartPosLab(obj, scene);
  return { origin, direction };
}

/** Compute (t along axis, perpendicular miss) for one candidate intercept
 *  point. t < 0 means the candidate is behind the axis origin. */
function projectInterceptOntoAxis(
  axis: { origin: Vec3; direction: Vec3 },
  interceptLab: Vec3,
): { t: number; miss: number } {
  const toIntercept = v3sub(interceptLab, axis.origin);
  const t = v3dot(toIntercept, axis.direction);
  const closest: Vec3 = {
    x: axis.origin.x + axis.direction.x * t,
    y: axis.origin.y + axis.direction.y * t,
    z: axis.origin.z + axis.direction.z * t,
  };
  const miss = v3len(v3sub(interceptLab, closest));
  return { t, miss };
}

export function validateOpticalLink(link: OpticalLink, scene: SceneData): LinkValidation {
  const fromObj = scene.objects.find((o) => o.id === link.fromObjectId);
  const toObj = scene.objects.find((o) => o.id === link.toObjectId);
  if (!fromObj || !toObj) {
    return {
      status: "broken",
      reason: "Endpoint object missing from scene",
      missDistanceMm: Number.POSITIVE_INFINITY,
      apertureMm: DEFAULT_APERTURE_MM,
    };
  }
  const fromEl = scene.opticalElements.find((e) => e.objectId === link.fromObjectId);
  const toEl = scene.opticalElements.find((e) => e.objectId === link.toObjectId);
  if (!fromEl || !toEl) {
    return {
      status: "broken",
      reason: "Endpoint has no OpticalElement registered",
      missDistanceMm: Number.POSITIVE_INFINITY,
      apertureMm: DEFAULT_APERTURE_MM,
    };
  }

  const axis = beamAxisFromObjectPort(link.fromObjectId, link.fromPort, scene);
  if (!axis) {
    return {
      status: "broken",
      reason:
        "Outgoing beam direction undefined — upstream chain is broken or the source has no incoming beam to reflect",
      missDistanceMm: Number.POSITIVE_INFINITY,
      apertureMm: DEFAULT_APERTURE_MM,
    };
  }

  // Find FIRST element along the axis (smallest positive t with miss ≤
  // aperture). This catches the user's "Mirror2 in front of Mirror1"
  // scenario — Mirror2's body intercepts the beam before it reaches Mirror1,
  // so the laser→Mirror1 link is physically broken even though the
  // closest-approach to Mirror1 alone would be on-axis.
  type Hit = { objId: string; t: number; miss: number; apertureMm: number };
  const hits: Hit[] = [];
  // Floating-point tolerance: only ignores intercepts that are essentially
  // ON the emission origin (rare — would require an element placed inside
  // the emitter). Set very small so a Mirror placed millimetres from the
  // laser still counts as a real hit ahead of any nominal target further out.
  const T_EPS = 0.01; // mm
  for (const otherEl of scene.opticalElements) {
    if (otherEl.objectId === link.fromObjectId) continue;
    const otherObj = scene.objects.find((o) => o.id === otherEl.objectId);
    if (!otherObj) continue;
    // Pick the input port for the comparison (use first input, or a sensible
    // default). For the actual to-object we use link.toPort precisely.
    const portToCheck =
      otherEl.objectId === link.toObjectId
        ? link.toPort
        : otherEl.inputPorts?.[0]?.portId ?? "in";
    const intercept = findInterceptPoint(otherEl.objectId, portToCheck, scene);
    const { t, miss } = projectInterceptOntoAxis(axis, intercept.posLab);
    if (t < T_EPS) continue;                     // behind us
    if (miss > intercept.apertureMm) continue;   // misses entirely
    hits.push({ objId: otherEl.objectId, t, miss, apertureMm: intercept.apertureMm });
  }
  hits.sort((a, b) => a.t - b.t);

  const targetIntercept = findInterceptPoint(link.toObjectId, link.toPort, scene);
  const targetProj = projectInterceptOntoAxis(axis, targetIntercept.posLab);

  // No element intercepts within aperture → beam shoots to infinity.
  if (hits.length === 0) {
    if (targetProj.miss <= 2 * targetIntercept.apertureMm) {
      // Target is off-axis but within clipping range — call it clipping.
      return {
        status: "clipping",
        reason: `Beam clips target — off-axis by ${targetProj.miss.toFixed(1)} mm (aperture ${targetIntercept.apertureMm.toFixed(1)} mm)`,
        missDistanceMm: targetProj.miss,
        apertureMm: targetIntercept.apertureMm,
      };
    }
    return {
      status: "broken",
      reason: `Beam misses target by ${targetProj.miss.toFixed(1)} mm (aperture ${targetIntercept.apertureMm.toFixed(1)} mm)`,
      missDistanceMm: targetProj.miss,
      apertureMm: targetIntercept.apertureMm,
    };
  }

  // First hit must BE the target. Otherwise some other element blocked the
  // beam first.
  const first = hits[0];
  if (first.objId !== link.toObjectId) {
    const blockerObj = scene.objects.find((o) => o.id === first.objId);
    return {
      status: "broken",
      reason: `Beam blocked by ${blockerObj?.name ?? first.objId.slice(0, 6)} at ${first.t.toFixed(0)} mm before reaching target`,
      missDistanceMm: targetProj.miss,
      apertureMm: targetIntercept.apertureMm,
    };
  }

  // First hit is the target → on-axis or clipping based on miss distance.
  if (first.miss <= first.apertureMm) {
    return {
      status: "ok",
      reason: `On axis (miss ${first.miss.toFixed(2)} mm of ${first.apertureMm.toFixed(1)} mm aperture, intercept at ${first.t.toFixed(0)} mm)`,
      missDistanceMm: first.miss,
      apertureMm: first.apertureMm,
    };
  }
  // Should not reach here because the hits filter excludes off-aperture
  // candidates. Defensive fallback: clipping.
  return {
    status: "clipping",
    reason: `Beam clips target — off-axis by ${first.miss.toFixed(1)} mm (aperture ${first.apertureMm.toFixed(1)} mm)`,
    missDistanceMm: first.miss,
    apertureMm: first.apertureMm,
  };
}

export function validateAllOpticalLinks(scene: SceneData): Map<string, LinkValidation> {
  const out = new Map<string, LinkValidation>();
  for (const link of scene.opticalLinks ?? []) {
    out.set(link.id, validateOpticalLink(link, scene));
  }
  return out;
}

// =============================================================================
// Snap-to-axis: when a link is freshly created, translate the to-object
// so its intercept point lies exactly on the from-object's beam axis.
// =============================================================================

/** Compute the lab-frame translation needed for `toObjectId` so its
 *  intercept point lands on the beam axis emerging from `fromObjectId.fromPort`.
 *  Distance along the axis is preserved (closest-approach projection of the
 *  current intercept onto the axis), so the user's chosen "longitudinal
 *  position" doesn't shift — only the transverse miss is killed.
 *
 *  Returns the new (xMm, yMm, zMm) for the to-object's body, or null when
 *  the geometry can't be resolved (broken upstream chain, missing object). */
// =============================================================================
// Suggested links: pair-wise scan of "potential link" candidates
// =============================================================================
//
// Returns pairs (from-OE, to-OE, port pair) where:
//  1. No optical_link of the same port pair already exists
//  2. The beam axis from `from`-port physically passes through `to`'s
//     intercept geometry (within aperture for circle/square, within 25 mm
//     for line / fallback shapes)
//  3. `to` is the FIRST hit along that axis — closer-on-axis to-objects
//     win so the user isn't told "laser → Mirror1" when Mirror2 is in the
//     way.

const SUGGEST_INTERCEPT_TOLERANCE_MM = 25;

export type SuggestedLink = {
  fromObjectId: string;
  fromPort: string;
  toObjectId: string;
  toPort: string;
  /** Distance along the beam axis from fromObject's emission origin to to's intercept (mm). */
  distanceMm: number;
  /** Perpendicular miss distance from beam axis to to's intercept (mm). */
  missMm: number;
  /** Aperture used for the comparison (mm). */
  apertureMm: number;
};

export function enumerateSuggestedLinks(scene: SceneData): SuggestedLink[] {
  const suggestions: SuggestedLink[] = [];
  const existingLinks = new Set(
    (scene.opticalLinks ?? []).map(
      (l) => `${l.fromObjectId}|${l.fromPort}|${l.toObjectId}|${l.toPort}`,
    ),
  );

  for (const fromEl of scene.opticalElements) {
    // Iterate over each output port of fromEl.
    const outputPorts = (fromEl.outputPorts ?? []).map((p) => p.portId);
    if (outputPorts.length === 0) {
      // Emitters without explicit output ports default to "out".
      if (fromEl.elementKind === "laser_source" || fromEl.elementKind === "tapered_amplifier") {
        outputPorts.push("out");
      } else {
        continue;
      }
    }

    for (const fromPort of outputPorts) {
      const axis = beamAxisFromObjectPort(fromEl.objectId, fromPort, scene);
      if (!axis) continue;

      // Find first hit among all candidate to-objects along this axis.
      type Hit = {
        toEl: OpticalElement;
        toPort: string;
        t: number;
        miss: number;
        apertureMm: number;
      };
      const hits: Hit[] = [];

      for (const toEl of scene.opticalElements) {
        if (toEl.objectId === fromEl.objectId) continue;
        // Skip emitters as targets (they don't catch beams).
        if (toEl.elementKind === "laser_source") continue;

        const inputPorts = (toEl.inputPorts ?? []).map((p) => p.portId);
        const candidatePorts = inputPorts.length > 0 ? inputPorts : ["in"];

        for (const toPort of candidatePorts) {
          const intercept = findInterceptPoint(toEl.objectId, toPort, scene);
          const { t, miss } = projectInterceptOntoAxis(axis, intercept.posLab);
          if (t < 0.01) continue;
          // Soft tolerance: pass either if within aperture (1-1) or within
          // 25 mm of intercept point (1-2 — covers AOM line / unspecified).
          const tol = Math.max(intercept.apertureMm, SUGGEST_INTERCEPT_TOLERANCE_MM);
          if (miss > tol) continue;
          hits.push({ toEl, toPort, t, miss, apertureMm: intercept.apertureMm });
        }
      }
      hits.sort((a, b) => a.t - b.t);

      // Only the FIRST hit becomes a suggestion (closer object catches the beam).
      const first = hits[0];
      if (!first) continue;

      const linkKey = `${fromEl.objectId}|${fromPort}|${first.toEl.objectId}|${first.toPort}`;
      if (existingLinks.has(linkKey)) continue;

      suggestions.push({
        fromObjectId: fromEl.objectId,
        fromPort,
        toObjectId: first.toEl.objectId,
        toPort: first.toPort,
        distanceMm: first.t,
        missMm: first.miss,
        apertureMm: first.apertureMm,
      });
    }
  }

  return suggestions;
}

export function computeSnapPositionForLink(
  fromObjectId: string,
  fromPort: string,
  toObjectId: string,
  toPort: string,
  scene: SceneData,
): { xMm: number; yMm: number; zMm: number } | null {
  const toObj = scene.objects.find((o) => o.id === toObjectId);
  if (!toObj) return null;

  const axis = beamAxisFromObjectPort(fromObjectId, fromPort, scene);
  if (!axis) return null;

  const intercept = findInterceptPoint(toObjectId, toPort, scene);

  // Project current intercept onto axis to find longitudinal distance t.
  const toIntercept = v3sub(intercept.posLab, axis.origin);
  let t = v3dot(toIntercept, axis.direction);
  // Don't snap behind the source — clamp to a small positive distance.
  if (!Number.isFinite(t) || t <= 0) {
    // Fall back to the physical distance from emission origin to current
    // body so the snap doesn't collapse the object onto the source.
    const bodyDelta = v3sub(objectPosLab(toObj), axis.origin);
    t = Math.max(10, v3dot(bodyDelta, axis.direction));
  }

  const desiredInterceptPos: Vec3 = {
    x: axis.origin.x + axis.direction.x * t,
    y: axis.origin.y + axis.direction.y * t,
    z: axis.origin.z + axis.direction.z * t,
  };
  // delta = where intercept WANTS to be − where it currently sits in lab.
  // Apply the same delta to the body position to translate the whole object.
  const delta = v3sub(desiredInterceptPos, intercept.posLab);
  return {
    xMm: toObj.xMm + delta.x,
    yMm: toObj.yMm + delta.y,
    zMm: toObj.zMm + delta.z,
  };
}

// =============================================================================
// "Snap to beam" — manual per-object alignment helper
// =============================================================================
//
// Replaces the old Beam-Placement panel + Suggested-links flow with a
// single button per optical object: find the nearest beam axis (within
// 25 mm of any of this object's intercept anchors), translate the object
// so the matched intercept point sits exactly on that axis. No chain
// ordering, no link manipulation — just geometry.

const SNAP_TOLERANCE_MM = 25;

export type SnapCandidate = {
  /** Source emitter / mirror that radiates this beam. */
  fromObjectId: string;
  fromPort: string;
  /** Target's anchor that will be aligned (id from asset.anchors). */
  anchorId: string;
  /** Aperture of the matched anchor (or default). */
  apertureMm: number;
  /** Distance along the beam axis to the projected intercept (mm). */
  distanceMm: number;
  /** Perpendicular miss before snap (mm). 0 after snap. */
  missMm: number;
  /** New (xMm, yMm, zMm) for this object's body so the anchor lands on axis. */
  newBodyPos: Vec3;
  /** Unit direction of the matched beam axis. Carried so consumers (e.g.
   *  MirrorAdjustControls' u/v basis) don't need to re-derive it via
   *  optical_links — the geometric chain walker already knew the direction
   *  even on reflected segments where no link row exists. */
  axisDirection: Vec3;
};

/** Read the renderer's published ray-trace segments off `window.__rayTraceDebug`
 *  and convert each one into a beam axis (origin, direction) in scene-mm.
 *  These are the EXACT segments the user sees rendered, so consuming them
 *  here makes snap-to-beam agree with the eye even when reflection
 *  conventions disagree between the data-only walker and the actual asset
 *  mesh face normals (the discrepancy that caused Mirror2 to report "no
 *  beam axis within 25 mm" while the beam visibly passed through it).
 *
 *  Three.js ↔ scene-mm mapping (from transformUtils.applyObjectTransform):
 *    three.X = scene.X / 100
 *    three.Y = scene.Z / 100
 *    three.Z = -scene.Y / 100
 *  Reverse it: scene = (three.X * 100, -three.Z * 100, three.Y * 100). */
function enumerateBeamAxesFromTraces(
  excludeObjectId: string,
): Array<{ fromObjectId: string; fromPort: string; origin: Vec3; direction: Vec3 }> | null {
  const win = (typeof window !== "undefined" ? window : null) as
    | (Window & { __rayTraceDebug?: Array<Record<string, unknown>> })
    | null;
  const traces = win?.__rayTraceDebug;
  if (!Array.isArray(traces) || traces.length === 0) return null;
  const axes: Array<{ fromObjectId: string; fromPort: string; origin: Vec3; direction: Vec3 }> = [];
  for (const seg of traces) {
    const sourceObjectId = typeof seg.sourceObjectId === "string" ? seg.sourceObjectId : "";
    if (!sourceObjectId || sourceObjectId === excludeObjectId) continue;
    const start = seg.startThree as { x: number; y: number; z: number } | undefined;
    const end = seg.endThree as { x: number; y: number; z: number } | undefined;
    if (!start || !end) continue;
    const origin: Vec3 = threeToLabPointMm(start);
    const endMm: Vec3 = threeToLabPointMm(end);
    const dx = endMm.x - origin.x;
    const dy = endMm.y - origin.y;
    const dz = endMm.z - origin.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) continue;
    axes.push({
      fromObjectId: sourceObjectId,
      fromPort: "out",
      origin,
      direction: { x: dx / len, y: dy / len, z: dz / len },
    });
  }
  return axes;
}

/** Fallback geometric walker — used when the renderer hasn't published
 *  trace segments yet (e.g. SSR or before first frame). Walks the chain
 *  using kindParams.normalLocal which can disagree with the actual mesh
 *  face normal for some assets, so this path is best-effort. */
export function enumerateBeamAxesFromEmitters(
  scene: SceneData,
  excludeObjectId: string,
  maxBounces = 6,
): Array<{ fromObjectId: string; fromPort: string; origin: Vec3; direction: Vec3 }> {
  const axes: Array<{ fromObjectId: string; fromPort: string; origin: Vec3; direction: Vec3 }> = [];

  const passThrough = new Set<string>([
    "lens_spherical", "lens_cylindrical", "waveplate", "polarizer", "isolator",
    "aom", "eom", "fiber_coupler", "saturable_absorber", "nonlinear_crystal",
  ]);
  const absorbing = new Set<string>([
    "detector", "camera", "spectrometer", "wavemeter", "beam_dump",
  ]);

  function reflectMirror(_elem: OpticalElement, obj: SceneObject, incident: Vec3): Vec3 {
    // V2 Phase 2 (alembic 0028): the surface normal lives on the
    // SceneObject's V2 anchorBindings; mirrorNormalLocal does the
    // binding → asset_anchor → null precedence so this stays in sync
    // with every other mirror-normal reader.
    const nLocal = mirrorNormalLocal(obj, scene) ?? { x: 0, y: 0, z: 1 };
    const nLab = v3norm(rotateLocalToLab(nLocal, obj.rxDeg, obj.ryDeg, obj.rzDeg));
    return v3norm(reflect(incident, nLab));
  }

  function walk(
    fromObjectId: string,
    fromPort: string,
    origin: Vec3,
    direction: Vec3,
    bounces: number,
  ) {
    axes.push({ fromObjectId, fromPort, origin, direction });
    if (bounces >= maxBounces) return;

    // Find first hit along (origin, direction) among all OE except source.
    type Hit = { obj: SceneObject; el: OpticalElement; t: number; miss: number; aperture: number };
    let best: Hit | null = null;
    for (const otherEl of scene.opticalElements) {
      if (otherEl.objectId === fromObjectId) continue;
      const otherObj = scene.objects.find((o) => o.id === otherEl.objectId);
      if (!otherObj) continue;
      const port = otherEl.inputPorts?.[0]?.portId ?? "in";
      const intercept = findInterceptPoint(otherEl.objectId, port, scene);
      const toIntercept = v3sub(intercept.posLab, origin);
      const t = v3dot(toIntercept, direction);
      if (t < 0.01) continue;
      const closest: Vec3 = {
        x: origin.x + direction.x * t,
        y: origin.y + direction.y * t,
        z: origin.z + direction.z * t,
      };
      const miss = v3len(v3sub(intercept.posLab, closest));
      if (miss > intercept.apertureMm) continue;
      if (!best || t < best.t) {
        best = { obj: otherObj, el: otherEl, t, miss, aperture: intercept.apertureMm };
      }
    }
    if (!best) return;

    const hitKind = best.el.elementKind;
    if (absorbing.has(hitKind)) return;

    // Compute next axis from hit point.
    const hitPoint: Vec3 = {
      x: origin.x + direction.x * best.t,
      y: origin.y + direction.y * best.t,
      z: origin.z + direction.z * best.t,
    };
    let nextDir = direction;
    if (hitKind === "mirror" || hitKind === "dichroic_mirror") {
      nextDir = reflectMirror(best.el, best.obj, direction);
    } else if (passThrough.has(hitKind)) {
      // direction unchanged
    } else if (hitKind === "beam_splitter") {
      // Treat transmitted as the through-path; reflected branch could be
      // walked too if needed. Skip the second branch for snap purposes —
      // pass-through is the dominant axis.
    } else {
      return; // unknown / emitter → stop
    }
    // Use the hit object's first output port id as the source-port label
    // for the next axis (best-effort labelling).
    const nextPort = best.el.outputPorts?.[0]?.portId ?? "out";
    walk(best.obj.id, nextPort, hitPoint, nextDir, bounces + 1);
  }

  for (const emitterEl of scene.opticalElements) {
    // ONLY laser_source seeds snap-to-beam axes. Tapered amplifiers are
    // technically emitters, but in practice the TA's forward output is a
    // short downstream link and you align downstream optics relative to
    // the upstream MASTER LASER's beam, not the TA's emission. Including
    // TA here pulled passive optics onto the TA's +X axis even when the
    // user was aligning to a different beam — confusing UX. Backward TA
    // emission is similarly excluded.
    if (emitterEl.elementKind !== "laser_source") {
      continue;
    }
    if (emitterEl.objectId === excludeObjectId) continue;
    const emitterObj = scene.objects.find((o) => o.id === emitterEl.objectId);
    if (!emitterObj) continue;
    const ports = emitterEl.outputPorts?.map((p) => p.portId) ?? ["out"];
    for (const port of ports) {
      const dir = computeOutgoingDirection(emitterEl.objectId, port, scene);
      if (!dir) continue;
      const origin = beamStartPosLab(emitterObj, scene);
      walk(emitterEl.objectId, port, origin, dir, 0);
    }
  }
  return axes;
}

/** Find the closest beam axis whose perpendicular distance to ANY of the
 *  object's intercept anchors is ≤ 25 mm, and return the snap that would
 *  align that anchor to the axis. Returns null when nothing is in range
 *  or the object has no OpticalElement / no usable anchor.
 *
 *  Beam axes considered:
 *   - Every segment of the geometrically-walked chain from each emitter,
 *     including post-reflection axes from mirrors. Doesn't require
 *     optical_links to exist — matches what the ray-tracer renders. */
export function findSnapToBeam(
  objectId: string,
  scene: SceneData,
): SnapCandidate | null {
  const obj = scene.objects.find((o) => o.id === objectId);
  if (!obj) return null;
  const el = scene.opticalElements.find((e) => e.objectId === objectId);
  if (!el) return null;

  // Prefer the renderer's published trace segments (window.__rayTraceDebug)
  // — those are exactly what the user sees on screen, so the snap will
  // agree with the eye. Fall back to a data-only geometric walker when no
  // traces have been published yet. The fallback can disagree on mirror
  // reflection direction for assets whose mesh face normal differs from
  // kindParams.normalLocal, so the trace-based path is preferred.
  const axes = enumerateBeamAxesFromTraces(objectId)
    ?? enumerateBeamAxesFromEmitters(scene, objectId);
  if (axes.length === 0) return null;

  // Collect THIS object's intercept anchors (asset-declared). If the asset
  // has none, fall back to body center with default aperture.
  const component = scene.components.find((c) => c.id === obj.componentId);
  const asset = component?.asset3dId
    ? scene.assets.find((a) => a.id === component.asset3dId)
    : undefined;
  type AnchorPoint = { id: string; localPos: Vec3; apertureMm: number };
  const anchorPoints: AnchorPoint[] = [];
  for (const a of asset?.anchors ?? []) {
    const id = a.id ?? "";
    if (id !== "intercept_face" && id !== "intercept_in" && id !== "intercept_out" && id !== "in" && id !== "seed") {
      continue;
    }
    if (!a.positionMmBodyLocal) continue;
    const apertureRaw = (a as unknown as { apertureMm?: number }).apertureMm;
    anchorPoints.push({
      id,
      localPos: { x: a.positionMmBodyLocal.x, y: a.positionMmBodyLocal.y, z: a.positionMmBodyLocal.z },
      apertureMm: typeof apertureRaw === "number" && apertureRaw > 0 ? apertureRaw : 12.5,
    });
  }
  if (anchorPoints.length === 0) {
    anchorPoints.push({ id: "body", localPos: { x: 0, y: 0, z: 0 }, apertureMm: 12.5 });
  }

  // Brute-force best-match: every (anchor × axis) pair, pick smallest miss
  // within tolerance and positive t.
  let best: SnapCandidate | null = null;
  for (const anchor of anchorPoints) {
    const offsetLab = rotateLocalToLab(anchor.localPos, obj.rxDeg, obj.ryDeg, obj.rzDeg);
    const anchorLab: Vec3 = {
      x: obj.xMm + offsetLab.x,
      y: obj.yMm + offsetLab.y,
      z: obj.zMm + offsetLab.z,
    };
    for (const axis of axes) {
      const toAnchor = v3sub(anchorLab, axis.origin);
      const t = v3dot(toAnchor, axis.direction);
      if (t <= 0) continue;
      const closest: Vec3 = {
        x: axis.origin.x + axis.direction.x * t,
        y: axis.origin.y + axis.direction.y * t,
        z: axis.origin.z + axis.direction.z * t,
      };
      const miss = v3len(v3sub(anchorLab, closest));
      if (miss > SNAP_TOLERANCE_MM) continue;
      // Translate body so anchor lands on the axis: delta = closest - anchorLab
      const newBodyPos: Vec3 = {
        x: obj.xMm + (closest.x - anchorLab.x),
        y: obj.yMm + (closest.y - anchorLab.y),
        z: obj.zMm + (closest.z - anchorLab.z),
      };
      if (!best || miss < best.missMm) {
        best = {
          fromObjectId: axis.fromObjectId,
          fromPort: axis.fromPort,
          anchorId: anchor.id,
          apertureMm: anchor.apertureMm,
          distanceMm: t,
          missMm: miss,
          newBodyPos,
          axisDirection: axis.direction,
        };
      }
    }
  }
  return best;
}

/** Build an orthonormal basis (u, v) perpendicular to `direction`.
 *  Used by P5/P6 to project transverse displacement / center offset.
 *  Conventions:
 *    - u = direction × world_up (or world_x if direction nearly parallel to up)
 *    - v = direction × u
 *  Both u and v are unit vectors and orthogonal to direction. */
export function perpendicularBasis(direction: Vec3): { u: Vec3; v: Vec3 } {
  const dirLen = v3len(direction);
  if (dirLen < 1e-9) return { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } };
  const dir = v3scale(direction, 1 / dirLen);
  const upWorld: Vec3 =
    Math.abs(dir.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = v3norm(v3cross(dir, upWorld));
  const v = v3norm(v3cross(dir, u));
  return { u, v };
}

// =============================================================================
// Beam tracing — walk one laser's downstream graph (rooted at an emitter)
// =============================================================================
//
// Used by the new BeamPlacementPanel which is **per-beam**: pick a laser,
// see the chain of objects sourced by it, restrict placement to those
// members. Branching elements (PBS / BS / dichroic) emit multiple legs;
// each becomes its own depth-first chain. Cycles are guarded.

export type BeamMember = {
  /** SceneObject id. */
  objectId: string;
  /** Hop index from the emitter (0 = the emitter itself). */
  depth: number;
  /** OpticalLink that brought the beam INTO this object (null for the
   *  emitter root). */
  incomingLinkId: string | null;
  /** Display branch tag for downstream UI: "main", or the from-port string
   *  on the parent branching element (e.g. "trans" / "refl"). */
  branchTag: string;
};

/** BFS the optical-link graph starting at the given laser's SceneObject id.
 *  Optionally filters out edges whose link validation status is "broken"
 *  (so a physically blocked chain doesn't list ghost members). Returns the
 *  members in visit order; every member is reached at most once. */
export function traceBeamFromEmitter(
  emitterObjectId: string,
  scene: SceneData,
  validations?: Map<string, LinkValidation>,
): BeamMember[] {
  const out: BeamMember[] = [];
  const seen = new Set<string>();
  const stack: BeamMember[] = [
    { objectId: emitterObjectId, depth: 0, incomingLinkId: null, branchTag: "main" },
  ];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) break;
    if (seen.has(cur.objectId)) continue;
    seen.add(cur.objectId);
    out.push(cur);
    // Push children (outgoing links from this object). Filter broken edges
    // when validations are supplied — broken means "no beam reaches the
    // downstream object", so it shouldn't count as a chain member.
    const outgoing = (scene.opticalLinks ?? []).filter((l) => l.fromObjectId === cur.objectId);
    // Reverse so DFS visits in declared order (stack is LIFO).
    for (let i = outgoing.length - 1; i >= 0; i -= 1) {
      const link = outgoing[i];
      if (validations) {
        const v = validations.get(link.id);
        if (v && v.status === "broken") continue;
      }
      stack.push({
        objectId: link.toObjectId,
        depth: cur.depth + 1,
        incomingLinkId: link.id,
        branchTag: outgoing.length > 1 ? link.fromPort : cur.branchTag,
      });
    }
  }
  return out;
}

/** List every emitter (laser_source / tapered_amplifier) in the scene that
 *  has at least one outgoing link. Used to populate the Beam selector. */
export function listBeamEmitters(scene: SceneData): SceneObject[] {
  const emitters = scene.opticalElements
    .filter(
      (e) => e.elementKind === "laser_source" || e.elementKind === "tapered_amplifier",
    )
    .map((e) => scene.objects.find((o) => o.id === e.objectId))
    .filter((o): o is SceneObject => Boolean(o));
  // Only emitters that actually source a chain — a free-floating laser
  // without an outgoing link doesn't define a "beam" worth picking yet.
  return emitters.filter((o) => scene.opticalLinks.some((l) => l.fromObjectId === o.id));
}

/** Enumerate the SLOT(s) where a given target sits within its current chain.
 *  Unlike enumerateBeamSegments (which returns every segment in the scene
 *  + virtual bridges), this returns ONLY the segment(s) that physically
 *  describe target's actual placement context:
 *
 *   - target has both incoming + outgoing link → one closed bridge per
 *     (in, out) pair (the "between two fixed neighbours" slot)
 *   - target has incoming only → one open bridge per incoming (chain tail
 *     extending past target's old position)
 *   - target has no incoming → no slots (target isn't on a beam yet)
 *
 *  This is the source of truth for "where can target be moved to without
 *  breaking the chain it lives in".
 */
export function enumerateSlotsForTarget(
  scene: SceneData,
  targetId: string,
  validations?: Map<string, LinkValidation>,
): BeamSegmentSummary[] {
  const isLinkValid = (linkId: string): boolean => {
    if (!validations) return true;
    const v = validations.get(linkId);
    return !v || v.status !== "broken";
  };
  const objsById = new Map<string, SceneObject>(scene.objects.map((o) => [o.id, o]));
  const elByObj = new Map<string, OpticalElement>(
    scene.opticalElements.map((e) => [e.objectId, e]),
  );
  const compById = new Map(scene.components.map((c) => [c.id, c]));
  const labelFor = (objId: string): string => {
    const o = objsById.get(objId);
    if (o?.name?.trim()) return o.name.trim();
    if (o) {
      const c = compById.get(o.componentId);
      if (c?.componentName?.trim() || c?.name?.trim()) {
        return c.componentName?.trim() || c.name?.trim() || objId.slice(0, 6);
      }
    }
    return objId.slice(0, 6);
  };

  const inLinks = scene.opticalLinks.filter((l) => l.toObjectId === targetId);
  const outLinks = scene.opticalLinks.filter((l) => l.fromObjectId === targetId);
  const targetObj = objsById.get(targetId);
  if (!targetObj) return [];

  const out: BeamSegmentSummary[] = [];
  const bridgedName = labelFor(targetId);

  if (inLinks.length > 0 && outLinks.length > 0) {
    for (const inLink of inLinks) {
      if (!isLinkValid(inLink.id)) continue;
      for (const outLink of outLinks) {
        if (!isLinkValid(outLink.id)) continue;
        const fromObj = objsById.get(inLink.fromObjectId);
        const toObj = objsById.get(outLink.toObjectId);
        if (!fromObj || !toObj) continue;
        const startLab = beamStartPosLab(fromObj, scene);
        const endLab = objectPosLab(toObj);
        const delta = v3sub(endLab, startLab);
        const lengthMm = v3len(delta);
        const directionUnit = lengthMm > 1e-6 ? v3norm(delta) : { x: 0, y: 0, z: 1 };
        const fromKind = elByObj.get(inLink.fromObjectId)?.elementKind ?? "?";
        const toKind = elByObj.get(outLink.toObjectId)?.elementKind ?? "?";
        const branchTag = outLinks.length > 1 ? ` [${outLink.fromPort}→${outLink.toPort}]` : "";
        out.push({
          key: `${inLink.fromObjectId}|${inLink.fromPort}|slot|${outLink.toObjectId}|${outLink.toPort}`,
          fromObjectId: inLink.fromObjectId,
          fromPort: inLink.fromPort,
          toObjectId: outLink.toObjectId,
          toPort: outLink.toPort,
          startLab,
          endLab,
          directionUnit,
          lengthMm,
          fromKindLabel: fromKind,
          toKindLabel: toKind,
          label: `${labelFor(inLink.fromObjectId)} → ${labelFor(outLink.toObjectId)} (${lengthMm.toFixed(1)} mm, slot for ${bridgedName}${branchTag})`,
          bridgedViaObjectId: outLink.toObjectId,
        });
      }
    }
  } else if (inLinks.length > 0) {
    // Chain tail — open slot extending past target's current position. We
    // freeze the direction at the time of enumeration (vector from upstream
    // emission origin to target's current pos) so the segment doesn't
    // re-orient as the user drags target along it.
    for (const inLink of inLinks) {
      if (!isLinkValid(inLink.id)) continue;
      const fromObj = objsById.get(inLink.fromObjectId);
      if (!fromObj) continue;
      const startLab = beamStartPosLab(fromObj, scene);
      const targetPos = objectPosLab(targetObj);
      const delta = v3sub(targetPos, startLab);
      const dist = v3len(delta);
      // If target is essentially co-located with upstream's emission, fall
      // back to upstream's natural outgoing direction instead of a degenerate
      // zero-length frozen vector.
      let directionUnit: Vec3;
      if (dist > 1e-6) {
        directionUnit = v3norm(delta);
      } else {
        const dir = computeOutgoingDirection(inLink.fromObjectId, inLink.fromPort, scene);
        directionUnit = dir ?? { x: 1, y: 0, z: 0 };
      }
      const fromKind = elByObj.get(inLink.fromObjectId)?.elementKind ?? "?";
      out.push({
        key: `${inLink.fromObjectId}|${inLink.fromPort}|slot-open|${targetId}`,
        fromObjectId: inLink.fromObjectId,
        fromPort: inLink.fromPort,
        toObjectId: null,
        toPort: null,
        startLab,
        endLab: null,
        directionUnit,
        lengthMm: null,
        fromKindLabel: fromKind,
        toKindLabel: null,
        label: `${labelFor(inLink.fromObjectId)} → (open, ∞, slot for ${bridgedName})`,
        bridgedOpen: true,
      });
    }
  }
  // No incoming → target isn't on a beam → no valid slots. Caller filters
  // such targets out of the Object dropdown.
  return out;
}

export const __testHelpers = { v3sub, v3dot, v3cross, v3norm, v3scale, v3add, v3lerp, reflect, OPEN_SEGMENT_DEFAULT_PREVIEW_MM };
