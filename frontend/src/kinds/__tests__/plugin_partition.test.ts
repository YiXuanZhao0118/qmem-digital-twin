/**
 * Phase 2 tests — pin the four-way contract for the
 * `partitionKindParamKeys` / `resolvePortDomain` helpers added in
 * `_plugin.ts`. Every existing plugin must keep rendering as before
 * until its Phase-3 migration; new plugins should be able to opt in to
 * the explicit intrinsic / state split incrementally.
 */

import { describe, expect, it } from "vitest";

import {
  definePhysicsPlugin,
  isPhysicsPlugin,
  partitionKindParamKeys,
  resolvePortDomain,
} from "../_plugin";
import { PHYSICS_PLUGINS } from "../_plugins";

describe("partitionKindParamKeys", () => {
  it("treats every key as state when neither list is set (legacy plugin)", () => {
    const p = definePhysicsPlugin<{ a: number; b: number }>({
      id: "x",
      displayName: "X",
      componentTypes: ["x"],
      assetCategory: "optical",
      physics: {
        elementKind: "x",
        primaryDomain: "optical",
        defaultPhysics: ["optical"],
        anchors: { required: [], optional: [], needsDirection: [] },
        alignVariant: "none",
        alignToleranceMm: 0,
        alignSummary: "",
        defaultParams: { a: 1, b: 2 },
      },
    });
    const r = partitionKindParamKeys(p);
    expect(r.intrinsic).toEqual([]);
    expect(r.state).toEqual(["a", "b"]);
    expect(r.overlap).toEqual([]);
    expect(r.unclassified).toEqual([]);
  });

  it("derives state from intrinsic when only intrinsic is set", () => {
    const p = definePhysicsPlugin<{ a: number; b: number; c: number }>({
      id: "x",
      displayName: "X",
      componentTypes: ["x"],
      assetCategory: "optical",
      physics: {
        elementKind: "x",
        primaryDomain: "optical",
        defaultPhysics: ["optical"],
        anchors: { required: [], optional: [], needsDirection: [] },
        alignVariant: "none",
        alignToleranceMm: 0,
        alignSummary: "",
        defaultParams: { a: 1, b: 2, c: 3 },
        intrinsicParamKeys: ["a", "c"],
      },
    });
    const r = partitionKindParamKeys(p);
    expect(r.intrinsic).toEqual(["a", "c"]);
    expect(r.state).toEqual(["b"]);
    expect(r.unclassified).toEqual([]);
  });

  it("derives intrinsic from state when only state is set", () => {
    const p = definePhysicsPlugin<{ a: number; b: number; c: number }>({
      id: "x",
      displayName: "X",
      componentTypes: ["x"],
      assetCategory: "optical",
      physics: {
        elementKind: "x",
        primaryDomain: "optical",
        defaultPhysics: ["optical"],
        anchors: { required: [], optional: [], needsDirection: [] },
        alignVariant: "none",
        alignToleranceMm: 0,
        alignSummary: "",
        defaultParams: { a: 1, b: 2, c: 3 },
        stateParamKeys: ["b"],
      },
    });
    const r = partitionKindParamKeys(p);
    expect(r.intrinsic).toEqual(["a", "c"]);
    expect(r.state).toEqual(["b"]);
  });

  it("reports overlap and unclassified when both lists are set imperfectly", () => {
    const p = definePhysicsPlugin<{ a: number; b: number; c: number; d: number }>({
      id: "x",
      displayName: "X",
      componentTypes: ["x"],
      assetCategory: "optical",
      physics: {
        elementKind: "x",
        primaryDomain: "optical",
        defaultPhysics: ["optical"],
        anchors: { required: [], optional: [], needsDirection: [] },
        alignVariant: "none",
        alignToleranceMm: 0,
        alignSummary: "",
        defaultParams: { a: 1, b: 2, c: 3, d: 4 },
        intrinsicParamKeys: ["a", "b"],
        stateParamKeys: ["b", "c"],
      },
    });
    const r = partitionKindParamKeys(p);
    expect(r.intrinsic).toEqual(["a"]);   // a only in intrinsic
    expect(r.state).toEqual(["c"]);        // c only in state
    expect(r.overlap).toEqual(["b"]);      // b in both -> reported
    expect(r.unclassified).toEqual(["d"]); // d in neither -> reported
  });
});

describe("resolvePortDomain", () => {
  const plugin = definePhysicsPlugin<{ a: number }>({
    id: "x",
    displayName: "X",
    componentTypes: ["x"],
    assetCategory: "optical",
    physics: {
      elementKind: "x",
      primaryDomain: "optical",
      defaultPhysics: ["optical"],
      anchors: { required: [], optional: [], needsDirection: [] },
      alignVariant: "none",
      alignToleranceMm: 0,
      alignSummary: "",
      defaultParams: { a: 0 },
      portDomains: { weird_pin: "dc" },
    },
  });

  it("returns the explicit override when set", () => {
    expect(resolvePortDomain(plugin, "weird_pin")).toBe("dc");
  });

  it("falls through to the rf_* heuristic", () => {
    expect(resolvePortDomain(plugin, "rf_in")).toBe("rf");
    expect(resolvePortDomain(plugin, "rf_out")).toBe("rf");
  });

  it("falls through to the optical heuristic", () => {
    expect(resolvePortDomain(plugin, "intercept_in")).toBe("optical");
    expect(resolvePortDomain(plugin, "fiber_end_a")).toBe("optical");
  });

  it("falls through to the trigger / ttl heuristic", () => {
    expect(resolvePortDomain(plugin, "trigger_in")).toBe("trigger");
    expect(resolvePortDomain(plugin, "gate_in")).toBe("ttl");
  });

  it("returns null when the heuristic can't classify", () => {
    expect(resolvePortDomain(plugin, "mystery")).toBeNull();
  });
});

// =============================================================================
// Phase 3 migration invariants — guards the registry so a newly-migrated
// plugin can't accidentally leave `intrinsicParamKeys` / `stateParamKeys`
// out of sync with `defaultParams`. Plugins that haven't opted in yet (no
// keys declared at all) are skipped; they remain "all state" by contract.
// =============================================================================

describe("PHYSICS_PLUGINS partition invariants", () => {
  it("every plugin that opts into the partition has no overlap and no unclassified keys", () => {
    for (const p of PHYSICS_PLUGINS) {
      if (!isPhysicsPlugin(p)) continue;
      const intrinsicGiven = p.physics.intrinsicParamKeys !== undefined;
      const stateGiven = p.physics.stateParamKeys !== undefined;
      if (!intrinsicGiven && !stateGiven) continue; // not migrated yet
      const r = partitionKindParamKeys(p);
      expect(r.overlap, `[${p.id}] keys in both intrinsic AND state: ${r.overlap.join(", ")}`)
        .toEqual([]);
      expect(
        r.unclassified,
        `[${p.id}] keys in neither intrinsic NOR state: ${r.unclassified.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("every intrinsicParamKeys / stateParamKeys entry actually exists in defaultParams", () => {
    for (const p of PHYSICS_PLUGINS) {
      if (!isPhysicsPlugin(p)) continue;
      const known = new Set(Object.keys(p.physics.defaultParams));
      for (const k of p.physics.intrinsicParamKeys ?? []) {
        expect(known.has(k as string), `[${p.id}] intrinsic key "${k}" not in defaultParams`).toBe(true);
      }
      for (const k of p.physics.stateParamKeys ?? []) {
        expect(known.has(k as string), `[${p.id}] state key "${k}" not in defaultParams`).toBe(true);
      }
    }
  });

  it("every portDomains anchor exists in anchors.required ∪ anchors.optional", () => {
    for (const p of PHYSICS_PLUGINS) {
      if (!isPhysicsPlugin(p)) continue;
      const known = new Set<string>([
        ...p.physics.anchors.required,
        ...p.physics.anchors.optional,
      ]);
      for (const a of Object.keys(p.physics.portDomains ?? {})) {
        expect(known.has(a), `[${p.id}] portDomains anchor "${a}" not in anchors contract`).toBe(true);
      }
    }
  });
});
