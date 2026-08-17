/**
 * Pinning tests for `updateSceneObjects` — the batch write every
 * multi-object transform path goes through (gizmo multi-drag, the group
 * delta fields, Align/Distribute, the Shift+S cursor menu).
 *
 * Invariants:
 *   - N objects → ONE store commit, so the debounced optical / RF
 *     recompute keyed on `scene.objects` runs once on the settled scene
 *     instead of chasing N intermediate commits (the "13 objects moved
 *     together is laggy" report);
 *   - N objects → ONE undo entry, not N;
 *   - locked objects are dropped before any network call;
 *   - a repeated objectId is last-write-wins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const updateObjectApiMock = vi.fn();

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateObjectApi: (id: string, patch: Record<string, unknown>) =>
    updateObjectApiMock(id, patch),
}));

const { useSceneStore } = await import("../sceneStore");

type TestObject = {
  id: string;
  name: string;
  componentId: string;
  xMm: number;
  yMm: number;
  zMm: number;
  rxDeg: number;
  ryDeg: number;
  rzDeg: number;
  visible: boolean;
  locked: boolean;
  properties: Record<string, unknown>;
};

function obj(id: string, xMm: number, locked = false): TestObject {
  return {
    id,
    name: id.toUpperCase(),
    componentId: `comp-${id}`,
    xMm,
    yMm: 0,
    zMm: 0,
    rxDeg: 0,
    ryDeg: 0,
    rzDeg: 0,
    visible: true,
    locked,
    properties: {},
  };
}

function seedScene(objects: TestObject[]) {
  const state = useSceneStore.getState();
  useSceneStore.setState({
    scene: { ...state.scene, objects: objects as never, collections: [], collectionMembers: [] },
    undoStack: [],
    redoStack: [],
  });
}

beforeEach(() => {
  updateObjectApiMock.mockReset();
  // Echo the patch back the way the API does, so upsertObjects lands the
  // new pose in the store.
  updateObjectApiMock.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
    const current = useSceneStore.getState().scene.objects.find((o) => o.id === id);
    return { ...(current ?? { id }), ...patch };
  });
});

describe("updateSceneObjects", () => {
  it("commits N moves in a single store update", async () => {
    seedScene([obj("a", 0), obj("b", 10), obj("c", 20)]);
    let commits = 0;
    const unsubscribe = useSceneStore.subscribe((next, prev) => {
      if (next.scene.objects !== prev.scene.objects) commits += 1;
    });
    try {
      await useSceneStore.getState().updateSceneObjects([
        { objectId: "a", patch: { xMm: 100 } },
        { objectId: "b", patch: { xMm: 110 } },
        { objectId: "c", patch: { xMm: 120 } },
      ]);
    } finally {
      unsubscribe();
    }
    expect(updateObjectApiMock).toHaveBeenCalledTimes(3);
    expect(commits).toBe(1);
    const objects = useSceneStore.getState().scene.objects;
    expect(objects.map((o) => o.xMm)).toEqual([100, 110, 120]);
  });

  it("records ONE undo entry for the whole batch", async () => {
    seedScene([obj("a", 0), obj("b", 10), obj("c", 20)]);
    await useSceneStore.getState().updateSceneObjects([
      { objectId: "a", patch: { xMm: 1 } },
      { objectId: "b", patch: { xMm: 2 } },
      { objectId: "c", patch: { xMm: 3 } },
    ]);
    const stack = useSceneStore.getState().undoStack;
    expect(stack).toHaveLength(1);
    expect(stack[0].description).toBe("Update 3 objects");
  });

  it("undo restores every member's previous pose", async () => {
    seedScene([obj("a", 0), obj("b", 10)]);
    await useSceneStore.getState().updateSceneObjects([
      { objectId: "a", patch: { xMm: 5 } },
      { objectId: "b", patch: { xMm: 15 } },
    ]);
    updateObjectApiMock.mockClear();
    await useSceneStore.getState().undoStack[0].undo();
    expect(updateObjectApiMock.mock.calls.map(([id, patch]) => [id, patch])).toEqual([
      ["a", { xMm: 0 }],
      ["b", { xMm: 10 }],
    ]);
  });

  it("drops locked objects before any network call", async () => {
    seedScene([obj("a", 0), obj("b", 10, true)]);
    await useSceneStore.getState().updateSceneObjects([
      { objectId: "a", patch: { xMm: 1 } },
      { objectId: "b", patch: { xMm: 2 } },
    ]);
    expect(updateObjectApiMock).toHaveBeenCalledTimes(1);
    expect(updateObjectApiMock).toHaveBeenCalledWith("a", { xMm: 1 });
  });

  it("is last-write-wins for a repeated objectId", async () => {
    seedScene([obj("a", 0)]);
    await useSceneStore.getState().updateSceneObjects([
      { objectId: "a", patch: { xMm: 1 } },
      { objectId: "a", patch: { xMm: 2 } },
    ]);
    expect(updateObjectApiMock).toHaveBeenCalledTimes(1);
    expect(updateObjectApiMock).toHaveBeenCalledWith("a", { xMm: 2 });
  });
});
