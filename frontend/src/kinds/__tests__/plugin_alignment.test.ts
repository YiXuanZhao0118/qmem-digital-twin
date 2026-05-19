/**
 * Plugin-vs-legacy alignment check.
 *
 * Each migrated ComponentPlugin in `PLUGINS` must agree with the
 * still-hand-maintained legacy tables (KIND_REGISTRY,
 * COMPONENT_TYPE_TO_KIND, KIND_LABELS, DEFAULT_KIND_PARAMS) on every
 * field we care about. If a plugin author drifts from the legacy data,
 * this test fails before the drift hits production.
 *
 * Once M2 finishes migrating every kind, the legacy tables become
 * derived from PLUGINS and this test becomes a fixed-point (legacy ===
 * derived). M3 deletes the legacy tables entirely.
 */
import { describe, it, expect } from "vitest";

import { PLUGINS, verifyAlignment } from "../_plugins";
import { KIND_REGISTRY } from "../_registry";
import {
  componentTypeToElementKind,
  DEFAULT_KIND_PARAMS,
  KIND_LABELS,
} from "../../utils/elementDefaults";

describe("ComponentPlugin alignment with legacy tables", () => {
  it("every migrated plugin matches the legacy KIND_REGISTRY entry", () => {
    const report = verifyAlignment(
      KIND_REGISTRY as unknown as Record<
        string,
        { kind: string; displayName: string; requiredAnchors: readonly string[] }
      >,
      KIND_LABELS as unknown as Record<string, string>,
      DEFAULT_KIND_PARAMS as unknown as Record<string, Record<string, unknown>>,
      componentTypeToElementKind,
    );
    if (!report.ok) {
      throw new Error(
        `Plugin/legacy alignment failures (${report.errors.length}):\n` +
          report.errors.map((e) => `  - ${e}`).join("\n"),
      );
    }
    expect(report.ok).toBe(true);
  });

  it("PLUGINS array covers every ElementKind + every catalog componentType", () => {
    // 27 physics plugins (one per ElementKind) + 23 passive (mechanical /
    // infrastructure / misc / passive-electronics / passive-optical) +
    // mirror_mount which started in M1 as a sample = 51 total. Snapshot
    // value so a regression (someone deletes a plugin) shows up
    // immediately.
    // 30 physics (incl. programmable_pulse_generator + fiber_end +
    // glan_polarizer) + mirror_mount (physics-flagged passive) +
    // 23 PASSIVE_PLUGINS = 54. Was 51 pre-PPG, 52 after PPG, 53 after
    // fiber_end, 54 after Stage A''.3 added glan_polarizer (the
    // Glan-Laser calcite polariser used by high-power isolators).
    expect(PLUGINS.length).toBe(54);

    // Every legacy ElementKind has a physics plugin claiming it.
    const physicsIds = new Set(
      PLUGINS.filter((p) => p.physics !== undefined).map((p) => p.id),
    );
    const expectedKinds = [
      "laser_source", "tapered_amplifier", "mirror", "dichroic_mirror",
      "lens_biconvex", "lens_plano_convex", "lens_cylindrical",
      "waveplate", "polarizer", "glan_polarizer", "beam_splitter", "fiber_coupler",
      "fiber", "fiber_end", "isolator", "aom", "eom", "nonlinear_crystal",
      "saturable_absorber", "detector", "camera", "spectrometer",
      "wavemeter", "beam_dump", "rf_source", "rf_amplifier",
      "horn_antenna", "programmable_pulse_generator",
      "rf_cable", "rf_switch",
    ];
    for (const k of expectedKinds) {
      expect(physicsIds.has(k)).toBe(true);
    }
    expect(physicsIds.size).toBe(expectedKinds.length);
  });

  it("no two plugins claim the same componentType", () => {
    const seen = new Map<string, string>();
    for (const p of PLUGINS) {
      for (const ct of p.componentTypes) {
        const prior = seen.get(ct);
        if (prior) {
          throw new Error(`componentType "${ct}" claimed by both ${prior} and ${p.id}`);
        }
        seen.set(ct, p.id);
      }
    }
  });

  it("every physics plugin's id matches its physics.elementKind", () => {
    for (const p of PLUGINS) {
      if (p.physics) {
        expect(p.id).toBe(p.physics.elementKind);
      }
    }
  });
});
