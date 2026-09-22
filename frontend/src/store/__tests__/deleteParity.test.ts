/**
 * Golden fixtures pinning the backend's `POST /api/v3/objects/delete` to the
 * web store's `deleteObjects` (`store/sceneStore.ts`).
 *
 * The web app deletes objects in the browser: it works out the whole cascade
 * from its scene snapshot — cables whose `rfCableEndpoints` point at a doomed
 * object, PPGs plugged into one (`properties.ppgAttachment`), legacy PPGs
 * whose every rf_cable is doomed (behind the `cables.length === 0` guard,
 * docs/introduce/rf.md §7) — and then fires one `DELETE /api/objects/{id}`
 * per row. A second client of the backend (the qmem-blender add-on) needs
 * the same cascade, so the endpoint runs the Python port
 * (`backend/app/services/object_delete.py`, on top of
 * `app/optical/rf_cables/flows.py` `plan_delete_objects`). This file holds
 * the two together:
 *
 *   - it runs the REAL `deleteObjects` against a recording fake of
 *     `api/client` over hand-picked scenes (the cases the unit tests pin, a
 *     scene shaped like the live bench, the TS quirks) and seeded-random
 *     ones, and records, per request, the DELETEs it issues (in order) and
 *     the TimingPrograms it drops from the store, in
 *     `backend/tests/fixtures/delete/{pinned,random}.json`;
 *   - `backend/tests/test_objects_delete_parity.py` feeds the same scenes to
 *     the Python plan (exact order), and `test_objects_delete_endpoint.py`
 *     replays them as real rows through the endpoint (order-independent);
 *   - THIS test fails when the committed fixtures no longer match what the
 *     TypeScript produces, so a TS change cannot land without regenerating
 *     them — which then fails the Python side until it is ported too.
 *
 * `orderIndependent` marks a request whose outcome does not depend on the
 * order the scene lists its objects in (checked by re-running it on
 * reversed and shuffled copies). Only those are replayed through the
 * database, which hands rows back in no particular order. The rest — e.g. a
 * cable whose end points at ANOTHER cable, which `deleteObjects`' single
 * pass catches only when the target cable comes first — are pinned by the
 * pure plan, which is given the objects in fixture order.
 *
 * Every object / program id is UUID-shaped so the endpoint test can insert
 * the scenes verbatim.
 *
 * Regenerate after an intentional change:
 *
 *     UPDATE_DELETE_FIXTURES=1 npx vitest run src/store/__tests__/deleteParity.test.ts
 *
 * Everything is deterministic (a seeded PRNG, no clock), so regenerating
 * without a TS change is a no-op.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { PhysicsElement, SceneData, SceneObject } from "../../types/digitalTwin";

// ─── recording fake of api/client ──────────────────────────────────────────

const deleteCalls: string[] = [];

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteObjectApi: async (id: string) => {
    deleteCalls.push(id);
  },
}));

const { useSceneStore } = await import("../sceneStore");

const FIXTURE_DIR = fileURLToPath(
  new URL("../../../../backend/tests/fixtures/delete/", import.meta.url),
);
const UPDATE = process.env.UPDATE_DELETE_FIXTURES === "1";

const PPG = "programmable_pulse_generator";

// ─── fixture shapes (what the Python reads) ────────────────────────────────

type ObjJson = { id: string; name: string; locked: boolean; properties: Record<string, unknown> };
type PeJson = { objectId: string; elementKind: string; kindParams: Record<string, unknown> };
type TpJson = { id: string; name: string };
type SceneJson = { objects: ObjJson[]; physicsElements: PeJson[]; timingPrograms: TpJson[] };
type Outcome = { deleted: string[]; deletedPrograms: string[] };
type CaseJson = {
  name: string;
  scene: number;
  request: string[];
  orderIndependent: boolean;
} & Outcome;
type FixtureJson = { scenes: SceneJson[]; cases: CaseJson[] };

// ─── deterministic randomness (same generator as rfCableParity.test.ts) ────

function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)];
  const chance = (p: number): boolean => next() < p;
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  const shuffle = <T,>(arr: readonly T[]): T[] => {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return { next, pick, chance, int, shuffle };
}
type Rng = ReturnType<typeof makeRng>;

// ─── ids: UUID-shaped, deterministic, one namespace per scene ──────────────

const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");

function idMaker(scope: number) {
  let objects = 0;
  let programs = 0;
  return {
    object: (): string => `de1e${hex(scope, 4)}-0000-4000-8000-${hex(++objects, 12)}`,
    program: (): string => `de1e${hex(scope, 4)}-0000-4000-9000-${hex(++programs, 12)}`,
    /** An id no row of this scene carries (a stale / already-deleted one). */
    unknown: (k: number): string => `de1e${hex(scope, 4)}-0000-4000-a000-${hex(k, 12)}`,
  };
}

// ─── running the real deleteObjects ────────────────────────────────────────

function toStoreScene(s: SceneJson): SceneData {
  return {
    objects: s.objects.map((o) => ({
      ...JSON.parse(JSON.stringify(o)),
      componentId: "component",
      xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 0, rzDeg: 0,
      visible: true,
      dynamicSources: null,
    })) as unknown as SceneObject[],
    physicsElements: s.physicsElements.map((p, i) => ({
      id: `pe-${i}`,
      ...JSON.parse(JSON.stringify(p)),
    })) as unknown as PhysicsElement[],
    timingPrograms: s.timingPrograms.map((t) => ({ ...t, intervals: [] })),
    components: [],
    componentBindings: [],
    objectBindings: [],
    assets: [],
    connections: [],
    assemblyRelations: [],
    deviceStates: [],
    opticalLinks: [],
    beamSegments: [],
    collections: [],
    collectionMembers: [],
  } as unknown as SceneData;
}

async function runDelete(s: SceneJson, request: string[]): Promise<Outcome> {
  deleteCalls.length = 0;
  useSceneStore.setState({
    scene: toStoreScene(s),
    selectedObjectId: null,
    selectedObjectIds: [],
    selectedComponentId: null,
  } as never);
  const programsBefore = s.timingPrograms.map((t) => t.id);
  await useSceneStore.getState().deleteObjects(request);
  const after = useSceneStore.getState().scene;
  const programsAfter = new Set((after.timingPrograms ?? []).map((t) => t.id));
  const deleted = [...deleteCalls];
  // What the store drops locally is exactly what it DELETEd (no 404s here).
  const remaining = new Set(after.objects.map((o) => o.id));
  const dropped = s.objects.map((o) => o.id).filter((id) => !remaining.has(id));
  expect([...dropped].sort()).toEqual([...new Set(deleted)].sort());
  return { deleted, deletedPrograms: programsBefore.filter((id) => !programsAfter.has(id)) };
}

const sortedKey = (o: Outcome): string =>
  JSON.stringify([[...o.deleted].sort(), [...o.deletedPrograms].sort()]);

/** Same outcome (as sets) with the scene's objects / elements reversed and
 *  shuffled — i.e. safe to compare against rows the database hands back in
 *  its own order. */
async function isOrderIndependent(s: SceneJson, request: string[], base: Outcome, seed: number): Promise<boolean> {
  const r = makeRng(seed);
  const variants: SceneJson[] = [
    { ...s, objects: [...s.objects].reverse(), physicsElements: [...s.physicsElements].reverse() },
  ];
  for (let i = 0; i < 4; i += 1) {
    variants.push({ ...s, objects: r.shuffle(s.objects), physicsElements: r.shuffle(s.physicsElements) });
  }
  const want = sortedKey(base);
  for (const v of variants) {
    if (sortedKey(await runDelete(v, request)) !== want) return false;
  }
  return true;
}

// ─── hand-built scenes ─────────────────────────────────────────────────────

class SceneBuilder {
  readonly objects: ObjJson[] = [];
  readonly physicsElements: PeJson[] = [];
  readonly timingPrograms: TpJson[] = [];
  private readonly ids = new Map<string, string>();
  private readonly mk: ReturnType<typeof idMaker>;
  private unknowns = 0;

  constructor(scope: number) {
    this.mk = idMaker(scope);
  }

  /** The id of `key`, allocated on first use (so links can name objects
   *  that are added later — the scene order is the order of `add`). */
  id(key: string): string {
    let id = this.ids.get(key);
    if (!id) {
      id = this.mk.object();
      this.ids.set(key, id);
    }
    return id;
  }

  unknown(): string {
    this.unknowns += 1;
    return this.mk.unknown(this.unknowns);
  }

  program(name: string): string {
    const id = this.mk.program();
    this.timingPrograms.push({ id, name });
    return id;
  }

  /** A program id no TimingProgram row carries. */
  missingProgram(): string {
    return this.mk.program();
  }

  link(key: string, anchorId = "rf_in", anchorName = anchorId): Record<string, string> {
    return { targetObjectId: this.id(key), targetAnchorId: anchorId, targetAnchorName: anchorName };
  }

  add(
    key: string,
    kind: string | null,
    properties: Record<string, unknown> = {},
    opts: { locked?: boolean; kindParams?: Record<string, unknown> } = {},
  ): string {
    const id = this.id(key);
    this.objects.push({ id, name: key, locked: opts.locked ?? false, properties });
    if (kind) this.physicsElements.push({ objectId: id, elementKind: kind, kindParams: opts.kindParams ?? {} });
    return id;
  }

  cable(key: string, a: Record<string, unknown> | null, b: Record<string, unknown> | null, opts: { locked?: boolean; kind?: string | null } = {}): string {
    const eps: Record<string, unknown> = {};
    if (a) eps.A = a;
    if (b) eps.B = b;
    return this.add(key, opts.kind === undefined ? "rf_cable" : opts.kind, { rfCableEndpoints: eps }, { locked: opts.locked });
  }

  /** A PPG with its own TimingProgram, plugged into `host` (or loose). */
  ppg(key: string, host: string | null, opts: { locked?: boolean; program?: unknown } = {}): string {
    const props = host ? { ppgAttachment: this.link(host, "ttl_in", "TTL") } : {};
    const programId = opts.program === undefined ? this.program(key) : opts.program;
    const kindParams = programId === null ? {} : { timingProgramId: programId };
    return this.add(key, PPG, props, { locked: opts.locked, kindParams });
  }

  scene(): SceneJson {
    return JSON.parse(JSON.stringify({
      objects: this.objects, physicsElements: this.physicsElements, timingPrograms: this.timingPrograms,
    })) as SceneJson;
  }
}

type PinnedScene = { name: string; build: SceneBuilder; requests: [string, string[]][] };

/** A scene shaped like the live bench (2026-09-22 snapshot): two DDSs, two
 *  switches with a PPG plugged into each TTL, amplifiers, AOMs, an EOM
 *  with a pigtail, a fibre into a detector, locked optics and mechanics —
 *  plus two legacy PPGs still wired through rf_cables. */
function labScene(): PinnedScene {
  const b = new SceneBuilder(1);
  b.add("TABLE", null, {}, { locked: true });
  b.add("DDS0", "rf_source");
  b.add("DDS1", "rf_source");
  b.add("SW0", "rf_switch");
  b.add("SW1", "rf_switch");
  b.add("AMP0", "rf_amplifier");
  b.add("AMP1", "rf_amplifier");
  b.add("AOM0", "aom");
  b.add("AOM1", "aom");
  b.add("DET0", "detector");
  b.add("EOM0", "eom", { pigtailEndpoints: { intercept_out: b.link("DET0", "fiber_in", "OPTICAL IN (FC/PC)") } });
  b.add("MIRROR0", "mirror", {}, { locked: true });
  b.add("MECH0", null, {}, { locked: true });
  b.add("FIBER0", "fiber", { fiberEndpoints: { B: b.link("DET0", "fiber_in", "OPTICAL IN (FC/PC)") } });
  b.cable("RF_CABLE0", b.link("DDS0", "rf_out", "CH0"), b.link("EOM0", "rf_in"));
  b.cable("RF_CABLE1", b.link("SW0", "rf_in"), b.link("DDS1", "rf_out", "CH0"));
  b.cable("RF_CABLE2", b.link("SW1", "rf_in"), b.link("DDS1", "rf_out", "CH1"));
  b.cable("RF_CABLE3", b.link("SW0", "rf_out", "RF1"), b.link("AMP0", "rf_in"));
  b.cable("RF_CABLE5", b.link("SW1", "rf_out", "RF1"), b.link("AMP1", "rf_in"));
  b.cable("RF_CABLE4", b.link("AMP0", "rf_out"), b.link("AOM0", "rf_in"));
  b.cable("RF_CABLE6", b.link("AMP1", "rf_out"), b.link("AOM1", "rf_in"));
  b.ppg("CH0", "SW0");
  b.ppg("CH1", "SW1");
  // Legacy PPGs: no attachment record, wired through real rf_cables.
  b.ppg("CH2", null);
  b.cable("LEGACY_CABLE0", b.link("CH2", "rf_out"), b.link("AOM1", "trigger_in"));
  b.ppg("CH3", null);
  b.cable("LEGACY_CABLE1", b.link("CH3", "rf_out"), b.link("AOM0", "trigger_in"));
  b.cable("LEGACY_CABLE2", b.link("CH3", "rf_out"), b.link("EOM0", "trigger_in"));
  b.program("UNUSED");

  const keys = b.objects.map((o) => o.name);
  const requests: [string, string[]][] = keys.map((k) => [`only ${k}`, [b.id(k)]]);
  requests.push(
    ["both switches", [b.id("SW0"), b.id("SW1")]],
    ["an amplifier and its AOM", [b.id("AMP0"), b.id("AOM0")]],
    ["both legacy-PPG sinks", [b.id("AOM0"), b.id("EOM0")]],
    ["one of CH3's two cables", [b.id("LEGACY_CABLE1")]],
    ["both of CH3's cables", [b.id("LEGACY_CABLE1"), b.id("LEGACY_CABLE2")]],
    ["a locked object alone (skipped)", [b.id("MIRROR0")]],
    ["locked and unlocked together", [b.id("MIRROR0"), b.id("SW0"), b.id("MECH0")]],
    ["duplicates", [b.id("SW0"), b.id("SW0"), b.id("AMP0")]],
    ["an unknown id", [b.unknown()]],
    ["an unknown id with a real one", [b.unknown(), b.id("DDS1")]],
    ["nothing", []],
    ["everything", keys.map((k) => b.id(k))],
    ["everything, reversed", keys.map((k) => b.id(k)).reverse()],
  );
  return { name: "lab", build: b, requests };
}

function pinnedScenes(): PinnedScene[] {
  const out: PinnedScene[] = [labScene()];

  // ppgAttachment.test.ts A2: `ppgsAttachedTo` finds the PPGs plugged into a
  // doomed instrument, and leaves those attached elsewhere alone.
  {
    const b = new SceneBuilder(2);
    b.ppg("p1", "host");
    b.add("p2", PPG, { ppgAttachment: { targetObjectId: b.unknown(), targetAnchorId: "ttl_in", targetAnchorName: "TTL" } });
    b.add("host", "rf_switch");
    b.add("unrelated", "mirror");
    out.push({
      name: "ppgAttachment A2",
      build: b,
      requests: [["the host", [b.id("host")]], ["an unrelated object", [b.id("unrelated")]]],
    });
  }

  // rf.md §7: a cable-less PPG must NOT read as "every cable is doomed" and
  // go with any unrelated delete — the `cables.length === 0` guard.
  {
    const b = new SceneBuilder(3);
    b.add("host", "rf_switch");
    b.ppg("attached", "host");
    b.ppg("loose", null);
    b.add("other", "rf_amplifier");
    b.add("dds", "rf_source");
    b.cable("cable", b.link("dds", "rf_out", "CH0"), b.link("other"));
    out.push({
      name: "cables.length === 0 guard",
      build: b,
      requests: [
        ["an unrelated instrument", [b.id("other")]],
        ["an unrelated cable", [b.id("cable")]],
        ["the host", [b.id("host")]],
      ],
    });
  }

  // Legacy PPGs wired through rf_cables: orphaned only when EVERY cable on
  // it is doomed; a cable counts only when its PhysicsElement is rf_cable.
  {
    const b = new SceneBuilder(4);
    b.add("aomA", "aom");
    b.add("aomB", "aom");
    b.ppg("one", null);
    b.cable("c1", b.link("one", "rf_out"), b.link("aomA", "trigger_in"));
    b.ppg("two", null);
    b.cable("c2", b.link("two", "rf_out"), b.link("aomA", "trigger_in"));
    b.cable("c3", b.link("aomB", "trigger_in"), b.link("two", "rf_out"));
    b.ppg("bothEnds", null);
    b.cable("c4", b.link("bothEnds", "rf_out"), b.link("bothEnds", "rf_out"));
    // Carries rfCableEndpoints but is not an rf_cable: the first pass still
    // deletes it with its target, yet it never counts as one of `ghost`'s
    // cables — so `ghost` has none and the guard keeps it.
    b.ppg("ghost", null);
    b.cable("noPe", b.link("ghost", "rf_out"), b.link("aomB", "trigger_in"), { kind: null });
    b.cable("mirrorish", b.link("ghost", "rf_out"), b.link("aomB", "trigger_in"), { kind: "mirror" });
    out.push({
      name: "legacy PPG orphan rule",
      build: b,
      requests: [
        ["aomA (one of two's cables)", [b.id("aomA")]],
        ["aomB", [b.id("aomB")]],
        ["both AOMs", [b.id("aomA"), b.id("aomB")]],
        ["a cable on a PPG directly", [b.id("c1")]],
        ["a cable to itself", [b.id("c4")]],
        ["the PPG with a self-loop cable", [b.id("bothEnds")]],
      ],
    });
  }

  // Locks: a locked REQUESTED object is skipped silently; a locked object
  // the cascade reaches is still DELETEd by the web (and 409s there) — the
  // endpoint refuses such a request whole.
  {
    const b = new SceneBuilder(5);
    b.add("host", "rf_switch");
    b.add("dds", "rf_source");
    b.cable("lockedCable", b.link("dds", "rf_out", "CH0"), b.link("host"), { locked: true });
    b.ppg("lockedPpg", "host", { locked: true });
    b.add("amp", "rf_amplifier");
    b.cable("cable", b.link("dds", "rf_out", "CH1"), b.link("amp"));
    b.add("lockedAmp", "rf_amplifier", {}, { locked: true });
    b.cable("toLocked", b.link("dds", "rf_out", "CH2"), b.link("lockedAmp"));
    out.push({
      name: "locks",
      build: b,
      requests: [
        ["the host (cascade reaches a locked cable and PPG)", [b.id("host")]],
        ["the locked cable itself", [b.id("lockedCable")]],
        ["the locked cable and its host", [b.id("lockedCable"), b.id("host")]],
        ["the dds (cascade reaches a locked cable)", [b.id("dds")]],
        ["the amp", [b.id("amp")]],
        ["a locked amp (skipped, so its cable stays)", [b.id("lockedAmp")]],
      ],
    });
  }

  // TS quirks carried over as they are.
  {
    const b = new SceneBuilder(6);
    b.add("host", "rf_switch");
    b.add("aom", "aom");
    // A PPG that is BOTH attached and still wired by a cable: the cable pass
    // runs before the attachment pass, so the PPG goes with its host but
    // the cable on it survives, dangling.
    b.ppg("ppg", "host");
    b.cable("cableOnPpg", b.link("ppg", "rf_out"), b.link("aom", "trigger_in"));
    // A cable whose end points at another cable: one pass in scene order,
    // so the chain is caught only as far as the scene lists it forwards.
    b.add("dds", "rf_source");
    b.cable("first", b.link("dds", "rf_out", "CH0"), b.link("aom"));
    b.cable("second", b.link("first", "connect_in"), null);
    b.cable("third", b.link("second", "connect_in"), null);
    out.push({
      name: "quirks",
      build: b,
      requests: [
        ["the host of a cabled PPG", [b.id("host")]],
        ["the dds (cable-to-cable chain)", [b.id("dds")]],
      ],
    });
  }

  // TimingPrograms: shared by two PPGs, missing, not a string, empty.
  {
    const b = new SceneBuilder(7);
    b.add("host", "rf_switch");
    const shared = b.program("shared");
    b.ppg("s1", "host", { program: shared });
    b.ppg("s2", "host", { program: shared });
    b.ppg("missing", "host", { program: b.missingProgram() });
    b.ppg("numeric", "host", { program: 7 });
    b.ppg("empty", "host", { program: "" });
    b.ppg("none", "host", { program: null });
    b.ppg("own", "host");
    out.push({ name: "timing programs", build: b, requests: [["the host", [b.id("host")]]] });
  }

  // Malformed link records never name a doomed object.
  {
    const b = new SceneBuilder(8);
    b.add("host", "rf_switch");
    const target = b.id("host");
    const odd: [string, unknown][] = [
      ["endpointsString", "host"],
      ["endpointsNull", null],
      ["endpointsArray", [b.link("host")]],
      ["endNull", { A: null, B: b.link("host") }],
      ["endString", { A: target }],
      ["targetNumber", { A: { targetObjectId: 5 } }],
      ["targetEmpty", { A: { targetObjectId: "" } }],
      ["targetObject", { A: { targetObjectId: { id: target } } }],
      ["targetOnly", { B: { targetObjectId: target } }],
    ];
    for (const [key, eps] of odd) b.add(key, "rf_cable", { rfCableEndpoints: eps });
    b.add("partialAttach", PPG, { ppgAttachment: { targetObjectId: target, targetAnchorId: "ttl_in" } });
    b.add("emptyNameAttach", PPG, { ppgAttachment: { targetObjectId: target, targetAnchorId: "ttl_in", targetAnchorName: "" } });
    b.add("stringAttach", PPG, { ppgAttachment: target });
    b.add("notAPpgAttach", "rf_amplifier", { ppgAttachment: b.link("host", "ttl_in", "TTL") });
    out.push({ name: "malformed links", build: b, requests: [["the host", [target]]] });
  }

  // Fibres and pigtails linked to a doomed object are NOT touched: the web
  // deletes and unlinks nothing on their side (a dangling patch cable is a
  // real bench state).
  {
    const b = new SceneBuilder(9);
    b.add("det", "detector");
    b.add("fiber", "fiber", { fiberEndpoints: { A: b.link("det", "fiber_in", "IN") } });
    b.add("eom", "eom", { pigtailEndpoints: { intercept_out: b.link("det", "fiber_in", "IN") } });
    out.push({ name: "fibres and pigtails", build: b, requests: [["the detector", [b.id("det")]]] });
  }
  return out;
}

// ─── seeded-random scenes ──────────────────────────────────────────────────

const INSTRUMENTS = ["rf_source", "rf_switch", "rf_amplifier", "aom", "eom", "detector", "mirror", "laser_source"];

function randomScene(r: Rng, scope: number): { scene: SceneJson; requests: string[][] } {
  const mk = idMaker(scope);
  const n = r.int(2, 22);
  const ids = Array.from({ length: n }, () => mk.object());
  const kinds = ids.map((): string | null => {
    const x = r.next();
    if (x < 0.36) return r.pick(INSTRUMENTS);
    if (x < 0.62) return "rf_cable";
    if (x < 0.8) return PPG;
    if (x < 0.88) return "fiber";
    return null;
  });
  const nonCables = ids.filter((_, i) => kinds[i] !== "rf_cable");
  const target = (): unknown => {
    const x = r.next();
    if (x < 0.72 && nonCables.length > 0) return r.pick(nonCables);
    if (x < 0.84) return r.pick(ids);
    if (x < 0.92) return mk.unknown(r.int(1, 3));
    return r.pick([null, "", 5, true, {}]);
  };
  const link = (): unknown =>
    r.chance(0.06)
      ? r.pick([null, "junk", 3, []])
      : {
          targetObjectId: target(),
          targetAnchorId: r.pick(["rf_in", "rf_out", "ttl_in", "trigger_in"]),
          targetAnchorName: r.pick(["CH0", "RF1", "TTL", "rf_in"]),
        };
  const programs: TpJson[] = [];
  const objects: ObjJson[] = [];
  const physicsElements: PeJson[] = [];
  ids.forEach((id, i) => {
    const kind = kinds[i];
    const properties: Record<string, unknown> = {};
    const kindParams: Record<string, unknown> = {};
    if (kind === "rf_cable" || (kind === null && r.chance(0.4))) {
      if (r.chance(0.05)) {
        properties.rfCableEndpoints = r.pick([null, "x", [], {}]);
      } else {
        const eps: Record<string, unknown> = {};
        if (r.chance(0.9)) eps.A = link();
        if (r.chance(0.9)) eps.B = link();
        properties.rfCableEndpoints = eps;
      }
    }
    if (kind === PPG) {
      const x = r.next();
      if (x < 0.62) {
        properties.ppgAttachment = { targetObjectId: target(), targetAnchorId: "ttl_in", targetAnchorName: "TTL" };
      } else if (x < 0.72) {
        properties.ppgAttachment = r.pick([
          { targetObjectId: target() },
          { targetObjectId: target(), targetAnchorId: "ttl_in", targetAnchorName: "" },
          "junk",
        ]);
      }
      const y = r.next();
      if (y < 0.66) {
        const tp = { id: mk.program(), name: `P${programs.length}` };
        programs.push(tp);
        kindParams.timingProgramId = tp.id;
      } else if (y < 0.76 && programs.length > 0) {
        kindParams.timingProgramId = r.pick(programs).id;
      } else if (y < 0.84) {
        kindParams.timingProgramId = mk.program(); // no such row
      } else if (y < 0.92) {
        kindParams.timingProgramId = r.pick([7, "", null]);
      }
    }
    if (kind === "fiber") {
      properties.fiberEndpoints = r.chance(0.5) ? { A: link(), B: link() } : { B: link() };
    }
    if (kind !== null && INSTRUMENTS.includes(kind) && r.chance(0.15)) {
      properties.pigtailEndpoints = { intercept_out: link() };
    }
    objects.push({ id, name: `${(kind ?? "none").toUpperCase()}_${i}`, locked: r.chance(0.12), properties });
    if (kind !== null) physicsElements.push({ objectId: id, elementKind: kind, kindParams });
  });
  if (r.chance(0.3)) programs.push({ id: mk.program(), name: "UNREFERENCED" });

  const requests: string[][] = [];
  const count = r.int(1, 3);
  for (let q = 0; q < count; q += 1) {
    if (r.chance(0.08)) {
      requests.push(r.shuffle(ids));
      continue;
    }
    const req: string[] = [];
    const k = r.int(0, Math.min(4, n));
    for (let j = 0; j < k; j += 1) req.push(r.pick(ids));
    if (r.chance(0.15)) req.push(mk.unknown(r.int(1, 3)));
    if (req.length > 0 && r.chance(0.1)) req.push(req[0]);
    requests.push(req);
  }
  return {
    scene: JSON.parse(JSON.stringify({ objects, physicsElements, timingPrograms: programs })) as SceneJson,
    requests,
  };
}

// ─── fixture builders ──────────────────────────────────────────────────────

async function caseFor(name: string, sceneIndex: number, s: SceneJson, request: string[], seed: number): Promise<CaseJson> {
  const outcome = await runDelete(s, request);
  return {
    name,
    scene: sceneIndex,
    request,
    orderIndependent: await isOrderIndependent(s, request, outcome, seed),
    ...outcome,
  };
}

async function buildPinned(): Promise<FixtureJson> {
  const scenes: SceneJson[] = [];
  const cases: CaseJson[] = [];
  for (const p of pinnedScenes()) {
    const s = p.build.scene();
    scenes.push(s);
    for (const [label, request] of p.requests) {
      cases.push(await caseFor(`${p.name}: ${label}`, scenes.length - 1, s, request, 1000 + cases.length));
    }
  }
  return { scenes, cases };
}

async function buildRandom(): Promise<FixtureJson> {
  const r = makeRng(20260922);
  const scenes: SceneJson[] = [];
  const cases: CaseJson[] = [];
  for (let i = 0; i < 120; i += 1) {
    const { scene, requests } = randomScene(r, 0x100 + i);
    scenes.push(scene);
    for (const [q, request] of requests.entries()) {
      cases.push(await caseFor(`random ${i}.${q}`, i, scene, request, 5000 + cases.length));
    }
  }
  return { scenes, cases };
}

const BUILDERS: Record<string, () => Promise<FixtureJson>> = {
  "pinned.json": buildPinned,
  "random.json": buildRandom,
};

// ─── the TS behaviour the pinned scenes are about, stated outright ─────────

describe("deleteObjects cascade (what the fixtures pin)", () => {
  const named = async (sceneName: string) => {
    const p = pinnedScenes().find((x) => x.name === sceneName)!;
    const s = p.build.scene();
    const run = async (label: string) => {
      const request = p.requests.find(([l]) => l === label)![1];
      const out = await runDelete(s, request);
      const nameOf = new Map(s.objects.map((o) => [o.id, o.name]));
      const progName = new Map(s.timingPrograms.map((t) => [t.id, t.name]));
      return {
        deleted: out.deleted.map((id) => nameOf.get(id)),
        programs: out.deletedPrograms.map((id) => progName.get(id)),
      };
    };
    return run;
  };

  it("an instrument takes its cables and the PPG plugged into it (and its program)", async () => {
    const run = await named("lab");
    expect(await run("only SW0")).toEqual({
      deleted: ["SW0", "RF_CABLE1", "RF_CABLE3", "CH0"],
      programs: ["CH0"],
    });
  });

  it("a cable-less PPG survives an unrelated delete (the cables.length === 0 guard)", async () => {
    const run = await named("cables.length === 0 guard");
    expect((await run("an unrelated instrument")).deleted).toEqual(["other", "cable"]);
  });

  it("a legacy PPG goes only when every rf_cable on it is doomed", async () => {
    const run = await named("lab");
    expect((await run("only AOM0")).deleted).toEqual(["AOM0", "RF_CABLE4", "LEGACY_CABLE1"]);
    expect(await run("both legacy-PPG sinks")).toEqual({
      deleted: ["AOM0", "EOM0", "RF_CABLE0", "RF_CABLE4", "LEGACY_CABLE1", "LEGACY_CABLE2", "CH3"],
      programs: ["CH3"],
    });
  });

  it("locked requested objects are skipped; a locked cascaded one is still DELETEd", async () => {
    const run = await named("locks");
    expect((await run("the locked cable itself")).deleted).toEqual([]);
    expect((await run("the host (cascade reaches a locked cable and PPG)")).deleted)
      .toEqual(["host", "lockedCable", "lockedPpg"]);
  });

  it("fibres and pigtails are left linked to a deleted object", async () => {
    const run = await named("fibres and pigtails");
    expect((await run("the detector")).deleted).toEqual(["det"]);
  });

  it("a cabled PPG goes with its host but its cable stays (cable pass runs first)", async () => {
    const run = await named("quirks");
    expect((await run("the host of a cabled PPG")).deleted).toEqual(["host", "ppg"]);
  });
});

// ─── committed fixtures ────────────────────────────────────────────────────

describe("delete parity fixtures (TS -> backend/tests/fixtures/delete)", () => {
  for (const [file, build] of Object.entries(BUILDERS)) {
    it(`${file} matches what the TypeScript produces`, async () => {
      const data = await build();
      const target = `${FIXTURE_DIR}${file}`;
      if (UPDATE) {
        mkdirSync(FIXTURE_DIR, { recursive: true });
        writeFileSync(target, `${JSON.stringify(data, null, 1)}\n`, "utf8");
        return;
      }
      let committed: FixtureJson;
      try {
        committed = JSON.parse(readFileSync(target, "utf8")) as FixtureJson;
      } catch {
        throw new Error(`${file} is missing — run with UPDATE_DELETE_FIXTURES=1`);
      }
      const stale = (what: string) =>
        new Error(
          `${file}: ${what}\nThe TypeScript no longer produces the committed fixture. If the change is intended: `
          + "regenerate with UPDATE_DELETE_FIXTURES=1, then port it to backend/app/services/object_delete.py "
          + "until backend/tests/test_objects_delete_parity.py is green again.",
        );
      if (JSON.stringify(data.scenes) !== JSON.stringify(committed.scenes)) throw stale("the scenes differ");
      if (data.cases.length !== committed.cases.length) throw stale("the case count differs");
      data.cases.forEach((c, i) => {
        if (JSON.stringify(c) !== JSON.stringify(committed.cases[i])) {
          throw stale(`case ${i} (${c.name}) differs: ${JSON.stringify(c)} != ${JSON.stringify(committed.cases[i])}`);
        }
      });
    }, 60_000);
  }
});
