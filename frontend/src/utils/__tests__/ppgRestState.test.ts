/**
 * The Pulse & Timing rest-level pill (`utils/ppgRestState.ts`).
 *
 * Invariants:
 *   R1. The pill READS the level the RF BFS gates on: the same
 *       `dynamicSources > asset defaultParams > kindParams` chain, so for
 *       every combination of the three tiers the pill's H/L equals the
 *       gate in the rest snapshot (`buildRfPropagation({idleRestMode})`).
 *   R2. The pill WRITES `dynamicSources.restState`, keeping every other
 *       per-instance key — and that write moves the gate even when the
 *       asset authors a `restState` of its own. Writing `kindParams` (what
 *       the pill used to do) could not: the asset tier shadows it.
 */
import { describe, expect, it } from "vitest";

import type {
  Asset3D,
  ComponentBinding,
  ComponentItem,
  PhysicsElement,
  SceneObject,
} from "../../types/digitalTwin";
import { ppgRestStatePatch, resolvePpgRestState } from "../ppgRestState";
import { buildRfPropagation } from "../rfPropagation";

type Tier = "HIGH" | "LOW" | undefined;

function scene(tiers: { dyn: Tier; asset: Tier; kind: Tier }, extraDyn: Record<string, unknown> = {}) {
  const dynamicSources: Record<string, unknown> = { ...extraDyn };
  if (tiers.dyn !== undefined) dynamicSources.restState = tiers.dyn;
  const defaultParams: Record<string, unknown> = { matingProtrusionMm: 9 };
  if (tiers.asset !== undefined) defaultParams.restState = tiers.asset;
  const kindParams: Record<string, unknown> = { timingProgramId: "prog", outputDomain: "rfout" };
  if (tiers.kind !== undefined) kindParams.restState = tiers.kind;

  const ppg = {
    id: "ppg", name: "CH0", componentId: "comp-ppg",
    xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 0, rzDeg: 0,
    visible: true, locked: false, properties: {},
    dynamicSources: Object.keys(dynamicSources).length > 0 ? dynamicSources : null,
  } as unknown as SceneObject;
  const asset = {
    id: "asset-ppg", name: "PPG BNC Male", kindId: "programmable_pulse_generator",
    anchors: [], defaultParams,
  } as unknown as Asset3D;
  // Binding-backed, like the live PPG: the asset is only reachable through
  // the component's single root binding (component.asset3dId is null).
  const component = { id: "comp-ppg", name: "PPG", kindId: "programmable_pulse_generator", asset3dId: null } as unknown as ComponentItem;
  const binding = {
    id: "b-ppg", componentId: "comp-ppg", parentBindingId: null, targetKind: "asset",
    asset3dId: "asset-ppg", subComponentId: null, role: "body", sortOrder: 0, properties: {},
    localXMm: 0, localYMm: 0, localZMm: 0, localRxDeg: 0, localRyDeg: 0, localRzDeg: 0,
  } as unknown as ComponentBinding;
  const pe = {
    id: "pe-ppg", objectId: "ppg", elementKind: "programmable_pulse_generator", kindParams,
  } as unknown as PhysicsElement;
  return { ppg, asset, component, binding, pe };
}

type Built = ReturnType<typeof scene>;

const slice = (s: Built) => ({
  components: [s.component], assets: [s.asset], componentBindings: [s.binding],
});

/** The rest-snapshot gate the RF BFS computes for this PPG. */
function gateIsHigh(s: Built): boolean {
  const result = buildRfPropagation({
    objects: [s.ppg],
    components: [s.component],
    assets: [s.asset],
    componentBindings: [s.binding],
    physicsElements: [s.pe],
    timingPrograms: [],
    idleRestMode: true,
  });
  return result.ppgGateHighObjectIds.has("ppg");
}

const TIERS: Tier[] = ["HIGH", "LOW", undefined];

describe("resolvePpgRestState (R1)", () => {
  it("reads dynamicSources over the asset over kindParams", () => {
    expect(resolvePpgRestState(...args(scene({ dyn: undefined, asset: undefined, kind: "HIGH" })))).toBe("HIGH");
    // The case the old kindParams-only read got wrong: the asset shadows it.
    expect(resolvePpgRestState(...args(scene({ dyn: undefined, asset: "LOW", kind: "HIGH" })))).toBe("LOW");
    expect(resolvePpgRestState(...args(scene({ dyn: "HIGH", asset: "LOW", kind: "LOW" })))).toBe("HIGH");
    expect(resolvePpgRestState(...args(scene({ dyn: "LOW", asset: "HIGH", kind: "HIGH" })))).toBe("LOW");
    expect(resolvePpgRestState(...args(scene({ dyn: undefined, asset: undefined, kind: undefined })))).toBe("LOW");
  });

  it("equals the RF BFS rest-snapshot gate for every tier combination", () => {
    for (const dyn of TIERS) {
      for (const asset of TIERS) {
        for (const kind of TIERS) {
          const s = scene({ dyn, asset, kind });
          expect(resolvePpgRestState(...args(s)) === "HIGH", `${dyn}/${asset}/${kind}`).toBe(gateIsHigh(s));
        }
      }
    }
  });

  it("reads LOW when the PPG has no object or no element", () => {
    const s = scene({ dyn: "HIGH", asset: undefined, kind: undefined });
    expect(resolvePpgRestState(undefined, undefined, slice(s))).toBe("LOW");
  });
});

describe("ppgRestStatePatch (R2)", () => {
  it("sets restState and keeps every other per-instance key", () => {
    const s = scene({ dyn: "LOW", asset: undefined, kind: undefined }, { channels: [1, 2], foo: "bar" });
    expect(ppgRestStatePatch(s.ppg, "HIGH")).toEqual({
      dynamicSources: { channels: [1, 2], foo: "bar", restState: "HIGH" },
    });
  });

  it("starts a fresh dict when the object has none", () => {
    const s = scene({ dyn: undefined, asset: undefined, kind: undefined });
    expect(s.ppg.dynamicSources).toBeNull();
    expect(ppgRestStatePatch(s.ppg, "LOW")).toEqual({ dynamicSources: { restState: "LOW" } });
  });

  it("moves the gate even when the asset authors restState — writing kindParams did not", () => {
    for (const assetTier of TIERS) {
      for (const next of ["HIGH", "LOW"] as const) {
        const s = scene({ dyn: undefined, asset: assetTier, kind: next === "HIGH" ? "LOW" : "HIGH" });
        // The pill's write, applied the way updateSceneObject would.
        const written: Built = { ...s, ppg: { ...s.ppg, ...ppgRestStatePatch(s.ppg, next) } };
        expect(resolvePpgRestState(...args(written))).toBe(next);
        expect(gateIsHigh(written)).toBe(next === "HIGH");
      }
    }
    // The old write path, for the record: kindParams HIGH under an asset LOW
    // leaves the gate LOW.
    const old = scene({ dyn: undefined, asset: "LOW", kind: "HIGH" });
    expect(gateIsHigh(old)).toBe(false);
  });
});

function args(s: Built): Parameters<typeof resolvePpgRestState> {
  return [s.ppg, s.pe, slice(s)];
}
