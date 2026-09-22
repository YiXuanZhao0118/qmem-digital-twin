/**
 * The store half of the fibre endpoint link — "plug this patch cable into
 * that instrument" (2026-08-21, the optical twin of `rfCableEndpoints`).
 *
 * The pure mating geometry is pinned in
 * `utils/__tests__/fiberPortAlignment.test.ts`. What is only reachable here
 * is the wiring, and every one of these is a way the feature can look like it
 * works while doing nothing:
 *   - a port is DISCOVERED at all (an optical anchor carrying a fibre
 *     `connectorType`, found by walking the binding tree — reading
 *     `asset3dId` finds nothing in a binding-backed scene);
 *   - a free-space face (no connectorType) is NOT offered as a port;
 *   - applying a port candidate PERSISTS `properties.fiberEndpoints`, which
 *     is what makes the end follow the part;
 *   - applying a BEAM candidate clears it again, and so does a hand-drag —
 *     manual override beats link;
 *   - `resnapFibersLinkedTo` moves a plugged end when its target moves.
 */

import * as THREE from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dirBodyToLab, pointBodyToLab } from "../../optical/pose";
import { FIBER_MATING_GAP_MM } from "../../utils/fiberAnchorResolver";

const updateObjectApiMock = vi.fn();
const upsertOpticalElementMock = vi.fn();

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateObjectApi: (id: string, patch: Record<string, unknown>) =>
    updateObjectApiMock(id, patch),
}));

const { useSceneStore } = await import("../sceneStore");

type Node = {
  posMm: [number, number, number];
  handleInMm?: [number, number, number];
  handleOutMm?: [number, number, number];
};

const FIBER_ID = "fiber-1";
const FIBER_COMP = "comp-fiber";
const DET_ID = "det-1";
const DET_COMP = "comp-det";
const MIRROR_ID = "mirror-1";
const MIRROR_COMP = "comp-mirror";

const IDENTITY_BINDING_POSE = {
  localXMm: 0, localYMm: 0, localZMm: 0, localRxDeg: 0, localRyDeg: 0, localRzDeg: 0,
};

const pose = (x = 0, y = 0, z = 0) => ({
  xMm: x, yMm: y, zMm: z, rxDeg: 0, ryDeg: 0, rzDeg: 0,
});

const obj = (id: string, componentId: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  componentId,
  ...pose(),
  visible: true,
  locked: false,
  properties: {},
  ...extra,
});

/** An optical anchor. `connectorType` present ⇒ it is a fibre receptacle. */
const anchor = (
  id: string,
  posMm: [number, number, number],
  axisX: [number, number, number],
  connectorType?: string,
) => ({
  id,
  name: id === "fiber_in" ? "OPTICAL IN (FC/PC)" : id,
  positionMmBodyLocal: { x: posMm[0], y: posMm[1], z: posMm[2] },
  axisXBodyLocal: { x: axisX[0], y: axisX[1], z: axisX[2] },
  apertureMm: 1.25,
  ...(connectorType ? { connectorType } : {}),
});

/** The connector the fibre's End B binds, and how that binding is keyed.
 *  Catalog fibres are inconsistent: `Fiber SM PC` uses `role: "end_b"`,
 *  `Fiber PM PC-APC` uses `properties.splineEnd: "B"`. The backend's
 *  `_connector_asset` accepts both, so the store must too — matching only
 *  `role` silently falls back to the 36.28 mm FC constant and mates the face
 *  ~23 mm from where the solver couples. */
const CONNECTOR_TIP_MM = 59.333;
const connectorAsset = () => ({
  id: "a-conn",
  catalogId: "pm_apc_780",
  anchors: [
    { id: "connect_out", positionMmBodyLocal: { x: 0, y: 0, z: 0 } },
    { id: "connect_in", positionMmBodyLocal: { x: 0, y: 0, z: CONNECTOR_TIP_MM } },
  ],
});

function seed(opts: {
  fiberNodes: Node[];
  detAt?: [number, number, number];
  /** How the fibre's End B connector binding is keyed, if present. */
  endBBindingKey?: "splineEnd" | "role";
}) {
  const state = useSceneStore.getState();
  const det = opts.detAt ?? [500, 0, 0];
  useSceneStore.setState({
    scene: {
      ...state.scene,
      objects: [
        obj(FIBER_ID, FIBER_COMP, { properties: { fiberNodes: opts.fiberNodes } }),
        obj(DET_ID, DET_COMP, { ...pose(det[0], det[1], det[2]) }),
        obj(MIRROR_ID, MIRROR_COMP, { ...pose(505, 0, 0) }),
      ] as never,
      components: [
        { id: FIBER_COMP, name: "Fiber SM PC", kindId: "fiber", properties: {} },
        { id: DET_COMP, name: "RF PMT RXM15EF", kindId: "detector", properties: {} },
        { id: MIRROR_COMP, name: "Mirror", kindId: "mirror", properties: {} },
      ] as never,
      // Binding-backed, like the real scene: the asset hangs off a binding
      // and `component.asset3dId` is null.
      componentBindings: [
        // `parentBindingId: null` is what makes these ROOT bindings —
        // `rootBindingsOf` filters on `=== null`, so leaving it undefined
        // yields an empty tree and no ports at all. The local pose is part of
        // the row (the columns are NOT NULL): ports are placed through it.
        { id: "b-det", componentId: DET_COMP, parentBindingId: null, sortOrder: 0, role: "root", targetKind: "asset", asset3dId: "a-det", ...IDENTITY_BINDING_POSE },
        { id: "b-mir", componentId: MIRROR_COMP, parentBindingId: null, sortOrder: 0, role: "root", targetKind: "asset", asset3dId: "a-mir", ...IDENTITY_BINDING_POSE },
        ...(opts.endBBindingKey
          ? [
              {
                id: "b-fib-b",
                componentId: FIBER_COMP,
                parentBindingId: null,
                sortOrder: 0,
                targetKind: "asset",
                asset3dId: "a-conn",
                role: opts.endBBindingKey === "role" ? "end_b" : "pm_780_apc",
                properties:
                  opts.endBBindingKey === "splineEnd" ? { splineEnd: "B" } : {},
                ...IDENTITY_BINDING_POSE,
              },
            ]
          : []),
      ] as never,
      objectBindings: [] as never,
      assets: [
        {
          id: "a-det",
          catalogId: "rxm15ef_step",
          // Light travels −X into the receiver; the bulkhead declares a
          // FEMALE FC/PC socket.
          anchors: [anchor("fiber_in", [0, 0, 0], [-1, 0, 0], "fc_pc_female")],
        },
        {
          id: "a-mir",
          catalogId: "mirror_step",
          // A free-space face: same anchor id, NO connectorType.
          anchors: [anchor("fiber_in", [0, 0, 0], [-1, 0, 0])],
        },
        connectorAsset(),
      ] as never,
      physicsElements: [] as never,
      collections: [],
      collectionMembers: [],
    },
    undoStack: [],
    redoStack: [],
  });
}

const straight = (x0: number, x1: number): Node[] => [
  { posMm: [x0, 0, 0], handleOutMm: [30, 0, 0] },
  { posMm: [x1, 0, 0], handleInMm: [-30, 0, 0] },
];

const linksOf = (id = FIBER_ID) =>
  (useSceneStore.getState().scene.objects.find((o) => o.id === id)?.properties as
    | { fiberEndpoints?: Record<string, unknown> }
    | undefined)?.fiberEndpoints;

const nodesOf = (id = FIBER_ID) =>
  (useSceneStore.getState().scene.objects.find((o) => o.id === id)?.properties as
    | { fiberNodes?: Node[] }
    | undefined)?.fiberNodes;

beforeEach(() => {
  updateObjectApiMock.mockReset();
  upsertOpticalElementMock.mockReset();
  updateObjectApiMock.mockImplementation(
    async (id: string, patch: Record<string, unknown>) => {
      const current = useSceneStore.getState().scene.objects.find((o) => o.id === id);
      return { ...(current ?? { id }), ...patch };
    },
  );
  useSceneStore.setState({ upsertOpticalElement: upsertOpticalElementMock as never });
  // No live trace in a unit test → no beam candidates, so anything the
  // picker returns here came from the port sweep.
  (globalThis as { __rayTraceDebug?: unknown }).__rayTraceDebug = [];
});

describe("finding fibre ports", () => {
  it("offers a receptacle found through the binding tree", async () => {
    seed({ fiberNodes: straight(0, 400) });
    const list = await useSceneStore
      .getState()
      .findFiberAlignmentCandidates(FIBER_ID, "B", 200);
    expect(list).toHaveLength(1);
    expect(list[0].port).toEqual({
      targetObjectId: DET_ID,
      targetAnchorId: "fiber_in",
      targetAnchorName: "OPTICAL IN (FC/PC)",
    });
    expect(list[0].displayLabel).toContain("DET-1");
  });

  it("does NOT offer a free-space face — only anchors that declare a connector", async () => {
    seed({ fiberNodes: straight(0, 400) });
    const list = await useSceneStore
      .getState()
      .findFiberAlignmentCandidates(FIBER_ID, "B", 200);
    // The mirror sits 5 mm BEYOND the detector, well inside tolerance, and
    // carries an identically-shaped fiber_in. Its only difference is the
    // missing connectorType — which must be enough to exclude it.
    expect(list.map((c) => c.port?.targetObjectId)).not.toContain(MIRROR_ID);
  });

  it("rejects a port outside tolerance", async () => {
    seed({ fiberNodes: straight(0, 100) });
    const list = await useSceneStore
      .getState()
      .findFiberAlignmentCandidates(FIBER_ID, "B", 25);
    expect(list).toEqual([]);
  });
});

describe("plugging in and unplugging", () => {
  it("persists the link when a port candidate is applied", async () => {
    seed({ fiberNodes: straight(0, 400) });
    const store = useSceneStore.getState();
    const [cand] = await store.findFiberAlignmentCandidates(FIBER_ID, "B", 200);
    await store.applyFiberAlignmentCandidate(FIBER_ID, "B", cand);
    expect(linksOf()).toEqual({
      B: {
        targetObjectId: DET_ID,
        targetAnchorId: "fiber_in",
        targetAnchorName: "OPTICAL IN (FC/PC)",
      },
    });
    // End A was never touched.
    expect(linksOf()!.A).toBeUndefined();
  });

  it("a BEAM candidate clears the link — a free-space placement is not a connection", async () => {
    seed({ fiberNodes: straight(0, 400) });
    const store = useSceneStore.getState();
    const [cand] = await store.findFiberAlignmentCandidates(FIBER_ID, "B", 200);
    await store.applyFiberAlignmentCandidate(FIBER_ID, "B", cand);
    expect(linksOf()!.B).toBeDefined();

    await useSceneStore.getState().applyFiberAlignmentCandidate(FIBER_ID, "B", {
      // Same payload shape, no `port` — i.e. what a beam segment produces.
      beamId: "trace:abc",
      distMm: 1,
      projectedPortLab: [0, 0, 0],
      newPosMmBody: [111, 0, 0],
      newHandleMmBody: [-30, 0, 0],
      newOutwardBody: [1, 0, 0],
    });
    expect(linksOf()!.B).toBeUndefined();
  });

  it("a hand-drag of the endpoint unplugs it", async () => {
    seed({ fiberNodes: straight(0, 400) });
    const store = useSceneStore.getState();
    const [cand] = await store.findFiberAlignmentCandidates(FIBER_ID, "B", 200);
    await store.applyFiberAlignmentCandidate(FIBER_ID, "B", cand);
    await useSceneStore.getState().updateFiberNodes(FIBER_ID, straight(0, 123), "B");
    expect(linksOf()!.B).toBeUndefined();
    expect(nodesOf()![1].posMm[0]).toBe(123);
  });

  it("clearFiberEndpointLink unplugs WITHOUT moving the cable", async () => {
    seed({ fiberNodes: straight(0, 400) });
    const store = useSceneStore.getState();
    const [cand] = await store.findFiberAlignmentCandidates(FIBER_ID, "B", 200);
    await store.applyFiberAlignmentCandidate(FIBER_ID, "B", cand);
    const parked = nodesOf()![1].posMm[0];
    await useSceneStore.getState().clearFiberEndpointLink(FIBER_ID, "B");
    expect(linksOf()!.B).toBeUndefined();
    // Contrast clearRfCableEndpointLink, which deletes the cable outright.
    expect(nodesOf()![1].posMm[0]).toBe(parked);
    expect(useSceneStore.getState().scene.objects.some((o) => o.id === FIBER_ID)).toBe(true);
  });
});

describe("the mated face uses the bound connector's own tip length", () => {
  // node = port − outward·(tip + gap), and outward here is −X (the port's
  // axisX is −X and End B faces along it), so node sits at
  // port + (tip + gap) on the X axis.
  const expectedNodeX = (tip: number) => 500 + tip + 0.01;

  it.each(["splineEnd", "role"] as const)(
    "resolves the connector binding keyed by %s",
    async (key) => {
      seed({ fiberNodes: straight(0, 400), endBBindingKey: key });
      const store = useSceneStore.getState();
      const [cand] = await store.findFiberAlignmentCandidates(FIBER_ID, "B", 200);
      await store.applyFiberAlignmentCandidate(FIBER_ID, "B", cand);
      expect(nodesOf()![1].posMm[0]).toBeCloseTo(expectedNodeX(CONNECTOR_TIP_MM), 6);
    },
  );

  it("falls back to the FC housing constant when no connector is bound", async () => {
    seed({ fiberNodes: straight(0, 400) });
    const store = useSceneStore.getState();
    const [cand] = await store.findFiberAlignmentCandidates(FIBER_ID, "B", 200);
    await store.applyFiberAlignmentCandidate(FIBER_ID, "B", cand);
    expect(nodesOf()![1].posMm[0]).toBeCloseTo(expectedNodeX(36.28), 6);
  });
});

describe("resnapFibersLinkedTo", () => {
  it("carries a plugged end along when its instrument moves", async () => {
    seed({ fiberNodes: straight(0, 400) });
    const store = useSceneStore.getState();
    const [cand] = await store.findFiberAlignmentCandidates(FIBER_ID, "B", 200);
    await store.applyFiberAlignmentCandidate(FIBER_ID, "B", cand);
    const before = nodesOf()![1].posMm[0];

    // Slide the receiver 50 mm down +X, as a committed pose change would.
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        objects: s.scene.objects.map((o) =>
          o.id === DET_ID ? { ...o, xMm: 550 } : o,
        ) as never,
      },
    }));
    await useSceneStore.getState().resnapFibersLinkedTo([DET_ID]);

    expect(nodesOf()![1].posMm[0]).toBeCloseTo(before + 50, 6);
    // Still plugged in afterwards — the resnap must not look like a manual move.
    expect(linksOf()!.B).toBeDefined();
  });

  it("ignores fibres whose target did not move", async () => {
    seed({ fiberNodes: straight(0, 400) });
    const store = useSceneStore.getState();
    const [cand] = await store.findFiberAlignmentCandidates(FIBER_ID, "B", 200);
    await store.applyFiberAlignmentCandidate(FIBER_ID, "B", cand);
    const before = nodesOf()![1].posMm[0];
    await useSceneStore.getState().resnapFibersLinkedTo([MIRROR_ID]);
    expect(nodesOf()![1].posMm[0]).toBe(before);
  });
});

describe("a beam placement uses the bound connector's tip too (2026-09-22)", () => {
  // The traced face of a connector-bound fibre is node + outward · tip, with
  // tip = the connector's own |mating face − cable root| (the backend's
  // _synth_fiber_slot). A beam placement must back the node out by that same
  // tip or the face lands `tip − 36.28` mm along the beam from the picked
  // point — it used to back out by the FC constant regardless.
  const beamAlongX = (y: number) => [{
    startThree: { x: 3, y: y / 100, z: 0 },
    endThree: { x: 6, y: y / 100, z: 0 },
    emitterObjectId: "src", sourceObjectId: "src",
  }];

  it.each([
    ["with a PM connector bound", "role" as const, CONNECTOR_TIP_MM],
    ["with no connector bound", undefined, 36.28],
  ])("puts the traced face on the picked point, %s", async (_label, key, tip) => {
    seed({ fiberNodes: straight(0, 400), endBBindingKey: key });
    (globalThis as { window?: unknown }).window = { __rayTraceDebug: beamAlongX(5) };
    try {
      const store = useSceneStore.getState();
      const cand = (await store.findFiberAlignmentCandidates(FIBER_ID, "B", 25)).find((c) => !c.port);
      expect(cand).toBeDefined();
      // Measured from the REAL current face (x = 400 + tip), 5 mm off the line.
      expect(cand!.distMm).toBeCloseTo(5, 9);
      expect(cand!.projectedPortLab[0]).toBeCloseTo(400 + tip, 9);
      await store.applyFiberAlignmentCandidate(FIBER_ID, "B", cand!);
      const n = nodesOf()![1];
      const outward = new THREE.Vector3(...n.handleInMm!).normalize().negate();
      const face = new THREE.Vector3(...n.posMm).addScaledVector(outward, tip);
      expect(face.distanceTo(new THREE.Vector3(...cand!.projectedPortLab))).toBeLessThan(1e-9);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});

describe("a tilted receiver bound through a rotated binding (2026-09-22)", () => {
  // The port must land where the TRACER hit-tests it: the port anchor lifted
  // by its binding (raw XYZ Euler, as the backend's _binding_tree_transform)
  // and then by the SceneObject pose (optical/pose, the backend's
  // pose._rotation_of). The retired local rotation copy the store used to
  // place ports with missed this receiver by centimetres.
  const DET_POSE = { xMm: 400, yMm: 50, zMm: 900, rxDeg: 135, ryDeg: 10, rzDeg: 30 };
  const BIND = { x: 3, y: -2, z: 5, rx: 20, ry: -35, rz: 60 };

  const portLab = (detPose: typeof DET_POSE) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(BIND.rx), THREE.MathUtils.degToRad(BIND.ry),
      THREE.MathUtils.degToRad(BIND.rz), "XYZ",
    ));
    const pComp = new THREE.Vector3(BIND.x, BIND.y, BIND.z); // anchor at the asset origin
    const aComp = new THREE.Vector3(-1, 0, 0).applyQuaternion(q);
    const p = pointBodyToLab({ x: pComp.x, y: pComp.y, z: pComp.z }, detPose);
    const a = dirBodyToLab({ x: aComp.x, y: aComp.y, z: aComp.z }, detPose);
    return { p: new THREE.Vector3(p.x, p.y, p.z), a: new THREE.Vector3(a.x, a.y, a.z).normalize() };
  };

  const tilt = (detPose: typeof DET_POSE) =>
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        objects: s.scene.objects.map((o) => (o.id === DET_ID ? { ...o, ...detPose } : o)) as never,
        componentBindings: (s.scene.componentBindings ?? []).map((b) =>
          b.id === "b-det"
            ? { ...b, localXMm: BIND.x, localYMm: BIND.y, localZMm: BIND.z, localRxDeg: BIND.rx, localRyDeg: BIND.ry, localRzDeg: BIND.rz }
            : b,
        ) as never,
      },
    }));

  /** End B's optical face in lab (the fibre sits at the identity pose, and
   *  no connector is bound, so the FC constant is its tip). */
  const faceBLab = () => {
    const nodes = nodesOf()!;
    const n = nodes[nodes.length - 1];
    const outward = new THREE.Vector3(...n.handleInMm!).normalize().negate();
    return new THREE.Vector3(...n.posMm).addScaledVector(outward, 36.28);
  };

  it("mates End B one gap short of where the tracer has the port", async () => {
    seed({ fiberNodes: straight(0, 400) });
    tilt(DET_POSE);
    const { p, a } = portLab(DET_POSE);
    const store = useSceneStore.getState();
    const cand = (await store.findFiberAlignmentCandidates(FIBER_ID, "B", 5000)).find((c) => c.port);
    expect(cand?.port?.targetObjectId).toBe(DET_ID);
    await store.applyFiberAlignmentCandidate(FIBER_ID, "B", cand!);
    expect(faceBLab().distanceTo(p.clone().addScaledVector(a, -FIBER_MATING_GAP_MM))).toBeLessThan(1e-9);
  });

  it("follows it through a re-snap", async () => {
    seed({ fiberNodes: straight(0, 400) });
    tilt(DET_POSE);
    const store = useSceneStore.getState();
    const cand = (await store.findFiberAlignmentCandidates(FIBER_ID, "B", 5000)).find((c) => c.port);
    await store.applyFiberAlignmentCandidate(FIBER_ID, "B", cand!);
    const moved = { ...DET_POSE, xMm: 425.5, rzDeg: 70 };
    tilt(moved);
    await useSceneStore.getState().resnapFibersLinkedTo([DET_ID]);
    const { p, a } = portLab(moved);
    expect(faceBLab().distanceTo(p.clone().addScaledVector(a, -FIBER_MATING_GAP_MM))).toBeLessThan(1e-9);
  });
});
