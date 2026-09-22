/**
 * Golden fixtures pinning the backend's fibre / pigtail ports to this
 * TypeScript.
 *
 * Plugging a patch cable into an instrument, aligning a fibre end or a
 * pigtail end, and re-snapping them when the instrument moves used to exist
 * only in the web store (`store/sceneStore.ts`) and the helpers under it
 * (`fiberAlignment.ts`, `fiberAnchorResolver.ts`, `pigtailAlignment.ts`,
 * `componentBindings.pigtailPortBindings`). A second client (the
 * qmem-blender add-on) needs them too, so they were ported to
 * `backend/app/optical/fibers/` and served as `POST /api/v3/fibers/*` and
 * `/api/v3/pigtails/*`. This file holds the two copies together:
 *
 *   - it runs the REAL TypeScript — the pure helpers directly, and the store
 *     flows through the real zustand store with the REST layer mocked — over
 *     hand-picked cases (what the unit tests pin) plus seeded-random ones, and
 *     records inputs + outputs in `backend/tests/fixtures/fibers/*.json`;
 *   - `backend/tests/optical/test_fiber_parity.py` replays them through the
 *     Python and asserts equality within 1e-9 (exactly for choices: which
 *     candidates, in which order, which link is written);
 *   - THIS test fails when the committed fixtures no longer match what the
 *     TypeScript produces, so a TS change cannot land without regenerating
 *     them — which then fails the Python side until it is ported too.
 *
 * One deliberate gap, and why the store scenes are shaped around it: the
 * store's fibre-port sweep (`collectFiberPortsLab`) and linked-end resolver
 * (`resolveLinkedFiberEndpoint`) lift a port into lab with a local copy of
 * the SceneObject rotation convention that was retired on 2026-06-01, and
 * without the port's binding transform. The backend uses the tracer's chain
 * instead (a port has to land where the tracer hit-tests it). The two agree
 * when the port's binding is the identity and the objects involved are
 * rotated about Z by 0 or ±180° only — every fibre port in the live scene —
 * so the STORE scenes below stay inside that set, while the pure helpers
 * (which use the correct convention) are exercised at arbitrary rotations.
 * See docs/introduce/fiber.md ("The backend port").
 *
 * Regenerate after an intentional change:
 *
 *     UPDATE_FIBER_FIXTURES=1 npx vitest run src/utils/__tests__/fiberParity.test.ts
 *
 * Everything is deterministic (a seeded PRNG, no clock), so regenerating
 * without a TS change is a no-op.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, vi } from "vitest";

import { pointBodyToLab, type V3Pose } from "../../optical/pose";
import { pigtailPortBindings } from "../componentBindings";
import {
  endpointOutwardBody,
  findFiberEndAlignmentCandidates,
  findFiberPortAlignmentCandidates,
  isFiberPortConnectorType,
  type BeamSegmentLab,
  type FiberNodePersist,
  type FiberPortLab,
} from "../fiberAlignment";
import {
  resolveLinkedFiberEndpoint,
  syncFiberNodesFromKindParams,
} from "../fiberAnchorResolver";
import {
  bindingPoseDelta,
  composeBindingPoses,
  computeConnectorAlignPose,
  connectorPortLab,
  findPigtailBeamCandidates,
  findPigtailPortCandidates,
  matedFaceLab,
  pigtailNodesFollowingConnector,
  type ConnectorPlacement,
} from "../pigtailAlignment";
import type { AnchorFrameLike, BindingPose } from "../portConnectorPlacement";

const updateObjectApiMock = vi.fn();
const upsertObjectBindingApiMock = vi.fn();

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateObjectApi: (id: string, patch: Record<string, unknown>) =>
    updateObjectApiMock(id, patch),
  upsertObjectBindingApi: (objectId: string, payload: Record<string, unknown>) =>
    upsertObjectBindingApiMock(objectId, payload),
}));

const { useSceneStore, resolveEffectiveFiberNodes } = await import("../../store/sceneStore");

const FIXTURE_DIR = fileURLToPath(
  new URL("../../../../backend/tests/fixtures/fibers/", import.meta.url),
);
const UPDATE = process.env.UPDATE_FIBER_FIXTURES === "1";

type Json = unknown;
type Vec3 = { x: number; y: number; z: number };
type T3 = [number, number, number];
type Pose = V3Pose;

/** JSON round-trip: drops `undefined`, turns class instances into plain data. */
const plain = (x: unknown): Json => JSON.parse(JSON.stringify(x));

// ─── deterministic randomness (same mulberry32 as alignParity.test.ts) ─────

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
  const t3 = (s: number): T3 => [uni(-s, s), uni(-s, s), uni(-s, s)];
  const unit = (): T3 => {
    for (;;) {
      const v = t3(1);
      const m = Math.hypot(v[0], v[1], v[2]);
      if (m > 0.1 && m <= 1) return [v[0] / m, v[1] / m, v[2] / m];
    }
  };
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)];
  const angle = (): number => uni(-180, 180);
  /** A SceneObject pose anywhere on the bench, any orientation. */
  const pose = (): Pose => ({
    xMm: uni(-500, 500), yMm: uni(-500, 500), zMm: uni(0, 1000),
    rxDeg: angle(), ryDeg: uni(-89, 89), rzDeg: angle(),
  });
  /** A pose inside the set where the store's legacy port convention agrees
   *  with the tracer's: no tilt, and a Z turn of 0 or ±180 deg only. */
  const flatPose = (): Pose => ({
    xMm: uni(-500, 500), yMm: uni(-500, 500), zMm: uni(0, 1000),
    rxDeg: 0, ryDeg: 0, rzDeg: pick([0, 180, -180]),
  });
  const bindingPose = (s = 100): BindingPose => ({
    localXMm: uni(-s, s), localYMm: uni(-s, s), localZMm: uni(-s, s),
    localRxDeg: angle(), localRyDeg: uni(-89, 89), localRzDeg: angle(),
  });
  return { next, uni, t3, unit, pick, angle, pose, flatPose, bindingPose };
}
type Rng = ReturnType<typeof makeRng>;

const add3 = (a: T3, b: T3): T3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: T3, k: number): T3 => [a[0] * k, a[1] * k, a[2] * k];
const xyz = (v: T3): Vec3 => ({ x: v[0], y: v[1], z: v[2] });
const IDENTITY: Pose = { xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 0, rzDeg: 0 };

function randomNodes(r: Rng, n = 2 + Math.floor(r.next() * 4)): FiberNodePersist[] {
  const nodes: FiberNodePersist[] = [];
  let p: T3 = r.t3(200);
  for (let i = 0; i < n; i += 1) {
    const node: FiberNodePersist = { posMm: p };
    const roll = r.next();
    if (i > 0) {
      if (roll < 0.7) node.handleInMm = r.t3(40);
      else if (roll < 0.8) node.handleInMm = [0, 0, 0];
    }
    if (i < n - 1) {
      if (r.next() < 0.7) node.handleOutMm = r.t3(40);
      else if (r.next() < 0.3) node.handleOutMm = [0, 0, 0];
    }
    nodes.push(node);
    p = add3(p, r.t3(120));
  }
  return nodes;
}

// ─── geometry.json — the patch-cable helpers ───────────────────────────────

function buildGeometry(): Json {
  const r = makeRng(0xf1be4);

  const connectorTypes = [
    "fc_pc_female", "fc_apc_female", "sc_pc_female", "lc_upc_female", "st_female",
    "st__female", "fc_pc_male", "fc_apc_male", "fc_pc", "fc_female", "sma_female",
    "bnc_female", "FC_PC_FEMALE", "fc_pc_female_x", "xfc_pc_female", "", null,
  ];
  const isPort = connectorTypes.map((ct) => ({ input: ct, output: isFiberPortConnectorType(ct) }));

  // endpointOutwardBody: handle, zero handle, missing handle, coincident nodes.
  const outwardInputs: { nodes: FiberNodePersist[]; end: "A" | "B" }[] = [
    { nodes: [{ posMm: [0, 0, 0], handleOutMm: [30, 0, 0] }, { posMm: [400, 0, 0], handleInMm: [-30, 0, 0] }], end: "A" },
    { nodes: [{ posMm: [0, 0, 0], handleOutMm: [30, 0, 0] }, { posMm: [400, 0, 0], handleInMm: [-30, 0, 0] }], end: "B" },
    { nodes: [{ posMm: [0, 0, 0] }, { posMm: [0, 100, 0] }], end: "A" },
    { nodes: [{ posMm: [0, 0, 0] }, { posMm: [0, 100, 0] }], end: "B" },
    { nodes: [{ posMm: [5, 5, 5], handleOutMm: [0, 0, 0] }, { posMm: [5, 5, 5] }], end: "A" },
    { nodes: [{ posMm: [1, 2, 3], handleOutMm: [1e-6, 0, 0] }, { posMm: [9, 2, 3] }], end: "A" },
  ];
  for (let i = 0; i < 12; i += 1) outwardInputs.push({ nodes: randomNodes(r), end: r.pick(["A", "B"] as const) });
  const outward = outwardInputs.map((input) => ({ input: plain(input), output: endpointOutwardBody(input.nodes, input.end) }));

  // Beam candidates: the unit-test geometry, then random fibres / poses /
  // beams (some within tolerance, one degenerate, some clamped).
  type BeamIn = { end: "A" | "B"; nodes: FiberNodePersist[]; pose: Pose; beamSegmentsLab: BeamSegmentLab[]; toleranceMm: number };
  const beamInputs: BeamIn[] = [
    {
      end: "A",
      nodes: [{ posMm: [0, 0, 0], handleOutMm: [30, 0, 0] }, { posMm: [400, 0, 0], handleInMm: [-30, 0, 0] }],
      pose: IDENTITY,
      beamSegmentsLab: [
        { beamId: "b1", aMm: [-100, -36.28, 3], bMm: [100, -36.28, 3], displayLabel: "L1", emitterObjectId: "e1", aomOrder: 1, branch: "main", wavelengthNm: 780 },
        { beamId: "b2", aMm: [0, 0, 0], bMm: [0, 0, 0] },
        { beamId: "b3", aMm: [-100, 500, 0], bMm: [100, 500, 0] },
      ],
      toleranceMm: 25,
    },
    {
      end: "B",
      nodes: [{ posMm: [0, 0, 0] }, { posMm: [400, 0, 0] }],
      pose: { xMm: 10, yMm: -20, zMm: 30, rxDeg: 0, ryDeg: 0, rzDeg: 90 },
      beamSegmentsLab: [{ beamId: "b1", aMm: [0, 300, 30], bMm: [0, 500, 30] }],
      toleranceMm: 100,
    },
  ];
  for (let i = 0; i < 16; i += 1) {
    const nodes = randomNodes(r);
    const pose = r.pose();
    const segs: BeamSegmentLab[] = [];
    for (let k = 0; k < 5; k += 1) {
      const a = r.t3(600);
      const b = r.next() < 0.1 ? a : add3(a, scale3(r.unit(), r.uni(1, 800)));
      const seg: BeamSegmentLab = { beamId: `trace:s${i}k${k}`, aMm: a, bMm: b };
      if (r.next() < 0.5) {
        seg.displayLabel = `L${k}`;
        seg.emitterObjectId = r.pick(["e1", "e2"]);
        seg.aomOrder = r.pick([null, 0, 1, -1]);
        seg.branch = r.pick(["main", "reflected", "transmitted"]);
        seg.wavelengthNm = r.uni(600, 1100);
      }
      segs.push(seg);
    }
    beamInputs.push({ end: r.pick(["A", "B"] as const), nodes, pose, beamSegmentsLab: segs, toleranceMm: r.pick([25, 400, 2000]) });
  }
  const beam = beamInputs.map((input) => ({ input: plain(input), output: plain(findFiberEndAlignmentCandidates(input)) }));

  // Port candidates: the unit-test port, then random ports at random
  // orientations, with and without an explicit connector tip.
  type PortIn = { end: "A" | "B"; nodes: FiberNodePersist[]; pose: Pose; ports: FiberPortLab[]; toleranceMm: number; tipMm?: number };
  const port0: FiberPortLab = {
    labPosMm: [500, 0, 0], labAxisX: [-1, 0, 0], targetName: "DET", targetObjectId: "det",
    targetAnchorId: "fiber_in", targetAnchorName: "OPTICAL IN (FC/PC)",
  };
  const portInputs: PortIn[] = [
    { end: "B", nodes: [{ posMm: [0, 0, 0], handleOutMm: [30, 0, 0] }, { posMm: [400, 0, 0], handleInMm: [-30, 0, 0] }], pose: IDENTITY, ports: [port0], toleranceMm: 250, tipMm: 59.333 },
    { end: "A", nodes: [{ posMm: [0, 0, 0], handleOutMm: [30, 0, 0] }, { posMm: [400, 0, 0], handleInMm: [-30, 0, 0] }], pose: IDENTITY, ports: [port0], toleranceMm: 1000 },
    { end: "B", nodes: [{ posMm: [0, 0, 0] }, { posMm: [400, 0, 0] }], pose: IDENTITY, ports: [port0, { ...port0, labAxisX: [0, 0, 0], targetObjectId: "degenerate" }], toleranceMm: 5, tipMm: 59.333 },
  ];
  for (let i = 0; i < 16; i += 1) {
    const ports: FiberPortLab[] = [];
    for (let k = 0; k < 4; k += 1) {
      ports.push({
        labPosMm: r.t3(500),
        labAxisX: scale3(r.unit(), r.uni(0.2, 3)),
        targetName: `OBJ${k}`,
        targetObjectId: `obj-${k}`,
        targetAnchorId: r.pick(["fiber_in", "intercept_in"]),
        targetAnchorName: r.pick(["OPTICAL IN", "fiber_in", "port"]),
      });
    }
    portInputs.push({
      end: r.pick(["A", "B"] as const), nodes: randomNodes(r), pose: r.pose(), ports,
      toleranceMm: r.pick([50, 600, 3000]),
      ...(r.next() < 0.6 ? { tipMm: r.uni(10, 70) } : {}),
    });
  }
  const port = portInputs.map((input) => ({ input: plain(input), output: plain(findFiberPortAlignmentCandidates(input)) }));

  // The linked-end resolver — only in the pose set where its local rotation
  // copy agrees with the tracer's (see the file header). The Python takes
  // the port already in lab, lifted by the tracer's own pose.
  type LinkIn = {
    endpoint: "A" | "B"; fiberPose: Pose; targetPose: Pose; targetAnchorPosBodyMm: T3;
    targetAnchorDirBody: T3; tipMm?: number; handleMagnitudeMm?: number;
  };
  const linkInputs: LinkIn[] = [
    { endpoint: "B", fiberPose: IDENTITY, targetPose: IDENTITY, targetAnchorPosBodyMm: [500, 0, 0], targetAnchorDirBody: [-1, 0, 0], tipMm: 59.333 },
    { endpoint: "B", fiberPose: IDENTITY, targetPose: IDENTITY, targetAnchorPosBodyMm: [500, 0, 0], targetAnchorDirBody: [0, 0, 0] },
    { endpoint: "A", fiberPose: IDENTITY, targetPose: { ...IDENTITY, rzDeg: 180 }, targetAnchorPosBodyMm: [0, 0, 13], targetAnchorDirBody: [1, 0, 0] },
  ];
  for (let i = 0; i < 16; i += 1) {
    linkInputs.push({
      endpoint: r.pick(["A", "B"] as const),
      fiberPose: r.flatPose(),
      targetPose: r.flatPose(),
      targetAnchorPosBodyMm: r.t3(60),
      targetAnchorDirBody: scale3(r.unit(), r.uni(0.3, 2)),
      ...(r.next() < 0.6 ? { tipMm: r.uni(10, 70) } : {}),
      ...(r.next() < 0.3 ? { handleMagnitudeMm: r.uni(5, 60) } : {}),
    });
  }
  const linked = linkInputs.map((input) => ({ input: plain(input), output: plain(resolveLinkedFiberEndpoint({ ...input, endpoint: input.endpoint })) }));

  const syncInputs: { endA: unknown; endB: unknown }[] = [
    { endA: { posMm: [1, 2, 3], tensionHandleMm: [10, 0, 0] }, endB: { posMm: [300, 5, 6], tensionHandleMm: [-10, 1, 0] } },
    { endA: null, endB: { posMm: [7, 8, 9] } },
    { endA: { tensionHandleMm: [0, 5, 0], posMm: [1, 2] }, endB: {} },
    { endA: { posMm: [1, 2, 3], rotDeg: [0, 0, 90], numericalAperture: 0.13 }, endB: null },
  ];
  const syncNodes = syncInputs.map((input) => ({
    input: plain(input),
    output: plain(syncFiberNodesFromKindParams(input.endA as never, input.endB as never, undefined)),
  }));

  // resolveEffectiveFiberNodes — the resolveEffectiveFiberNodes.test.ts cases.
  const n2 = [{ posMm: [0, 0, 0], handleOutMm: [10, 0, 0] }, { posMm: [300, 0, 0], handleInMm: [-10, 0, 0] }];
  const pe = (kindParams: unknown, elementKind = "fiber") => ({ objectId: "o1", elementKind, kindParams });
  const effInputs: { obj: unknown; component: unknown; physicsElements: unknown[] }[] = [
    { obj: { id: "o1", properties: { fiberNodes: n2 } }, component: { properties: { fiberNodes: [{ posMm: [9, 9, 9] }, { posMm: [8, 8, 8] }] } }, physicsElements: [] },
    { obj: { id: "o1", properties: { fiberNodes: [{ posMm: [1, 1, 1] }] } }, component: { properties: { fiberNodes: n2 } }, physicsElements: [] },
    { obj: { id: "o1", properties: {} }, component: { properties: {} }, physicsElements: [pe({ endA: { posMm: [1, 2, 3], tensionHandleMm: [0, 0, 5] }, endB: { posMm: [4, 5, 6], tensionHandleMm: [0, 0, -5] } })] },
    { obj: { id: "o1", properties: {} }, component: null, physicsElements: [] },
    { obj: { id: "o1", properties: {} }, component: null, physicsElements: [pe({ fiberType: "single_mode" })] },
    { obj: { id: "o1", properties: {} }, component: null, physicsElements: [pe({ endA: {} })] },
    { obj: { id: "o1", properties: {} }, component: null, physicsElements: [pe({ endA: { posMm: [1, 2, 3] } }, "mirror")] },
    { obj: null, component: { properties: {} }, physicsElements: [pe({ endA: { posMm: [1, 2, 3] } })] },
  ];
  const effectiveNodes = effInputs.map((input) => ({
    input: plain(input),
    output: plain(resolveEffectiveFiberNodes(input.obj as never, input.component as never, input.physicsElements as never) ?? null),
  }));

  return { isPort, outward, beam, port, linked, syncNodes, effectiveNodes };
}

// ─── pigtail.json — the pigtail-connector helpers ──────────────────────────

/** `30126A9-Step`.fiber_out — the FC/APC ferrule face (8° off +Z). */
const FC_FACE = {
  id: "fiber_out",
  positionMmBodyLocal: { x: 0.0, y: -0.0398994676147898, z: 11.210308583577474 },
  axisXBodyLocal: { x: 2.686006310088765e-7, y: -0.1391728997450958, z: 0.9902680970204327 },
  axisYBodyLocal: { x: 3.7749301227963455e-8, y: 0.9902680970204691, z: 0.13917289974509064 },
  axisZBodyLocal: { x: -1.0, y: 0.0, z: 0.0 },
  apertureMm: 2.5,
  connectorType: "fc_apc_male",
};
/** …and its fiber_root — the wire junction the pigtail welds to. */
const FC_ROOT = { id: "fiber_root", positionMmBodyLocal: { x: 0, y: 9.56499836600135e-16, z: -25.000499725341797 } };
const PORT_IN_POSE: BindingPose = { localXMm: -91.2362, localYMm: 0, localZMm: 0, localRxDeg: 0, localRyDeg: -82.000011642, localRzDeg: -90.00011058 };
const PORT_OUT_POSE: BindingPose = { localXMm: 221.2362, localYMm: 0, localZMm: 0, localRxDeg: 0, localRyDeg: 82.000011642, localRzDeg: 89.99988942 };
const PORT_OUT_NODES: FiberNodePersist[] = [
  { posMm: [130, 0, 0], handleOutMm: [17.641299355907716, 4.898746060480223e-22, -10.185208931988088] },
  { posMm: [163.2395013562146, 9.230152101384416e-22, -13.322874806339092], handleInMm: [-8.85380907159749, -2.458580937532114e-22, 0], handleOutMm: [8.85380907159749, 2.458580937532114e-22, 0] },
  { posMm: [196.47900271242915, 1.8460304202768833e-21, -3.479392041881746], handleInMm: [-17.641299355907716, -4.898746060480223e-22, -10.185208931988088] },
];
const PORT_IN_NODES: FiberNodePersist[] = [
  { posMm: [0, 0, 0], handleOutMm: [-17.641299355907716, -4.898746060169379e-22, -10.185208931988088] },
  { posMm: [-33.239501356214575, -9.230152100798729e-22, -13.322874806339092], handleInMm: [8.85380907159749, 2.4585809373761075e-22, 0], handleOutMm: [-8.85380907159749, -2.4585809373761075e-22, 0] },
  { posMm: [-66.47900271242915, -1.8460304201597457e-21, -3.479392041881746], handleInMm: [17.641299355907716, 4.898746060169379e-22, -10.185208931988088] },
];
const EOM0_POSE: Pose = { xMm: -1100, yMm: -308.228629, zMm: 992.988832, rxDeg: 0, ryDeg: 0, rzDeg: 180 };

function randomFace(r: Rng): AnchorFrameLike {
  const x = r.unit();
  const y = r.unit();
  return {
    positionMmBodyLocal: xyz(r.t3(30)),
    axisXBodyLocal: xyz(scale3(x, r.uni(0.5, 2))),
    axisYBodyLocal: xyz(y),
  };
}

function buildPigtail(): Json {
  const r = makeRng(0x919a11);

  type PlacementIn = { placement: ConnectorPlacement; objectPose: Pose };
  const placements: PlacementIn[] = [
    { placement: { pose: PORT_OUT_POSE, parentPose: null, connectIn: FC_FACE }, objectPose: IDENTITY },
    { placement: { pose: PORT_IN_POSE, parentPose: null, connectIn: FC_FACE }, objectPose: EOM0_POSE },
    { placement: { pose: PORT_OUT_POSE, parentPose: null, connectIn: { positionMmBodyLocal: { x: 0, y: 0, z: 1 }, axisXBodyLocal: { x: 0, y: 0, z: 1 } } }, objectPose: IDENTITY },
    { placement: { pose: PORT_OUT_POSE, parentPose: null, connectIn: { ...FC_FACE, axisYBodyLocal: FC_FACE.axisXBodyLocal } }, objectPose: IDENTITY },
  ];
  for (let i = 0; i < 14; i += 1) {
    placements.push({
      placement: {
        pose: r.bindingPose(),
        parentPose: r.next() < 0.5 ? r.bindingPose(50) : null,
        connectIn: r.next() < 0.5 ? FC_FACE : randomFace(r),
      },
      objectPose: r.pose(),
    });
  }
  const portLab = placements.map((input) => ({ input: plain(input), output: plain(connectorPortLab(input.placement, input.objectPose)) }));

  type AlignIn = PlacementIn & { targetPosLab: T3; targetAxisXLab: T3 };
  const alignInputs: AlignIn[] = [];
  // No-op (target = where the face already is), an anti-parallel flip, a
  // degenerate direction, then random targets.
  const here = connectorPortLab(placements[1].placement, placements[1].objectPose)!;
  alignInputs.push({ ...placements[1], targetPosLab: here.posMm, targetAxisXLab: here.axisXMm });
  alignInputs.push({ ...placements[1], targetPosLab: add3(here.posMm, [5, -3, 1]), targetAxisXLab: scale3(here.axisXMm, -1) });
  alignInputs.push({ ...placements[1], targetPosLab: here.posMm, targetAxisXLab: [0, 0, 0] });
  alignInputs.push({ ...placements[2], targetPosLab: [1, 2, 3], targetAxisXLab: [1, 0, 0] });
  for (let i = 0; i < 18; i += 1) {
    const base = placements[Math.floor(r.next() * placements.length)];
    if (!connectorPortLab(base.placement, base.objectPose)) continue;
    alignInputs.push({ ...base, targetPosLab: r.t3(800), targetAxisXLab: scale3(r.unit(), r.uni(0.2, 3)) });
  }
  const align = alignInputs.map((input) => ({ input: plain(input), output: plain(computeConnectorAlignPose(input)) }));

  const chains: BindingPose[][] = [[], [PORT_OUT_POSE], [PORT_IN_POSE, PORT_OUT_POSE]];
  for (let i = 0; i < 8; i += 1) {
    const n = 1 + Math.floor(r.next() * 4);
    chains.push(Array.from({ length: n }, () => r.bindingPose()));
  }
  const compose = chains.map((poses) => ({ input: plain(poses), output: plain(composeBindingPoses(poses)) }));

  const deltaInputs: { target: BindingPose; baseline: BindingPose }[] = [
    { target: { ...PORT_OUT_POSE, localRzDeg: 270 }, baseline: PORT_OUT_POSE },
    { target: { ...PORT_OUT_POSE, localRxDeg: 180 }, baseline: { ...PORT_OUT_POSE, localRxDeg: 0 } },
    { target: { ...PORT_OUT_POSE, localRxDeg: -180 }, baseline: { ...PORT_OUT_POSE, localRxDeg: 0 } },
    { target: { ...PORT_OUT_POSE, localRyDeg: 540 }, baseline: { ...PORT_OUT_POSE, localRyDeg: 0 } },
    { target: { ...PORT_OUT_POSE, localRzDeg: -900.5 }, baseline: PORT_OUT_POSE },
  ];
  for (let i = 0; i < 8; i += 1) deltaInputs.push({ target: r.bindingPose(400), baseline: r.bindingPose(400) });
  const delta = deltaInputs.map((input) => ({ input: plain(input), output: plain(bindingPoseDelta(input.target, input.baseline)) }));

  type FollowIn = { nodes: FiberNodePersist[]; oldPose: BindingPose; newPose: BindingPose; connectOutPosMm: T3 };
  const rootPos: T3 = [FC_ROOT.positionMmBodyLocal.x, FC_ROOT.positionMmBodyLocal.y, FC_ROOT.positionMmBodyLocal.z];
  const followInputs: FollowIn[] = [
    { nodes: PORT_OUT_NODES, oldPose: PORT_OUT_POSE, newPose: PORT_OUT_POSE, connectOutPosMm: rootPos },
    { nodes: PORT_OUT_NODES, oldPose: PORT_OUT_POSE, newPose: { ...PORT_OUT_POSE, localXMm: 250, localRzDeg: 100 }, connectOutPosMm: rootPos },
    { nodes: [PORT_OUT_NODES[0]], oldPose: PORT_OUT_POSE, newPose: PORT_IN_POSE, connectOutPosMm: rootPos },
    { nodes: [PORT_IN_NODES[0], { posMm: [1, 2, 3] }], oldPose: PORT_IN_POSE, newPose: PORT_OUT_POSE, connectOutPosMm: rootPos },
  ];
  for (let i = 0; i < 8; i += 1) {
    followInputs.push({ nodes: randomNodes(r), oldPose: r.bindingPose(), newPose: r.bindingPose(), connectOutPosMm: r.t3(30) });
  }
  const follow = followInputs.map((input) => ({ input: plain(input), output: plain(pigtailNodesFollowingConnector(input)) }));

  const beamInputs: { portLab: { posMm: T3; axisXMm: T3 }; beamSegmentsLab: BeamSegmentLab[]; toleranceMm: number }[] = [
    {
      portLab: { posMm: [0, 0, 0], axisXMm: [1, 0, 0] },
      beamSegmentsLab: [
        { beamId: "b1", aMm: [-100, 3, 0], bMm: [100, 3, 0], displayLabel: "L", emitterObjectId: "e", aomOrder: -1, branch: "main", wavelengthNm: 852 },
        { beamId: "far", aMm: [-100, 300, 0], bMm: [100, 300, 0] },
        { beamId: "zero", aMm: [1, 1, 1], bMm: [1, 1, 1] },
      ],
      toleranceMm: 25,
    },
  ];
  for (let i = 0; i < 10; i += 1) {
    const segs: BeamSegmentLab[] = [];
    for (let k = 0; k < 5; k += 1) {
      const a = r.t3(400);
      segs.push({
        beamId: `trace:p${i}k${k}`, aMm: a, bMm: add3(a, scale3(r.unit(), r.uni(1, 600))),
        ...(r.next() < 0.5 ? { emitterObjectId: "e", aomOrder: r.pick([null, 1, -1]), branch: "main", wavelengthNm: 780, displayLabel: "x" } : {}),
      });
    }
    beamInputs.push({ portLab: { posMm: r.t3(300), axisXMm: r.unit() }, beamSegmentsLab: segs, toleranceMm: r.pick([50, 500, 5000]) });
  }
  const beam = beamInputs.map((input) => ({ input: plain(input), output: plain(findPigtailBeamCandidates(input)) }));

  const portInputs: { end: "A" | "B"; portLab: { posMm: T3; axisXMm: T3 }; ports: FiberPortLab[]; toleranceMm: number }[] = [];
  for (let i = 0; i < 10; i += 1) {
    const ports: FiberPortLab[] = [];
    for (let k = 0; k < 4; k += 1) {
      ports.push({
        labPosMm: r.t3(300), labAxisX: k === 3 && i === 0 ? [0, 0, 0] : scale3(r.unit(), r.uni(0.2, 3)),
        targetName: `P${k}`, targetObjectId: `o${k}`, targetAnchorId: "fiber_in", targetAnchorName: `IN ${k}`,
      });
    }
    portInputs.push({ end: r.pick(["A", "B"] as const), portLab: { posMm: r.t3(300), axisXMm: r.unit() }, ports, toleranceMm: r.pick([100, 400, 5000]) });
  }
  const ports = portInputs.map((input) => ({ input: plain(input), output: plain(findPigtailPortCandidates(input)) }));

  const matedInputs = portInputs[0].ports.flatMap((port) => (["A", "B"] as const).map((end) => ({ port, end })));
  const mated = matedInputs.map((input) => ({ input: plain(input), output: plain(matedFaceLab(input.port, input.end)) }));

  return { portLab, align, compose, delta, follow, beam, ports, mated };
}

// ─── store scenes (flows.json) ─────────────────────────────────────────────

type Obj = Record<string, unknown> & { id: string; name: string; componentId: string } & Pose;
type Scene = {
  objects: Obj[];
  components: Record<string, unknown>[];
  componentBindings: Record<string, unknown>[];
  objectBindings: Record<string, unknown>[];
  assets: Record<string, unknown>[];
  physicsElements: Record<string, unknown>[];
};

const anchor = (id: string, pos: T3, axisX: T3 | null, extra: Record<string, unknown> = {}) => ({
  id,
  positionMmBodyLocal: xyz(pos),
  ...(axisX ? { axisXBodyLocal: xyz(axisX) } : {}),
  ...extra,
});
const asset = (id: string, kindId: string, anchors: unknown[]) => ({ id, name: id, kindId, anchors, defaultParams: {} });
const component = (id: string, kindId: string, extra: Record<string, unknown> = {}) => ({ id, name: id, kindId, asset3dId: null, properties: {}, ...extra });
const bindingRow = (p: {
  id: string; componentId: string; asset?: string | null; parent?: string | null; kind?: "asset" | "empty";
  role?: string; pose?: BindingPose; properties?: Record<string, unknown>; sortOrder?: number;
}) => ({
  id: p.id,
  componentId: p.componentId,
  parentBindingId: p.parent ?? null,
  targetKind: p.kind ?? "asset",
  asset3dId: p.asset ?? null,
  subComponentId: null,
  role: p.role ?? p.id,
  ...(p.pose ?? { localXMm: 0, localYMm: 0, localZMm: 0, localRxDeg: 0, localRyDeg: 0, localRzDeg: 0 }),
  tunableAxes: {},
  sortOrder: p.sortOrder ?? 0,
  properties: p.properties ?? {},
});
const sceneObject = (id: string, componentId: string, pose: Pose, properties: Record<string, unknown> = {}): Obj => ({
  id, name: id.toUpperCase(), componentId, ...pose, visible: true, locked: false, properties, dynamicSources: null,
});

/** A trace segment as the viewer publishes it (three units = lab / 100). */
type TraceSeg = {
  startThree: Vec3; endThree: Vec3; emitterObjectId?: string; sourceObjectId?: string;
  wavelengthNm?: number; branch?: string; aomSideband?: { order?: number };
};
const traceSeg = (a: T3, b: T3, extra: Omit<TraceSeg, "startThree" | "endThree"> = {}): TraceSeg => ({
  startThree: xyz(scale3(a, 0.01)), endThree: xyz(scale3(b, 0.01)), ...extra,
});

/** The BeamSegmentLab the store's `collectBeamSegmentsLab` builds from a
 *  trace — recorded so the Python is fed exactly what the store saw. */
function beamSegmentsOf(scene: Scene, traces: TraceSeg[]): Json {
  const name = (id?: string) => (id ? scene.objects.find((o) => o.id === id)?.name ?? id.slice(0, 6) : "?");
  const fmt = (o?: number) => (o === undefined || o === null ? "" : o === 0 ? " 0-order" : o > 0 ? ` +${o}-order` : ` ${o}-order`);
  return traces.map((s) => {
    const order = s.aomSideband?.order;
    return plain({
      beamId: `trace:${(s.emitterObjectId ?? "?").slice(0, 8)}:o${order ?? "x"}:${(s.sourceObjectId ?? "?").slice(0, 8)}`,
      aMm: [s.startThree.x * 100, s.startThree.y * 100, s.startThree.z * 100],
      bMm: [s.endThree.x * 100, s.endThree.y * 100, s.endThree.z * 100],
      displayLabel: `${name(s.emitterObjectId)}${s.sourceObjectId && s.sourceObjectId !== s.emitterObjectId ? ` via ${name(s.sourceObjectId)}` : ""}${fmt(order)}${typeof s.wavelengthNm === "number" ? ` @ ${s.wavelengthNm.toFixed(0)} nm` : ""}`,
      emitterObjectId: s.emitterObjectId,
      aomOrder: order ?? null,
      branch: s.branch,
      wavelengthNm: s.wavelengthNm,
      sourceObjectId: s.sourceObjectId,
    });
  });
}

let obSeq = 0;

function seedStore(scene: Scene, traces: TraceSeg[]): void {
  obSeq = 0;
  const state = useSceneStore.getState();
  useSceneStore.setState({
    scene: {
      ...state.scene,
      objects: structuredClone(scene.objects) as never,
      components: structuredClone(scene.components) as never,
      componentBindings: structuredClone(scene.componentBindings) as never,
      objectBindings: structuredClone(scene.objectBindings) as never,
      assets: structuredClone(scene.assets) as never,
      physicsElements: structuredClone(scene.physicsElements) as never,
      collections: [],
      collectionMembers: [],
    },
    undoStack: [],
    redoStack: [],
    upsertOpticalElement: (async (payload: { objectId: string; elementKind: string; kindParams: unknown }) => {
      const cur = useSceneStore.getState().scene.physicsElements.find((e) => e.objectId === payload.objectId);
      const element = { ...(cur ?? {}), ...payload };
      useSceneStore.setState((s) => ({
        scene: {
          ...s.scene,
          physicsElements: [
            ...s.scene.physicsElements.filter((e) => e.objectId !== payload.objectId),
            element,
          ] as never,
        },
      }));
      return element;
    }) as never,
  });
  (globalThis as { window?: unknown }).window = { __rayTraceDebug: traces };
}

/** The persisted state a flow can change, in a stable shape. */
function snapshot(): Json {
  const s = useSceneStore.getState().scene;
  const objects: Record<string, unknown> = {};
  for (const o of s.objects) objects[o.id] = o.properties ?? {};
  const pes: Record<string, unknown> = {};
  for (const e of s.physicsElements) pes[e.objectId] = (e as { kindParams?: unknown }).kindParams ?? null;
  const obs = (s.objectBindings ?? [])
    .map((b) => ({
      objectId: b.objectId,
      componentBindingId: b.componentBindingId,
      localXMmDelta: b.localXMmDelta ?? null,
      localYMmDelta: b.localYMmDelta ?? null,
      localZMmDelta: b.localZMmDelta ?? null,
      localRxDegDelta: b.localRxDegDelta ?? null,
      localRyDegDelta: b.localRyDegDelta ?? null,
      localRzDegDelta: b.localRzDegDelta ?? null,
      asset3dIdOverride: b.asset3dIdOverride ?? null,
      properties: b.properties ?? {},
    }))
    .sort((a, b) => `${a.objectId}|${a.componentBindingId}`.localeCompare(`${b.objectId}|${b.componentBindingId}`));
  return plain({ objects, physicsElements: pes, objectBindings: obs });
}

type Op =
  | { op: "find"; kind: "fiber" | "pigtail"; objectId: string; end: "A" | "B"; toleranceMm: number }
  | { op: "apply"; kind: "fiber" | "pigtail"; objectId: string; end: "A" | "B"; toleranceMm: number; index: number; pick?: "port" | "beam" }
  | { op: "clear"; kind: "fiber" | "pigtail"; objectId: string; end: "A" | "B" }
  | { op: "move"; objectId: string; pose: Pose }
  | { op: "resnap"; kind: "fiber" | "pigtail"; movedObjectIds: string[] };

async function findCandidates(kind: "fiber" | "pigtail", objectId: string, end: "A" | "B", tol: number) {
  const store = useSceneStore.getState();
  return kind === "fiber"
    ? store.findFiberAlignmentCandidates(objectId, end, tol)
    : store.findPigtailAlignmentCandidates(objectId, end, tol);
}

/** Run a flow through the REAL store and record every step. */
async function runFlow(name: string, scene: Scene, traces: TraceSeg[], ops: Op[]): Promise<Json> {
  seedStore(scene, traces);
  const steps: Json[] = [];
  for (const op of ops) {
    const store = useSceneStore.getState();
    if (op.op === "find") {
      steps.push({ ...op, candidates: plain(await findCandidates(op.kind, op.objectId, op.end, op.toleranceMm)) });
    } else if (op.op === "apply") {
      const all = await findCandidates(op.kind, op.objectId, op.end, op.toleranceMm);
      // `pick` narrows to receptacle / beam candidates before indexing.
      const list = op.pick === undefined ? all : all.filter((c) => (op.pick === "port") === Boolean(c.port));
      const cand = list[op.index];
      if (!cand) throw new Error(`${name}: no candidate ${op.index} for ${op.objectId}/${op.end}`);
      if (op.kind === "fiber") await store.applyFiberAlignmentCandidate(op.objectId, op.end, cand as never);
      else await store.applyPigtailAlignmentCandidate(op.objectId, op.end, cand as never);
      steps.push({ ...op, candidate: plain(cand), state: snapshot() });
    } else if (op.op === "clear") {
      if (op.kind === "fiber") await store.clearFiberEndpointLink(op.objectId, op.end);
      else await store.clearPigtailEndpointLink(op.objectId, op.end);
      steps.push({ ...op, state: snapshot() });
    } else if (op.op === "move") {
      useSceneStore.setState((s) => ({
        scene: { ...s.scene, objects: s.scene.objects.map((o) => (o.id === op.objectId ? { ...o, ...op.pose } : o)) as never },
      }));
      steps.push({ ...op });
    } else {
      if (op.kind === "fiber") await store.resnapFibersLinkedTo(op.movedObjectIds);
      else await store.resnapPigtailsLinkedTo(op.movedObjectIds);
      steps.push({ ...op, state: snapshot() });
    }
  }
  delete (globalThis as { window?: unknown }).window;
  return { name, scene: plain(scene), beamSegments: beamSegmentsOf(scene, traces), initial: null, steps };
}

// The catalog connectors (live values): PM FC/PC with the fibre spelling, and
// an older fibre connector still on the coax spelling (both must resolve).
const CONN_PM = asset("a-conn-pm", "fiber_connector", [
  anchor("fiber_root", [0, 0, 0], [0, 0, -1]),
  anchor("fiber_out", [-0.002, 0.002, 59.525], [0, 0, 1], { connectorType: "fc_pc_male", apertureMm: 2.5 }),
]);
const CONN_COAX_SPELLING = asset("a-conn-legacy", "fiber_connector", [
  anchor("connect_out", [0, 0, 0], [0, 0, -1]),
  anchor("connect_in", [0.001, 0, 56.891], [0, 0, 1], { connectorType: "fc_pc_male" }),
]);

/** A port's lab position under a flat pose (the set the scenes stay in). */
function labOf(pose: Pose, body: T3): T3 {
  const p = pointBodyToLab(xyz(body), pose);
  return [p.x, p.y, p.z];
}

function buildFiberFlow(seed: number, name: string): Promise<Json> {
  const r = makeRng(seed);
  const detPose = r.flatPose();
  const det2Pose = r.flatPose();
  const srcPose = r.flatPose();
  const oldPose = r.flatPose();
  const detPort: T3 = [-4, 10.258, 17.584];
  const srcPort: T3 = [0, 0, 13];
  const oldPort: T3 = [3, -2, 1];
  const assets = [
    asset("a-det", "detector", [anchor("fiber_in", detPort, [-1, 0, 0], { name: "OPTICAL IN (FC/PC)", connectorType: "fc_pc_female", apertureMm: 1.25 })]),
    asset("a-src", "laser_source", [
      anchor("fiber_in", srcPort, [1, 0, 0], { name: "UNIVERSAL CONNECTOR", connectorType: "fc_pc_female" }),
      anchor("intercept_out", srcPort, [1, 0, 0]),
    ]),
    // Pre-0133 spelling: an intercept declaring a female connector, and an
    // anchor with only the legacy direction field.
    asset("a-old", "detector", [
      anchor("intercept_in", oldPort, [0, 1, 0], { connectorType: "fc_apc_female" }),
      anchor("legacy_port", [0, 0, 40], null, { connectorType: "sc_pc_female", directionBodyLocal: xyz([0, 0, 2]) }),
    ]),
    // A free-space face and a male plug: never ports.
    asset("a-mir", "mirror", [anchor("fiber_in", [0, 0, 0], [-1, 0, 0])]),
    asset("a-plug", "fiber_connector", [anchor("fiber_out", [0, 0, 5], [0, 0, 1], { connectorType: "fc_apc_male" })]),
    asset("a-nonport-mount", "mechanical", [anchor("mount_point", [1, 1, 1], [0, 0, 1])]),
    CONN_PM,
    CONN_COAX_SPELLING,
  ];
  const components = [
    component("c-det", "detector"),
    component("c-src", "laser_source"),
    component("c-old", "detector", { asset3dId: "a-old" }),
    component("c-mir", "mirror"),
    component("c-plug", "fiber_connector"),
    component("c-fib-role", "fiber"),
    component("c-fib-spline", "fiber"),
    component("c-fib-none", "fiber", {
      properties: { fiberNodes: [{ posMm: [0, 0, 0], handleOutMm: [20, 0, 0] }, { posMm: [250, 0, 0], handleInMm: [-20, 0, 0] }] },
    }),
  ];
  const componentBindings = [
    bindingRow({ id: "b-det", componentId: "c-det", asset: "a-det" }),
    // A transformed non-port binding in the same Component: must not disturb the port.
    bindingRow({ id: "b-det-mount", componentId: "c-det", asset: "a-nonport-mount", pose: { localXMm: 5, localYMm: 6, localZMm: 7, localRxDeg: 10, localRyDeg: 20, localRzDeg: 30 }, sortOrder: 1 }),
    bindingRow({ id: "b-src", componentId: "c-src", asset: "a-src" }),
    bindingRow({ id: "b-mir", componentId: "c-mir", asset: "a-mir" }),
    bindingRow({ id: "b-plug", componentId: "c-plug", asset: "a-plug" }),
    bindingRow({ id: "b-fr-a", componentId: "c-fib-role", asset: "a-conn-pm", role: "end_a" }),
    bindingRow({ id: "b-fr-b", componentId: "c-fib-role", asset: "a-conn-pm", role: "end_b", sortOrder: 1 }),
    bindingRow({ id: "b-fs-b", componentId: "c-fib-spline", asset: "a-conn-pm", role: "pm_780_apc", properties: { splineEnd: "B" } }),
    bindingRow({ id: "b-fs-a", componentId: "c-fib-spline", asset: "a-conn-legacy", role: "pm_780_pc", properties: { splineEnd: "A" }, sortOrder: 1 }),
  ];
  const detLab = labOf(detPose, detPort);
  const srcLab = labOf(srcPose, srcPort);
  // Fibres parked near the ports (their faces within a few cm), flat poses.
  const fib0Pose: Pose = { ...r.flatPose(), rzDeg: 0 };
  const fib1Pose: Pose = { ...r.flatPose(), rzDeg: 180 };
  const toBody = (pose: Pose, lab: T3): T3 => {
    // Flat poses only: rz ∈ {0, ±180} ⇒ x,y flip with the turn.
    const c = Math.round(Math.cos((pose.rzDeg * Math.PI) / 180));
    return [(lab[0] - pose.xMm) * c, (lab[1] - pose.yMm) * c, lab[2] - pose.zMm];
  };
  const fib0Nodes: FiberNodePersist[] = [
    { posMm: add3(toBody(fib0Pose, srcLab), [60, 8, -5]), handleOutMm: [30, 0, 0] },
    { posMm: add3(toBody(fib0Pose, srcLab), [200, 40, -20]), handleInMm: [-15, 5, 0], handleOutMm: [15, -5, 0] },
    { posMm: add3(toBody(fib0Pose, detLab), [70, -9, 4]), handleInMm: [-30, 0, 0] },
  ];
  const fib1EndA = add3(toBody(fib1Pose, detLab), [-50, 12, 3]);
  const fib1EndB = add3(toBody(fib1Pose, labOf(det2Pose, detPort)), [45, 5, -8]);
  const objects: Obj[] = [
    sceneObject("det0", "c-det", detPose),
    sceneObject("det1", "c-det", det2Pose),
    sceneObject("src0", "c-src", srcPose),
    sceneObject("old0", "c-old", oldPose),
    sceneObject("mir0", "c-mir", { ...detPose, xMm: detPose.xMm + 3 }),
    sceneObject("plug0", "c-plug", { ...srcPose, yMm: srcPose.yMm + 2 }),
    sceneObject("fib0", "c-fib-role", fib0Pose, { fiberNodes: fib0Nodes, keepMe: { a: 1 } }),
    sceneObject("fib1", "c-fib-spline", fib1Pose, { fiberEndpoints: null }),
    sceneObject("fib2", "c-fib-none", { ...r.flatPose(), rzDeg: 180 }),
  ];
  const physicsElements = [
    { objectId: "fib0", elementKind: "fiber", kindParams: { fiberType: "polarization_maintaining", endA: { numericalAperture: 0.12 }, endB: { posMm: [0, 0, 0], slowAxisDegInBodyFrame: 90 } } },
    { objectId: "fib1", elementKind: "fiber", kindParams: { endA: { posMm: fib1EndA, tensionHandleMm: [-10, 0, 0] }, endB: { posMm: fib1EndB, tensionHandleMm: [10, 2, 0] } } },
    { objectId: "det0", elementKind: "detector", kindParams: {} },
  ];
  const scene: Scene = { objects, components, componentBindings, objectBindings: [], assets, physicsElements };

  // Beams around fib0's End A face: one chain in two hops (collapses), its
  // ±1 AOM orders, a reflected branch, a segment emitted BY fib0 (skipped)
  // and a zero-length one.
  const faceA = labOf(fib0Pose, add3(fib0Nodes[0].posMm, [-36.28, 0, 0]));
  const dir: T3 = [1, 0.1, 0];
  const traces: TraceSeg[] = [
    traceSeg(add3(faceA, [-300, -30, 4]), add3(faceA, [-100, -10, 4]), { emitterObjectId: "src0", sourceObjectId: "src0", wavelengthNm: 780, branch: "main" }),
    traceSeg(add3(faceA, [-100, -10, 4]), add3(faceA, [100, 10, 4]), { emitterObjectId: "src0", sourceObjectId: "mir0", wavelengthNm: 780, branch: "main" }),
    traceSeg(add3(faceA, [-100, -10, 9]), add3(faceA, [100, 10, 9]), { emitterObjectId: "src0", sourceObjectId: "mir0", wavelengthNm: 780, branch: "main", aomSideband: { order: 1 } }),
    traceSeg(add3(faceA, [-100, -10, -7]), add3(faceA, [100, 10, -7]), { emitterObjectId: "src0", sourceObjectId: "mir0", wavelengthNm: 780, branch: "main", aomSideband: { order: -1 } }),
    traceSeg(add3(faceA, [0, -60, 2]), add3(faceA, [0, 60, 2]), { emitterObjectId: "src0", sourceObjectId: "mir0", wavelengthNm: 852.4, branch: "reflected" }),
    traceSeg(add3(faceA, scale3(dir, -50)), add3(faceA, scale3(dir, 50)), { emitterObjectId: "fib0", sourceObjectId: "fib0" }),
    traceSeg(faceA, faceA, { emitterObjectId: "src0", sourceObjectId: "src0" }),
  ];

  const detMoved: Pose = { ...detPose, xMm: detPose.xMm + 37.5, yMm: detPose.yMm - 12.25, rzDeg: detPose.rzDeg === 0 ? 180 : 0 };
  const srcMoved: Pose = { ...srcPose, zMm: srcPose.zMm + 3 };
  const ops: Op[] = [
    { op: "find", kind: "fiber", objectId: "fib0", end: "A", toleranceMm: 400 },
    { op: "find", kind: "fiber", objectId: "fib0", end: "B", toleranceMm: 400 },
    { op: "find", kind: "fiber", objectId: "fib0", end: "B", toleranceMm: 25 },
    { op: "find", kind: "fiber", objectId: "fib1", end: "A", toleranceMm: 5000 },
    { op: "find", kind: "fiber", objectId: "fib2", end: "B", toleranceMm: 5000 },
    { op: "find", kind: "fiber", objectId: "det0", end: "A", toleranceMm: 400 },
    { op: "apply", kind: "fiber", objectId: "fib0", end: "B", toleranceMm: 400, index: 0 },
    { op: "apply", kind: "fiber", objectId: "fib0", end: "A", toleranceMm: 400, index: 0 },
    { op: "apply", kind: "fiber", objectId: "fib0", end: "A", toleranceMm: 400, index: 1 },
    // Plug End A in, park it on a beam (which must UNPLUG it), plug it back.
    { op: "apply", kind: "fiber", objectId: "fib0", end: "A", toleranceMm: 400, index: 0, pick: "port" },
    { op: "apply", kind: "fiber", objectId: "fib0", end: "A", toleranceMm: 400, index: 0, pick: "beam" },
    { op: "apply", kind: "fiber", objectId: "fib0", end: "A", toleranceMm: 400, index: 0, pick: "port" },
    { op: "apply", kind: "fiber", objectId: "fib1", end: "A", toleranceMm: 5000, index: 0 },
    { op: "apply", kind: "fiber", objectId: "fib1", end: "B", toleranceMm: 5000, index: 1 },
    { op: "apply", kind: "fiber", objectId: "fib2", end: "B", toleranceMm: 5000, index: 0 },
    { op: "clear", kind: "fiber", objectId: "fib2", end: "B" },
    { op: "clear", kind: "fiber", objectId: "fib2", end: "B" },
    { op: "clear", kind: "fiber", objectId: "fib2", end: "A" },
    { op: "apply", kind: "fiber", objectId: "fib2", end: "A", toleranceMm: 5000, index: 2 },
    { op: "move", objectId: "det0", pose: detMoved },
    { op: "move", objectId: "src0", pose: srcMoved },
    { op: "move", objectId: "old0", pose: { ...oldPose, xMm: oldPose.xMm - 20, rzDeg: oldPose.rzDeg === 0 ? -180 : 0 } },
    { op: "resnap", kind: "fiber", movedObjectIds: ["det0", "src0", "old0", "nope"] },
    { op: "resnap", kind: "fiber", movedObjectIds: ["mir0"] },
    { op: "resnap", kind: "fiber", movedObjectIds: [] },
  ];
  return runFlow(name, scene, traces, ops);
}

function buildPigtailFlow(seed: number, name: string): Promise<Json> {
  const r = makeRng(seed);
  const detPort: T3 = [-4, 10.258, 17.584];
  const srcPort: T3 = [0, 0, 13];
  const assets = [
    asset("a-eom", "eom", [
      anchor("intercept_in", [0, 0, 0], [1, 0, 0], { apertureMm: 0.5 }),
      anchor("intercept_out", [130, 0, 0], [1, 0, 0], { apertureMm: 0.5 }),
      anchor("rf_in", [60, 10, 5], [0, 1, 0], { connectorType: "sma_female" }),
    ]),
    asset("a-fc", "fiber_connector", [FC_ROOT, FC_FACE]),
    asset("a-fc-legacy", "fiber_connector", [
      { ...FC_ROOT, id: "connect_out" },
      { ...FC_FACE, id: "connect_in" },
    ]),
    asset("a-fc-noaxis", "fiber_connector", [FC_ROOT, { id: "fiber_out", positionMmBodyLocal: { x: 0, y: 0, z: 11 }, axisXBodyLocal: { x: 0, y: 0, z: 1 } }]),
    asset("a-det", "detector", [anchor("fiber_in", detPort, [-1, 0, 0], { name: "OPTICAL IN (FC/PC)", connectorType: "fc_pc_female" })]),
    asset("a-src", "laser_source", [anchor("fiber_in", srcPort, [1, 0, 0], { name: "UNIVERSAL CONNECTOR", connectorType: "fc_pc_female" })]),
  ];
  const components = [
    component("c-eom", "eom"),
    component("c-eom-nested", "eom"),
    component("c-eom-bad", "eom"),
    component("c-det", "detector"),
    component("c-src", "laser_source"),
  ];
  const componentBindings = [
    bindingRow({ id: "e-mod", componentId: "c-eom", asset: "a-eom", role: "modulator" }),
    bindingRow({ id: "e-in", componentId: "c-eom", asset: "a-fc", role: "port_in", pose: PORT_IN_POSE, properties: { portAnchor: "intercept_in", fiberNodes: PORT_IN_NODES, fiberRadiusMm: 0.9 }, sortOrder: 1 }),
    bindingRow({ id: "e-out", componentId: "c-eom", asset: "a-fc", role: "port_out", pose: PORT_OUT_POSE, properties: { portAnchor: "intercept_out", fiberNodes: PORT_OUT_NODES }, sortOrder: 2 }),
    // Nested: the input connector hangs under a transformed mount; the output
    // is a bare root with no jacket; a connector with no portAnchor is inert.
    bindingRow({ id: "n-mod", componentId: "c-eom-nested", asset: "a-eom", role: "modulator" }),
    bindingRow({ id: "n-mount", componentId: "c-eom-nested", kind: "empty", role: "mount", pose: { localXMm: 5, localYMm: -3, localZMm: 2, localRxDeg: 10, localRyDeg: 20, localRzDeg: 30 }, sortOrder: 1 }),
    bindingRow({ id: "n-in", componentId: "c-eom-nested", parent: "n-mount", asset: "a-fc-legacy", role: "port_in", pose: PORT_IN_POSE, properties: { portAnchor: "intercept_in", fiberNodes: PORT_IN_NODES }, sortOrder: 2 }),
    bindingRow({ id: "n-out", componentId: "c-eom-nested", asset: "a-fc", role: "port_out", pose: PORT_OUT_POSE, properties: { portAnchor: "intercept_out" }, sortOrder: 3 }),
    bindingRow({ id: "n-loose", componentId: "c-eom-nested", asset: "a-fc", role: "spare", pose: PORT_OUT_POSE, sortOrder: 4 }),
    bindingRow({ id: "x-mod", componentId: "c-eom-bad", asset: "a-eom", role: "modulator" }),
    bindingRow({ id: "x-in", componentId: "c-eom-bad", asset: "a-fc-noaxis", role: "port_in", properties: { portAnchor: "intercept_in" }, sortOrder: 1 }),
    bindingRow({ id: "b-det", componentId: "c-det", asset: "a-det" }),
    bindingRow({ id: "b-src", componentId: "c-src", asset: "a-src" }),
  ];
  const eom0Pose = EOM0_POSE;
  const eom1Pose = r.pose();
  // Put a receptacle ~1 cm from each EOM0 port face, on flat poses.
  const place = (face: T3, port: T3, rz: number, jitter: T3): Pose => {
    const c = Math.round(Math.cos((rz * Math.PI) / 180));
    const want = add3(face, jitter);
    return { xMm: want[0] - c * port[0], yMm: want[1] - c * port[1], zMm: want[2] - port[2], rxDeg: 0, ryDeg: 0, rzDeg: rz };
  };
  const outFace = connectorPortLab({ pose: PORT_OUT_POSE, parentPose: null, connectIn: FC_FACE }, eom0Pose)!.posMm;
  const inFace = connectorPortLab({ pose: PORT_IN_POSE, parentPose: null, connectIn: FC_FACE }, eom0Pose)!.posMm;
  const detPose = place(outFace, detPort, 180, [6, -4, 3]);
  const srcPose = place(inFace, srcPort, 0, [-5, 7, -2]);
  const eom1In = connectorPortLab({ pose: { ...PORT_IN_POSE, localXMm: PORT_IN_POSE.localXMm + 2, localRzDeg: PORT_IN_POSE.localRzDeg + 15 }, parentPose: { localXMm: 5, localYMm: -3, localZMm: 2, localRxDeg: 10, localRyDeg: 20, localRzDeg: 30 }, connectIn: FC_FACE }, eom1Pose)!.posMm;
  const det1Pose = place(eom1In, detPort, -180, [3, 3, 3]);
  const objects: Obj[] = [
    sceneObject("eom0", "c-eom", eom0Pose, { bindingFiberNodes: { "orphan-binding": [{ posMm: [0, 0, 0] }] } }),
    sceneObject("eom1", "c-eom-nested", eom1Pose, { bindingFiberNodes: { "n-in": PORT_IN_NODES.map((n) => ({ ...n, posMm: add3(n.posMm, [0, 1, 0]) })) }, pigtailEndpoints: { intercept_out: { targetObjectId: "gone", targetAnchorId: "fiber_in", targetAnchorName: "x" } } }),
    sceneObject("eomx", "c-eom-bad", r.pose()),
    sceneObject("det0", "c-det", detPose),
    sceneObject("src0", "c-src", srcPose),
    sceneObject("det1", "c-det", det1Pose),
  ];
  const objectBindings = [{
    id: "ob-existing", objectId: "eom1", componentBindingId: "n-in",
    localXMmDelta: 2, localYMmDelta: null, localZMmDelta: null, localRxDegDelta: null, localRyDegDelta: null, localRzDegDelta: 15,
    asset3dIdOverride: null, properties: { note: "kept" },
  }];
  const scene: Scene = { objects, components, componentBindings, objectBindings, assets, physicsElements: [] };

  const traces: TraceSeg[] = [
    traceSeg(add3(outFace, [-200, 20, 5]), add3(outFace, [200, -20, 5]), { emitterObjectId: "src0", sourceObjectId: "src0", wavelengthNm: 852, branch: "main" }),
    traceSeg(add3(outFace, [-200, 20, -6]), add3(outFace, [200, -20, -6]), { emitterObjectId: "src0", sourceObjectId: "src0", wavelengthNm: 852, branch: "main", aomSideband: { order: 1 } }),
    traceSeg(add3(inFace, [0, -100, 1]), add3(inFace, [0, 100, 1]), { emitterObjectId: "src0", sourceObjectId: "det0", wavelengthNm: 852, branch: "transmitted" }),
    traceSeg(add3(inFace, [0, -100, 3]), add3(inFace, [0, 100, 3]), { emitterObjectId: "eom0", sourceObjectId: "eom0", wavelengthNm: 852 }),
  ];

  const ops: Op[] = [
    { op: "find", kind: "pigtail", objectId: "eom0", end: "A", toleranceMm: 1000 },
    { op: "find", kind: "pigtail", objectId: "eom0", end: "B", toleranceMm: 1000 },
    { op: "find", kind: "pigtail", objectId: "eom0", end: "B", toleranceMm: 25 },
    { op: "find", kind: "pigtail", objectId: "eom1", end: "A", toleranceMm: 5000 },
    { op: "find", kind: "pigtail", objectId: "eom1", end: "B", toleranceMm: 5000 },
    { op: "find", kind: "pigtail", objectId: "eomx", end: "A", toleranceMm: 5000 },
    { op: "find", kind: "pigtail", objectId: "det0", end: "A", toleranceMm: 5000 },
    { op: "apply", kind: "pigtail", objectId: "eom0", end: "B", toleranceMm: 1000, index: 0 },
    { op: "apply", kind: "pigtail", objectId: "eom0", end: "A", toleranceMm: 1000, index: 0 },
    { op: "apply", kind: "pigtail", objectId: "eom0", end: "A", toleranceMm: 1000, index: 1 },
    { op: "apply", kind: "pigtail", objectId: "eom1", end: "A", toleranceMm: 5000, index: 0 },
    { op: "apply", kind: "pigtail", objectId: "eom1", end: "B", toleranceMm: 5000, index: 1 },
    { op: "clear", kind: "pigtail", objectId: "eom0", end: "B" },
    { op: "clear", kind: "pigtail", objectId: "eom0", end: "B" },
    { op: "apply", kind: "pigtail", objectId: "eom0", end: "B", toleranceMm: 1000, index: 0, pick: "port" },
    { op: "apply", kind: "pigtail", objectId: "eom0", end: "A", toleranceMm: 1000, index: 0, pick: "beam" },
    { op: "apply", kind: "pigtail", objectId: "eom0", end: "A", toleranceMm: 1000, index: 0, pick: "port" },
    { op: "move", objectId: "src0", pose: { ...srcPose, yMm: srcPose.yMm - 8, rzDeg: 180 } },
    { op: "move", objectId: "det0", pose: { ...detPose, xMm: detPose.xMm + 12.5, zMm: detPose.zMm - 4, rzDeg: 0 } },
    { op: "move", objectId: "det1", pose: { ...det1Pose, yMm: det1Pose.yMm + 30 } },
    { op: "resnap", kind: "pigtail", movedObjectIds: ["det0", "det1", "src0"] },
    { op: "resnap", kind: "pigtail", movedObjectIds: ["src0-not-linked"] },
  ];
  return runFlow(name, scene, traces, ops);
}

async function buildFlows(): Promise<Json> {
  updateObjectApiMock.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
    const current = useSceneStore.getState().scene.objects.find((o) => o.id === id);
    return { ...(current ?? { id }), ...patch };
  });
  upsertObjectBindingApiMock.mockImplementation(async (objectId: string, payload: Record<string, unknown>) => {
    const existing = (useSceneStore.getState().scene.objectBindings ?? []).find(
      (b) => b.objectId === objectId && b.componentBindingId === payload.componentBindingId,
    );
    obSeq += 1;
    return { ...(existing ?? {}), id: existing?.id ?? `ob-new-${obSeq}`, objectId, ...payload };
  });
  return [
    await buildFiberFlow(0xf10a, "fiber-a"),
    await buildFiberFlow(0xf10b, "fiber-b"),
    await buildPigtailFlow(0x9a1, "pigtail-a"),
    await buildPigtailFlow(0x9a2, "pigtail-b"),
  ];
}

/** `pigtailPortBindings` over the pigtail scenes — which ports, in which
 *  order, with which poses. */
async function buildPortBindings(): Promise<Json> {
  const flows = (await buildFlows()) as { name: string; scene: Scene }[];
  const out: Json[] = [];
  for (const f of flows) {
    if (!f.name.startsWith("pigtail")) continue;
    for (const obj of f.scene.objects) {
      const comp = f.scene.components.find((c) => c.id === obj.componentId);
      if (!comp) continue;
      const ports = pigtailPortBindings(comp as never, obj as never, f.scene as never);
      out.push({
        flow: f.name,
        objectId: obj.id,
        ports: plain(ports.map((p) => ({
          end: p.end,
          portAnchor: p.portAnchor,
          bindingId: p.binding.id,
          connectorId: p.connector.id,
          connectInId: p.connectIn.id,
          connectOutId: p.connectOut?.id ?? null,
          basePose: p.basePose,
          effectivePose: p.effectivePose,
          objectBindingId: p.objectBinding?.id ?? null,
          parentChain: p.parentChain,
        }))),
      });
    }
  }
  return out;
}

// ─── write / compare ───────────────────────────────────────────────────────

const BUILDERS: Record<string, () => Json | Promise<Json>> = {
  "geometry.json": buildGeometry,
  "pigtail.json": buildPigtail,
  "flows.json": buildFlows,
  "port_bindings.json": buildPortBindings,
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

describe("fibre parity fixtures (TS -> backend/tests/fixtures/fibers)", () => {
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
        throw new Error(`${file} is missing — run with UPDATE_FIBER_FIXTURES=1`);
      }
      try {
        expectSame(data, committed, file);
      } catch (err) {
        throw new Error(
          `${(err as Error).message}\nThe TypeScript no longer produces the committed fixture. If the change is `
          + "intended: regenerate with UPDATE_FIBER_FIXTURES=1, then port it to backend/app/optical/fibers "
          + "until backend/tests/optical/test_fiber_parity.py is green again.",
        );
      }
    });
  }
});
