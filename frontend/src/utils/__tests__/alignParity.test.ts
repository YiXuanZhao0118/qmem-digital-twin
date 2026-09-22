/**
 * Golden fixtures pinning the backend's Python align ports to this TypeScript.
 *
 * The align solvers used to exist only here (`mirrorCoupling.ts`,
 * `isolatorAlign.ts`, `aomAlign.ts`, and the `anchorPose.ts` walk they stand
 * on). A second client of the backend (the qmem-blender add-on) needs them
 * too, so they were ported to `backend/app/optical/align/` and served as
 * `POST /api/v3/align/*` — and two copies of one solver drift unless
 * something holds them together. This file is that something:
 *
 *   - it runs the REAL TypeScript over hand-picked cases (the ones the unit
 *     tests pin) plus seeded-random ones, and records inputs + outputs in
 *     `backend/tests/fixtures/align/*.json`;
 *   - `backend/tests/optical/test_align_parity.py` feeds the same inputs to
 *     the Python and asserts equality within 1e-9;
 *   - THIS test fails when the committed fixtures no longer match what the
 *     TypeScript produces, so a TS change cannot land without regenerating
 *     them — which then fails the Python side until it is ported too.
 *
 * Regenerate after an intentional change:
 *
 *     UPDATE_ALIGN_FIXTURES=1 npx vitest run src/utils/__tests__/alignParity.test.ts
 *
 * Everything is deterministic (a seeded PRNG, no clock), so regenerating
 * without a TS change is a no-op.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as THREE from "three";
import { describe, it } from "vitest";

import type {
  Asset3D,
  ComponentBinding,
  ComponentItem,
  ObjectBinding,
  SceneData,
  SceneObject,
} from "../../types/digitalTwin";
import { sceneObjectEulerFromQuaternion, sceneObjectToQuaternion } from "../../optical/frames";
import { braggAngleRad } from "../../optical/kinds/aom/physics";
import { resolveAnchorPosesLab } from "../anchorPose";
import {
  aomBraggReadout,
  braggTiltRad,
  computeAomBraggAlignPose,
  computeAomTiltNudgePose,
  resolveAomBraggFrame,
  type AomBraggFrame,
} from "../aomAlign";
import { primaryAssetForObject, resolveBindingTree } from "../componentBindings";
import {
  collectRoleCentres,
  computeIsolatorAlignPose,
  computePointDirAlignPose,
  computeTranslateOnlyPose,
  pickPolariserCentre,
  type RoleCentre,
  type Vec3,
} from "../isolatorAlign";
import {
  checkMirrorTouch,
  currentTargetMissMm,
  isSolveError,
  mirrorFactsFromObject,
  planMirrorCoupling,
  poseMirrorTo,
  solveCouplingGeometry,
  type MirrorFacts,
  type Ray,
} from "../mirrorCoupling";

const FIXTURE_DIR = fileURLToPath(
  new URL("../../../../backend/tests/fixtures/align/", import.meta.url),
);
const UPDATE = process.env.UPDATE_ALIGN_FIXTURES === "1";

type SceneSlice = Pick<SceneData, "componentBindings" | "objectBindings" | "assets" | "components">;
type Json = unknown;

// ─── deterministic randomness ──────────────────────────────────────────────

/** mulberry32 — small, seedable, identical on every JS engine. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const uni = (lo: number, hi: number): number => lo + (hi - lo) * next();
  const vec = (s: number): Vec3 => ({ x: uni(-s, s), y: uni(-s, s), z: uni(-s, s) });
  const unitVec = (): Vec3 => {
    for (;;) {
      const v = vec(1);
      const m = Math.hypot(v.x, v.y, v.z);
      if (m > 0.1 && m <= 1) return { x: v.x / m, y: v.y / m, z: v.z / m };
    }
  };
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)];
  const angle = (): number => uni(-180, 180);
  return { next, uni, vec, unitVec, pick, angle };
}
type Rng = ReturnType<typeof makeRng>;

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3): Vec3 => v(a.x + b.x, a.y + b.y, a.z + b.z);
const scale = (a: Vec3, k: number): Vec3 => v(a.x * k, a.y * k, a.z * k);
const neg = (a: Vec3): Vec3 => v(-a.x, -a.y, -a.z);

// ─── scene builders (the TS shapes; the Python side reads the same JSON) ────

type Pose = { xMm: number; yMm: number; zMm: number; rxDeg: number; ryDeg: number; rzDeg: number };

function sceneObject(id: string, componentId: string, pose: Partial<Pose>, extra: Partial<SceneObject> = {}): SceneObject {
  return {
    id,
    name: id,
    componentId,
    xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 0, rzDeg: 0,
    visible: true,
    locked: false,
    properties: {},
    dynamicSources: null,
    ...pose,
    ...extra,
  } as unknown as SceneObject;
}

function anchor(
  id: string,
  pos: Vec3,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, positionMmBodyLocal: pos, ...extra };
}

function asset(id: string, kindId: string, anchors: Record<string, unknown>[], defaultParams: Record<string, unknown> = {}): Asset3D {
  return { id, name: id, kindId, filePath: `${id}.glb`, anchors, defaultParams } as unknown as Asset3D;
}

function component(id: string, kindId: string | null, extra: Record<string, unknown> = {}): ComponentItem {
  return { id, name: id, kindId, asset3dId: null, properties: {}, ...extra } as unknown as ComponentItem;
}

function binding(p: {
  id: string;
  componentId: string;
  parent?: string | null;
  kind: "asset" | "subcomponent" | "empty";
  asset?: string | null;
  sub?: string | null;
  role?: string;
  pos?: [number, number, number];
  rot?: [number, number, number];
  properties?: Record<string, unknown>;
  sortOrder?: number;
}): ComponentBinding {
  const [x, y, z] = p.pos ?? [0, 0, 0];
  const [rx, ry, rz] = p.rot ?? [0, 0, 0];
  return {
    id: p.id,
    componentId: p.componentId,
    parentBindingId: p.parent ?? null,
    targetKind: p.kind,
    asset3dId: p.asset ?? null,
    subComponentId: p.sub ?? null,
    role: p.role ?? p.id,
    localXMm: x, localYMm: y, localZMm: z,
    localRxDeg: rx, localRyDeg: ry, localRzDeg: rz,
    tunableAxes: {},
    sortOrder: p.sortOrder ?? 0,
    properties: p.properties ?? {},
  } as unknown as ComponentBinding;
}

function objectBinding(id: string, objectId: string, componentBindingId: string, d: Partial<Record<
  "localXMmDelta" | "localYMmDelta" | "localZMmDelta" | "localRxDegDelta" | "localRyDegDelta" | "localRzDegDelta",
  number | null
>>, asset3dIdOverride: string | null = null): ObjectBinding {
  return {
    id, objectId, componentBindingId,
    localXMmDelta: null, localYMmDelta: null, localZMmDelta: null,
    localRxDegDelta: null, localRyDegDelta: null, localRzDegDelta: null,
    asset3dIdOverride,
    ...d,
  } as unknown as ObjectBinding;
}

// ─── output projections ────────────────────────────────────────────────────

const poseOf = (o: SceneObject): Pose => ({
  xMm: o.xMm, yMm: o.yMm, zMm: o.zMm, rxDeg: o.rxDeg, ryDeg: o.ryDeg, rzDeg: o.rzDeg,
});

function factsJson(f: MirrorFacts): Json {
  return {
    objectId: f.objectId,
    name: f.name,
    sceneObject: poseOf(f.sceneObject),
    centreCad: f.centreCad,
    normalCad: f.normalCad,
    centreLab: f.centreLab,
    normalLab: f.normalLab,
    apertureMm: f.apertureMm,
  };
}

const vecJson = (p: { x: number; y: number; z: number } | null): Json =>
  p ? { x: p.x, y: p.y, z: p.z } : null;

function roleCentresJson(centres: RoleCentre[]): Json {
  return centres.map((c) => ({ role: c.role, isSub: c.isSub, posMm: vecJson(c.posMm) }));
}

/** JSON round-trip: drops `undefined`, turns class instances into plain data. */
const plain = (x: unknown): Json => JSON.parse(JSON.stringify(x));

// ─── anchor poses (the binding-tree walk every solver stands on) ───────────

function buildAnchorPoses(): Json {
  const r = makeRng(0xa11c0);
  const scenes: Json[] = [];

  // Scene 1: a composite with nested asset bindings, an empty mount, a
  // sub-Component spliced in twice (so its anchors dedupe), ObjectBinding
  // deltas, a legacy-direction anchor, a direction-less anchor, a zero
  // aperture, a legacy (binding-less) Component and role-labelled polarisers.
  {
    const assets = [
      asset("asset-housing", "isolator", [
        anchor("intercept_in", v(0, 0, -20), { axisXBodyLocal: v(0, 0, -1), apertureMm: 2.5 }),
        anchor("intercept_out", v(0, 0, 20), { axisXBodyLocal: v(0, 0, 1), apertureMm: 2.5 }),
      ]),
      asset("asset-piece", "mechanical", [
        anchor("mount_point", v(1, 1, 1)),
      ]),
      asset("asset-glan", "beam_splitter", [
        anchor("intercept_in", v(0, 0, -5), { axisXBodyLocal: v(0, 0, -1), apertureMm: 5 }),
        anchor("intercept_out", v(0, 0, 5), { axisXBodyLocal: v(0, 0, 1), apertureMm: 0 }),
        anchor("legacy_dir", v(2, -1, 0.5), { directionBodyLocal: v(0.3, 0.4, 0.5) }),
        anchor("no_dir", v(-2, 1, 0)),
      ]),
      asset("asset-glan-coat", "beam_splitter", [
        anchor("coating", v(0.1, 0.2, 0.3), { name: "C1", axisXBodyLocal: v(1, 0, 0), apertureMm: 4 }),
        anchor("coating", v(0.4, 0.5, 0.6), { name: "C2", axisXBodyLocal: v(0, 1, 0) }),
      ]),
      asset("asset-face", "mirror", [
        anchor("intercept_face", v(0, 0, 0), { axisXBodyLocal: v(0, 0, 1), apertureMm: 12.7 }),
        anchor("intercept_in", v(0, 0, -20), { axisXBodyLocal: v(1, 0, 0) }),
      ]),
      asset("asset-legacy", "lens_biconvex", [
        anchor("intercept_in", v(0, 0, -3), { axisXBodyLocal: v(0, 0, -2) }),
        anchor("intercept_out", v(0, 0, 3), { axisXBodyLocal: v(0, 0, 2) }),
      ]),
    ];
    const components = [
      component("comp-iso", null),
      component("comp-glan", "beam_splitter"),
      component("comp-legacy", "lens_biconvex", { asset3dId: "asset-legacy" }),
    ];
    const componentBindings = [
      binding({ id: "b-body", componentId: "comp-iso", kind: "asset", asset: "asset-housing", role: "body", pos: [1, 2, 3], rot: [5, 10, 15] }),
      binding({ id: "b-front-mount", componentId: "comp-iso", parent: "b-body", kind: "empty", role: "front_mount", pos: [0, 5, 0], rot: [0, 90, 0] }),
      binding({ id: "b-front-glan", componentId: "comp-iso", parent: "b-front-mount", kind: "subcomponent", sub: "comp-glan", role: "fg", properties: { role_label: "front_glan_laser" }, pos: [0, 0, 10], rot: [0, 0, 30] }),
      binding({ id: "b-back", componentId: "comp-iso", parent: "b-body", kind: "subcomponent", sub: "comp-glan", role: "back_pbs", pos: [0, 0, 13], rot: [180, 0, 0], sortOrder: 1 }),
      binding({ id: "b-front-piece", componentId: "comp-iso", parent: "b-body", kind: "asset", asset: "asset-piece", role: "io_3_850_hp_front_piece", sortOrder: 2 }),
      binding({ id: "b-face", componentId: "comp-iso", kind: "asset", asset: "asset-face", role: "face", pos: [-7, 3, 2], rot: [-90, 0, 45], sortOrder: 1 }),
      binding({ id: "g-root", componentId: "comp-glan", kind: "asset", asset: "asset-glan", role: "glan", pos: [0.5, 0, 0], rot: [0, 0, 45] }),
      binding({ id: "g-coat", componentId: "comp-glan", parent: "g-root", kind: "asset", asset: "asset-glan-coat", role: "coat", pos: [0, 1, 0], rot: [38.5, 0, 0] }),
    ];
    const objects = [
      sceneObject("iso-1", "comp-iso", { xMm: -120.5, yMm: 44.25, zMm: 908.8, rxDeg: 12, ryDeg: -30, rzDeg: 45 }),
      sceneObject("iso-2", "comp-iso", { xMm: 3, yMm: -4, zMm: 5, rxDeg: 135, ryDeg: -90, rzDeg: 0 }),
      sceneObject("legacy-1", "comp-legacy", { xMm: 10, yMm: 20, zMm: 30, rxDeg: 0, ryDeg: 90, rzDeg: 0 }),
    ];
    const objectBindings = [
      objectBinding("ob-1", "iso-1", "b-front-mount", { localRxDegDelta: 3, localZMmDelta: -0.25 }),
      objectBinding("ob-2", "iso-1", "b-face", { localXMmDelta: 1.5, localRzDegDelta: null }),
      objectBinding("ob-3", "iso-2", "b-body", { localRyDegDelta: 7 }),
    ];
    scenes.push({ name: "composite", scene: { components, componentBindings, objectBindings, assets }, objects });
  }

  // Scenes 2..4: random trees — random target kinds, depths, rotations,
  // anchors (some without direction), object poses and deltas.
  for (let s = 0; s < 3; s += 1) {
    const assets: Asset3D[] = [];
    const components: ComponentItem[] = [];
    const componentBindings: ComponentBinding[] = [];
    const objectBindings: ObjectBinding[] = [];
    const objects: SceneObject[] = [];
    const nAssets = 5;
    for (let i = 0; i < nAssets; i += 1) {
      const anchors: Record<string, unknown>[] = [];
      const nAnchors = 1 + Math.floor(r.next() * 3);
      for (let k = 0; k < nAnchors; k += 1) {
        const extra: Record<string, unknown> = {};
        const roll = r.next();
        if (roll < 0.7) extra.axisXBodyLocal = r.unitVec();
        else if (roll < 0.85) extra.directionBodyLocal = scale(r.unitVec(), r.uni(0.5, 3));
        if (r.next() < 0.6) extra.apertureMm = r.uni(0.5, 15);
        if (r.next() < 0.3) extra.name = `P${k}`;
        anchors.push(anchor(r.pick(["intercept_in", "intercept_out", "intercept_face", "seed", "rf_in"]), r.vec(40), extra));
      }
      assets.push(asset(`s${s}-a${i}`, "mirror", anchors));
    }
    const nComps = 3;
    for (let c = 0; c < nComps; c += 1) components.push(component(`s${s}-c${c}`, null));
    for (let c = 0; c < nComps; c += 1) {
      const compId = `s${s}-c${c}`;
      const ids: string[] = [];
      const nBind = 2 + Math.floor(r.next() * 4);
      for (let b = 0; b < nBind; b += 1) {
        const id = `${compId}-b${b}`;
        const parent = ids.length > 0 && r.next() < 0.6 ? r.pick(ids) : null;
        const kindRoll = r.next();
        // Only point sub-Components at later ones, so no cycle is authored
        // (both sides guard against cycles anyway).
        const canSub = c < nComps - 1;
        const kind: "asset" | "subcomponent" | "empty" =
          kindRoll < 0.65 ? "asset" : kindRoll < 0.85 && canSub ? "subcomponent" : "empty";
        componentBindings.push(binding({
          id,
          componentId: compId,
          parent,
          kind,
          asset: kind === "asset" ? r.pick(assets).id : null,
          sub: kind === "subcomponent" ? `s${s}-c${c + 1 + Math.floor(r.next() * (nComps - c - 1))}` : null,
          role: r.pick(["front", "back", "front_glan_laser", "back_pbs", "body", "io_front_piece", ""]),
          pos: [r.uni(-30, 30), r.uni(-30, 30), r.uni(-30, 30)],
          rot: [r.angle(), r.uni(-89, 89), r.angle()],
          sortOrder: b,
        }));
        ids.push(id);
      }
    }
    for (let o = 0; o < 4; o += 1) {
      const compId = `s${s}-c${Math.floor(r.next() * nComps)}`;
      const id = `s${s}-o${o}`;
      objects.push(sceneObject(id, compId, {
        xMm: r.uni(-500, 500), yMm: r.uni(-500, 500), zMm: r.uni(0, 1000),
        rxDeg: r.angle(), ryDeg: o === 3 ? r.pick([-90, 90]) : r.uni(-89, 89), rzDeg: r.angle(),
      }));
      for (const b of componentBindings.filter((x) => x.componentId === compId)) {
        if (r.next() < 0.4) {
          objectBindings.push(objectBinding(`${id}-ob-${b.id}`, id, b.id, {
            localXMmDelta: r.next() < 0.5 ? r.uni(-2, 2) : null,
            localRyDegDelta: r.next() < 0.5 ? r.uni(-5, 5) : null,
            localRzDegDelta: r.uni(-5, 5),
          }));
        }
      }
    }
    scenes.push({ name: `random-${s}`, scene: { components, componentBindings, objectBindings, assets }, objects });
  }

  // Scene 5: per-instance asset swaps (ObjectBinding.asset3dIdOverride),
  // honoured the way the tracer's loader honours them: on an asset binding of
  // the object's own Component, and nowhere else — not on an empty binding,
  // not inside a spliced sub-Component, not on a binding-less legacy
  // Component. Also an override onto an asset the scene lacks (-> missing),
  // one on a binding with no asset of its own, and deltas without a swap.
  // Added after the random scenes so their seeded draws are unchanged.
  {
    const assets = [
      asset("ov-lens", "lens_biconvex", [
        anchor("intercept_in", v(0, 0, -3), { axisXBodyLocal: v(0, 0, -1), apertureMm: 6 }),
        anchor("intercept_out", v(0, 0, 3), { axisXBodyLocal: v(0, 0, 1), apertureMm: 6 }),
      ]),
      asset("ov-aom", "aom", [
        anchor("intercept_in", v(0, -11.2, -1.2), { axisXBodyLocal: v(0, -1, 0), apertureMm: 1.5 }),
        anchor("intercept_out", v(0, 11.2, -1.2), { axisXBodyLocal: v(0, 1, 0), apertureMm: 1.5 }),
        anchor("acoustic_axis", v(0, 0, -1.2), { axisXBodyLocal: v(-1, 0, 0) }),
      ]),
      asset("ov-glan", "beam_splitter", [
        anchor("intercept_face", v(0.3, 0.1, 0), { axisXBodyLocal: v(0.6, 0, 0.8), apertureMm: 5 }),
      ]),
      asset("ov-piece", "mechanical", [
        anchor("mount_point", v(2, -1, 4)),
      ]),
    ];
    const components = [
      component("ov-single", "lens_biconvex"),
      component("ov-composite", null),
      component("ov-legacy", "mechanical", { asset3dId: "ov-piece" }),
    ];
    const componentBindings = [
      binding({ id: "ovs-root", componentId: "ov-single", kind: "asset", asset: "ov-lens", role: "lens", pos: [0, 0, 1], rot: [0, 90, 0] }),
      binding({ id: "ovc-body", componentId: "ov-composite", kind: "asset", asset: "ov-lens", role: "body", pos: [1, -2, 3], rot: [10, -20, 30] }),
      binding({ id: "ovc-child", componentId: "ov-composite", parent: "ovc-body", kind: "asset", asset: "ov-glan", role: "front", pos: [0, 4, 0], rot: [0, 0, 45] }),
      binding({ id: "ovc-empty", componentId: "ov-composite", parent: "ovc-body", kind: "empty", role: "mount", pos: [0, 0, -6], sortOrder: 1 }),
      binding({ id: "ovc-null", componentId: "ov-composite", parent: "ovc-body", kind: "asset", asset: null, role: "slot", pos: [5, 0, 0], rot: [90, 0, 0], sortOrder: 2 }),
      binding({ id: "ovc-sub", componentId: "ov-composite", kind: "subcomponent", sub: "ov-single", role: "back", pos: [0, 0, 20], rot: [180, 0, 0], sortOrder: 1 }),
    ];
    const objects = [
      sceneObject("ov-plain", "ov-single", { xMm: 10, yMm: 20, zMm: 30, rxDeg: 0, ryDeg: 45, rzDeg: 0 }),
      sceneObject("ov-swap", "ov-single", { xMm: -40, yMm: 5, zMm: 900, rxDeg: 12, ryDeg: -30, rzDeg: 45 }),
      sceneObject("ov-missing", "ov-single", { xMm: 1, yMm: 2, zMm: 3 }),
      sceneObject("ov-comp-1", "ov-composite", { xMm: 100, yMm: -50, zMm: 910, rxDeg: -90, ryDeg: 20, rzDeg: 5 }),
      sceneObject("ov-comp-2", "ov-composite", { xMm: 3, yMm: -4, zMm: 5, rxDeg: 135, ryDeg: -60, rzDeg: 0 }),
      sceneObject("ov-legacy-1", "ov-legacy", { xMm: 7, yMm: 8, zMm: 9, rxDeg: 0, ryDeg: 0, rzDeg: 90 }),
    ];
    const objectBindings = [
      objectBinding("ob-swap", "ov-swap", "ovs-root", { localRzDegDelta: 2 }, "ov-aom"),
      objectBinding("ob-missing", "ov-missing", "ovs-root", {}, "no-such-asset"),
      objectBinding("ob-c1-body", "ov-comp-1", "ovc-body", { localXMmDelta: 0.5, localRyDegDelta: -3 }, "ov-aom"),
      objectBinding("ob-c1-child", "ov-comp-1", "ovc-child", {}, "ov-piece"),
      objectBinding("ob-c1-empty", "ov-comp-1", "ovc-empty", {}, "ov-glan"),
      objectBinding("ob-c1-null", "ov-comp-1", "ovc-null", {}, "ov-glan"),
      // Keyed to the SUB-Component's binding: never applied (no per-instance
      // state below the object's own Component, in the loader or the walk).
      objectBinding("ob-c1-sub", "ov-comp-1", "ovs-root", {}, "ov-aom"),
      objectBinding("ob-c2-body", "ov-comp-2", "ovc-body", { localZMmDelta: 1.25, localRxDegDelta: 4 }),
    ];
    scenes.push({ name: "asset-override", scene: { components, componentBindings, objectBindings, assets }, objects });
  }

  // Resolve every object of every scene with the real TS.
  return scenes.map((entry) => {
    const { name, scene, objects } = entry as {
      name: string; scene: SceneSlice; objects: SceneObject[];
    };
    const results = objects.map((obj) => {
      const comp = scene.components.find((c) => c.id === obj.componentId)!;
      const anchors = resolveAnchorPosesLab(comp, obj, scene).map((a) => ({
        anchorId: a.anchorId,
        anchorName: a.anchorName,
        assetId: a.asset.id,
        posCad: vecJson(a.posCad),
        axisXCad: vecJson(a.axisXCad),
        posLab: vecJson(a.posLab),
        axisXLab: vecJson(a.axisXLab),
        apertureMm: a.apertureMm,
      }));
      const centres: RoleCentre[] = [];
      collectRoleCentres(
        resolveBindingTree(comp, obj, scene), new THREE.Vector3(), new THREE.Quaternion(), centres,
      );
      return {
        objectId: obj.id,
        anchors,
        roleCentres: roleCentresJson(centres),
        front: vecJson(pickPolariserCentre(centres, "front")),
        back: vecJson(pickPolariserCentre(centres, "back")),
        // The align paths' "main asset" (AlignToBeamControls): override-aware.
        primaryAssetId: primaryAssetForObject(comp, obj, scene)?.id ?? null,
      };
    });
    return plain({ name, scene, objects, results });
  });
}

// ─── mirror coupling ───────────────────────────────────────────────────────

/** The BB1-E03 mirror of `mirrorCoupling.test.ts` (face normal +Z, bound
 *  with localRx -90), plus a dichroic whose face sits off the Component
 *  origin and declares no aperture (-> the 6.35 mm default). */
function mirrorScene(): SceneSlice {
  return {
    components: [component("comp-mirror", "mirror"), component("comp-dichroic", "dichroic_mirror")],
    assets: [
      asset("asset-mirror", "mirror", [
        anchor("intercept_face", v(0, 0, 0), {
          axisXBodyLocal: v(0, 0, 1), axisYBodyLocal: v(0, 1, 0), axisZBodyLocal: v(-1, 0, 0),
          apertureMm: 12.7, apertureShape: "circle",
        }),
      ]),
      asset("asset-dichroic", "dichroic_mirror", [
        anchor("intercept_face", v(1.5, -2, 0.75), { axisXBodyLocal: v(0, 0.6, 0.8) }),
      ]),
    ],
    componentBindings: [
      binding({ id: "bind-mirror", componentId: "comp-mirror", kind: "asset", asset: "asset-mirror", role: "BB1-E03-Step", rot: [-90, 0, 0] }),
      binding({ id: "bind-dichroic", componentId: "comp-dichroic", kind: "asset", asset: "asset-dichroic", role: "dmlp", pos: [3, 4, -5], rot: [10, -20, 30] }),
    ],
    objectBindings: [],
  };
}

function facts(scene: SceneSlice, obj: SceneObject): MirrorFacts {
  const f = mirrorFactsFromObject(obj, scene);
  if (isSolveError(f)) throw new Error(f.error);
  return f;
}

function rayJson(r: Ray): Json {
  return { origin: vecJson(r.origin), dir: vecJson(r.dir) };
}

function buildMirrorCoupling(): Json {
  const r = makeRng(0x3177);
  const scene = mirrorScene();
  const mk = (id: string, pose: Partial<Pose>, comp = "comp-mirror") => sceneObject(id, comp, pose);

  // (1) Scene-level facts: the mirror face through the anchor walk.
  const factObjects: SceneObject[] = [
    mk("MIRROR5", { xMm: -298.926606, yMm: -453.518962, zMm: 908.83165, rxDeg: 135, ryDeg: -90, rzDeg: 0 }),
    mk("MIRROR7", { xMm: -297.414177, yMm: -489.149399, zMm: 909.760341, rxDeg: -45, ryDeg: -90, rzDeg: 0 }),
    mk("MIRROR8", { xMm: -261.018145, yMm: -487.429769, zMm: 908.83165, rxDeg: 45, ryDeg: -90, rzDeg: 0 }),
  ];
  for (let i = 0; i < 10; i += 1) {
    factObjects.push(mk(`M${i}`, {
      xMm: r.uni(-400, 400), yMm: r.uni(-600, 0), zMm: r.uni(800, 1000),
      rxDeg: r.angle(), ryDeg: i % 4 === 0 ? r.pick([-90, 90]) : r.uni(-89, 89), rzDeg: r.angle(),
    }, i % 3 === 0 ? "comp-dichroic" : "comp-mirror"));
  }
  const factsCases = factObjects.map((o) => ({ object: o, output: factsJson(facts(scene, o)) }));

  // (2) solveCouplingGeometry: every case the unit tests pin, then random.
  const solveInputs: {
    inRay: Ray; targetRay: Ray; currentA: Vec3; currentB: Vec3;
    foldMm?: number; apertureAMm?: number; apertureBMm?: number;
  }[] = [
    { inRay: { origin: v(0, 0, 0), dir: v(1, 0, 0) }, targetRay: { origin: v(100, 50, 20), dir: v(0, 1, 0) }, currentA: v(-999, -999, -999), currentB: v(999, 999, 999) },
    { inRay: { origin: v(0, 0, 0), dir: v(1, 0, 0) }, targetRay: { origin: v(80, 40, -25), dir: v(0, 0.6, 0.8) }, currentA: v(0, 0, 0), currentB: v(0, 0, 0) },
    { inRay: { origin: v(-298.9266, -453.519, 908.8317), dir: v(0, -1, 0) }, targetRay: { origin: v(-261.435, -363.323, 908.8317), dir: v(0, 1, 0) }, currentA: v(-297.4142, -489.1494, 909.7603), currentB: v(-261.0181, -487.4298, 908.8317) },
    { inRay: { origin: v(0, 0, 0), dir: v(0, -1, 0) }, targetRay: { origin: v(30, 100, 0), dir: v(0, 1, 0) }, currentA: v(0, -50, 0), currentB: v(30, -50, 0) },
    { inRay: { origin: v(0, 0, 0), dir: v(0, -1, 0) }, targetRay: { origin: v(30, 100, 0), dir: v(0, 1, 0) }, currentA: v(0, -50, 0), currentB: v(30, -50, 0), foldMm: 75 },
    { inRay: { origin: v(0, 0, 0), dir: v(1, 0, 0) }, targetRay: { origin: v(200, 0, 30), dir: v(1, 0, 0) }, currentA: v(50, 0, 0), currentB: v(50, 0, 30) },
    {
      inRay: { origin: v(-237.43771492340383, -462.4784510765962, 908.83165), dir: v(-0.00003422430668179471, -0.9999999994143485, 0) },
      targetRay: { origin: v(-187.480474, -379.409561, 908.83165), dir: v(0, 1, 0) },
      currentA: v(-237.462383, -512.476504, 910.799999), currentB: v(-187.480474, -512.476504, 910.799999),
    },
    {
      inRay: { origin: v(0, 0, 0), dir: v(1, 0, 0) },
      targetRay: { origin: v(300, 0, 40), dir: v(Math.cos(Math.PI / 180), Math.sin(Math.PI / 180), 0) },
      currentA: v(0, 0, 0), currentB: v(0, 0, 0),
    },
    { inRay: { origin: v(0, 0, 0), dir: v(1, 0, 0) }, targetRay: { origin: v(500, 0, 0), dir: v(1, 0, 0) }, currentA: v(100, 0, 0), currentB: v(200, 0, 0) },
    { inRay: { origin: v(0, 0, 0), dir: v(1, 0, 0) }, targetRay: { origin: v(100, 50, 20), dir: v(0, -1, 0) }, currentA: v(0, 0, 0), currentB: v(0, 0, 0) },
    // Degenerate inputs and the fouling warning.
    { inRay: { origin: v(0, 0, 0), dir: v(0, 0, 0) }, targetRay: { origin: v(1, 2, 3), dir: v(0, 1, 0) }, currentA: v(0, 0, 0), currentB: v(0, 0, 0) },
    { inRay: { origin: v(0, 0, 0), dir: v(1, 0, 0) }, targetRay: { origin: v(1, 2, 3), dir: v(0, 0, 0) }, currentA: v(0, 0, 0), currentB: v(0, 0, 0) },
    { inRay: { origin: v(0, 0, 0), dir: v(0, -2, 0) }, targetRay: { origin: v(8, 100, 0), dir: v(0, 3, 0) }, currentA: v(0, -50, 0), currentB: v(8, -50, 0), apertureAMm: 6.35, apertureBMm: 12.7 },
  ];
  for (let i = 0; i < 40; i += 1) {
    const d0 = r.unitVec();
    const branch = i % 4;
    // 0: generic; 1: exactly anti-parallel; 2: exactly parallel; 3: nearly
    // anti-parallel (the residual-pointing band the distance rule exists for).
    const dT = branch === 0 ? r.unitVec()
      : branch === 1 ? neg(d0)
      : branch === 2 ? d0
      : (() => {
          const tilt = r.uni(1e-6, 2e-4);
          const p = r.unitVec();
          const t = add(neg(d0), scale(p, tilt));
          const m = Math.hypot(t.x, t.y, t.z);
          return v(t.x / m, t.y / m, t.z / m);
        })();
    const pIn = r.vec(300);
    solveInputs.push({
      inRay: { origin: pIn, dir: scale(d0, r.uni(0.5, 2)) },
      targetRay: { origin: add(pIn, r.vec(200)), dir: dT },
      currentA: add(pIn, r.vec(150)),
      currentB: add(pIn, r.vec(150)),
      ...(r.next() < 0.25 ? { foldMm: r.uni(-50, 200) } : {}),
      ...(r.next() < 0.5 ? { apertureAMm: r.uni(3, 30), apertureBMm: r.uni(3, 30) } : {}),
    });
  }
  const solveCases = solveInputs.map((input) => ({
    input: plain(input),
    output: plain(solveCouplingGeometry(input)),
  }));

  // (3) Mirror pairs: the U-turn bench layout of the unit tests, roughed in
  // with random error (touch passes or narrowly fails), then fully random
  // pairs (touch mostly fails; the plan is computed regardless).
  type PairCase = { inRay: Ray; targetRay: Ray; a: MirrorFacts; b: MirrorFacts; foldMm?: number };
  const pairs: PairCase[] = [];
  pairs.push({
    inRay: { origin: v(0, 0, 0), dir: v(0, -1, 0) },
    targetRay: { origin: v(40, 0, 0), dir: v(0, 1, 0) },
    a: facts(scene, mk("A", { xMm: 1.5, yMm: -101, zMm: 0.9, rxDeg: -45, ryDeg: -90, rzDeg: 0 })),
    b: facts(scene, mk("B", { xMm: 40.4, yMm: -99.2, zMm: 0, rxDeg: 45, ryDeg: -90, rzDeg: 0 })),
  });
  pairs.push({
    inRay: { origin: v(0, 0, 0), dir: v(0, -1, 0) },
    targetRay: { origin: v(40, 0, 0), dir: v(0, 1, 0) },
    a: facts(scene, mk("A", { xMm: 0, yMm: -100, zMm: 60, rxDeg: -45, ryDeg: -90, rzDeg: 0 })),
    b: facts(scene, mk("B", { xMm: 40, yMm: -100, zMm: 0, rxDeg: 45, ryDeg: -90, rzDeg: 0 })),
  });
  for (let i = 0; i < 16; i += 1) {
    const dx = r.uni(20, 80);
    const y = r.uni(-150, -60);
    pairs.push({
      inRay: { origin: v(0, 0, 0), dir: v(0, -1, 0) },
      targetRay: { origin: v(dx, 0, 0), dir: v(0, 1, 0) },
      a: facts(scene, mk("A", {
        xMm: r.uni(-3, 3), yMm: y + r.uni(-3, 3), zMm: r.uni(-3, 3),
        rxDeg: -45 + r.uni(-2, 2), ryDeg: i % 2 === 0 ? -90 : -90 + r.uni(-2, 2), rzDeg: r.uni(-1, 1),
      })),
      b: facts(scene, mk("B", {
        xMm: dx + r.uni(-3, 3), yMm: y + r.uni(-3, 3), zMm: r.uni(-3, 3),
        rxDeg: 45 + r.uni(-2, 2), ryDeg: i % 2 === 0 ? -90 : -90 + r.uni(-2, 2), rzDeg: r.uni(-1, 1),
      })),
      ...(i % 5 === 0 ? { foldMm: r.uni(40, 160) } : {}),
    });
  }
  for (let i = 0; i < 16; i += 1) {
    pairs.push({
      inRay: { origin: r.vec(200), dir: r.unitVec() },
      targetRay: { origin: r.vec(200), dir: r.unitVec() },
      a: facts(scene, mk("A", {
        xMm: r.uni(-200, 200), yMm: r.uni(-200, 200), zMm: r.uni(-200, 200),
        rxDeg: r.angle(), ryDeg: r.uni(-89, 89), rzDeg: r.angle(),
      }, i % 2 === 0 ? "comp-mirror" : "comp-dichroic")),
      b: facts(scene, mk("B", {
        xMm: r.uni(-200, 200), yMm: r.uni(-200, 200), zMm: r.uni(-200, 200),
        rxDeg: r.angle(), ryDeg: r.uni(-89, 89), rzDeg: r.angle(),
      })),
    });
  }
  const pairInput = (p: PairCase): Json => ({
    inRay: rayJson(p.inRay),
    targetRay: rayJson(p.targetRay),
    a: factsJson(p.a),
    b: factsJson(p.b),
    ...(p.foldMm !== undefined ? { foldMm: p.foldMm } : {}),
  });
  const pairCases = pairs.map((p) => ({
    input: pairInput(p),
    touch: plain(checkMirrorTouch({ inRay: p.inRay, targetRay: p.targetRay, a: p.a, b: p.b })),
    plan: plain(planMirrorCoupling({ inRay: p.inRay, targetRay: p.targetRay, a: p.a, b: p.b, foldMm: p.foldMm })),
    miss: currentTargetMissMm(p.inRay, p.targetRay, p.a, p.b),
  }));

  // (4) poseMirrorTo on its own: the unit tests' cases (including the
  // "already aimed right" identity), anti-parallel flips, and random.
  const poseInputs: { mirror: MirrorFacts; centreLab: Vec3; normalLab: Vec3 }[] = [];
  {
    const m = facts(scene, mk("M", { xMm: 10, yMm: -20, zMm: 5, rxDeg: 45, ryDeg: -90, rzDeg: 0 }));
    poseInputs.push({ mirror: m, centreLab: v(-100, 33, 907), normalLab: v(Math.SQRT1_2, 0, Math.SQRT1_2) });
    const m2 = facts(scene, mk("M", { xMm: 1, yMm: 2, zMm: 3, rxDeg: -45, ryDeg: -90, rzDeg: 0 }));
    poseInputs.push({ mirror: m2, centreLab: v(50, 60, 70), normalLab: m2.normalLab });
    poseInputs.push({ mirror: m2, centreLab: v(50, 60, 70), normalLab: neg(m2.normalLab) });
  }
  for (let i = 0; i < 24; i += 1) {
    const m = facts(scene, mk("M", {
      xMm: r.uni(-300, 300), yMm: r.uni(-300, 300), zMm: r.uni(-300, 300),
      rxDeg: r.angle(), ryDeg: i % 6 === 0 ? r.pick([-90, 90]) : r.uni(-89, 89), rzDeg: r.angle(),
    }, i % 2 === 0 ? "comp-mirror" : "comp-dichroic"));
    poseInputs.push({
      mirror: m,
      centreLab: r.vec(400),
      normalLab: i % 8 === 7 ? neg(m.normalLab) : r.unitVec(),
    });
  }
  const poseCases = poseInputs.map((p) => ({
    input: { mirror: factsJson(p.mirror), centreLab: vecJson(p.centreLab), normalLab: vecJson(p.normalLab) },
    output: plain(poseMirrorTo(p.mirror, p.centreLab, p.normalLab)),
  }));

  return {
    scene: plain(scene),
    facts: plain(factsCases),
    solve: solveCases,
    pairs: pairCases,
    pose: poseCases,
  };
}

// ─── point + direction align (isolatorAlign.ts) ────────────────────────────

/** MIRROR2 (live scene, 2026-09-22) and its near-pole variants — see the
 *  call site in `buildPointDir`. */
function mirror2PoleCases() {
  const mirror2: Pose = {
    xMm: -492.654465, yMm: -537.195519, zMm: 910.799999, rxDeg: -135, ryDeg: -90, rzDeg: 0,
  };
  const ref = v(-387.3906559182327, -537.2652968730044, 908.83165);
  const sx = 0.008087770214956286;
  const cy = 0.999967293451616;
  const out: {
    pointCadMm: Vec3; dirCadMm: Vec3; sceneObject: Pose; beamDir: Vec3; beamRef: Vec3;
    reverse?: boolean; rollDeg?: number;
  }[] = [];
  for (const flip of [1, -1]) {
    for (const rollDeg of [90, -90]) {
      for (const reverse of [false, true]) {
        out.push({ pointCadMm: v(0, 0, 0), dirCadMm: v(0, 1, 0), sceneObject: mirror2,
          beamDir: v(flip * sx, flip * cy, 0), beamRef: ref, reverse, rollDeg });
      }
    }
  }
  for (const offDeg of [1e-3, 1e-5, 1e-7, 1e-9]) {
    const t = (offDeg * Math.PI) / 180;
    for (const rollDeg of [90, -90]) {
      out.push({ pointCadMm: v(0, 0, 0), dirCadMm: v(0, 1, 0), sceneObject: mirror2,
        beamDir: v(sx * Math.cos(t), cy * Math.cos(t), Math.sin(t)), beamRef: ref, rollDeg });
    }
  }
  return out;
}

function buildPointDir(): Json {
  const r = makeRng(0x150);
  const so = (pose: Partial<Pose>) => sceneObject("obj", "comp", pose);

  type PdIn = {
    pointCadMm: Vec3; dirCadMm: Vec3; sceneObject: Pose; beamDir: Vec3; beamRef: Vec3;
    reverse?: boolean; rollDeg?: number; extraTilt?: { axisCadMm: Vec3; angleRad: number };
  };
  const pd: PdIn[] = [
    // The unit tests' cases.
    { pointCadMm: v(0, 0, -13), dirCadMm: v(0, 0, 26), sceneObject: poseOf(so({ xMm: 10, yMm: 20, zMm: 5 })), beamDir: v(1, 0, 0), beamRef: v(100, 50, -7) },
    { pointCadMm: v(0, 11, 0), dirCadMm: v(0, 73, 0), sceneObject: poseOf(so({ xMm: -30, yMm: 12, zMm: 40, rxDeg: 12, ryDeg: -30, rzDeg: 45 })), beamDir: v(0.3, -0.5, 0.8), beamRef: v(5, -2, 11) },
    { pointCadMm: v(0, 0, -10), dirCadMm: v(0, 0, 30), sceneObject: poseOf(so({ xMm: 5, yMm: -3, zMm: 2, rxDeg: 10, ryDeg: 20, rzDeg: -5 })), beamDir: v(1, 0.2, 0), beamRef: v(50, 10, 3), reverse: false },
    { pointCadMm: v(0, 0, -10), dirCadMm: v(0, 0, 30), sceneObject: poseOf(so({ xMm: 5, yMm: -3, zMm: 2, rxDeg: 10, ryDeg: 20, rzDeg: -5 })), beamDir: v(1, 0.2, 0), beamRef: v(50, 10, 3), reverse: true },
    { pointCadMm: v(0, 0, 0), dirCadMm: v(0, 0, 1), sceneObject: poseOf(so({})), beamDir: v(1, 0, 0), beamRef: v(0, 0, 0), rollDeg: 90 },
    // setFromUnitVectors' special branches: already parallel, exactly
    // anti-parallel along x (|x| > |z|) and along z (the other axis).
    { pointCadMm: v(1, 2, 3), dirCadMm: v(1, 0, 0), sceneObject: poseOf(so({ xMm: 7 })), beamDir: v(1, 0, 0), beamRef: v(0, 5, 5) },
    { pointCadMm: v(1, 2, 3), dirCadMm: v(1, 0, 0), sceneObject: poseOf(so({ xMm: 7 })), beamDir: v(-1, 0, 0), beamRef: v(0, 5, 5) },
    { pointCadMm: v(1, 2, 3), dirCadMm: v(0, 0, 2), sceneObject: poseOf(so({ zMm: 7 })), beamDir: v(0, 0, 1), beamRef: v(0, 5, 5), reverse: true },
    // Degenerate direction -> null.
    { pointCadMm: v(1, 2, 3), dirCadMm: v(0, 0, 1e-7), sceneObject: poseOf(so({})), beamDir: v(1, 0, 0), beamRef: v(0, 0, 0) },
    // The gimbal pole (2026-09-22). MIRROR2 of the live scene (alignSpec
    // point 0, direction +y) rolled 90° onto a beam 8.1 mrad off the y axis:
    // the resulting pose sits exactly at ry = ±90°, where the old
    // decomposition read noise and put the align direction 2.75e-4 rad off the
    // beam (ry 8.5e-7° short of 90). Then the same beam tilted out of the
    // plane by 1e-3° … 1e-9°, so ry lands that close to the pole.
    ...mirror2PoleCases(),
  ];
  for (let i = 0; i < 40; i += 1) {
    pd.push({
      pointCadMm: r.vec(40),
      dirCadMm: scale(r.unitVec(), r.uni(0.5, 80)),
      sceneObject: poseOf(so({
        xMm: r.uni(-500, 500), yMm: r.uni(-500, 500), zMm: r.uni(0, 1000),
        rxDeg: r.angle(), ryDeg: i % 7 === 0 ? r.pick([-90, 90]) : r.uni(-89, 89), rzDeg: r.angle(),
      })),
      beamDir: scale(r.unitVec(), r.uni(0.2, 5)),
      beamRef: r.vec(500),
      ...(r.next() < 0.5 ? { reverse: r.next() < 0.5 } : {}),
      ...(r.next() < 0.5 ? { rollDeg: r.angle() } : {}),
      ...(r.next() < 0.4 ? { extraTilt: { axisCadMm: r.unitVec(), angleRad: r.uni(-0.05, 0.05) } } : {}),
    });
  }
  const pointDirCases = pd.map((input) => ({
    input: plain(input),
    output: plain(computePointDirAlignPose({
      ...input, sceneObject: so(input.sceneObject),
    })),
  }));

  type IsoIn = { frontCadMm: Vec3; backCadMm: Vec3; sceneObject: Pose; beamDir: Vec3; beamRef: Vec3; reverse?: boolean; rollDeg?: number };
  const iso: IsoIn[] = [
    { frontCadMm: v(0, 0, -13), backCadMm: v(0, 0, 13), sceneObject: poseOf(so({ xMm: 10, yMm: 20, zMm: 5 })), beamDir: v(1, 0, 0), beamRef: v(100, 50, -7) },
    { frontCadMm: v(0, 11, 0), backCadMm: v(0, 84, 0), sceneObject: poseOf(so({ xMm: -30, yMm: 12, zMm: 40, rxDeg: 12, ryDeg: -30, rzDeg: 45 })), beamDir: v(0.3, -0.5, 0.8), beamRef: v(5, -2, 11) },
    { frontCadMm: v(1, 2, 3), backCadMm: v(1, 2, 3), sceneObject: poseOf(so({})), beamDir: v(1, 0, 0), beamRef: v(0, 0, 0) },
  ];
  for (let i = 0; i < 12; i += 1) {
    iso.push({
      frontCadMm: r.vec(30),
      backCadMm: r.vec(30),
      sceneObject: poseOf(so({ xMm: r.uni(-300, 300), yMm: r.uni(-300, 300), zMm: r.uni(-300, 300), rxDeg: r.angle(), ryDeg: r.uni(-89, 89), rzDeg: r.angle() })),
      beamDir: r.unitVec(),
      beamRef: r.vec(300),
      ...(r.next() < 0.5 ? { reverse: true } : {}),
      ...(r.next() < 0.5 ? { rollDeg: r.angle() } : {}),
    });
  }
  const isolatorCases = iso.map((input) => ({
    input: plain(input),
    output: plain(computeIsolatorAlignPose({ ...input, sceneObject: so(input.sceneObject) })),
  }));

  type ToIn = { pointCadMm: Vec3; sceneObject: Pose; beamDir: Vec3; beamRef: Vec3 };
  const to: ToIn[] = [];
  for (let i = 0; i < 12; i += 1) {
    to.push({
      pointCadMm: r.vec(40),
      sceneObject: poseOf(so({ xMm: r.uni(-300, 300), yMm: r.uni(-300, 300), zMm: r.uni(-300, 300), rxDeg: r.angle(), ryDeg: r.uni(-89, 89), rzDeg: r.angle() })),
      beamDir: scale(r.unitVec(), r.uni(0.2, 5)),
      beamRef: r.vec(300),
    });
  }
  const translateCases = to.map((input) => ({
    input: plain(input),
    output: plain(computeTranslateOnlyPose({ ...input, sceneObject: so(input.sceneObject) })),
  }));

  // pickPolariserCentre's preference ladder, role by role.
  const c = (role: string, isSub: boolean, p: Vec3): RoleCentre => ({
    role, isSub, posMm: new THREE.Vector3(p.x, p.y, p.z),
  });
  const pickSets: { centres: RoleCentre[]; side: "front" | "back" }[] = [
    { centres: [c("front_mount", false, v(0, 5, 0)), c("front_glan_laser", true, v(0, 5, 13))], side: "front" },
    { centres: [c("back_pbs", true, v(0, 0, 13))], side: "front" },
    { centres: [c("io_3_850_hp_front_piece", false, v(0, 0, 0)), c("front", false, v(0, 0, -12))], side: "front" },
    { centres: [c("io_back_piece", false, v(1, 0, 0)), c("Back_Glan", false, v(2, 0, 0))], side: "back" },
    { centres: [c("back_piece", false, v(1, 0, 0)), c("back_mount", false, v(3, 0, 0))], side: "back" },
    { centres: [c("back_piece", false, v(1, 0, 0)), c("back_piece_2", true, v(4, 0, 0))], side: "back" },
    { centres: [c("front_piece", false, v(1, 0, 0))], side: "front" },
    { centres: [c("FRONT", false, v(9, 9, 9)), c("front_polarizer", true, v(1, 0, 0))], side: "front" },
  ];
  const pickCases = pickSets.map(({ centres, side }) => ({
    input: { centres: roleCentresJson(centres), side },
    output: vecJson(pickPolariserCentre(centres, side)),
  }));

  return {
    pointDir: pointDirCases,
    isolator: isolatorCases,
    translateOnly: translateCases,
    pick: pickCases,
  };
}

// ─── AOM Bragg (aomAlign.ts) ───────────────────────────────────────────────

function buildAomBragg(): Json {
  const r = makeRng(0xa0b);
  const so = (pose: Partial<Pose>) => sceneObject("obj-aom", "comp-aom", pose);

  const mt80Anchors = [
    anchor("intercept_in", v(0, -11.2, 0), { axisXBodyLocal: v(0, -1, 0) }),
    anchor("intercept_out", v(0, 11.2, 0), { axisXBodyLocal: v(0, 1, 0) }),
  ];
  type FrameIn = { anchors: Record<string, unknown>[]; defaultParams: Record<string, unknown> };
  const frameInputs: FrameIn[] = [
    { anchors: mt80Anchors, defaultParams: { rfPropagationDirectionBodyLocal: [-1, 0, 0] } },
    { anchors: [...mt80Anchors, anchor("acoustic_axis", v(0, 0, 0), { axisXBodyLocal: v(0, 0, 1) })], defaultParams: { rfPropagationDirectionBodyLocal: [-1, 0, 0] } },
    { anchors: mt80Anchors, defaultParams: { rfPropagationDirectionBodyLocal: [-1, 0.2, 0] } },
    { anchors: mt80Anchors, defaultParams: { acousticAxisBodyLocal: { x: 0, y: 0.1, z: -1 } } },
    { anchors: [...mt80Anchors, anchor("acoustic_axis", v(0, 0, 0), { directionBodyLocal: v(1, 0, 1) })], defaultParams: {} },
    { anchors: [], defaultParams: { rfPropagationDirectionBodyLocal: [-1, 0, 0] } },
    { anchors: mt80Anchors, defaultParams: {} },
    { anchors: mt80Anchors, defaultParams: { rfPropagationDirectionBodyLocal: [0, 2, 0] } },
    { anchors: mt80Anchors, defaultParams: { rfPropagationDirectionBodyLocal: [1, "x", 0] } },
  ];
  for (let i = 0; i < 10; i += 1) {
    const pIn = r.vec(20);
    const d = r.unitVec();
    const len = r.uni(5, 30);
    const anchors = [
      anchor("intercept_in", pIn, { axisXBodyLocal: neg(d) }),
      anchor("intercept_out", add(pIn, scale(d, len)), { axisXBodyLocal: d }),
    ];
    if (i % 2 === 0) anchors.push(anchor("acoustic_axis", r.vec(5), { axisXBodyLocal: r.unitVec() }));
    frameInputs.push({ anchors, defaultParams: { rfPropagationDirectionBodyLocal: [r.uni(-1, 1), r.uni(-1, 1), r.uni(-1, 1)] } });
  }
  const frames: (AomBraggFrame | null)[] = frameInputs.map((f) =>
    resolveAomBraggFrame(asset("asset-aom", "aom", f.anchors, f.defaultParams)),
  );
  const frameCases = frameInputs.map((input, i) => ({ input: plain(input), output: plain(frames[i]) }));
  const goodFrames = frames.filter((f): f is AomBraggFrame => f !== null);

  const thetaBInputs = [
    { freqMhz: 80, v: 4200, lambdaNm: 780 },
    { freqMhz: 80, v: 4200, lambdaNm: 852.347 },
    { freqMhz: 110, v: 5960, lambdaNm: 1064 },
  ];
  for (let i = 0; i < 6; i += 1) thetaBInputs.push({ freqMhz: r.uni(20, 400), v: r.uni(600, 6000), lambdaNm: r.uni(400, 1600) });
  const thetaBCases = thetaBInputs.map((t) => ({
    input: t,
    output: braggAngleRad({ centerFreqMhz: t.freqMhz, acousticVelocityMps: t.v }, t.lambdaNm),
  }));
  const THETA_B = thetaBCases[0].output as number;

  type AlignIn = { frame: AomBraggFrame; sceneObject: Pose; beamDir: Vec3; beamRef: Vec3; reverse?: boolean; rollDeg?: number; tiltRad: number };
  const alignInputs: AlignIn[] = [];
  for (const order of [1, -1]) {
    for (const reverse of [false, true]) {
      alignInputs.push({
        frame: goodFrames[0],
        sceneObject: poseOf(so({ xMm: 13, yMm: 7, zMm: 62, ryDeg: 20 })),
        beamDir: v(1, 0, 0), beamRef: v(0, 0, 50),
        reverse, tiltRad: braggTiltRad(order, THETA_B),
      });
    }
  }
  alignInputs.push({
    frame: goodFrames[0], sceneObject: poseOf(so({ xMm: 13, yMm: 7, zMm: 62, ryDeg: 20 })),
    beamDir: v(1, 0, 0), beamRef: v(0, 0, 50), tiltRad: braggTiltRad(1, THETA_B) + 2e-3,
  });
  for (let i = 0; i < 20; i += 1) {
    alignInputs.push({
      frame: r.pick(goodFrames),
      sceneObject: poseOf(so({ xMm: r.uni(-300, 300), yMm: r.uni(-300, 300), zMm: r.uni(0, 1000), rxDeg: r.angle(), ryDeg: r.uni(-89, 89), rzDeg: r.angle() })),
      beamDir: scale(r.unitVec(), r.uni(0.5, 2)),
      beamRef: r.vec(300),
      ...(r.next() < 0.5 ? { reverse: r.next() < 0.5 } : {}),
      ...(r.next() < 0.3 ? { rollDeg: r.angle() } : {}),
      tiltRad: r.pick([1, -1]) * r.uni(1e-3, 2e-2) + (r.next() < 0.3 ? r.uni(-2e-3, 2e-3) : 0),
    });
  }
  const alignCases = alignInputs.map((input) => ({
    input: plain(input),
    output: plain(computeAomBraggAlignPose({ ...input, sceneObject: so(input.sceneObject) })),
  }));

  type NudgeIn = { frame: AomBraggFrame; sceneObject: Pose; deltaRad: number };
  const nudgeInputs: NudgeIn[] = [];
  for (let i = 0; i < 12; i += 1) {
    nudgeInputs.push({
      frame: r.pick(goodFrames),
      sceneObject: poseOf(so({ xMm: r.uni(-300, 300), yMm: r.uni(-300, 300), zMm: r.uni(0, 1000), rxDeg: r.angle(), ryDeg: r.uni(-89, 89), rzDeg: r.angle() })),
      deltaRad: r.uni(-5e-3, 5e-3),
    });
  }
  const nudgeCases = nudgeInputs.map((input) => ({
    input: plain(input),
    output: plain(computeAomTiltNudgePose({ ...input, sceneObject: so(input.sceneObject) })),
  }));

  type ReadIn = {
    frame: AomBraggFrame; sceneObject: Pose; beamDir: Vec3; thetaBRad: number; wavelengthNm: number;
    freqMhz: number; acousticVelocityMps: number; refractiveIndex: number; crystalLengthMm: number; orders?: number[];
  };
  const readInputs: ReadIn[] = [];
  // Read back every aligned pose above (the unit tests' assertions), then
  // random poses, a zero beam (-> null) and theta_B = 0 (matchedOrder 0).
  alignInputs.forEach((a, i) => {
    const out = alignCases[i].output as Pose | null;
    if (!out) return;
    readInputs.push({
      frame: a.frame, sceneObject: out, beamDir: a.beamDir, thetaBRad: THETA_B, wavelengthNm: 780,
      freqMhz: 80, acousticVelocityMps: 4200, refractiveIndex: 2.26, crystalLengthMm: i % 2 === 0 ? 22.4 : 1.6,
      ...(i % 3 === 0 ? { orders: [2, -2, 0] } : {}),
    });
  });
  for (let i = 0; i < 10; i += 1) {
    readInputs.push({
      frame: r.pick(goodFrames),
      sceneObject: poseOf(so({ rxDeg: r.angle(), ryDeg: r.uni(-89, 89), rzDeg: r.angle() })),
      beamDir: r.unitVec(), thetaBRad: r.uni(1e-3, 2e-2), wavelengthNm: r.uni(600, 1100),
      freqMhz: r.uni(40, 200), acousticVelocityMps: r.uni(600, 6000), refractiveIndex: r.uni(1.4, 2.4),
      crystalLengthMm: r.uni(1, 30),
    });
  }
  readInputs.push({
    frame: goodFrames[0], sceneObject: poseOf(so({})), beamDir: v(0, 0, 0), thetaBRad: THETA_B,
    wavelengthNm: 780, freqMhz: 80, acousticVelocityMps: 4200, refractiveIndex: 2.26, crystalLengthMm: 22.4,
  });
  readInputs.push({
    frame: goodFrames[0], sceneObject: poseOf(so({ rzDeg: 1 })), beamDir: v(1, 0, 0), thetaBRad: 0,
    wavelengthNm: 780, freqMhz: 80, acousticVelocityMps: 4200, refractiveIndex: 2.26, crystalLengthMm: 22.4,
  });
  const readoutCases = readInputs.map((input) => ({
    input: plain(input),
    output: plain(aomBraggReadout({ ...input, sceneObject: so(input.sceneObject) })),
  }));

  return {
    frame: frameCases,
    thetaB: thetaBCases,
    align: alignCases,
    nudge: nudgeCases,
    readout: readoutCases,
  };
}

// ─── pose decomposition near the pole (frames.sceneObjectEulerFromQuaternion)

/** Every align pose goes through `sceneObjectEulerFromQuaternion`; these pin
 *  its pole handling directly: ry within 1e-3° … 1e-9° of ±90° (and exactly
 *  at it), several rx / rz splits, plus random rotations. The output is a
 *  pose dict so the Python side compares it as a pose (as a rotation matrix
 *  near the pole, where only rx ± rz is defined). */
function buildEuler(): Json {
  const r = makeRng(0xe0e0);
  const toPose = (e: { rxDeg: number; ryDeg: number; rzDeg: number }): Pose => ({
    xMm: 0, yMm: 0, zMm: 0, rxDeg: e.rxDeg, ryDeg: e.ryDeg, rzDeg: e.rzDeg,
  });
  const qs: THREE.Quaternion[] = [];
  for (const sign of [1, -1]) {
    for (const offDeg of [0, 1e-9, 1e-7, 1e-5, 1e-3]) {
      for (const [rx, rz] of [[0, 0], [12.5, -30.25], [-135, 0], [179.9, 45], [-0.4634, 88.123456789]]) {
        qs.push(sceneObjectToQuaternion(
          sceneObject("e", "c", { rxDeg: rx, ryDeg: sign * (90 - offDeg), rzDeg: rz }),
        ));
      }
    }
  }
  for (let i = 0; i < 30; i += 1) {
    qs.push(sceneObjectToQuaternion(sceneObject("e", "c", {
      rxDeg: r.angle(), ryDeg: i % 3 === 0 ? r.pick([-1, 1]) * (90 - r.uni(0, 1e-4)) : r.uni(-90, 90), rzDeg: r.angle(),
    })));
  }
  return {
    cases: qs.map((q) => ({
      input: { q: { x: q.x, y: q.y, z: q.z, w: q.w } },
      output: toPose(sceneObjectEulerFromQuaternion(q)),
    })),
  };
}

// ─── write / compare ───────────────────────────────────────────────────────

const BUILDERS: Record<string, () => Json> = {
  "anchor_poses.json": buildAnchorPoses,
  "mirror_coupling.json": buildMirrorCoupling,
  "point_dir.json": buildPointDir,
  "aom_bragg.json": buildAomBragg,
  "euler.json": buildEuler,
};

/** Equal up to 1e-12 on numbers (V8's Math is deterministic, but a Node
 *  upgrade may change a libm ulp), exact on everything else. */
function expectSame(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === "number" && typeof actual === "number") {
    if (Math.abs(actual - expected) > 1e-12 * Math.max(1, Math.abs(expected))) {
      throw new Error(`${path}: ${actual} != ${expected}`);
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      throw new Error(`${path}: array length differs`);
    }
    expected.forEach((e, i) => expectSame(actual[i], e, `${path}[${i}]`));
    return;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") throw new Error(`${path}: not an object`);
    const ek = Object.keys(expected).sort();
    const ak = Object.keys(actual as object).sort();
    if (ek.join(",") !== ak.join(",")) throw new Error(`${path}: keys ${ak} != ${ek}`);
    for (const k of ek) {
      expectSame((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], `${path}.${k}`);
    }
    return;
  }
  if (actual !== expected) throw new Error(`${path}: ${String(actual)} != ${String(expected)}`);
}

describe("align parity fixtures (TS -> backend/tests/fixtures/align)", () => {
  for (const [file, build] of Object.entries(BUILDERS)) {
    it(`${file} matches what the TypeScript produces`, () => {
      const data = build();
      const target = `${FIXTURE_DIR}${file}`;
      if (UPDATE) {
        mkdirSync(FIXTURE_DIR, { recursive: true });
        writeFileSync(target, `${JSON.stringify(data, null, 1)}\n`, "utf8");
        return;
      }
      let committed: unknown;
      try {
        committed = JSON.parse(readFileSync(target, "utf8"));
      } catch {
        throw new Error(`${file} is missing — run with UPDATE_ALIGN_FIXTURES=1`);
      }
      try {
        expectSame(data, committed, file);
      } catch (err) {
        throw new Error(
          `${(err as Error).message}\nThe TypeScript no longer produces the committed fixture. If the change is `
          + "intended: regenerate with UPDATE_ALIGN_FIXTURES=1, then port it to backend/app/optical/align "
          + "until backend/tests/optical/test_align_parity.py is green again.",
        );
      }
    });
  }
});
