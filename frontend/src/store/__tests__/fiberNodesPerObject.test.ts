/**
 * Regression tests for fibre node editing being keyed on **objectId**, not
 * componentId (2026-08-21).
 *
 * The bug: `enterFiberEdit` took a componentId and `updateFiberNodes` /
 * `insertFiberNode` / `removeFiberNode` each resolved their target with
 * `objects.find((o) => o.componentId === componentId)` — the FIRST match. Two
 * patch cords instantiated from one catalog Component (which the parts
 * library produces through ordinary use, since `ensureObjectForComponent`
 * places a second `fiber` object happily) therefore shared one edit target:
 * every node edit on either cable landed on object #1, so the second could
 * not be shaped at all, and the gizmo drew #1's nodes no matter which one was
 * selected. `rf_cable` never had this — it was keyed by objectId from the
 * start, and these actions now match it.
 *
 * Invariants pinned here:
 *   - a write names its SceneObject exactly; the sibling on the same
 *     Component is untouched;
 *   - that holds for whichever sibling is written, including the one the old
 *     `find` would NOT have returned;
 *   - insert / remove read the named object's own node array;
 *   - `enterFiberEdit` stores the objectId it was given.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const updateObjectApiMock = vi.fn();

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

/** Two SceneObjects on ONE catalog fibre Component — the shape that broke. */
const COMPONENT_ID = "comp-fiber-pm-apc";

function fiberObj(id: string, nodes: Node[]) {
  return {
    id,
    name: id.toUpperCase(),
    componentId: COMPONENT_ID,
    xMm: 0,
    yMm: 0,
    zMm: 0,
    rxDeg: 0,
    ryDeg: 0,
    rzDeg: 0,
    visible: true,
    locked: false,
    properties: { fiberNodes: nodes },
  };
}

function straight(x0: number, x1: number): Node[] {
  return [
    { posMm: [x0, 0, 0], handleOutMm: [10, 0, 0] },
    { posMm: [x1, 0, 0], handleInMm: [-10, 0, 0] },
  ];
}

function seed(objects: unknown[]) {
  const state = useSceneStore.getState();
  useSceneStore.setState({
    scene: {
      ...state.scene,
      objects: objects as never,
      components: [{ id: COMPONENT_ID, name: "Fiber PM APC", properties: {} }] as never,
      collections: [],
      collectionMembers: [],
    },
    undoStack: [],
    redoStack: [],
  });
}

function nodesOf(id: string): Node[] | undefined {
  const obj = useSceneStore.getState().scene.objects.find((o) => o.id === id);
  return (obj?.properties as { fiberNodes?: Node[] } | undefined)?.fiberNodes;
}

beforeEach(() => {
  updateObjectApiMock.mockReset();
  updateObjectApiMock.mockImplementation(
    async (id: string, patch: Record<string, unknown>) => {
      const current = useSceneStore.getState().scene.objects.find((o) => o.id === id);
      return { ...(current ?? { id }), ...patch };
    },
  );
});

describe("fibre node edits are per SceneObject", () => {
  it("writes only the named object, leaving its sibling on the same Component alone", async () => {
    seed([fiberObj("fiber-1", straight(0, 300)), fiberObj("fiber-2", straight(500, 800))]);
    const before2 = nodesOf("fiber-2");

    await useSceneStore.getState().updateFiberNodes("fiber-1", straight(0, 999));

    expect(updateObjectApiMock).toHaveBeenCalledTimes(1);
    expect(updateObjectApiMock.mock.calls[0][0]).toBe("fiber-1");
    expect(nodesOf("fiber-1")?.[1].posMm).toEqual([999, 0, 0]);
    expect(nodesOf("fiber-2")).toEqual(before2);
  });

  it("writes the SECOND sibling — the one the old componentId `find` never returned", async () => {
    seed([fiberObj("fiber-1", straight(0, 300)), fiberObj("fiber-2", straight(500, 800))]);
    const before1 = nodesOf("fiber-1");

    await useSceneStore.getState().updateFiberNodes("fiber-2", straight(500, 1234));

    expect(updateObjectApiMock.mock.calls[0][0]).toBe("fiber-2");
    expect(nodesOf("fiber-2")?.[1].posMm[0]).toBe(1234);
    expect(nodesOf("fiber-1")).toEqual(before1);
  });

  it("insertFiberNode reads and grows the named object's own array", async () => {
    seed([fiberObj("fiber-1", straight(0, 300)), fiberObj("fiber-2", straight(500, 800))]);

    await useSceneStore
      .getState()
      .insertFiberNode("fiber-2", 1, { posMm: [650, 40, 0] });

    expect(nodesOf("fiber-2")).toHaveLength(3);
    expect(nodesOf("fiber-2")?.[1].posMm).toEqual([650, 40, 0]);
    // The sibling keeps its two endpoints — it did not receive the insert.
    expect(nodesOf("fiber-1")).toHaveLength(2);
  });

  it("removeFiberNode drops an interior node from the named object only", async () => {
    const withInterior: Node[] = [
      { posMm: [500, 0, 0], handleOutMm: [10, 0, 0] },
      { posMm: [650, 40, 0] },
      { posMm: [800, 0, 0], handleInMm: [-10, 0, 0] },
    ];
    seed([fiberObj("fiber-1", withInterior), fiberObj("fiber-2", withInterior)]);

    await useSceneStore.getState().removeFiberNode("fiber-2", 1);

    expect(nodesOf("fiber-2")).toHaveLength(2);
    expect(nodesOf("fiber-1")).toHaveLength(3);
  });

  it("enterFiberEdit stores the objectId it was handed", () => {
    seed([fiberObj("fiber-1", straight(0, 300)), fiberObj("fiber-2", straight(500, 800))]);

    useSceneStore.getState().enterFiberEdit("fiber-2");

    expect(useSceneStore.getState().fiberEditingObjectId).toBe("fiber-2");
    // Mutually exclusive with the rf_cable gizmo, as before.
    expect(useSceneStore.getState().rfCableEditingObjectId).toBeNull();
  });
});
