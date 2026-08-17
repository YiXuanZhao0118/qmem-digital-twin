/**
 * Pinning tests for `applyEvents` — the batched WebSocket broadcast path
 * (App.tsx buffers socket messages per frame and calls this).
 *
 * Invariants:
 *   - a burst of events lands as ONE store commit, so the optical / RF
 *     recompute keyed on `scene.objects` runs once;
 *   - later events in a burst reduce against earlier ones (fold, not
 *     last-write-wins on the base state);
 *   - an `object.updated` echo that carries a version already in the
 *     store is dropped — no new `scene.objects` array, no re-trace.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useSceneStore } from "../sceneStore";

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
  updatedAt?: string;
};

function obj(id: string, xMm: number, updatedAt = "2026-08-17T00:00:00.000000Z"): TestObject {
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
    locked: false,
    properties: {},
    updatedAt,
  };
}

function updatedEvent(payload: TestObject) {
  return { type: "object.updated", payload } as never;
}

beforeEach(() => {
  const state = useSceneStore.getState();
  useSceneStore.setState({
    scene: { ...state.scene, objects: [obj("a", 0), obj("b", 10), obj("c", 20)] as never },
    selectedComponentId: null,
    selectedObjectId: null,
    selectedObjectIds: [],
  });
});

function countCommits(run: () => void): number {
  let commits = 0;
  const unsubscribe = useSceneStore.subscribe((next, prev) => {
    if (next.scene.objects !== prev.scene.objects) commits += 1;
  });
  try {
    run();
  } finally {
    unsubscribe();
  }
  return commits;
}

describe("applyEvents", () => {
  it("folds a burst of object.updated events into one commit", () => {
    const commits = countCommits(() => {
      useSceneStore.getState().applyEvents([
        updatedEvent(obj("a", 100, "2026-08-17T01:00:00.000000Z")),
        updatedEvent(obj("b", 110, "2026-08-17T01:00:00.000000Z")),
        updatedEvent(obj("c", 120, "2026-08-17T01:00:00.000000Z")),
      ]);
    });
    expect(commits).toBe(1);
    expect(useSceneStore.getState().scene.objects.map((o) => o.xMm)).toEqual([100, 110, 120]);
  });

  it("reduces later events against earlier ones in the same burst", () => {
    // Two updates to the same object: the second must win, which only
    // holds if each event reduces against the folded result.
    useSceneStore.getState().applyEvents([
      updatedEvent(obj("a", 1, "2026-08-17T01:00:00.000000Z")),
      updatedEvent(obj("a", 2, "2026-08-17T02:00:00.000000Z")),
    ]);
    expect(useSceneStore.getState().scene.objects.find((o) => o.id === "a")?.xMm).toBe(2);
  });

  it("drops an echo whose updatedAt matches the stored row", () => {
    // Self-echo of a write already applied: same version, so no commit.
    const commits = countCommits(() => {
      useSceneStore.getState().applyEvents([
        updatedEvent(obj("a", 999)),
        updatedEvent(obj("b", 999)),
      ]);
    });
    expect(commits).toBe(0);
    expect(useSceneStore.getState().scene.objects.find((o) => o.id === "a")?.xMm).toBe(0);
  });

  it("still applies a genuinely newer version of a known object", () => {
    useSceneStore.getState().applyEvents([
      updatedEvent(obj("a", 42, "2026-08-18T00:00:00.000000Z")),
    ]);
    expect(useSceneStore.getState().scene.objects.find((o) => o.id === "a")?.xMm).toBe(42);
  });

  it("ignores keepalive traffic without committing", () => {
    const commits = countCommits(() => {
      useSceneStore.getState().applyEvents([
        { type: "pong" } as never,
        { type: "scene.connected" } as never,
      ]);
    });
    expect(commits).toBe(0);
  });
});
