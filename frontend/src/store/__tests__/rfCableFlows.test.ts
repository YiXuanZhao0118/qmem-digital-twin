/**
 * The RF cable / PPG store flows land where the physics says they should.
 *
 * `utils/__tests__/rfCableParity.test.ts` pins the backend port to these
 * flows; this file pins the flows themselves to an independent reference —
 * the port poses `utils/anchorPose.resolveAnchorPosesLab` computes (the
 * transform chain the tracer and the renderer use) — for the cases that
 * were wrong until 2026-09-22 (docs/introduce/rf.md §7):
 *
 *   R1. The port lookup of `findRfCableAlignmentCandidates` and of
 *       `createRfCableBetweenPorts` uses the REAL SceneObject rotation. It
 *       was an inline mirror-image `Rz·Rx·Ry`, so a port on an instrument
 *       rotated about x or y (the live DDS / switches at rx −90) was placed
 *       where it is not.
 *   R2. The align picker measures from, and mates to, the cable end's BOUND
 *       connector length (`connectorTipMmFromAnchors`, as connect and resnap
 *       do). It used the procedural 15.5 mm, so an aligned SMA end (25.45 mm)
 *       overshot its port by 9.95 mm.
 *   R4. A new PPG is named `CH<number of PPGs>` stepped past any name taken
 *       (case-insensitively, as the backend's unique name check). The bare
 *       count collided once a PPG other than the last was deleted, and the
 *       create failed with a 409.
 *   R5. Connect, resnap and align pose a port through its BINDING CHAIN
 *       (`rfCableAnchorResolver.rfPortPoses`): nested / rotated / offset
 *       bindings and ObjectBinding deltas. They read the anchor in its own
 *       asset's frame, exact only on an identity root binding.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAnchorPosesLab } from "../../utils/anchorPose";
import type { SceneData } from "../../types/digitalTwin";

const updateObjectApiMock = vi.fn();
const createObjectApiMock = vi.fn();
const createTimingProgramApiMock = vi.fn();

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateObjectApi: (id: string, patch: Record<string, unknown>) => updateObjectApiMock(id, patch),
  createObjectApi: (payload: Record<string, unknown>) => createObjectApiMock(payload),
  createTimingProgramApi: (payload: Record<string, unknown>) => createTimingProgramApiMock(payload),
  updateOpticalElementApi: async (objectId: string, patch: Record<string, unknown>) => ({
    id: `pe-${objectId}`, objectId, ...patch,
  }),
}));

const { useSceneStore } = await import("../sceneStore");

type V = { x: number; y: number; z: number };
type Node = { posMm: [number, number, number]; handleInMm?: [number, number, number]; handleOutMm?: [number, number, number] };

const anchor = (id: string, pos: [number, number, number], axis: [number, number, number], extra: Record<string, unknown> = {}) => ({
  id,
  positionMmBodyLocal: { x: pos[0], y: pos[1], z: pos[2] },
  axisXBodyLocal: { x: axis[0], y: axis[1], z: axis[2] },
  ...extra,
});

const obj = (id: string, componentId: string, pose: Partial<Record<"xMm" | "yMm" | "zMm" | "rxDeg" | "ryDeg" | "rzDeg", number>>, properties: Record<string, unknown> = {}) => ({
  id, name: id.toUpperCase(), componentId,
  xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 0, rzDeg: 0,
  ...pose, visible: true, locked: false, properties,
});

/** A DDS rotated like the live one (rx −90, rz 180) and an amplifier
 *  rotated about y, both binding-backed; an SMA cable Component with no
 *  connector bindings (so every tip is the 15.5 mm procedural fallback). */
function seed(cable?: { nodes: Node[]; pose?: V; smaConnectors?: boolean }): SceneData {
  const scene = {
    ...useSceneStore.getState().scene,
    objects: [
      obj("dds", "c-dds", { xMm: -910.099, yMm: 754.744, zMm: 704.245, rxDeg: -90, rzDeg: 180 }),
      obj("amp", "c-amp", { xMm: -1500, yMm: 500, zMm: 700, ryDeg: 30, rzDeg: 15 }),
      ...(cable
        ? [obj("cable", "c-cable", { xMm: cable.pose?.x ?? 0, yMm: cable.pose?.y ?? 0, zMm: cable.pose?.z ?? 0 }, { rfCableNodes: cable.nodes })]
        : []),
    ],
    components: [
      { id: "c-dds", name: "DDS", kindId: "rf_source", asset3dId: null, properties: {} },
      { id: "c-amp", name: "AMP", kindId: "rf_amplifier", asset3dId: null, properties: {} },
      { id: "c-cable", name: "RF cable", kindId: "rf_cable", asset3dId: null, properties: {} },
    ],
    componentBindings: [
      ...(cable?.smaConnectors
        ? [
          { id: "b-end-a", componentId: "c-cable", parentBindingId: null, sortOrder: 0, role: "end_a", targetKind: "asset", asset3dId: "a-sma", properties: { splineEnd: "A" } },
          { id: "b-end-b", componentId: "c-cable", parentBindingId: null, sortOrder: 1, role: "end_b", targetKind: "asset", asset3dId: "a-sma", properties: { splineEnd: "B" } },
        ]
        : []),
      { id: "b-dds", componentId: "c-dds", parentBindingId: null, sortOrder: 0, role: "root", targetKind: "asset", asset3dId: "a-dds", localXMm: 0, localYMm: 0, localZMm: 0, localRxDeg: 0, localRyDeg: 0, localRzDeg: 0 },
      { id: "b-amp", componentId: "c-amp", parentBindingId: null, sortOrder: 0, role: "root", targetKind: "asset", asset3dId: "a-amp", localXMm: 0, localYMm: 0, localZMm: 0, localRxDeg: 0, localRyDeg: 0, localRzDeg: 0 },
    ],
    objectBindings: [],
    assets: [
      // The catalog `sma male`: connect_out on the spline node, connect_in
      // (the mating face) 25.45 mm further on.
      { id: "a-sma", name: "sma male", kindId: "rf_cable_connector", anchors: [
        anchor("connect_out", [-4, 0, 0], [1, 0, 0]),
        anchor("connect_in", [-29.45, 0, 0], [-1, 0, 0]),
      ] },
      { id: "a-dds", name: "dds", kindId: "rf_source", anchors: [anchor("rf_out", [6.8, 5, 12], [0, 0, 1], { name: "CH2", connectorType: "sma_female" })] },
      { id: "a-amp", name: "amp", kindId: "rf_amplifier", anchors: [
        anchor("rf_in", [-55.5, 0, 0], [-1, 0, 0], { connectorType: "sma_female" }),
        anchor("rf_out", [55.5, 0, 0], [1, 0, 0], { connectorType: "sma_female" }),
      ] },
    ],
    physicsElements: [
      { id: "pe-dds", objectId: "dds", elementKind: "rf_source", kindParams: {} },
      { id: "pe-amp", objectId: "amp", elementKind: "rf_amplifier", kindParams: {} },
      ...(cable ? [{ id: "pe-cable", objectId: "cable", elementKind: "rf_cable", kindParams: {} }] : []),
    ],
  } as unknown as SceneData;
  useSceneStore.setState({ scene, activeCollectionId: null } as never);
  return scene;
}

/** The port as the tracer / renderer place it. */
function realPort(scene: SceneData, objectId: string, anchorName: string): { pos: V; axis: V } {
  const o = scene.objects.find((x) => x.id === objectId)!;
  const c = scene.components.find((x) => x.id === o.componentId)!;
  const p = resolveAnchorPosesLab(c, o, scene).find((x) => x.anchorName === anchorName)!;
  return { pos: p.posLab, axis: p.axisXLab! };
}

/** A cable end's mating face in lab mm: node + outward × tip, outward =
 *  −handle (identity cable rotation). */
function face(pose: V, node: Node, end: "A" | "B", tip: number): { pos: V; out: V } {
  const h = (end === "A" ? node.handleOutMm : node.handleInMm)!;
  const m = Math.hypot(h[0], h[1], h[2]);
  const out = { x: -h[0] / m, y: -h[1] / m, z: -h[2] / m };
  return {
    pos: {
      x: pose.x + node.posMm[0] + out.x * tip,
      y: pose.y + node.posMm[1] + out.y * tip,
      z: pose.z + node.posMm[2] + out.z * tip,
    },
    out,
  };
}

const dist = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

beforeEach(() => {
  updateObjectApiMock.mockReset();
  updateObjectApiMock.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
    ...useSceneStore.getState().scene.objects.find((o) => o.id === id),
    ...patch,
  }));
  createObjectApiMock.mockReset();
  createObjectApiMock.mockImplementation(async (payload: Record<string, unknown>) => ({
    id: "new-cable", name: "RF_CABLE9", properties: {}, visible: true, locked: false, ...payload,
  }));
});

describe("R1: RF ports are placed with the real SceneObject rotation", () => {
  it.each([
    ["rotated about x (rx −90, rz 180)", "dds", "CH2"],
    ["rotated about y (ry 30, rz 15)", "amp", "rf_out"],
  ])("offers and mates a port on an instrument %s", async (_label, objectId, anchorName) => {
    const probe = seed();
    const port = realPort(probe, objectId, anchorName);
    // Park end B 3 mm in front of the port: node = port + axis × (3 + 15.5),
    // handle along +axis so the end's outward faces back into the port.
    const k = 3 + 15.5;
    const nodeB: Node = {
      posMm: [port.pos.x + port.axis.x * k, port.pos.y + port.axis.y * k, port.pos.z + port.axis.z * k],
      handleInMm: [port.axis.x * 30, port.axis.y * 30, port.axis.z * 30],
    };
    const scene = seed({ nodes: [{ posMm: [nodeB.posMm[0] + 200, nodeB.posMm[1], nodeB.posMm[2]], handleOutMm: [-30, 0, 0] }, nodeB] });
    const list = await useSceneStore.getState().findRfCableAlignmentCandidates("cable", "B", 25);
    const cand = list.find((c) => c.targetObjectId === objectId && c.targetAnchorName === anchorName);
    expect(cand).toBeDefined();
    expect(cand!.distMm).toBeCloseTo(3, 9);

    await useSceneStore.getState().applyRfCableAlignmentCandidate("cable", "B", cand!);
    const props = updateObjectApiMock.mock.calls[0][1].properties as { rfCableNodes: Node[] };
    const mated = face({ x: 0, y: 0, z: 0 }, props.rfCableNodes[1], "B", 15.5);
    expect(dist(mated.pos, port.pos)).toBeLessThan(1e-9);
    expect(dist(mated.out, { x: -port.axis.x, y: -port.axis.y, z: -port.axis.z })).toBeLessThan(1e-12);
    void scene;
  });

  it("puts a new cable at the midpoint of the two real ports", async () => {
    const scene = seed();
    await useSceneStore.getState().createRfCableBetweenPorts({
      srcObjectId: "dds", srcAnchorId: "rf_out", srcAnchorName: "CH2",
      tgtObjectId: "amp", tgtAnchorId: "rf_in", tgtAnchorName: "rf_in",
    });
    const a = realPort(scene, "dds", "CH2").pos;
    const b = realPort(scene, "amp", "rf_in").pos;
    const payload = createObjectApiMock.mock.calls[0][0] as { xMm: number; yMm: number; zMm: number };
    expect(dist({ x: payload.xMm, y: payload.yMm, z: payload.zMm }, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }))
      .toBeLessThan(1e-9);
  });
});


describe("R2: the align picker uses the end's bound connector length", () => {
  it("measures an SMA end mated by connect as 0 mm off, and keeps it on the port", async () => {
    const SMA_TIP = 25.45;
    const probe = seed();
    const port = realPort(probe, "amp", "rf_in");
    // End B exactly where connect / resnap put it: node = port + axis × 25.45.
    const nodeB: Node = {
      posMm: [port.pos.x + port.axis.x * SMA_TIP, port.pos.y + port.axis.y * SMA_TIP, port.pos.z + port.axis.z * SMA_TIP],
      handleInMm: [port.axis.x * 30, port.axis.y * 30, port.axis.z * 30],
    };
    seed({
      nodes: [{ posMm: [nodeB.posMm[0] + 200, nodeB.posMm[1], nodeB.posMm[2]], handleOutMm: [-30, 0, 0] }, nodeB],
      smaConnectors: true,
    });
    const list = await useSceneStore.getState().findRfCableAlignmentCandidates("cable", "B", 25);
    const cand = list.find((c) => c.targetObjectId === "amp" && c.targetAnchorName === "rf_in")!;
    expect(cand).toBeDefined();
    expect(cand.distMm).toBeLessThan(1e-9); // was 9.95 (25.45 − 15.5)

    await useSceneStore.getState().applyRfCableAlignmentCandidate("cable", "B", cand);
    const props = updateObjectApiMock.mock.calls[0][1].properties as { rfCableNodes: Node[] };
    const mated = face({ x: 0, y: 0, z: 0 }, props.rfCableNodes[1], "B", SMA_TIP);
    expect(dist(mated.pos, port.pos)).toBeLessThan(1e-9);
  });
});


describe("R5: RF ports are posed through their binding chain", () => {
  /** `seed()` plus an amplifier whose ports sit on a NESTED binding
   *  (rotated + offset under a body root) with an ObjectBinding delta on
   *  top, on a tilted object. Every RF port lookup used to read the anchor
   *  in its own asset's frame — exact only on an identity root binding. */
  function seedNested(cable?: { nodes: Node[]; endpoints?: Record<string, unknown> }): SceneData {
    const base = seed();
    const scene = {
      ...base,
      objects: [
        ...base.objects,
        obj("nest", "c-nest", { xMm: -1400, yMm: 450, zMm: 760, rxDeg: 10, ryDeg: 30, rzDeg: 15 }),
        ...(cable
          ? [obj("cable", "c-cable", {}, { rfCableNodes: cable.nodes, ...(cable.endpoints ? { rfCableEndpoints: cable.endpoints } : {}) })]
          : []),
      ],
      components: [...base.components, { id: "c-nest", name: "NEST", kindId: "rf_amplifier", asset3dId: null, properties: {} }],
      componentBindings: [
        ...(base.componentBindings ?? []),
        { id: "b-nest-body", componentId: "c-nest", parentBindingId: null, sortOrder: 0, role: "body", targetKind: "asset", asset3dId: "a-nest-body", localXMm: 0, localYMm: 0, localZMm: 0, localRxDeg: 0, localRyDeg: 0, localRzDeg: 0 },
        { id: "b-nest-ports", componentId: "c-nest", parentBindingId: "b-nest-body", sortOrder: 1, role: "ports", targetKind: "asset", asset3dId: "a-amp", localXMm: 12, localYMm: -7, localZMm: 25, localRxDeg: 30, localRyDeg: -60, localRzDeg: 45 },
      ],
      objectBindings: [{
        id: "ob-nest", objectId: "nest", componentBindingId: "b-nest-ports",
        localXMmDelta: 4, localYMmDelta: null, localZMmDelta: null,
        localRxDegDelta: null, localRyDegDelta: -20, localRzDegDelta: null, asset3dIdOverride: null,
      }],
      assets: [...base.assets, { id: "a-nest-body", name: "nest body", kindId: "rf_amplifier", anchors: [] }],
      physicsElements: [
        ...base.physicsElements,
        { id: "pe-nest", objectId: "nest", elementKind: "rf_amplifier", kindParams: {} },
        ...(cable ? [{ id: "pe-cable", objectId: "cable", elementKind: "rf_cable", kindParams: {} }] : []),
      ],
    } as unknown as SceneData;
    useSceneStore.setState({ scene, activeCollectionId: null } as never);
    return scene;
  }

  it("connect mates both ends onto the real ports", async () => {
    const scene = seedNested();
    await useSceneStore.getState().createRfCableBetweenPorts({
      srcObjectId: "dds", srcAnchorId: "rf_out", srcAnchorName: "CH2",
      tgtObjectId: "nest", tgtAnchorId: "rf_in", tgtAnchorName: "rf_in",
    });
    const payload = createObjectApiMock.mock.calls[0][0] as { xMm: number; yMm: number; zMm: number };
    const pose = { x: payload.xMm, y: payload.yMm, z: payload.zMm };
    const calls = updateObjectApiMock.mock.calls;
    const last = calls[calls.length - 1][1].properties as { rfCableNodes: Node[] };
    const nodes = last.rfCableNodes;
    const src = realPort(scene, "dds", "CH2");
    const tgt = realPort(scene, "nest", "rf_in");
    expect(dist(face(pose, nodes[0], "A", 15.5).pos, src.pos)).toBeLessThan(1e-9);
    const b = face(pose, nodes[nodes.length - 1], "B", 15.5);
    expect(dist(b.pos, tgt.pos)).toBeLessThan(1e-9);
    expect(dist(b.out, { x: -tgt.axis.x, y: -tgt.axis.y, z: -tgt.axis.z })).toBeLessThan(1e-12);
    // The midpoint is between the REAL ports too.
    expect(dist(pose, { x: (src.pos.x + tgt.pos.x) / 2, y: (src.pos.y + tgt.pos.y) / 2, z: (src.pos.z + tgt.pos.z) / 2 }))
      .toBeLessThan(1e-9);
  });

  it("resnap puts a linked end back on the real port", async () => {
    const scene = seedNested({
      nodes: [{ posMm: [0, 0, 0], handleOutMm: [30, 0, 0] }, { posMm: [100, 0, 0], handleInMm: [-30, 0, 0] }],
      endpoints: { B: { targetObjectId: "nest", targetAnchorId: "rf_out", targetAnchorName: "rf_out" } },
    });
    await useSceneStore.getState().resnapRfCablesLinkedTo(["nest"]);
    const props = updateObjectApiMock.mock.calls[0][1].properties as { rfCableNodes: Node[] };
    const port = realPort(scene, "nest", "rf_out");
    const b = face({ x: 0, y: 0, z: 0 }, props.rfCableNodes[1], "B", 15.5);
    expect(dist(b.pos, port.pos)).toBeLessThan(1e-9);
    expect(dist(b.out, { x: -port.axis.x, y: -port.axis.y, z: -port.axis.z })).toBeLessThan(1e-12);
  });

  it("align offers the real port and mates onto it", async () => {
    const port = realPort(seedNested(), "nest", "rf_out");
    const k = 3 + 15.5;
    const nodeB: Node = {
      posMm: [port.pos.x + port.axis.x * k, port.pos.y + port.axis.y * k, port.pos.z + port.axis.z * k],
      handleInMm: [port.axis.x * 30, port.axis.y * 30, port.axis.z * 30],
    };
    seedNested({ nodes: [{ posMm: [nodeB.posMm[0] + 200, nodeB.posMm[1], nodeB.posMm[2]], handleOutMm: [-30, 0, 0] }, nodeB] });
    const list = await useSceneStore.getState().findRfCableAlignmentCandidates("cable", "B", 25);
    const cand = list.find((c) => c.targetObjectId === "nest" && c.targetAnchorName === "rf_out");
    expect(cand).toBeDefined();
    expect(cand!.distMm).toBeCloseTo(3, 9);
    await useSceneStore.getState().applyRfCableAlignmentCandidate("cable", "B", cand!);
    const props = updateObjectApiMock.mock.calls[0][1].properties as { rfCableNodes: Node[] };
    expect(dist(face({ x: 0, y: 0, z: 0 }, props.rfCableNodes[1], "B", 15.5).pos, port.pos)).toBeLessThan(1e-9);
  });
});


describe("R4: a new PPG takes the next free CH<n>", () => {
  it.each([
    // [existing PPG names, other object names, expected]
    [["CH0", "CH1"], [], "CH2"],        // unchanged when nothing collides
    [["CH1"], [], "CH2"],               // CH0 deleted out of {CH0, CH1}: was CH1 → 409
    [["CH1"], ["ch2"], "CH3"],          // case-insensitive, and steps more than once
  ])("PPGs %j + objects %j → %s", async (ppgNames, otherNames, expected) => {
    const base = seed();
    const ppgs = (ppgNames as string[]).map((name, i) => ({ ...obj(`ppg${i}`, "c-ppg", {}), name }));
    const others = (otherNames as string[]).map((name, i) => ({ ...obj(`other${i}`, "c-amp", {}), name }));
    useSceneStore.setState({
      scene: {
        ...base,
        objects: [...base.objects, ...ppgs, ...others],
        components: [
          ...base.components,
          { id: "c-ppg", name: "PPG BNC MALE", kindId: "programmable_pulse_generator", asset3dId: null, properties: { connectorType: "bnc" } },
        ],
        componentBindings: [
          ...(base.componentBindings ?? []),
          { id: "b-ppg", componentId: "c-ppg", parentBindingId: null, sortOrder: 0, role: "root", targetKind: "asset", asset3dId: "a-ppg" },
        ],
        assets: [
          ...base.assets,
          { id: "a-ppg", name: "ppg", kindId: "programmable_pulse_generator", anchors: [anchor("rf_out", [0, 0, 4.8], [0, 0, 1], { connectorType: "bnc_male" })] },
        ],
        physicsElements: [
          ...base.physicsElements,
          ...ppgs.map((o) => ({ id: `pe-${o.id}`, objectId: o.id, elementKind: "programmable_pulse_generator", kindParams: {} })),
        ],
        timingPrograms: [],
      } as unknown as SceneData,
    } as never);
    createTimingProgramApiMock.mockReset();
    createTimingProgramApiMock.mockImplementation(async (payload: Record<string, unknown>) => ({ id: "tp-new", intervals: [], ...payload }));

    const created = await useSceneStore.getState().createProgrammablePulseGenerator({ connectorType: "bnc" });
    expect(created).not.toBeNull();
    expect(createTimingProgramApiMock.mock.calls[0][0].name).toBe(expected);
    expect(createObjectApiMock.mock.calls[0][0].name).toBe(expected);
  });
});
