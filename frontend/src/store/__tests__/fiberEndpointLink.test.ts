/**
 * The store half of the fibre and pigtail endpoint flows, after wave 3b moved
 * the geometry behind `POST /api/v3/fibers/*` and `/api/v3/pigtails/*`
 * (2026-09-23) and deleted `utils/fiberAlignment.ts` + `utils/pigtailAlignment.ts`.
 *
 * What is pinned HERE is the wiring — every one of these is a way the feature
 * can look like it works while doing nothing:
 *   - the picker sends THIS client's live beam segments (the server cannot
 *     know which beams exist) and hands back what came off the wire;
 *   - a beam candidate carries its segment, because applying one has to name
 *     the segment back — the endpoint recomputes from the target;
 *   - a port candidate goes to `/connect`, a beam candidate to `/apply`;
 *   - the response's SceneObject AND fibre PhysicsElement are both committed
 *     (the PE is what the solver reads — `_synth_fiber_slot`);
 *   - the undo entry the old `upsertOpticalElement` path recorded still
 *     appears, with the same description and the same inverse;
 *   - a re-snap of a part nothing is plugged into costs no round trip;
 *   - a hand-drag still unplugs locally (that path never went to the server).
 *
 * What is NOT here any more: the mating geometry itself (End B facing along
 * the port's axisX, the 10 µm gap, the dedup, the connector tip). There is
 * one implementation of it now and it is Python —
 * `backend/tests/optical/test_fiber_endpoints.py` and the golden fixtures in
 * `backend/tests/fixtures/fibers/`. The one exception is the per-end port-pose
 * editor, which has no endpoint and keeps its maths in TypeScript; its
 * connector-tip fix is pinned at the bottom of this file.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getFiberPortLabPose } from "../../utils/fiberAnchorResolver";

const updateObjectApiMock = vi.fn();
const upsertOpticalElementMock = vi.fn();
const fiberCandidatesMock = vi.fn();
const fiberConnectMock = vi.fn();
const fiberApplyBeamMock = vi.fn();
const fiberDisconnectMock = vi.fn();
const fiberResnapMock = vi.fn();
const pigtailCandidatesMock = vi.fn();
const pigtailApplyMock = vi.fn();
const pigtailDisconnectMock = vi.fn();
const pigtailResnapMock = vi.fn();

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateObjectApi: (id: string, patch: Record<string, unknown>) =>
    updateObjectApiMock(id, patch),
  fiberCandidatesApi: (...a: unknown[]) => fiberCandidatesMock(...a),
  fiberConnectApi: (...a: unknown[]) => fiberConnectMock(...a),
  fiberApplyBeamApi: (...a: unknown[]) => fiberApplyBeamMock(...a),
  fiberDisconnectApi: (...a: unknown[]) => fiberDisconnectMock(...a),
  fiberResnapApi: (...a: unknown[]) => fiberResnapMock(...a),
  pigtailCandidatesApi: (...a: unknown[]) => pigtailCandidatesMock(...a),
  pigtailApplyApi: (...a: unknown[]) => pigtailApplyMock(...a),
  pigtailDisconnectApi: (...a: unknown[]) => pigtailDisconnectMock(...a),
  pigtailResnapApi: (...a: unknown[]) => pigtailResnapMock(...a),
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
const EOM_ID = "eom-1";
const EOM_COMP = "comp-eom";

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

/** The link record a `/connect` response carries back. */
const PORT_LINK = {
  targetObjectId: DET_ID,
  targetAnchorId: "fiber_in",
  targetAnchorName: "OPTICAL IN (FC/PC)",
};

/** The connector the fibre's End B binds, and how that binding is keyed.
 *  Catalog fibres are inconsistent: `Fiber SM PC` uses `role: "end_b"`,
 *  `Fiber PM PC-APC` uses `properties.splineEnd: "B"`. `_connector_asset`
 *  accepts both, so `fiberEndConnectorTipMm` must too — matching only `role`
 *  silently falls back to the 36.28 mm FC constant, i.e. ~23 mm from where
 *  the solver couples. */
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
  /** How the fibre's End B connector binding is keyed, if present. */
  endBBindingKey?: "splineEnd" | "role";
  /** Pre-existing links on the fibre / the pigtailed instrument. */
  fiberEndpoints?: Record<string, unknown>;
  pigtailEndpoints?: Record<string, unknown>;
  /** Give the fibre a PhysicsElement so the PE half is exercised. */
  fiberKindParams?: Record<string, unknown>;
} = { fiberNodes: [] }) {
  const state = useSceneStore.getState();
  useSceneStore.setState({
    scene: {
      ...state.scene,
      objects: [
        obj(FIBER_ID, FIBER_COMP, {
          properties: {
            fiberNodes: opts.fiberNodes,
            ...(opts.fiberEndpoints ? { fiberEndpoints: opts.fiberEndpoints } : {}),
          },
        }),
        obj(DET_ID, DET_COMP, { ...pose(500, 0, 0) }),
        obj(EOM_ID, EOM_COMP, {
          properties: opts.pigtailEndpoints
            ? { pigtailEndpoints: opts.pigtailEndpoints }
            : {},
        }),
      ] as never,
      components: [
        { id: FIBER_COMP, name: "Fiber SM PC", kindId: "fiber", properties: {} },
        { id: DET_COMP, name: "RF PMT RXM15EF", kindId: "detector", properties: {} },
        { id: EOM_COMP, name: "EOSpace EOM", kindId: "eom", properties: {} },
      ] as never,
      componentBindings: [
        { id: "b-det", componentId: DET_COMP, parentBindingId: null, sortOrder: 0, role: "root", targetKind: "asset", asset3dId: "a-det", ...IDENTITY_BINDING_POSE },
        ...(opts.endBBindingKey
          ? [{
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
            }]
          : []),
      ] as never,
      objectBindings: [] as never,
      assets: [
        {
          id: "a-det",
          catalogId: "rxm15ef_step",
          anchors: [{
            id: "fiber_in",
            name: "OPTICAL IN (FC/PC)",
            positionMmBodyLocal: { x: 0, y: 0, z: 0 },
            axisXBodyLocal: { x: -1, y: 0, z: 0 },
            apertureMm: 1.25,
            connectorType: "fc_pc_female",
          }],
        },
        connectorAsset(),
      ] as never,
      physicsElements: (opts.fiberKindParams
        ? [{
            id: "pe-fiber",
            objectId: FIBER_ID,
            elementKind: "fiber",
            kindParams: opts.fiberKindParams,
          }]
        : []) as never,
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

const objectOf = (id: string) =>
  useSceneStore.getState().scene.objects.find((o) => o.id === id);

const linksOf = (id = FIBER_ID) =>
  (objectOf(id)?.properties as { fiberEndpoints?: Record<string, unknown> } | undefined)
    ?.fiberEndpoints;

const nodesOf = (id = FIBER_ID) =>
  (objectOf(id)?.properties as { fiberNodes?: Node[] } | undefined)?.fiberNodes;

/** The object row `/connect` would answer with. */
const connectedObject = (nodes: Node[]) => ({
  ...obj(FIBER_ID, FIBER_COMP, {
    properties: { fiberNodes: nodes, fiberEndpoints: { B: PORT_LINK } },
  }),
});

const PORT_CANDIDATE = {
  beamId: `port:${DET_ID}:fiber_in`,
  distMm: 4,
  projectedPortLab: [500, 0, 0] as [number, number, number],
  newPosMmBody: [536.29, 0, 0] as [number, number, number],
  newHandleMmBody: [-30, 0, 0] as [number, number, number],
  newOutwardBody: [1, 0, 0] as [number, number, number],
  displayLabel: "🔌 DET-1 · OPTICAL IN (FC/PC)",
  port: PORT_LINK,
};

const beamCandidate = (over: Record<string, unknown> = {}) => ({
  beamId: "trace:emit0001:o0:src00001",
  distMm: 2,
  projectedPortLab: [400, 0, 0] as [number, number, number],
  newPosMmBody: [436.28, 0, 0] as [number, number, number],
  newHandleMmBody: [-30, 0, 0] as [number, number, number],
  newOutwardBody: [1, 0, 0] as [number, number, number],
  emitterObjectId: "emit0001",
  aomOrder: 0,
  branch: "main",
  ...over,
});

/** One `__rayTraceDebug` segment. Three.js world units are 100 mm. */
const traceSeg = (
  aX: number, bX: number, over: Record<string, unknown> = {},
) => ({
  startThree: { x: aX / 100, y: 0, z: 0 },
  endThree: { x: bX / 100, y: 0, z: 0 },
  emitterObjectId: "emit0001",
  sourceObjectId: "src00001",
  branch: "main",
  aomSideband: { order: 0 },
  wavelengthNm: 852,
  ...over,
});

beforeEach(() => {
  for (const m of [
    updateObjectApiMock, upsertOpticalElementMock, fiberCandidatesMock,
    fiberConnectMock, fiberApplyBeamMock, fiberDisconnectMock, fiberResnapMock,
    pigtailCandidatesMock, pigtailApplyMock, pigtailDisconnectMock, pigtailResnapMock,
  ]) m.mockReset();
  updateObjectApiMock.mockImplementation(
    async (id: string, patch: Record<string, unknown>) => ({
      ...(objectOf(id) ?? { id }), ...patch,
    }),
  );
  useSceneStore.setState({ upsertOpticalElement: upsertOpticalElementMock as never });
  // `collectBeamSegmentsLab` reads `window.__rayTraceDebug` — the viewer's
  // live trace. The default vitest environment here is node, so stub the one
  // global it touches rather than paying for a whole DOM.
  vi.stubGlobal("window", { __rayTraceDebug: [] });
});

describe("findFiberAlignmentCandidates", () => {
  it("sends this client's beam segments and returns what came off the wire", async () => {
    seed({ fiberNodes: straight(0, 400) });
    vi.stubGlobal("window", { __rayTraceDebug: [traceSeg(300, 600)] });
    fiberCandidatesMock.mockResolvedValue({ candidates: [PORT_CANDIDATE] });

    const list = await useSceneStore.getState()
      .findFiberAlignmentCandidates(FIBER_ID, "B", 25);

    expect(fiberCandidatesMock).toHaveBeenCalledTimes(1);
    const [id, payload] = fiberCandidatesMock.mock.calls[0];
    expect(id).toBe(FIBER_ID);
    expect(payload.end).toBe("B");
    expect(payload.toleranceMm).toBe(25);
    expect(payload.beamSegments).toEqual([
      expect.objectContaining({ aMm: [300, 0, 0], bMm: [600, 0, 0], aomOrder: 0 }),
    ]);
    expect(list).toEqual([PORT_CANDIDATE]);
  });

  it("drops segments the fibre itself emitted, as the picker always has", async () => {
    seed({ fiberNodes: straight(0, 400) });
    vi.stubGlobal("window", { __rayTraceDebug: [
      traceSeg(300, 600, { sourceObjectId: FIBER_ID }),
    ] });
    fiberCandidatesMock.mockResolvedValue({ candidates: [] });
    await useSceneStore.getState().findFiberAlignmentCandidates(FIBER_ID, "B", 25);
    expect(fiberCandidatesMock.mock.calls[0][1].beamSegments).toEqual([]);
  });

  it("attaches the originating segment to a BEAM candidate, not to a port one", async () => {
    seed({ fiberNodes: straight(0, 400) });
    vi.stubGlobal("window", { __rayTraceDebug: [traceSeg(300, 600)] });
    fiberCandidatesMock.mockResolvedValue({
      candidates: [beamCandidate(), PORT_CANDIDATE],
    });

    const [beam, port] = await useSceneStore.getState()
      .findFiberAlignmentCandidates(FIBER_ID, "B", 25);
    expect(beam.beam).toEqual(
      expect.objectContaining({ aMm: [300, 0, 0], bMm: [600, 0, 0] }),
    );
    expect(port.beam).toBeUndefined();
  });

  it("picks the right segment when a splitter emits two legs under one beamId", async () => {
    seed({ fiberNodes: straight(0, 400) });
    vi.stubGlobal("window", { __rayTraceDebug: [
      traceSeg(300, 600, { branch: "transmitted" }),
      traceSeg(300, 600, { branch: "reflected", startThree: { x: 3, y: 1, z: 0 }, endThree: { x: 6, y: 1, z: 0 } }),
    ] });
    fiberCandidatesMock.mockResolvedValue({
      candidates: [beamCandidate({ branch: "reflected", projectedPortLab: [400, 100, 0] })],
    });
    const [cand] = await useSceneStore.getState()
      .findFiberAlignmentCandidates(FIBER_ID, "B", 25);
    expect(cand.beam?.aMm).toEqual([300, 100, 0]);
  });

  it("answers an empty picker — not a throw — when the endpoint refuses", async () => {
    seed({ fiberNodes: [] });
    fiberCandidatesMock.mockRejectedValue(new Error("422 no fibre spline"));
    await expect(
      useSceneStore.getState().findFiberAlignmentCandidates(FIBER_ID, "B", 25),
    ).resolves.toEqual([]);
  });
});

describe("applyFiberAlignmentCandidate", () => {
  it("plugs a port candidate in through /connect and commits object + PE", async () => {
    seed({
      fiberNodes: straight(0, 400),
      fiberKindParams: { endB: { posMm: [400, 0, 0], tensionHandleMm: [-30, 0, 0] } },
    });
    const newPe = {
      id: "pe-fiber", objectId: FIBER_ID, elementKind: "fiber",
      kindParams: { endB: { posMm: [536.29, 0, 0], tensionHandleMm: [-30, 0, 0] } },
    };
    fiberConnectMock.mockResolvedValue({
      object: connectedObject(straight(0, 536.29)),
      physicsElement: newPe,
      candidate: PORT_CANDIDATE,
    });

    await useSceneStore.getState()
      .applyFiberAlignmentCandidate(FIBER_ID, "B", PORT_CANDIDATE);

    expect(fiberApplyBeamMock).not.toHaveBeenCalled();
    expect(fiberConnectMock).toHaveBeenCalledWith(FIBER_ID, {
      end: "B",
      target: {
        objectId: DET_ID,
        anchorName: "OPTICAL IN (FC/PC)",
        anchorId: "fiber_in",
      },
    });
    expect(linksOf()).toEqual({ B: PORT_LINK });
    expect(nodesOf()![1].posMm[0]).toBe(536.29);
    // The PE is the write the SOLVER reads; committing it is what keeps the
    // viewer and the next trace in step with the link.
    expect(
      useSceneStore.getState().scene.physicsElements.find((e) => e.objectId === FIBER_ID),
    ).toEqual(newPe);
  });

  it("records the same 'Edit physics' undo entry the old PE write did", async () => {
    const oldKindParams = { endB: { posMm: [400, 0, 0], tensionHandleMm: [-30, 0, 0] } };
    seed({ fiberNodes: straight(0, 400), fiberKindParams: oldKindParams });
    fiberConnectMock.mockResolvedValue({
      object: connectedObject(straight(0, 536.29)),
      physicsElement: {
        id: "pe-fiber", objectId: FIBER_ID, elementKind: "fiber",
        kindParams: { endB: { posMm: [536.29, 0, 0], tensionHandleMm: [-30, 0, 0] } },
      },
      candidate: PORT_CANDIDATE,
    });

    await useSceneStore.getState()
      .applyFiberAlignmentCandidate(FIBER_ID, "B", PORT_CANDIDATE);

    const stack = useSceneStore.getState().undoStack;
    expect(stack).toHaveLength(1);
    expect(stack[0].description).toBe("Edit physics: FIBER-1");
  });

  it("records nothing when the fibre had no PhysicsElement — as before", async () => {
    seed({ fiberNodes: straight(0, 400) });
    fiberConnectMock.mockResolvedValue({
      object: connectedObject(straight(0, 536.29)),
      physicsElement: null,
      candidate: PORT_CANDIDATE,
    });
    await useSceneStore.getState()
      .applyFiberAlignmentCandidate(FIBER_ID, "B", PORT_CANDIDATE);
    expect(useSceneStore.getState().undoStack).toEqual([]);
  });

  it("sends a BEAM candidate to /apply with the segment it came from", async () => {
    seed({ fiberNodes: straight(0, 400) });
    const cand = { ...beamCandidate(), beam: { beamId: "trace:emit0001:o0:src00001", aMm: [300, 0, 0], bMm: [600, 0, 0] } };
    fiberApplyBeamMock.mockResolvedValue({
      object: obj(FIBER_ID, FIBER_COMP, { properties: { fiberNodes: straight(0, 436.28) } }),
      physicsElement: null,
      candidate: cand,
    });

    await useSceneStore.getState()
      .applyFiberAlignmentCandidate(FIBER_ID, "B", cand as never);

    expect(fiberConnectMock).not.toHaveBeenCalled();
    expect(fiberApplyBeamMock).toHaveBeenCalledWith(FIBER_ID, {
      end: "B", beam: cand.beam,
    });
    // A beam placement is a free-space placement, not a connection: the
    // endpoint drops the link and the store commits that.
    expect(linksOf()).toBeUndefined();
  });

  it("writes nothing for a beam candidate whose segment went missing", async () => {
    seed({ fiberNodes: straight(0, 400) });
    await useSceneStore.getState()
      .applyFiberAlignmentCandidate(FIBER_ID, "B", beamCandidate() as never);
    expect(fiberApplyBeamMock).not.toHaveBeenCalled();
    expect(fiberConnectMock).not.toHaveBeenCalled();
  });
});

describe("clearFiberEndpointLink", () => {
  it("unplugs through /disconnect and leaves the cable where it is", async () => {
    seed({ fiberNodes: straight(0, 536.29), fiberEndpoints: { B: PORT_LINK } });
    fiberDisconnectMock.mockResolvedValue({
      object: obj(FIBER_ID, FIBER_COMP, {
        properties: { fiberNodes: straight(0, 536.29), fiberEndpoints: {} },
      }),
      changed: true,
    });

    await useSceneStore.getState().clearFiberEndpointLink(FIBER_ID, "B");

    expect(fiberDisconnectMock).toHaveBeenCalledWith(FIBER_ID, "B");
    expect(linksOf()!.B).toBeUndefined();
    // Contrast clearRfCableEndpointLink, which deletes the cable outright —
    // a dangling patch cable is a real bench state.
    expect(nodesOf()![1].posMm[0]).toBe(536.29);
    expect(objectOf(FIBER_ID)).toBeDefined();
  });

  it("commits nothing when that end had no link (changed: false)", async () => {
    seed({ fiberNodes: straight(0, 400) });
    fiberDisconnectMock.mockResolvedValue({
      object: obj("someone-else", FIBER_COMP), changed: false,
    });
    await useSceneStore.getState().clearFiberEndpointLink(FIBER_ID, "B");
    expect(objectOf("someone-else")).toBeUndefined();
  });
});

describe("resnapFibersLinkedTo", () => {
  it("costs no round trip when nothing is plugged into the moved part", async () => {
    seed({ fiberNodes: straight(0, 400) });
    await useSceneStore.getState().resnapFibersLinkedTo([DET_ID]);
    expect(fiberResnapMock).not.toHaveBeenCalled();
  });

  it("re-snaps and commits both rows when a plugged end's part moved", async () => {
    seed({ fiberNodes: straight(0, 536.29), fiberEndpoints: { B: PORT_LINK } });
    const moved = obj(FIBER_ID, FIBER_COMP, {
      properties: { fiberNodes: straight(0, 586.29), fiberEndpoints: { B: PORT_LINK } },
    });
    fiberResnapMock.mockResolvedValue({
      resnapped: [{ objectId: FIBER_ID, end: "B", ...PORT_LINK }],
      updated: [moved],
      physicsElements: [],
    });

    await useSceneStore.getState().resnapFibersLinkedTo([DET_ID]);

    expect(fiberResnapMock).toHaveBeenCalledWith([DET_ID]);
    expect(nodesOf()![1].posMm[0]).toBe(586.29);
    // Still plugged in — a re-snap must not read as a manual move.
    expect(linksOf()!.B).toEqual(PORT_LINK);
  });

  it("does not ask about a part the link does not name", async () => {
    seed({ fiberNodes: straight(0, 536.29), fiberEndpoints: { B: PORT_LINK } });
    await useSceneStore.getState().resnapFibersLinkedTo(["someone-else"]);
    expect(fiberResnapMock).not.toHaveBeenCalled();
  });
});

describe("a hand-drag still unplugs locally", () => {
  it("clearEndpointLink on updateFiberNodes drops the link in the same PUT", async () => {
    seed({ fiberNodes: straight(0, 536.29), fiberEndpoints: { B: PORT_LINK } });
    await useSceneStore.getState().updateFiberNodes(FIBER_ID, straight(0, 123), "B");
    expect(linksOf()!.B).toBeUndefined();
    expect(nodesOf()![1].posMm[0]).toBe(123);
    // Manual override beats link, and it never needed the server to say so.
    expect(fiberDisconnectMock).not.toHaveBeenCalled();
  });
});

describe("pigtail ends", () => {
  it("apply moves the connector through /apply and commits the ObjectBinding", async () => {
    seed({ fiberNodes: [] });
    const cand = { key: `port:${DET_ID}:fiber_in`, distMm: 3,
      targetPosLab: [500, 0, 0] as [number, number, number],
      targetAxisXLab: [-1, 0, 0] as [number, number, number],
      port: PORT_LINK };
    const binding = { id: "ob-1", objectId: EOM_ID, componentBindingId: "b-port-out" };
    pigtailApplyMock.mockResolvedValue({
      object: obj(EOM_ID, EOM_COMP, {
        properties: { pigtailEndpoints: { intercept_out: PORT_LINK } },
      }),
      objectBinding: binding,
      candidate: cand,
    });

    await useSceneStore.getState().applyPigtailAlignmentCandidate(EOM_ID, "B", cand);

    expect(pigtailApplyMock).toHaveBeenCalledWith(EOM_ID, {
      end: "B",
      target: {
        port: {
          objectId: DET_ID,
          anchorName: "OPTICAL IN (FC/PC)",
          anchorId: "fiber_in",
        },
      },
    });
    expect(
      (objectOf(EOM_ID)?.properties as { pigtailEndpoints?: Record<string, unknown> })
        ?.pigtailEndpoints,
    ).toEqual({ intercept_out: PORT_LINK });
    expect(useSceneStore.getState().scene.objectBindings).toContainEqual(binding);
  });

  it("candidates answers an empty picker when the part has no connector there", async () => {
    seed({ fiberNodes: [] });
    pigtailCandidatesMock.mockRejectedValue(new Error("422 no pigtail connector"));
    await expect(
      useSceneStore.getState().findPigtailAlignmentCandidates(EOM_ID, "A", 25),
    ).resolves.toEqual([]);
  });

  it("disconnect commits only when the endpoint says something changed", async () => {
    seed({ fiberNodes: [], pigtailEndpoints: { intercept_out: PORT_LINK } });
    pigtailDisconnectMock.mockResolvedValue({
      object: obj(EOM_ID, EOM_COMP, { properties: { pigtailEndpoints: {} } }),
      changed: true,
    });
    await useSceneStore.getState().clearPigtailEndpointLink(EOM_ID, "B");
    expect(pigtailDisconnectMock).toHaveBeenCalledWith(EOM_ID, "B");
    expect(
      (objectOf(EOM_ID)?.properties as { pigtailEndpoints?: Record<string, unknown> })
        ?.pigtailEndpoints,
    ).toEqual({});
  });

  it("resnap costs no round trip when no pigtail names the moved part", async () => {
    seed({ fiberNodes: [] });
    await useSceneStore.getState().resnapPigtailsLinkedTo([DET_ID]);
    expect(pigtailResnapMock).not.toHaveBeenCalled();
  });

  it("resnap asks and commits when one does", async () => {
    seed({ fiberNodes: [], pigtailEndpoints: { intercept_out: PORT_LINK } });
    const binding = { id: "ob-1", objectId: EOM_ID, componentBindingId: "b-port-out" };
    pigtailResnapMock.mockResolvedValue({
      resnapped: [{ objectId: EOM_ID, end: "B", portAnchor: "intercept_out", ...PORT_LINK }],
      updated: [obj(EOM_ID, EOM_COMP, {
        properties: { pigtailEndpoints: { intercept_out: PORT_LINK } },
      })],
      objectBindings: [binding],
    });
    await useSceneStore.getState().resnapPigtailsLinkedTo([DET_ID]);
    expect(pigtailResnapMock).toHaveBeenCalledWith([DET_ID]);
    expect(useSceneStore.getState().scene.objectBindings).toContainEqual(binding);
  });
});

describe("the per-end port-pose editor uses the bound connector's tip (2026-09-23)", () => {
  // The one fibre endpoint flow with no backend endpoint behind it: the user
  // types a lab pose, which is neither a projection onto a beam nor a mate
  // into a receptacle. It therefore keeps its maths in TypeScript — and until
  // this fix it kept the 36.28 mm FC constant as well, so for a
  // connector-bound cable the face it showed and wrote was NOT the face the
  // solver couples through (`known-issues.md`).
  //
  // node = labToBody(targetPos) − outward_body · tip, so with an identity pose
  // and outward = +X the node lands at targetPos.x − tip.
  const placeAt500 = async () => {
    await useSceneStore.getState()
      .setFiberPortLabPose(FIBER_ID, "B", [500, 0, 0], [1, 0, 0]);
  };

  it.each(["splineEnd", "role"] as const)(
    "resolves the connector binding keyed by %s",
    async (key) => {
      seed({ fiberNodes: straight(0, 400), endBBindingKey: key });
      await placeAt500();
      expect(nodesOf()![1].posMm[0]).toBeCloseTo(500 - CONNECTOR_TIP_MM, 9);
    },
  );

  it("falls back to the FC housing constant when no connector is bound", async () => {
    seed({ fiberNodes: straight(0, 400) });
    await placeAt500();
    expect(nodesOf()![1].posMm[0]).toBeCloseTo(500 - 36.28, 9);
  });

  it("the panel's READ half agrees with what the write half stored", async () => {
    seed({ fiberNodes: straight(0, 400), endBBindingKey: "splineEnd" });
    await placeAt500();
    const readBack = getFiberPortLabPose(
      "B", nodesOf()! as never, pose(), CONNECTOR_TIP_MM,
    );
    expect(readBack!.posLab[0]).toBeCloseTo(500, 9);
    expect(readBack!.outwardLab[0]).toBeCloseTo(1, 9);
  });

  it("still writes the endpoint through to the PE, keeping its undo entry", async () => {
    seed({
      fiberNodes: straight(0, 400), endBBindingKey: "splineEnd",
      fiberKindParams: { endB: { posMm: [400, 0, 0], tensionHandleMm: [-30, 0, 0] } },
    });
    await placeAt500();
    // `upsertOpticalElement` is the history-recording path and has always
    // been how this editor reached the solver's copy of the endpoint.
    expect(upsertOpticalElementMock).toHaveBeenCalledTimes(1);
    const payload = upsertOpticalElementMock.mock.calls[0][0];
    expect(payload.elementKind).toBe("fiber");
    expect(payload.kindParams.endB.posMm[0]).toBeCloseTo(500 - CONNECTOR_TIP_MM, 9);
  });
});
