/**
 * Golden fixtures pinning the backend's RF-cable / PPG endpoints to this
 * TypeScript.
 *
 * The web app creates, re-snaps, aligns and removes coax cables and
 * Programmable Pulse Generators in the browser (`store/sceneStore.ts`:
 * `createRfCableBetweenPorts`, `resnapRfCablesLinkedTo`,
 * `findRfCableAlignmentCandidates` + `applyRfCableAlignmentCandidate`,
 * `clearRfCableEndpointLink`, `createPpgAtPort` +
 * `createProgrammablePulseGenerator`, `deleteObjects`, and the utils they
 * call). A second client of the backend (the qmem-blender add-on) needs the
 * same flows, so they were ported to `backend/app/optical/rf_cables/` and
 * served as `POST /api/v3/rf-cables/*` and `POST /api/v3/ppg/*`. This file
 * holds the two copies together:
 *
 *   - it runs the REAL TypeScript — the pure utils directly, and the store
 *     flows against a recording fake of `api/client` — over hand-picked cases
 *     (the ones the unit tests pin, plus a scene shaped like the live lab) and
 *     seeded-random scenes, and records inputs + outputs in
 *     `backend/tests/fixtures/rf_cables/*.json`;
 *   - `backend/tests/optical/test_rf_cables_parity.py` feeds the same inputs
 *     to the Python and asserts equality (1e-9 on poses / nodes, exact on
 *     choices: cable variant, PPG component, rule rejections, delete sets);
 *   - THIS test fails when the committed fixtures no longer match what the
 *     TypeScript produces, so a TS change cannot land without regenerating
 *     them — which then fails the Python side until it is ported too.
 *
 * One layer is transcribed rather than run: the RF Link panel's drop /
 * right-click gates (`RfLinkPanel.tsx` — the port list `rfLinkPortsOf`, the
 * occupancy set `occupiedPortKeys`, the pointer-up predicates and
 * `canSpawnPpgHere`) live inline in a React component and are not
 * exportable without touching the web app. They are simple predicates over
 * the real helpers (`resolveRfLinkPortDomain`, `connectorFamilyFromAnchor`,
 * `kindParticipatesInRfLink`, `anchorsInBindingTree`, `ppgAttachments`) and
 * are written out below as `panelPortsOf` / `occupiedPortKeys` /
 * `connectGate` / `ppgGate`, each citing the panel lines it copies. One
 * deliberate tightening: the endpoint also rejects a BUSY SOURCE port — the
 * panel only checks the drop target (its cursor already marks a busy source
 * "not-allowed", but `onPointerDown` does not enforce it).
 *
 * Regenerate after an intentional change:
 *
 *     UPDATE_RF_CABLE_FIXTURES=1 npx vitest run src/utils/__tests__/rfCableParity.test.ts
 *
 * Everything is deterministic (a seeded PRNG, no clock), so regenerating
 * without a TS change is a no-op.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, vi } from "vitest";

import type {
  Anchor,
  Asset3D,
  ComponentBinding,
  ComponentItem,
  PhysicsElement,
  SceneData,
  SceneObject,
} from "../../types/digitalTwin";
import { PHYSICS_PLUGINS } from "../../kinds/_plugins";
import { sceneObjectEulerFromQuaternion, threeToLabMm } from "../../optical/frames";
import { dirBodyToLab, pointBodyToLab } from "../../optical/pose";
import { anchorsInBindingTree, primaryAsset } from "../componentBindings";
import { computePpgMountedThreePose } from "../ppgMounting";
import { ppgAttachments } from "../ppgAttachment";
import {
  connectorFamilyFromAnchor,
  kindParticipatesInRfLink,
  resolveRfLinkPortDomain,
  rfLinkRoleAnchors,
  type RfLinkSignalDomain,
} from "../rfLinkPorts";
import {
  connectorTipMmFromAnchors,
  resolveLinkedRfCableEndpoint,
} from "../rfCableAnchorResolver";
import { findRfCableEndpointAlignmentCandidates } from "../rfCableAlignment";

// ─── recording fake of api/client ──────────────────────────────────────────

type Json = unknown;
type Call = { op: string } & Record<string, Json>;

const calls: Call[] = [];
let seq = 0;
// Assigned after the dynamic store import below (the mock factory is hoisted).
let getStoreScene: () => SceneData = () => {
  throw new Error("store not loaded");
};

/** JSON round-trip: drops `undefined`, turns class instances into plain data. */
const plain = (x: unknown): Json => (x === undefined ? null : JSON.parse(JSON.stringify(x)));

function fakeCreateObject(payload: Record<string, unknown>): SceneObject {
  seq += 1;
  calls.push({ op: "createObject", payload: plain(payload) });
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    id: `new-obj-${seq}`,
    name: typeof payload.name === "string" ? payload.name : `AUTO${seq}`,
    componentId: payload.componentId,
    xMm: num(payload.xMm), yMm: num(payload.yMm), zMm: num(payload.zMm),
    rxDeg: num(payload.rxDeg), ryDeg: num(payload.ryDeg), rzDeg: num(payload.rzDeg),
    visible: payload.visible ?? true,
    locked: payload.locked ?? false,
    properties: (payload.properties as Record<string, unknown>) ?? {},
    dynamicSources: null,
  } as unknown as SceneObject;
}

function fakeUpdateObject(id: string, patch: Record<string, unknown>): SceneObject {
  calls.push({ op: "updateObject", id, patch: plain(patch) });
  const current = getStoreScene().objects.find((o) => o.id === id);
  return { ...(current ?? { id }), ...patch } as unknown as SceneObject;
}

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createObjectApi: async (payload: Record<string, unknown>) => fakeCreateObject(payload),
  updateObjectApi: async (id: string, patch: Record<string, unknown>) => fakeUpdateObject(id, patch),
  deleteObjectApi: async (id: string) => {
    calls.push({ op: "deleteObject", id });
  },
  createTimingProgramApi: async (payload: Record<string, unknown>) => {
    seq += 1;
    calls.push({ op: "createTimingProgram", payload: plain(payload) });
    return { id: `tp-new-${seq}`, name: payload.name, intervals: payload.intervals ?? [] };
  },
  deleteTimingProgramApi: async (id: string) => {
    calls.push({ op: "deleteTimingProgram", id });
  },
  updateOpticalElementApi: async (objectId: string, patch: Record<string, unknown>) => {
    calls.push({ op: "updateOpticalElement", objectId, patch: plain(patch) });
    return { id: `pe-${objectId}`, objectId, elementKind: patch.elementKind, kindParams: patch.kindParams };
  },
  createOpticalElementApi: async (payload: Record<string, unknown>) => {
    calls.push({ op: "createOpticalElement", payload: plain(payload) });
    return { id: `pe-${payload.objectId}`, ...payload };
  },
}));

const { useSceneStore } = await import("../../store/sceneStore");
getStoreScene = () => useSceneStore.getState().scene;

const FIXTURE_DIR = fileURLToPath(
  new URL("../../../../backend/tests/fixtures/rf_cables/", import.meta.url),
);
const UPDATE = process.env.UPDATE_RF_CABLE_FIXTURES === "1";

// ─── deterministic randomness (same generator as alignParity.test.ts) ──────

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
  const vec = (s: number): V3 => ({ x: uni(-s, s), y: uni(-s, s), z: uni(-s, s) });
  const unitVec = (): V3 => {
    for (;;) {
      const v = vec(1);
      const m = Math.hypot(v.x, v.y, v.z);
      if (m > 0.1 && m <= 1) return { x: v.x / m, y: v.y / m, z: v.z / m };
    }
  };
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)];
  const chance = (p: number): boolean => next() < p;
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  return { next, uni, vec, unitVec, pick, chance, int };
}
type Rng = ReturnType<typeof makeRng>;

type V3 = { x: number; y: number; z: number };
type Tuple3 = [number, number, number];
type Pose = { xMm: number; yMm: number; zMm: number; rxDeg: number; ryDeg: number; rzDeg: number };

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const t3 = (p: V3): Tuple3 => [p.x, p.y, p.z];

function randomPose(r: Rng, spread = 800): Pose {
  const roll = r.next();
  const pos = { xMm: r.uni(-spread, spread), yMm: r.uni(-spread, spread), zMm: r.uni(600, 1200) };
  if (roll < 0.2) return { ...pos, rxDeg: 0, ryDeg: 0, rzDeg: 0 };
  if (roll < 0.45) {
    const q = [-180, -90, 0, 90, 180];
    return { ...pos, rxDeg: r.pick(q), ryDeg: r.pick([-90, 0, 90]), rzDeg: r.pick(q) };
  }
  return { ...pos, rxDeg: r.uni(-180, 180), ryDeg: r.uni(-89, 89), rzDeg: r.uni(-180, 180) };
}

// ─── scene builders (the TS shapes; the Python side reads the same JSON) ────

type SceneJson = {
  objects: SceneObject[];
  components: ComponentItem[];
  componentBindings: ComponentBinding[];
  objectBindings: [];
  assets: Asset3D[];
  physicsElements: PhysicsElement[];
  timingPrograms: { id: string; name: string; intervals: [] }[];
};

function anchor(id: string, pos: V3, extra: Record<string, unknown> = {}): Anchor {
  return { id, positionMmBodyLocal: pos, ...extra } as unknown as Anchor;
}

function asset(id: string, kindId: string, anchors: Anchor[], defaultParams: Record<string, unknown> = {}): Asset3D {
  return { id, name: id, kindId, filePath: `${id}.glb`, anchors, defaultParams } as unknown as Asset3D;
}

function component(id: string, kindId: string | null, extra: Record<string, unknown> = {}): ComponentItem {
  return { id, name: id, kindId, asset3dId: null, properties: {}, ...extra } as unknown as ComponentItem;
}

function binding(p: {
  id: string;
  componentId: string;
  parent?: string | null;
  kind?: "asset" | "subcomponent" | "empty";
  asset?: string | null;
  sub?: string | null;
  role?: string;
  pos?: Tuple3;
  rot?: Tuple3;
  properties?: Record<string, unknown>;
  sortOrder?: number;
}): ComponentBinding {
  const [x, y, z] = p.pos ?? [0, 0, 0];
  const [rx, ry, rz] = p.rot ?? [0, 0, 0];
  return {
    id: p.id,
    componentId: p.componentId,
    parentBindingId: p.parent ?? null,
    targetKind: p.kind ?? "asset",
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

function sceneObject(
  id: string,
  componentId: string,
  pose: Partial<Pose>,
  extra: Partial<SceneObject> = {},
): SceneObject {
  return {
    id,
    name: id.toUpperCase(),
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

function pe(objectId: string, elementKind: string, kindParams: Record<string, unknown> = {}): PhysicsElement {
  return { id: `pe-${objectId}`, objectId, elementKind, kindParams } as unknown as PhysicsElement;
}

function emptySceneJson(): SceneJson {
  return {
    objects: [], components: [], componentBindings: [], objectBindings: [],
    assets: [], physicsElements: [], timingPrograms: [],
  };
}

function toStoreScene(s: SceneJson): SceneData {
  return {
    ...(JSON.parse(JSON.stringify(s)) as SceneJson),
    connections: [],
    assemblyRelations: [],
    deviceStates: [],
    opticalLinks: [],
    beamSegments: [],
    collections: [],
    collectionMembers: [],
  } as unknown as SceneData;
}

/** A coax connector asset the way the catalog authors them: `connect_out`
 *  on the spline node, `connect_in` on the mating face `tipMm` further on. */
function connectorAsset(id: string, family: "sma" | "bnc", tip: number | "coincident" | "missing", r?: Rng): Asset3D {
  const base = r ? r.vec(20) : v(-4, 0, 0);
  const dir = r ? r.unitVec() : v(-1, 0, 0);
  const anchors: Anchor[] = [anchor("connect_out", base, { axisXBodyLocal: dir })];
  if (tip === "coincident") {
    anchors.push(anchor("connect_in", base));
  } else if (tip !== "missing") {
    anchors.push(anchor("connect_in", v(base.x + dir.x * tip, base.y + dir.y * tip, base.z + dir.z * tip)));
  }
  return asset(id, "rf_cable_connector", anchors, { family, gender: "male" });
}

// ─── the RF Link panel gates, transcribed (see the header) ─────────────────

type PanelPort = {
  objectId: string;
  anchorId: string;
  anchorName: string;
  role: "in" | "out";
  domain: RfLinkSignalDomain;
  connectorFamily: "sma" | "bnc" | null;
};
type PortRef = { objectId: string; anchorName: string; anchorId?: string };

const roleOf = (anchorId: string): "in" | "out" =>
  anchorId === "rf_in" || anchorId === "ttl_in" || anchorId === "trigger_in" ? "in" : "out";

/** `RfLinkPanel.nodes` (:913) + `rfLinkPortsOf` (:224) + `rfLinkFallbackPorts`
 *  (:258): the ports the panel offers for one object — `[]` when the object
 *  is not an RF Link node at all. */
function panelPortsOf(scene: SceneData, objectId: string): PanelPort[] {
  const obj = scene.objects.find((o) => o.id === objectId);
  if (!obj) return [];
  const kind = scene.physicsElements.find((p) => p.objectId === objectId)?.elementKind ?? null;
  if (kind === "rf_cable") return [];
  if (!kindParticipatesInRfLink(kind)) return [];
  const comp = scene.components.find((c) => c.id === obj.componentId);
  const anchors = comp ? anchorsInBindingTree(comp, scene).map((o) => o.anchor) : [];
  let ports: PanelPort[] = [];
  for (const a of anchors) {
    const domain = resolveRfLinkPortDomain({ kind, anchorId: a.id });
    if (!domain) continue;
    ports.push({
      objectId, anchorId: a.id, anchorName: a.name ?? a.id, role: roleOf(a.id), domain,
      connectorFamily: connectorFamilyFromAnchor(a),
    });
  }
  if (ports.length === 0) {
    ports = rfLinkRoleAnchors(kind).map(({ anchorId, domain }) => ({
      objectId, anchorId, anchorName: anchorId, role: roleOf(anchorId), domain, connectorFamily: null,
    }));
  }
  return ports;
}

/** `RfLinkPanel.occupiedPortKeys` (:1056). */
function occupiedPortKeys(scene: SceneData): Set<string> {
  const s = new Set<string>();
  const kindOf = new Map(scene.physicsElements.map((p) => [p.objectId, p.elementKind]));
  for (const obj of scene.objects) {
    if (kindOf.get(obj.id) !== "rf_cable") continue;
    const ep = (obj.properties as { rfCableEndpoints?: Record<string, { targetObjectId: string; targetAnchorId: string; targetAnchorName: string } | undefined> })
      .rfCableEndpoints;
    for (const link of [ep?.A, ep?.B]) {
      if (link) s.add(`${link.targetObjectId}|${link.targetAnchorId}|${link.targetAnchorName}`);
    }
  }
  for (const { ppgObjectId, attachment } of ppgAttachments(scene.objects, scene.physicsElements)) {
    s.add(`${attachment.targetObjectId}|${attachment.targetAnchorId}|${attachment.targetAnchorName}`);
    s.add(`${ppgObjectId}|rf_out|rf_out`);
  }
  return s;
}

function findPort(scene: SceneData, ref: PortRef): PanelPort | { code: string } {
  if (!scene.objects.some((o) => o.id === ref.objectId)) return { code: "object_not_found" };
  const hits = panelPortsOf(scene, ref.objectId).filter(
    (p) => p.anchorName === ref.anchorName && (ref.anchorId === undefined || p.anchorId === ref.anchorId),
  );
  if (hits.length === 0) return { code: "port_not_found" };
  if (hits.length > 1) return { code: "ambiguous_port" };
  return hits[0];
}

const busy = (occ: Set<string>, p: PanelPort): boolean =>
  occ.has(`${p.objectId}|${p.anchorId}|${p.anchorName}`);

/** `RfLinkPanel` pointer-up (:1525-1534), in the endpoint's order. */
function connectGate(scene: SceneData, a: PortRef, b: PortRef): { code: string } | { src: PanelPort; tgt: PanelPort } {
  const pa = findPort(scene, a);
  if ("code" in pa) return pa;
  const pb = findPort(scene, b);
  if ("code" in pb) return pb;
  if (pa.objectId === pb.objectId) return { code: "same_object" };
  if (pa.role === pb.role) return { code: "role_mismatch" };
  if (!pa.connectorFamily || !pb.connectorFamily) return { code: "connector_undefined" };
  if (pa.domain !== pb.domain) return { code: "domain_mismatch" };
  const occ = occupiedPortKeys(scene);
  if (busy(occ, pa) || busy(occ, pb)) return { code: "port_busy" };
  // The panel hands the store the OUT port as src (:1535).
  return pa.role === "out" ? { src: pa, tgt: pb } : { src: pb, tgt: pa };
}

/** `RfLinkPanel.canSpawnPpgHere` (:1910). */
function ppgGate(scene: SceneData, ref: PortRef): { code: string } | PanelPort {
  const p = findPort(scene, ref);
  if ("code" in p) return p;
  if (p.role !== "in" || (p.domain !== "ttl" && p.domain !== "trigger")) return { code: "not_a_gate_input" };
  if (!p.connectorFamily) return { code: "connector_undefined" };
  if (busy(occupiedPortKeys(scene), p)) return { code: "port_busy" };
  return p;
}

// ─── running the store flows ───────────────────────────────────────────────

function loadStore(s: SceneJson): void {
  calls.length = 0;
  seq = 0;
  useSceneStore.setState({
    scene: toStoreScene(s),
    activeCollectionId: null,
    selectedObjectId: null,
    selectedObjectIds: [],
  } as never);
}

const posePick = (o: Record<string, unknown>): Pose => ({
  xMm: o.xMm as number, yMm: o.yMm as number, zMm: o.zMm as number,
  rxDeg: o.rxDeg as number, ryDeg: o.ryDeg as number, rzDeg: o.rzDeg as number,
});

/** A `computePpgMountedThreePose` result as the SceneObject pose the backend
 *  stores for it: position back to lab mm (`threeToLabMm`), rotation through
 *  `sceneObjectEulerFromQuaternion` — both the web's own converters. */
function mountedPoseOf(scene: SceneData, ppgObjectId: string): Pose | null {
  const ppg = scene.objects.find((o) => o.id === ppgObjectId);
  if (!ppg) return null;
  const comp = scene.components.find((c) => c.id === ppg.componentId);
  const ppgAsset = comp ? primaryAsset(comp, scene) ?? undefined : undefined;
  const m = computePpgMountedThreePose(scene, ppg, comp, ppgAsset);
  if (!m) return null;
  const p = threeToLabMm(m.positionThree);
  const e = sceneObjectEulerFromQuaternion(m.quaternion);
  return { xMm: p.xMm, yMm: p.yMm, zMm: p.zMm, rxDeg: e.rxDeg, ryDeg: e.ryDeg, rzDeg: e.rzDeg };
}

async function runConnect(s: SceneJson, a: PortRef, b: PortRef): Promise<Json> {
  loadStore(s);
  const scene = getStoreScene();
  const gate = connectGate(scene, a, b);
  if ("code" in gate) return { ok: false, code: gate.code };
  const id = await useSceneStore.getState().createRfCableBetweenPorts({
    srcObjectId: gate.src.objectId, srcAnchorId: gate.src.anchorId, srcAnchorName: gate.src.anchorName,
    tgtObjectId: gate.tgt.objectId, tgtAnchorId: gate.tgt.anchorId, tgtAnchorName: gate.tgt.anchorName,
  });
  if (id === null) {
    const anyCable = scene.components.some((c) => c.kindId === "rf_cable" || c.kindId === "sma_cable");
    if (anyCable) throw new Error("store rejected a connect the gate accepted");
    return { ok: false, code: "no_cable_component" };
  }
  const created = calls.find((c) => c.op === "createObject")!.payload as Record<string, unknown>;
  const patches = calls.filter((c) => c.op === "updateObject");
  const last = patches[patches.length - 1]?.patch as { properties?: unknown } | undefined;
  return {
    ok: true,
    componentId: created.componentId,
    pose: posePick(created),
    properties: last?.properties ?? {},
  };
}

/** The PPGs the endpoint re-mounts on a resnap (a backend ADDITION — the web
 *  re-derives the mount at render time and never persists it): every PPG
 *  plugged into a moved object, or moved itself. The pose is the real
 *  `computePpgMountedThreePose`. */
function ppgMountsFor(scene: SceneData, moved: Set<string>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const { ppgObjectId, attachment } of ppgAttachments(scene.objects, scene.physicsElements)) {
    if (!moved.has(attachment.targetObjectId) && !moved.has(ppgObjectId)) continue;
    out[ppgObjectId] = mountedPoseOf(scene, ppgObjectId);
  }
  return out;
}

async function runResnap(s: SceneJson, movedIds: string[]): Promise<Json> {
  loadStore(s);
  const scene = getStoreScene();
  await useSceneStore.getState().resnapRfCablesLinkedTo(movedIds);
  const patches: Record<string, Json> = {};
  for (const c of calls) {
    if (c.op !== "updateObject") continue;
    patches[c.id as string] = (c.patch as { properties?: Json }).properties ?? null;
  }
  return { patches, ppgMounts: ppgMountsFor(scene, new Set(movedIds)) };
}

async function runAlign(s: SceneJson, cableId: string, end: "A" | "B", toleranceMm: number, pickIndex: number | null): Promise<Json> {
  loadStore(s);
  const list = await useSceneStore.getState().findRfCableAlignmentCandidates(cableId, end, toleranceMm);
  const out: Record<string, Json> = { candidates: plain(list) };
  if (pickIndex !== null && list.length > 0) {
    const cand = list[pickIndex % list.length];
    await useSceneStore.getState().applyRfCableAlignmentCandidate(cableId, end, cand);
    const patch = calls.find((c) => c.op === "updateObject")?.patch as { properties?: Json } | undefined;
    out.picked = {
      objectId: cand.targetObjectId, anchorId: cand.targetAnchorId, anchorName: cand.targetAnchorName,
    };
    out.properties = patch?.properties ?? null;
  }
  return out;
}

function deletedPrograms(before: SceneData, deleted: string[]): string[] {
  const ids: string[] = [];
  for (const id of deleted) {
    const p = before.physicsElements.find((e) => e.objectId === id);
    if (p?.elementKind !== "programmable_pulse_generator") continue;
    const tp = (p.kindParams as { timingProgramId?: unknown }).timingProgramId;
    if (typeof tp === "string" && tp) ids.push(tp);
  }
  return ids;
}

async function runDisconnect(s: SceneJson, cableId: string, end: "A" | "B"): Promise<Json> {
  loadStore(s);
  const before = getStoreScene();
  await useSceneStore.getState().clearRfCableEndpointLink(cableId, end);
  const deleted = calls.filter((c) => c.op === "deleteObject").map((c) => c.id as string);
  return { deleted, deletedPrograms: deletedPrograms(before, deleted) };
}

async function runDetach(s: SceneJson, ppgId: string): Promise<Json> {
  loadStore(s);
  const before = getStoreScene();
  // The RF Link panel's "Disconnect" on a PPG (`handleRemoveCableFromMenu`).
  await useSceneStore.getState().deleteObject(ppgId);
  const deleted = calls.filter((c) => c.op === "deleteObject").map((c) => c.id as string);
  return { deleted, deletedPrograms: deletedPrograms(before, deleted) };
}

async function runPpgAttach(s: SceneJson, ref: PortRef): Promise<Json> {
  loadStore(s);
  const scene = getStoreScene();
  const gate = ppgGate(scene, ref);
  if ("code" in gate) return { ok: false, code: gate.code };
  const created = await useSceneStore.getState().createPpgAtPort({
    targetObjectId: gate.objectId,
    targetAnchorId: gate.anchorId,
    targetAnchorName: gate.anchorName,
    targetConnectorFamily: gate.connectorFamily!,
  });
  if (!created) return { ok: false, code: "no_ppg_component" };
  const obj = calls.find((c) => c.op === "createObject")!.payload as Record<string, unknown>;
  const program = calls.find((c) => c.op === "createTimingProgram")!.payload as Record<string, unknown>;
  const peCall = calls.find((c) => c.op === "updateOpticalElement")!.patch as Record<string, unknown>;
  const { timingProgramId, ...kindParams } = peCall.kindParams as Record<string, unknown>;
  void timingProgramId;
  const attach = calls.filter((c) => c.op === "updateObject").pop()!.patch as { properties: Record<string, unknown> };
  return {
    ok: true,
    componentId: obj.componentId,
    name: obj.name,
    programName: program.name,
    programIntervals: program.intervals,
    elementKind: peCall.elementKind,
    kindParams,
    attachment: attach.properties.ppgAttachment,
    mountedPose: mountedPoseOf(getStoreScene(), created.objectId),
  };
}

// ─── the lab scene (shaped like the live 2026-09 scene) ────────────────────

/** Real catalog numbers: `sma male` (tip 25.45 mm, connect_out→in along −X),
 *  `BNC Male` (tip 43.5 mm along +Z), `PPG BNC Male` (rf_out z=4.8 facing +Z,
 *  matingProtrusionMm 9). Instruments sit at the live scene's rotated poses. */
function labScene(opts: { cables?: "all" | "smaOnly" | "none" } = {}): SceneJson {
  const s = emptySceneJson();
  const cables = opts.cables ?? "all";
  s.assets.push(
    asset("a-sma-male", "rf_cable_connector", [
      anchor("connect_out", v(-4, 0, 0), { axisXBodyLocal: v(1, 0, 0) }),
      anchor("connect_in", v(-29.45, 0, 0), { axisXBodyLocal: v(-1, 0, 0) }),
    ], { family: "sma", gender: "male" }),
    asset("a-bnc-male", "rf_cable_connector", [
      anchor("connect_out", v(0, 0, -29.7), { axisXBodyLocal: v(0, 0, -1) }),
      anchor("connect_in", v(0, 0, 13.8), { axisXBodyLocal: v(0, 0, 1) }),
    ], { family: "bnc", gender: "male" }),
    asset("a-dds", "rf_source", [0, 1, 2, 3].map((i) =>
      anchor("rf_out", v(-20 + 13.4 * i, 5, 12), { name: `CH${i}`, axisXBodyLocal: v(0, 0, 1), connectorType: "sma_female" }),
    )),
    asset("a-switch", "rf_switch", [
      anchor("rf_in", v(0, -12.5, 9), { axisXBodyLocal: v(0, -1, 0), connectorType: "bnc_female" }),
      anchor("rf_out", v(-9, 12.5, 9), { name: "RF1", axisXBodyLocal: v(0, 1, 0), connectorType: "sma_female" }),
      anchor("rf_out", v(9, 12.5, 9), { name: "RF2", axisXBodyLocal: v(0, 1, 0), connectorType: "sma_female" }),
      anchor("ttl_in", v(20, 0, 9), { axisXBodyLocal: v(1, 0, 0), connectorType: "bnc_female" }),
    ]),
    asset("a-amp", "rf_amplifier", [
      anchor("rf_in", v(-55.5, 0, 0), { axisXBodyLocal: v(-1, 0, 0), connectorType: "sma_female" }),
      anchor("rf_out", v(55.5, 0, 0), { axisXBodyLocal: v(1, 0, 0), connectorType: "sma_female" }),
    ]),
    asset("a-aom", "aom", [
      anchor("intercept_in", v(-10, 0, -1.2265), { axisXBodyLocal: v(1, 0, 0), apertureMm: 1.5 }),
      anchor("intercept_out", v(10, 0, -1.2265), { axisXBodyLocal: v(1, 0, 0), apertureMm: 1.5 }),
      anchor("acoustic_axis", v(0, 0, 0), { axisXBodyLocal: v(0, 0, 1) }),
      anchor("rf_in", v(45.5, 0, -1.2265), { axisXBodyLocal: v(1, 0, 0), connectorType: "sma_female" }),
      // A trigger on an AOM exercises the `trigger` domain + a legacy dir.
      anchor("trigger_in", v(30, 10, 0), { directionBodyLocal: v(0, 2, 0), connectorType: "bnc_female" }),
    ]),
    asset("a-eom-mod", "eom", [
      anchor("intercept_in", v(-40, 0, 0), { axisXBodyLocal: v(1, 0, 0) }),
      anchor("rf_in", v(0, 8, 6), { name: "RF IN", axisXBodyLocal: v(0, 0, 1), connectorType: "sma_female" }),
      // A gate input on the multi-root EOM: its PPG must mount (M7).
      anchor("ttl_in", v(10, -8, 6), { name: "BIAS TTL", axisXBodyLocal: v(0, -1, 0), connectorType: "bnc_female" }),
    ]),
    asset("a-fc-apc", "fiber_connector", [
      anchor("fiber_root", v(0, 0, 0)),
      anchor("fiber_out", v(0, 0, 20), { axisXBodyLocal: v(0, 0, 1), connectorType: "fc_apc_male" }),
    ]),
    asset("a-det", "detector", [
      anchor("fiber_in", v(0, 0, 0), { axisXBodyLocal: v(-1, 0, 0), connectorType: "fc_pc_female" }),
      // No connectorType: offered by the panel as "NO CONN".
      anchor("rf_out", v(12, 0, 3), { axisXBodyLocal: v(1, 0, 0) }),
    ]),
    asset("a-ppg-bnc", "programmable_pulse_generator", [
      anchor("rf_out", v(0, 0, 4.8), { axisXBodyLocal: v(0, 0, 1), connectorType: "bnc_male" }),
    ], { matingProtrusionMm: 9 }),
    asset("a-ppg-sma-noport", "programmable_pulse_generator", [
      anchor("trigger_out", v(0, 0, 4), { axisXBodyLocal: v(0, 0, 1), connectorType: "sma_male" }),
    ]),
  );

  const catalogCable = (id: string, name: string, a: string, b: string): void => {
    s.components.push(component(id, "rf_cable", { name, properties: { category: "electronics" } }));
    s.componentBindings.push(
      binding({ id: `${id}-a`, componentId: id, asset: a, role: "end_a", properties: { splineEnd: "A" } }),
      binding({ id: `${id}-b`, componentId: id, asset: b, role: "end_b", properties: { splineEnd: "B" } }),
    );
  };
  if (cables !== "none") catalogCable("c-cable-sma", "RF cable SMA", "a-sma-male", "a-sma-male");
  if (cables === "all") {
    catalogCable("c-cable-bnc-sma", "RF cable BNC SMA", "a-bnc-male", "a-sma-male");
    catalogCable("c-cable-bnc", "RF Cable BNC", "a-bnc-male", "a-bnc-male");
  }

  const device = (cid: string, kindId: string, assetId: string): void => {
    s.components.push(component(cid, kindId));
    s.componentBindings.push(binding({ id: `${cid}-root`, componentId: cid, asset: assetId, role: "root" }));
  };
  device("c-dds", "rf_source", "a-dds");
  device("c-switch", "rf_switch", "a-switch");
  device("c-amp", "rf_amplifier", "a-amp");
  device("c-aom", "aom", "a-aom");
  device("c-det", "detector", "a-det");
  // Multi-root EOM: modulator + two FC/APC pigtail connectors.
  s.components.push(component("c-eom", "eom"));
  s.componentBindings.push(
    binding({ id: "c-eom-mod", componentId: "c-eom", asset: "a-eom-mod", role: "modulator" }),
    binding({ id: "c-eom-fa", componentId: "c-eom", asset: "a-fc-apc", role: "port_a", pos: [-80, 0, 0], sortOrder: 1 }),
    binding({ id: "c-eom-fb", componentId: "c-eom", asset: "a-fc-apc", role: "port_b", pos: [80, 0, 0], sortOrder: 2 }),
  );
  // PPG catalog: an empty SMA shell (no bindings — the ppgHasUsableAsset
  // regression), an SMA PPG whose asset has no rf_out, and the real BNC one.
  s.components.push(component("c-ppg-sma-shell", "programmable_pulse_generator", { properties: { connectorType: "sma" } }));
  s.components.push(component("c-ppg-sma-noport", "programmable_pulse_generator", { properties: { connectorType: "sma" } }));
  s.componentBindings.push(binding({ id: "c-ppg-sma-noport-root", componentId: "c-ppg-sma-noport", asset: "a-ppg-sma-noport" }));
  s.components.push(component("c-ppg-bnc", "programmable_pulse_generator", { properties: { category: "electronics", connectorType: "bnc" } }));
  s.componentBindings.push(binding({ id: "c-ppg-bnc-root", componentId: "c-ppg-bnc", asset: "a-ppg-bnc", role: "PPG BNC Male" }));

  const place = (id: string, cid: string, kind: string, pose: Pose, extra: Partial<SceneObject> = {}): void => {
    s.objects.push(sceneObject(id, cid, pose, extra));
    s.physicsElements.push(pe(id, kind));
  };
  place("dds", "c-dds", "rf_source", { xMm: -910.099, yMm: 754.744, zMm: 704.245, rxDeg: -90, ryDeg: 0, rzDeg: 180 });
  place("switch", "c-switch", "rf_switch", { xMm: -1239.576, yMm: 761.745, zMm: 699.415, rxDeg: -90, ryDeg: 0, rzDeg: 180 });
  place("amp0", "c-amp", "rf_amplifier", { xMm: -1602.456, yMm: 767, zMm: 689.665, rxDeg: -90, ryDeg: 0, rzDeg: 180 });
  place("amp1", "c-amp", "rf_amplifier", { xMm: -1602.259, yMm: 767, zMm: 752.648, rxDeg: 90, ryDeg: -180, rzDeg: 0 });
  place("aom", "c-aom", "aom", { xMm: -441.212, yMm: -211.749, zMm: 905.233, rxDeg: 0, ryDeg: 0, rzDeg: -179.535 });
  place("eom", "c-eom", "eom", { xMm: -1100, yMm: -308.229, zMm: 992.989, rxDeg: 0, ryDeg: 0, rzDeg: 180 });
  place("det", "c-det", "detector", { xMm: -904.02, yMm: -127.12, zMm: 962.463, rxDeg: 0, ryDeg: 0, rzDeg: -180 });
  // A locked instrument: connecting to it must still work (the cable, not
  // the instrument, is written).
  place("amp2", "c-amp", "rf_amplifier", { xMm: -1500, yMm: 500, zMm: 700, rxDeg: 0, ryDeg: 30, rzDeg: 15 }, { locked: true });

  if (cables !== "none") {
    // RF_CABLE0: dds CH0 → amp0 rf_in (so both are busy), stale nodes.
    s.objects.push(sceneObject("cable0", "c-cable-sma", { xMm: -1200, yMm: 44, zMm: 1088 }, {
      properties: {
        rfCableEndpoints: {
          A: { targetObjectId: "dds", targetAnchorId: "rf_out", targetAnchorName: "CH0" },
          B: { targetObjectId: "amp0", targetAnchorId: "rf_in", targetAnchorName: "rf_in" },
        },
        rfCableNodes: [
          { posMm: [300, -700, -380], handleOutMm: [0, 30, 0] },
          { posMm: [0, 0, 0], handleInMm: [-20, 0, 0], handleOutMm: [20, 0, 0] },
          { posMm: [-400, 720, -400], handleInMm: [0, -30, 0] },
        ],
      },
    }));
    s.physicsElements.push(pe("cable0", "rf_cable", { lengthMm: 152 }));
    // Two unlinked cables whose end B is parked 3 mm in front of a port
    // (face = node + outward × the 15.5 mm procedural tip) on an
    // instrument rotated about x (dds CH2) / about y (amp2 rf_out). The port
    // is placed with the real SceneObject rotation (`optical/pose`).
    const park = (id: string, objectId: string, anchorName: string, origin: V3): void => {
      const obj = s.objects.find((o) => o.id === objectId)!;
      const comp = s.components.find((c) => c.id === obj.componentId)!;
      const assetId = s.componentBindings.find((b) => b.componentId === comp.id)!.asset3dId!;
      const a = s.assets.find((x) => x.id === assetId)!.anchors.find((x) => (x.name ?? x.id) === anchorName)!;
      const port = pointBodyToLab(a.positionMmBodyLocal, obj);
      const out = dirBodyToLab(a.axisXBodyLocal!, obj);
      const k = 3 + 15.5;
      const nodeB: Tuple3 = [port.x + out.x * k - origin.x, port.y + out.y * k - origin.y, port.z + out.z * k - origin.z];
      s.objects.push(sceneObject(id, "c-cable-sma", { xMm: origin.x, yMm: origin.y, zMm: origin.z }, {
        properties: {
          rfCableEndpoints: {},
          rfCableNodes: [
            { posMm: [nodeB[0] + 200, nodeB[1], nodeB[2]], handleOutMm: [-30, 0, 0] },
            { posMm: nodeB, handleInMm: [out.x * 30, out.y * 30, out.z * 30] },
          ],
        },
      }));
      s.physicsElements.push(pe(id, "rf_cable"));
    };
    park("loose-dds", "dds", "CH2", v(-800, 600, 800));
    park("loose-amp2", "amp2", "rf_out", v(-1400, 450, 750));
  }
  // PPG CH0 plugged into the AOM's trigger_in, its program bound.
  s.objects.push(sceneObject("ppg0", "c-ppg-bnc", { xMm: -777.171, yMm: 108.736, zMm: 954.982 }, {
    name: "CH0",
    properties: { ppgAttachment: { targetObjectId: "aom", targetAnchorId: "trigger_in", targetAnchorName: "trigger_in" } },
  }));
  s.physicsElements.push(pe("ppg0", "programmable_pulse_generator", {
    connectorType: "bnc", timingProgramId: "tp-0", outputDomain: "rfout", highVoltageV: 3.2,
  }));
  s.timingPrograms.push({ id: "tp-0", name: "CH0", intervals: [] });
  return s;
}

// ─── random scenes ─────────────────────────────────────────────────────────

const RF_KINDS = ["rf_source", "rf_amplifier", "rf_switch", "aom", "eom", "detector", "horn_antenna"] as const;
const CONNECTOR_TYPES = ["sma_female", "bnc_female", "sma_male", "bnc_male", undefined, "fc_pc_female"] as const;

function randomAnchor(r: Rng, id: string, name?: string): Anchor {
  const extra: Record<string, unknown> = {};
  if (name !== undefined) extra.name = name;
  const roll = r.next();
  if (roll < 0.72) extra.axisXBodyLocal = r.unitVec();
  else if (roll < 0.87) extra.directionBodyLocal = { ...r.unitVec(), x: r.uni(-3, 3) };
  else if (roll < 0.93) extra.axisXBodyLocal = v(0, 0, 0);
  // else: no direction at all → +X default
  if (r.chance(0.35)) extra.axisYBodyLocal = r.unitVec();
  const ct = r.pick(CONNECTOR_TYPES);
  if (ct !== undefined) extra.connectorType = ct;
  return anchor(id, r.vec(60), extra);
}

function anchorsForKind(r: Rng, kind: string): Anchor[] {
  switch (kind) {
    case "rf_source":
      return Array.from({ length: r.int(1, 4) }, (_, i) => randomAnchor(r, "rf_out", `CH${i}`));
    case "rf_amplifier":
      return [randomAnchor(r, "rf_in"), randomAnchor(r, "rf_out")];
    case "rf_switch":
      return [randomAnchor(r, "rf_in"), randomAnchor(r, "rf_out", "RF1"), randomAnchor(r, "rf_out", "RF2"), randomAnchor(r, "ttl_in")];
    case "aom":
      return [randomAnchor(r, "intercept_in"), randomAnchor(r, "rf_in"), ...(r.chance(0.5) ? [randomAnchor(r, "trigger_in")] : [])];
    case "eom":
      return [randomAnchor(r, "rf_in", r.chance(0.5) ? "RF IN" : undefined), ...(r.chance(0.4) ? [randomAnchor(r, "ttl_in")] : [])];
    case "detector":
      return [randomAnchor(r, "rf_out"), randomAnchor(r, "fiber_in")];
    case "horn_antenna":
      return [randomAnchor(r, "aperture")];
    default:
      return [randomAnchor(r, "intercept_face")];
  }
}

type RandomScene = { scene: SceneJson; cableIds: string[]; ppgIds: string[]; objectIds: string[] };

function randomScene(r: Rng, tag: string): RandomScene {
  const s = emptySceneJson();
  const cableIds: string[] = [];
  const ppgIds: string[] = [];

  // Cable catalog.
  const nCableComps = r.int(0, 4);
  for (let i = 0; i < nCableComps; i += 1) {
    const cid = `${tag}-cc${i}`;
    const props: Record<string, unknown> = {};
    if (r.chance(0.4)) props.lengthMm = r.uni(60, 400);
    if (r.chance(0.15)) props.endAConnector = r.pick(["bnc_male", "sma_male"]);
    if (r.chance(0.15)) props.connectorType = r.pick(["sma", "bnc"]);
    s.components.push(component(cid, r.chance(0.9) ? "rf_cable" : "sma_cable", { properties: props }));
    const nConn = r.chance(0.85) ? 2 : r.int(0, 1);
    const keying = r.pick(["both", "role", "splineEnd"] as const);
    for (let k = 0; k < nConn; k += 1) {
      const aid = `${cid}-conn${k}`;
      const tipRoll = r.next();
      s.assets.push(connectorAsset(
        aid, r.pick(["sma", "bnc"] as const),
        tipRoll < 0.8 ? r.uni(10, 50) : tipRoll < 0.9 ? "coincident" : "missing", r,
      ));
      const end = k === 0 ? "A" : "B";
      const role = keying === "splineEnd" ? `conn${k}` : end === "A" ? "end_a" : "end_b";
      const properties = keying === "role" ? {} : { splineEnd: end };
      s.componentBindings.push(binding({
        id: `${cid}-b${k}`, componentId: cid, asset: aid, role, properties,
        sortOrder: r.chance(0.2) ? 5 - k : k,
      }));
    }
  }

  // PPG catalog.
  const nPpgComps = r.int(1, 3);
  for (let i = 0; i < nPpgComps; i += 1) {
    const cid = `${tag}-pc${i}`;
    const props: Record<string, unknown> = {};
    if (r.chance(0.9)) props.connectorType = i % 2 === 0 ? "bnc" : "sma";
    s.components.push(component(cid, "programmable_pulse_generator", { properties: props }));
    if (r.chance(0.85)) {
      const aid = `${cid}-asset`;
      const anchors = r.chance(0.9) ? [randomAnchor(r, "rf_out")] : [randomAnchor(r, "trigger_out")];
      const dp: Record<string, unknown> = {};
      const pr = r.next();
      if (pr < 0.5) dp.matingProtrusionMm = r.uni(0.5, 15);
      else if (pr < 0.6) dp.matingProtrusionMm = -3;
      s.assets.push(asset(aid, "programmable_pulse_generator", anchors, dp));
      if (r.chance(0.8)) s.componentBindings.push(binding({ id: `${cid}-root`, componentId: cid, asset: aid }));
      else (s.components[s.components.length - 1] as unknown as { asset3dId: string }).asset3dId = aid;
    }
  }

  // Instruments.
  const nInst = r.int(3, 6);
  const instIds: string[] = [];
  for (let i = 0; i < nInst; i += 1) {
    const kind = r.chance(0.12) ? "mirror" : r.pick(RF_KINDS);
    const cid = `${tag}-ic${i}`;
    const oid = `${tag}-i${i}`;
    s.components.push(component(cid, kind));
    const aid = `${cid}-asset`;
    const anchors = anchorsForKind(r, kind);
    const shape = r.next();
    if (shape < 0.5) {
      s.assets.push(asset(aid, kind, anchors));
      s.componentBindings.push(binding({ id: `${cid}-root`, componentId: cid, asset: aid }));
    } else if (shape < 0.68) {
      s.assets.push(asset(aid, kind, anchors));
      (s.components[s.components.length - 1] as unknown as { asset3dId: string }).asset3dId = aid;
    } else if (shape < 0.84) {
      // Multi-root: the ports on one root, a connector-ish asset on another.
      s.assets.push(asset(aid, kind, anchors));
      s.assets.push(asset(`${aid}-2`, "fiber_connector", [randomAnchor(r, "fiber_out"), ...(r.chance(0.5) ? [randomAnchor(r, "rf_in")] : [])]));
      s.componentBindings.push(
        binding({ id: `${cid}-r0`, componentId: cid, asset: aid, pos: t3(r.vec(20)) }),
        binding({ id: `${cid}-r1`, componentId: cid, asset: `${aid}-2`, pos: t3(r.vec(50)), rot: [r.uni(-90, 90), 0, 0], sortOrder: 1 }),
      );
    } else if (shape < 0.95) {
      // Root asset + a transformed child asset carrying half the ports.
      const half = Math.ceil(anchors.length / 2);
      s.assets.push(asset(aid, kind, anchors.slice(0, half)));
      s.assets.push(asset(`${aid}-c`, kind, anchors.slice(half)));
      s.componentBindings.push(
        binding({ id: `${cid}-root`, componentId: cid, asset: aid }),
        binding({ id: `${cid}-child`, componentId: cid, parent: `${cid}-root`, asset: `${aid}-c`, pos: t3(r.vec(30)), rot: [0, 0, r.uni(-180, 180)] }),
      );
    }
    // else: no asset at all → the panel's role-contract fallback ports.
    s.objects.push(sceneObject(oid, cid, randomPose(r), { locked: r.chance(0.1) }));
    if (!r.chance(0.06)) s.physicsElements.push(pe(oid, kind));
    instIds.push(oid);
  }

  const allRefs = (): { objectId: string; anchorId: string; anchorName: string }[] => {
    const out: { objectId: string; anchorId: string; anchorName: string }[] = [];
    const scene = toStoreScene(s);
    for (const o of scene.objects) {
      const comp = scene.components.find((c) => c.id === o.componentId);
      if (!comp) continue;
      for (const { anchor: a } of anchorsInBindingTree(comp, scene)) {
        out.push({ objectId: o.id, anchorId: a.id, anchorName: a.name ?? a.id });
      }
    }
    return out;
  };

  // PPG instances (plugged into a random port, sometimes malformed).
  const ppgComps = s.components.filter((c) => c.kindId === "programmable_pulse_generator");
  const nPpg = ppgComps.length > 0 ? r.int(0, 2) : 0;
  for (let i = 0; i < nPpg; i += 1) {
    const oid = `${tag}-ppg${i}`;
    const refs = allRefs().filter((x) => instIds.includes(x.objectId));
    const props: Record<string, unknown> = {};
    const roll = r.next();
    if (roll < 0.75 && refs.length > 0) {
      const ref = r.pick(refs);
      props.ppgAttachment = { targetObjectId: ref.objectId, targetAnchorId: ref.anchorId, targetAnchorName: ref.anchorName };
    } else if (roll < 0.85) {
      props.ppgAttachment = { targetObjectId: r.pick(instIds), targetAnchorId: "ttl_in" };
    }
    s.objects.push(sceneObject(oid, r.pick(ppgComps).id, randomPose(r), { properties: props, locked: r.chance(0.1) }));
    s.physicsElements.push(pe(oid, "programmable_pulse_generator", { timingProgramId: `tp-${oid}` }));
    if (r.chance(0.85)) s.timingPrograms.push({ id: `tp-${oid}`, name: `CH${i}`, intervals: [] });
    ppgIds.push(oid);
  }

  // Cable instances.
  const cableComps = s.components.filter((c) => c.kindId === "rf_cable" || c.kindId === "sma_cable");
  const nCables = cableComps.length > 0 ? r.int(0, 3) : 0;
  for (let i = 0; i < nCables; i += 1) {
    const oid = `${tag}-cable${i}`;
    const refs = allRefs().filter((x) => x.objectId !== oid);
    const link = (): Record<string, string> | undefined => {
      const roll = r.next();
      if (roll < 0.7 && refs.length > 0) {
        const ref = r.pick(refs);
        return { targetObjectId: ref.objectId, targetAnchorId: ref.anchorId, targetAnchorName: ref.anchorName };
      }
      if (roll < 0.8) return { targetObjectId: `${tag}-gone`, targetAnchorId: "rf_in", targetAnchorName: "rf_in" };
      if (roll < 0.87 && ppgIds.length > 0) {
        return { targetObjectId: r.pick(ppgIds), targetAnchorId: "rf_out", targetAnchorName: "rf_out" };
      }
      return undefined;
    };
    const eps: Record<string, unknown> = {};
    const la = link();
    const lb = link();
    if (la) eps.A = la;
    if (lb) eps.B = lb;
    const props: Record<string, unknown> = { rfCableEndpoints: eps };
    if (r.chance(0.6)) {
      const n = r.int(2, 4);
      props.rfCableNodes = Array.from({ length: n }, () => {
        const node: Record<string, unknown> = { posMm: t3(r.vec(300)) };
        if (r.chance(0.6)) node.handleOutMm = r.chance(0.1) ? [0, 0, 0] : t3(r.vec(40));
        if (r.chance(0.6)) node.handleInMm = r.chance(0.1) ? [0, 0, 0] : t3(r.vec(40));
        return node;
      });
    } else if (r.chance(0.2)) {
      props.rfCableNodes = [{ posMm: t3(r.vec(100)) }];
    }
    const pose = r.chance(0.7) ? { ...randomPose(r), rxDeg: 0, ryDeg: 0, rzDeg: 0 } : randomPose(r);
    s.objects.push(sceneObject(oid, r.pick(cableComps).id, pose, { properties: props, locked: r.chance(0.12) }));
    s.physicsElements.push(pe(oid, "rf_cable"));
    cableIds.push(oid);
  }

  // Scene order is DB heap order in the real app; shuffle so nothing relies
  // on instruments preceding cables.
  for (let i = s.objects.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r.next() * (i + 1));
    [s.objects[i], s.objects[j]] = [s.objects[j], s.objects[i]];
  }
  return { scene: s, cableIds, ppgIds, objectIds: s.objects.map((o) => o.id) };
}

// ─── fixture: the pure functions ───────────────────────────────────────────

function buildPure(): Json {
  const r = makeRng(0x7fca11e);

  // resolveLinkedRfCableEndpoint — the connect / resnap mating math.
  const linked: Json[] = [];
  const linkedInputs: Parameters<typeof resolveLinkedRfCableEndpoint>[0][] = [
    {
      endpoint: "B",
      cablePose: { xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 0, rzDeg: 0 },
      targetPose: { xMm: -441.212, yMm: -211.749, zMm: 905.233, rxDeg: 0, ryDeg: 0, rzDeg: -179.535 },
      targetAnchorPosBodyMm: [45.5, 0, -1.2265],
      targetAnchorDirBody: [1, 0, 0],
      connectorTipMm: 25.45,
    },
    {
      endpoint: "A",
      cablePose: { xMm: 10, yMm: 20, zMm: 30, rxDeg: 0, ryDeg: 0, rzDeg: 0 },
      targetPose: { xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 0, rzDeg: 0 },
      targetAnchorPosBodyMm: [1, 2, 3],
      targetAnchorDirBody: [0, 0, 0],
    },
  ];
  for (let i = 0; i < 40; i += 1) {
    linkedInputs.push({
      endpoint: r.pick(["A", "B"] as const),
      cablePose: r.chance(0.6) ? { ...randomPose(r), rxDeg: 0, ryDeg: 0, rzDeg: 0 } : randomPose(r),
      targetPose: randomPose(r),
      targetAnchorPosBodyMm: t3(r.vec(80)),
      targetAnchorDirBody: r.chance(0.8) ? t3(r.unitVec()) : [r.uni(-3, 3), r.uni(-3, 3), r.uni(-3, 3)],
      ...(r.chance(0.8) ? { connectorTipMm: r.uni(5, 50) } : {}),
      ...(r.chance(0.2) ? { handleMagnitudeMm: r.uni(1, 80) } : {}),
    });
  }
  for (const input of linkedInputs) linked.push({ input: plain(input), output: plain(resolveLinkedRfCableEndpoint(input)) });

  // findRfCableEndpointAlignmentCandidates — the align-candidates math.
  const cands: Json[] = [];
  for (let i = 0; i < 30; i += 1) {
    const n = r.int(2, 5);
    const nodes = Array.from({ length: n }, () => {
      const node: { posMm: Tuple3; handleInMm?: Tuple3; handleOutMm?: Tuple3 } = { posMm: t3(r.vec(200)) };
      if (r.chance(0.6)) node.handleOutMm = r.chance(0.15) ? [0, 0, 0] : t3(r.vec(40));
      if (r.chance(0.6)) node.handleInMm = r.chance(0.15) ? [0, 0, 0] : t3(r.vec(40));
      return node;
    });
    if (i === 0) nodes[1] = { posMm: [...nodes[0].posMm] as Tuple3 }; // coincident neighbour
    const cablePose = r.chance(0.5) ? { ...randomPose(r, 200), rxDeg: 0, ryDeg: 0, rzDeg: 0 } : randomPose(r, 200);
    const ports = Array.from({ length: r.int(0, 6) }, (_, k) => ({
      labPosMm: t3(r.vec(900)),
      labDirOutward: r.chance(0.9) ? t3(r.unitVec()) : ([0, 0, 0] as Tuple3),
      targetName: `T${k}`,
      targetObjectId: `o${k}`,
      targetAnchorName: `P${k}`,
      targetAnchorId: r.pick(["rf_in", "rf_out"]),
    }));
    // Two ports at the same spot: the sort must keep their input order.
    if (ports.length > 1 && r.chance(0.3)) ports[1] = { ...ports[1], labPosMm: [...ports[0].labPosMm] as Tuple3 };
    const input = {
      endpoint: r.pick(["A", "B"] as const),
      cablePose,
      cableNodes: nodes,
      ports,
      toleranceMm: r.pick([25, 400, 2000, 1e6]),
      ...(r.chance(0.2) ? { handleMagnitudeMm: r.uni(1, 80) } : {}),
      // Most calls pass the bound connector's own length; some rely on the
      // procedural default.
      ...(i % 4 !== 3 ? { connectorTipMm: r.pick([25.45, 43.5, r.uni(5, 60)]) } : {}),
    };
    cands.push({ input: plain(input), output: plain(findRfCableEndpointAlignmentCandidates(input)) });
  }

  // connectorTipMmFromAnchors.
  const tips: Json[] = [];
  const tipCases: { anchors: Anchor[] | null; family: string | null }[] = [
    { anchors: connectorAsset("x", "sma", 25.45).anchors as Anchor[], family: null },
    { anchors: connectorAsset("x", "bnc", "coincident").anchors as Anchor[], family: "bnc_male" },
    { anchors: connectorAsset("x", "bnc", "missing").anchors as Anchor[], family: "BNC" },
    { anchors: null, family: "sma" },
    { anchors: [], family: null },
    { anchors: [anchor("connect_in", v(1, 2, 3)), anchor("connect_out", v(1, 2, 3.0000005))], family: null },
  ];
  for (let i = 0; i < 6; i += 1) tipCases.push({ anchors: connectorAsset("x", "sma", r.uni(5, 60), r).anchors as Anchor[], family: null });
  for (const c of tipCases) tips.push({ input: plain(c), output: connectorTipMmFromAnchors(c.anchors, c.family) });

  // Port domains, per the plugin contracts (pins the manifest-driven Python).
  const kinds: (string | null)[] = [null, "unknown_kind", ...PHYSICS_PLUGINS.map((p) => p.physics.elementKind)];
  const anchorIds = [
    "rf_in", "rf_out", "ttl_in", "ttl_out", "trigger_in", "trigger_out", "gate_in",
    "intercept_in", "intercept_face", "fiber_in", "fiber_out", "aperture", "connect_in", "acoustic_axis", "CH0",
  ];
  const domains: Json[] = kinds.map((kind) => ({
    kind,
    participates: kindParticipatesInRfLink(kind),
    domains: Object.fromEntries(anchorIds.map((id) => [id, resolveRfLinkPortDomain({ kind, anchorId: id })])),
    roleAnchors: rfLinkRoleAnchors(kind),
  }));
  // No `domainsAreCompatible` table: the store's compatibility check runs
  // after the panel's stricter exact-domain gate, so it can never decide.
  const families = ["sma_female", "sma_male", "bnc_female", "bnc_male", "sma", "bnc", "SMA_female", "fc_pc_female", "n_female", "", null]
    .map((ct) => ({ connectorType: ct, family: connectorFamilyFromAnchor(ct === null ? {} : ({ connectorType: ct } as never)) }));

  // computePpgMountedThreePose, as the SceneObject pose the backend stores.
  const mounts: Json[] = [];
  const mountScene = (i: number): { scene: SceneJson; ppgId: string } => {
    const s = emptySceneJson();
    const targetKind = r.pick(["rf_switch", "aom", "eom"]);
    const targetAnchors = [randomAnchor(r, "ttl_in", r.chance(0.3) ? "TTL IN" : undefined), randomAnchor(r, "trigger_in")];
    const shape = r.next();
    s.assets.push(asset("tgt-asset", targetKind, targetAnchors));
    s.components.push(component("tgt-comp", targetKind));
    if (shape < 0.6) s.componentBindings.push(binding({ id: "tgt-root", componentId: "tgt-comp", asset: "tgt-asset" }));
    else if (shape < 0.8) (s.components[0] as unknown as { asset3dId: string }).asset3dId = "tgt-asset";
    else {
      // Multi-root: primaryAsset gives up → the mount does not resolve.
      s.assets.push(asset("tgt-conn", "fiber_connector", [randomAnchor(r, "fiber_out")]));
      s.componentBindings.push(
        binding({ id: "tgt-r0", componentId: "tgt-comp", asset: "tgt-asset" }),
        binding({ id: "tgt-r1", componentId: "tgt-comp", asset: "tgt-conn", sortOrder: 1 }),
      );
    }
    const dp: Record<string, unknown> = {};
    // A non-number protrusion (hand-edited JSON) reads as 0.
    if (r.chance(0.6)) dp.matingProtrusionMm = r.chance(0.9) ? r.uni(0.5, 15) : "9";
    s.assets.push(asset("ppg-asset", "programmable_pulse_generator", [
      ...(r.chance(0.3) ? [randomAnchor(r, "trigger_out")] : []),
      randomAnchor(r, "rf_out"),
      randomAnchor(r, "rf_out", "second"),
    ], dp));
    s.components.push(component("ppg-comp", "programmable_pulse_generator", { properties: { connectorType: "bnc" } }));
    s.componentBindings.push(binding({ id: "ppg-root", componentId: "ppg-comp", asset: "ppg-asset" }));
    s.objects.push(sceneObject("tgt", "tgt-comp", randomPose(r)));
    s.physicsElements.push(pe("tgt", targetKind));
    const which = r.pick(targetAnchors);
    const att: Record<string, string> = {
      targetObjectId: "tgt", targetAnchorId: which.id, targetAnchorName: (which.name as string | undefined) ?? which.id,
    };
    if (i % 7 === 3) att.targetAnchorName = "nope";
    s.objects.push(sceneObject("ppg", "ppg-comp", randomPose(r), { properties: { ppgAttachment: att } }));
    s.physicsElements.push(pe("ppg", "programmable_pulse_generator"));
    return { scene: s, ppgId: "ppg" };
  };
  for (let i = 0; i < 30; i += 1) {
    const { scene, ppgId } = mountScene(i);
    mounts.push({ scene: plain(scene), ppgObjectId: ppgId, output: mountedPoseOf(toStoreScene(scene), ppgId) });
  }
  // The ppgMounting.test.ts geometry (M1/M3/M6): switch at x=100, ttl_in at
  // body −20 facing −X, PPG rf_out at +5 facing +X.
  for (const protrusion of [0, 9]) {
    const s = emptySceneJson();
    s.assets.push(asset("host", "rf_switch", [anchor("ttl_in", v(-20, 0, 0), { axisXBodyLocal: v(-1, 0, 0) })]));
    s.assets.push(asset("ppg", "programmable_pulse_generator", [anchor("rf_out", v(5, 0, 0), { axisXBodyLocal: v(1, 0, 0) })],
      protrusion ? { matingProtrusionMm: protrusion } : {}));
    s.components.push(component("comp-host", "rf_switch"), component("comp-ppg", "programmable_pulse_generator"));
    s.componentBindings.push(
      binding({ id: "bind-host", componentId: "comp-host", asset: "host" }),
      binding({ id: "bind-ppg", componentId: "comp-ppg", asset: "ppg" }),
    );
    s.objects.push(sceneObject("host", "comp-host", { xMm: 100 }));
    s.objects.push(sceneObject("ppg", "comp-ppg", { xMm: -500, yMm: 300 }, {
      properties: { ppgAttachment: { targetObjectId: "host", targetAnchorId: "ttl_in", targetAnchorName: "ttl_in" } },
    }));
    s.physicsElements.push(pe("host", "rf_switch"), pe("ppg", "programmable_pulse_generator"));
    mounts.push({ scene: plain(s), ppgObjectId: "ppg", output: mountedPoseOf(toStoreScene(s), "ppg") });
  }
  // Legacy PPG wired through an rf_cable (no attachment record).
  {
    const s = emptySceneJson();
    s.assets.push(asset("host", "rf_switch", [anchor("ttl_in", v(-20, 0, 0), { axisXBodyLocal: v(-1, 0, 0) })]));
    s.assets.push(asset("ppg", "programmable_pulse_generator", [anchor("rf_out", v(5, 0, 0), { axisXBodyLocal: v(1, 0, 0) })]));
    s.components.push(component("comp-host", "rf_switch", { asset3dId: "host" }), component("comp-ppg", "programmable_pulse_generator", { asset3dId: "ppg" }));
    s.objects.push(sceneObject("host", "comp-host", { xMm: 100, rzDeg: 33 }));
    s.objects.push(sceneObject("ppg", "comp-ppg", {}));
    s.objects.push(sceneObject("cable", "comp-cable", {}, {
      properties: { rfCableEndpoints: {
        A: { targetObjectId: "host", targetAnchorId: "ttl_in", targetAnchorName: "ttl_in" },
        B: { targetObjectId: "ppg", targetAnchorId: "rf_out", targetAnchorName: "rf_out" },
      } },
    }));
    s.physicsElements.push(pe("host", "rf_switch"), pe("ppg", "programmable_pulse_generator"), pe("cable", "rf_cable"));
    mounts.push({ scene: plain(s), ppgObjectId: "ppg", output: mountedPoseOf(toStoreScene(s), "ppg") });
  }

  return {
    resolveLinked: linked,
    alignCandidates: cands,
    connectorTip: tips,
    portDomains: domains,
    connectorFamily: families,
    ppgMount: mounts,
  };
}

// ─── fixture: the store flows ──────────────────────────────────────────────

async function buildFlows(): Promise<Json> {
  const scenes: { name: string; scene: SceneJson }[] = [];
  const cases: Json[] = [];
  const addScene = (name: string, scene: SceneJson): number => {
    scenes.push({ name, scene: plain(scene) as SceneJson });
    return scenes.length - 1;
  };

  // Hand-picked, on the lab scene.
  const lab = labScene();
  const iLab = addScene("lab", lab);
  const P = (objectId: string, anchorName: string, anchorId?: string): PortRef =>
    (anchorId === undefined ? { objectId, anchorName } : { objectId, anchorName, anchorId });
  const connects: [string, PortRef, PortRef][] = [
    ["sma-sma direct", P("dds", "CH1"), P("amp1", "rf_in")],
    ["request order in→out", P("amp1", "rf_in"), P("dds", "CH1")],
    ["switch RF1 → AOM rf_in (rotated AOM)", P("switch", "RF1"), P("aom", "rf_in")],
    ["sma out → bnc in: reverse-swapped BNC-SMA cable", P("dds", "CH2"), P("switch", "rf_in")],
    ["multi-root EOM rf_in", P("dds", "CH3", "rf_out"), P("eom", "RF IN", "rf_in")],
    ["locked instrument end", P("amp2", "rf_out"), P("aom", "rf_in")],
    ["same object", P("amp1", "rf_out"), P("amp1", "rf_in")],
    ["both outs", P("dds", "CH1"), P("amp1", "rf_out")],
    ["rf ↔ ttl", P("dds", "CH3"), P("switch", "ttl_in")],
    ["PPG rfout ↔ ttl (panel: exact domain)", P("ppg0", "rf_out"), P("switch", "ttl_in")],
    ["busy target", P("dds", "CH1"), P("amp0", "rf_in")],
    ["busy source", P("dds", "CH0"), P("amp1", "rf_in")],
    ["switch RF2 → amp1 (both rotated)", P("switch", "RF2", "rf_out"), P("amp1", "rf_in")],
    ["no connector on detector rf_out", P("det", "rf_out"), P("amp1", "rf_in")],
    ["unknown port name", P("dds", "CH9"), P("amp1", "rf_in")],
    ["unknown object", P("nope", "CH1"), P("amp1", "rf_in")],
    ["optical anchor is not an RF port", P("aom", "intercept_in"), P("dds", "CH1")],
  ];
  for (const [label, a, b] of connects) {
    cases.push({ label, scene: iLab, op: "connect", request: { a, b }, expected: await runConnect(lab, a, b) });
  }
  const labSmaOnly = labScene({ cables: "smaOnly" });
  const iSmaOnly = addScene("lab-sma-only", labSmaOnly);
  cases.push({
    label: "no matching variant → first rf_cable fallback",
    scene: iSmaOnly, op: "connect", request: { a: P("dds", "CH2"), b: P("switch", "rf_in") },
    expected: await runConnect(labSmaOnly, P("dds", "CH2"), P("switch", "rf_in")),
  });
  const labNoCables = labScene({ cables: "none" });
  const iNoCables = addScene("lab-no-cables", labNoCables);
  cases.push({
    label: "no cable component at all",
    scene: iNoCables, op: "connect", request: { a: P("dds", "CH1"), b: P("amp1", "rf_in") },
    expected: await runConnect(labNoCables, P("dds", "CH1"), P("amp1", "rf_in")),
  });

  cases.push({ label: "resnap dds + amp0", scene: iLab, op: "resnap", request: { movedObjectIds: ["dds", "amp0"] }, expected: await runResnap(lab, ["dds", "amp0"]) });
  cases.push({ label: "resnap aom (PPG re-mount)", scene: iLab, op: "resnap", request: { movedObjectIds: ["aom"] }, expected: await runResnap(lab, ["aom"]) });
  cases.push({ label: "resnap nothing linked", scene: iLab, op: "resnap", request: { movedObjectIds: ["det"] }, expected: await runResnap(lab, ["det"]) });
  for (const end of ["A", "B"] as const) {
    for (const tol of [25, 2000]) {
      cases.push({
        label: `align candidates cable0 ${end} tol ${tol}`,
        scene: iLab, op: "align", request: { cableId: "cable0", end, toleranceMm: tol, pickIndex: 0 },
        expected: await runAlign(lab, "cable0", end, tol, 0),
      });
    }
  }
  // Loose cable ends parked 3 mm off a port of an instrument rotated about x
  // (the DDS at rx −90 / rz 180, like the live bench) and one rotated about
  // y (amp2, ry 30 / rz 15), placed through the REAL SceneObject rotation.
  // With the mirror-image rotation the store used to have, neither port is
  // inside the 25 mm window.
  for (const [cableId, axis] of [["loose-dds", "x"], ["loose-amp2", "y"]] as const) {
    const expected = await runAlign(lab, cableId, "B", 25, 0) as { candidates: unknown[] };
    if (expected.candidates.length === 0) throw new Error(`${cableId}: the parked port must be a candidate`);
    cases.push({
      label: `align candidates ${cableId}: port on an instrument rotated about ${axis}`,
      scene: iLab, op: "align", request: { cableId, end: "B", toleranceMm: 25, pickIndex: 0 },
      expected,
    });
  }
  cases.push({ label: "disconnect A", scene: iLab, op: "disconnect", request: { cableId: "cable0", end: "A" }, expected: await runDisconnect(lab, "cable0", "A") });
  cases.push({ label: "detach PPG", scene: iLab, op: "ppgDetach", request: { ppgId: "ppg0" }, expected: await runDetach(lab, "ppg0") });
  const ppgRefs: [string, PortRef][] = [
    ["BNC ttl_in on the switch", P("switch", "ttl_in")],
    ["gate input on the multi-root EOM mounts", P("eom", "BIAS TTL")],
    ["trigger_in already has a PPG", P("aom", "trigger_in")],
    ["rf_in is not a gate input", P("amp1", "rf_in")],
    ["output port", P("dds", "CH1")],
  ];
  for (const [label, ref] of ppgRefs) {
    cases.push({ label, scene: iLab, op: "ppgAttach", request: { target: ref }, expected: await runPpgAttach(lab, ref) });
  }
  // An SMA gate input: only the shell / port-less SMA PPGs exist → rejected.
  const labSmaTtl = labScene();
  (labSmaTtl.assets.find((a) => a.id === "a-switch")!.anchors.find((a) => a.id === "ttl_in") as unknown as { connectorType: string })
    .connectorType = "sma_female";
  const iSmaTtl = addScene("lab-sma-ttl", labSmaTtl);
  cases.push({
    label: "SMA ttl_in: no usable SMA PPG",
    scene: iSmaTtl, op: "ppgAttach", request: { target: P("switch", "ttl_in") },
    expected: await runPpgAttach(labSmaTtl, P("switch", "ttl_in")),
  });

  // Random scenes.
  const r = makeRng(0xcab1e5);
  for (let si = 0; si < 20; si += 1) {
    const { scene, cableIds, ppgIds, objectIds } = randomScene(r, `r${si}`);
    const idx = addScene(`random-${si}`, scene);
    const store = toStoreScene(scene);
    const refs: PortRef[] = [];
    for (const o of store.objects) {
      const comp = store.components.find((c) => c.id === o.componentId);
      if (!comp) continue;
      for (const { anchor: a } of anchorsInBindingTree(comp, store)) {
        refs.push(r.chance(0.5)
          ? { objectId: o.id, anchorName: a.name ?? a.id, anchorId: a.id }
          : { objectId: o.id, anchorName: a.name ?? a.id });
      }
    }
    // Fallback-port names on mesh-less objects, plus a bogus one.
    for (const o of store.objects) refs.push({ objectId: o.id, anchorName: r.pick(["rf_in", "rf_out", "ttl_in"]) });
    refs.push({ objectId: `${objectIds[0]}`, anchorName: "bogus" });
    // Bias most requests toward ports the panel offers, and connects toward
    // pairs that pass the role / connector / domain gates, so the random
    // cases reach the store (variant choice, geometry) rather than all
    // stopping at "port_not_found".
    const offered: PanelPort[] = store.objects.flatMap((o) => panelPortsOf(store, o.id));
    const refOf = (p: PanelPort): PortRef =>
      (r.chance(0.5) ? { objectId: p.objectId, anchorName: p.anchorName, anchorId: p.anchorId } : { objectId: p.objectId, anchorName: p.anchorName });
    const gatePorts = offered.filter((p) => p.role === "in" && (p.domain === "ttl" || p.domain === "trigger"));

    for (let k = 0; k < 14 && refs.length > 1; k += 1) {
      let a: PortRef;
      let b: PortRef;
      const roll = r.next();
      const matesOf = (pa: PanelPort): PanelPort[] => offered.filter((q) => q.objectId !== pa.objectId
        && q.role !== pa.role && q.domain === pa.domain && q.connectorFamily && pa.connectorFamily);
      const mateable = offered.filter((p) => matesOf(p).length > 0);
      if (roll < 0.7 && mateable.length > 0) {
        const pa = r.pick(mateable);
        a = refOf(pa);
        b = refOf(r.pick(matesOf(pa)));
      } else if (roll < 0.88 && offered.length > 1) {
        a = refOf(r.pick(offered));
        b = refOf(r.pick(offered));
      } else {
        a = r.pick(refs);
        b = r.pick(refs);
      }
      cases.push({ label: `random connect ${si}.${k}`, scene: idx, op: "connect", request: { a, b }, expected: await runConnect(scene, a, b) });
    }
    for (let k = 0; k < 3; k += 1) {
      const moved = objectIds.filter(() => r.chance(0.4));
      cases.push({ label: `random resnap ${si}.${k}`, scene: idx, op: "resnap", request: { movedObjectIds: moved }, expected: await runResnap(scene, moved) });
    }
    for (const cableId of cableIds) {
      for (const end of ["A", "B"] as const) {
        const tol = r.pick([25, 300, 5000]);
        const pickIndex = r.chance(0.7) ? r.int(0, 5) : null;
        cases.push({
          label: `random align ${si} ${cableId} ${end}`,
          scene: idx, op: "align", request: { cableId, end, toleranceMm: tol, pickIndex },
          expected: await runAlign(scene, cableId, end, tol, pickIndex),
        });
      }
      const end = r.pick(["A", "B"] as const);
      cases.push({ label: `random disconnect ${si} ${cableId}`, scene: idx, op: "disconnect", request: { cableId, end }, expected: await runDisconnect(scene, cableId, end) });
    }
    for (const ppgId of ppgIds) {
      cases.push({ label: `random detach ${si} ${ppgId}`, scene: idx, op: "ppgDetach", request: { ppgId }, expected: await runDetach(scene, ppgId) });
    }
    for (let k = 0; k < 5; k += 1) {
      const ref = gatePorts.length > 0 && r.chance(0.75) ? refOf(r.pick(gatePorts)) : r.pick(refs);
      cases.push({ label: `random ppg attach ${si}.${k}`, scene: idx, op: "ppgAttach", request: { target: ref }, expected: await runPpgAttach(scene, ref) });
    }
  }
  return { scenes, cases };
}

// ─── write / compare ───────────────────────────────────────────────────────

const BUILDERS: Record<string, () => Json | Promise<Json>> = {
  "pure.json": buildPure,
  "flows.json": buildFlows,
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

describe("rf cable / PPG parity fixtures (TS -> backend/tests/fixtures/rf_cables)", () => {
  for (const [file, build] of Object.entries(BUILDERS)) {
    it(`${file} matches what the TypeScript produces`, async () => {
      const data = plain(await build());
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
        throw new Error(`${file} is missing — run with UPDATE_RF_CABLE_FIXTURES=1`);
      }
      try {
        expectSame(data, committed, file);
      } catch (err) {
        throw new Error(
          `${(err as Error).message}\nThe TypeScript no longer produces the committed fixture. If the change is `
          + "intended: regenerate with UPDATE_RF_CABLE_FIXTURES=1, then port it to backend/app/optical/rf_cables "
          + "until backend/tests/optical/test_rf_cables_parity.py is green again.",
        );
      }
    }, 60_000);
  }
});

