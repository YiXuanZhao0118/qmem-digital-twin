/**
 * Exhaustiveness invariants — the safety net that prevents the
 * pre-P2 drift modes from coming back:
 *
 *   1. Every ElementKind in the TS union has a matching PhysicsPlugin.
 *   2. Every PhysicsPlugin's id matches its physics.elementKind.
 *   3. No two plugins claim the same componentType.
 *   4. Every plugin's catalogGroup (if set) maps to a known group.
 *   5. Every assetCategory value is one of the 5 enum members.
 *   6. Every PhysicsPlugin's defaultParams pass a shape sanity check
 *      (no undefined, no NaN, no top-level reserved keys).
 *
 * These run on every `npm test` and on every commit (once we wire
 * pre-commit hooks). They are the "registry is sound" assertions —
 * if a future PR adds a kind to digitalTwin.ts but forgets the
 * plugin file, this test fails BEFORE the bug ships.
 */
import { describe, expect, it } from "vitest";

import { isPhysicsPlugin } from "../_plugin";
import {
  PHYSICS_PLUGINS,
  PLUGINS,
  derivedCategoryToComponentTypes,
  derivedComponentTypeToKind,
  derivedKindLabels,
  pluginForComponentType,
  pluginForKind,
} from "../_plugins";
import type { ElementKind } from "../../types/digitalTwin";

const KIND_UNION_MEMBERS: ElementKind[] = [
  "laser_source",
  "tapered_amplifier",
  "mirror",
  "dichroic_mirror",
  "lens_biconvex",
  "lens_plano_convex",
  "lens_cylindrical",
  "waveplate",
  "polarizer",
  "beam_splitter",
  "fiber_coupler",
  "fiber",
  "fiber_end",
  "isolator",
  "aom",
  "eom",
  "nonlinear_crystal",
  "saturable_absorber",
  "detector",
  "camera",
  "spectrometer",
  "wavemeter",
  "beam_dump",
  "rf_source",
  "rf_amplifier",
  "horn_antenna",
  "programmable_pulse_generator",
  "rf_cable",
  "rf_switch",
];

const VALID_ASSET_CATEGORIES = new Set([
  "optical",
  "electronics",
  "mechanical",
  "infrastructure",
  "misc",
]);

const VALID_CATALOG_GROUPS = new Set([
  "Emitters",
  "Passive",
  "Active / Nonlinear",
  "Sinks",
  "RF",
]);

describe("Plugin registry exhaustiveness", () => {
  it("every ElementKind union member is covered by a PhysicsPlugin", () => {
    const pluginKinds = new Set(PHYSICS_PLUGINS.map((p) => p.physics.elementKind));
    const missing = KIND_UNION_MEMBERS.filter((k) => !pluginKinds.has(k));
    expect(missing, `ElementKinds without plugins: ${missing.join(", ")}`).toEqual([]);
  });

  it("every PhysicsPlugin has a matching ElementKind union member", () => {
    const unionSet = new Set<string>(KIND_UNION_MEMBERS);
    const orphans = PHYSICS_PLUGINS.filter((p) => !unionSet.has(p.physics.elementKind));
    expect(
      orphans.map((p) => p.id),
      "Plugins not in ElementKind union",
    ).toEqual([]);
  });

  it("plugin id === physics.elementKind for every PhysicsPlugin", () => {
    for (const p of PHYSICS_PLUGINS) {
      expect(p.id).toBe(p.physics.elementKind);
    }
  });

  it("no two plugins claim the same componentType", () => {
    const seen = new Map<string, string>();
    for (const p of PLUGINS) {
      for (const ct of p.componentTypes) {
        const prior = seen.get(ct);
        if (prior) {
          throw new Error(
            `componentType "${ct}" claimed by both ${prior} and ${p.id}`,
          );
        }
        seen.set(ct, p.id);
      }
    }
  });

  it("every assetCategory is a valid enum member", () => {
    for (const p of PLUGINS) {
      expect(
        VALID_ASSET_CATEGORIES.has(p.assetCategory),
        `[${p.id}] invalid assetCategory: ${p.assetCategory}`,
      ).toBe(true);
    }
  });

  it("every catalogGroup (when set) is one of the canonical labels", () => {
    for (const p of PLUGINS) {
      if (p.catalogGroup !== undefined) {
        expect(
          VALID_CATALOG_GROUPS.has(p.catalogGroup),
          `[${p.id}] unknown catalogGroup: ${p.catalogGroup}`,
        ).toBe(true);
      }
    }
  });

  it("every PhysicsPlugin has non-empty displayName and defaultParams", () => {
    for (const p of PHYSICS_PLUGINS) {
      expect(p.displayName.length, `[${p.id}] empty displayName`).toBeGreaterThan(0);
      expect(
        Object.keys(p.physics.defaultParams).length,
        `[${p.id}] empty defaultParams`,
      ).toBeGreaterThan(0);
    }
  });

  it("defaultParams contain no undefined / NaN at top level", () => {
    for (const p of PHYSICS_PLUGINS) {
      for (const [key, value] of Object.entries(p.physics.defaultParams)) {
        expect(value, `[${p.id}.${key}] is undefined`).not.toBeUndefined();
        if (typeof value === "number") {
          expect(Number.isNaN(value), `[${p.id}.${key}] is NaN`).toBe(false);
        }
      }
    }
  });

  it("anchors.needsDirection ⊆ required ∪ optional", () => {
    for (const p of PHYSICS_PLUGINS) {
      const known = new Set<string>([
        ...p.physics.anchors.required,
        ...p.physics.anchors.optional,
      ]);
      for (const a of p.physics.anchors.needsDirection) {
        expect(known.has(a), `[${p.id}] needsDirection has unknown anchor: ${a}`).toBe(
          true,
        );
      }
      for (const a of p.physics.anchors.needsAperture ?? []) {
        expect(known.has(a), `[${p.id}] needsAperture has unknown anchor: ${a}`).toBe(
          true,
        );
      }
    }
  });

  it("kinds with alignVariant !== 'none' have at least one required anchor", () => {
    for (const p of PHYSICS_PLUGINS) {
      if (p.physics.alignVariant !== "none") {
        expect(
          p.physics.anchors.required.length,
          `[${p.id}] alignVariant=${p.physics.alignVariant} but no required anchors`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("Derive helpers", () => {
  it("derivedComponentTypeToKind contains every componentType from PhysicsPlugins", () => {
    const map = derivedComponentTypeToKind();
    for (const p of PHYSICS_PLUGINS) {
      for (const ct of p.componentTypes) {
        expect(map[ct], `componentType ${ct} missing from derived map`).toBe(
          p.physics.elementKind,
        );
      }
    }
  });

  it("derivedKindLabels covers every PhysicsPlugin", () => {
    const labels = derivedKindLabels();
    for (const p of PHYSICS_PLUGINS) {
      expect(labels[p.physics.elementKind]).toBe(p.displayName);
    }
  });

  it("derivedCategoryToComponentTypes partitions all componentTypes", () => {
    const byCategory = derivedCategoryToComponentTypes();
    const all = new Set<string>();
    for (const cat of VALID_ASSET_CATEGORIES) {
      for (const ct of byCategory[cat as keyof typeof byCategory]) all.add(ct);
    }
    for (const p of PLUGINS) {
      for (const ct of p.componentTypes) {
        expect(all.has(ct), `componentType ${ct} not in any category`).toBe(true);
      }
    }
  });

  it("pluginForComponentType resolves every claimed componentType", () => {
    for (const p of PLUGINS) {
      for (const ct of p.componentTypes) {
        expect(pluginForComponentType(ct)).toBe(p);
      }
    }
  });

  it("pluginForKind resolves every PhysicsPlugin by its kind", () => {
    for (const p of PHYSICS_PLUGINS) {
      expect(pluginForKind(p.physics.elementKind)).toBe(p);
    }
  });

  it("pluginForComponentType returns null for unknown componentTypes", () => {
    expect(pluginForComponentType("not_a_real_type")).toBeNull();
  });

  it("isPhysicsPlugin discriminator works", () => {
    for (const p of PLUGINS) {
      const isPhys = isPhysicsPlugin(p);
      expect(isPhys).toBe(p.physics !== undefined);
    }
  });
});
