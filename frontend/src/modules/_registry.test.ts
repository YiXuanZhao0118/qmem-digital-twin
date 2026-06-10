/**
 * Guards the multiphysics module registry.
 *
 * As of 2026-06-10 the only top-level tab is the integrated Lab
 * (``optics_seq``). The Optics (``optics_cavity``), Electronics
 * (``spice``), and EM (``em_fem``) modules were removed entirely —
 * frontend tabs, backend solvers, and the ``SimulationModule`` enum
 * values. This test pins that the only surviving non-tab enum values
 * (``optics_fdtd`` reserved, ``magnetics_dc`` Lab overlay) stay out of
 * ``MODULES`` so nothing silently reappears as a top-level tab.
 */
import { describe, expect, it } from "vitest";

import type { SimulationModule } from "../types/digitalTwin";
import { getModule, MODULES } from "./_registry";

// Top-level tabs the ModuleSwitcher shows.
const TOP_LEVEL_MODULES: SimulationModule[] = ["optics_seq"];

// Backend enum values that are intentionally NOT top-level tabs:
// optics_fdtd is reserved (never shipped a tab); magnetics_dc is a Lab
// overlay, not its own tab. optics_cavity / spice / em_fem were deleted
// from the enum entirely on 2026-06-10 (so they can't appear here).
const NOT_TOP_LEVEL: SimulationModule[] = ["optics_fdtd", "magnetics_dc"];

describe("modules/_registry", () => {
  it("registers a top-level def for every shown module", () => {
    const registered = new Set(MODULES.map((m) => m.id));
    for (const id of TOP_LEVEL_MODULES) {
      expect(registered.has(id), `missing top-level module def for "${id}"`).toBe(true);
    }
  });

  it("does not register removed / nested modules as top-level tabs", () => {
    const registered = new Set(MODULES.map((m) => m.id));
    for (const id of NOT_TOP_LEVEL) {
      expect(
        registered.has(id),
        `"${id}" should not be a top-level tab`,
      ).toBe(false);
    }
  });

  it("Lab is the integrated 3D workspace and ships as available (Phase A)", () => {
    expect(getModule("optics_seq").displayName).toBe("Lab");
    expect(getModule("optics_seq").status).toBe("available");
    expect(getModule("optics_seq").phase).toBe("A");
  });

  it("getModule falls back to Lab for a non-tab id", () => {
    // optics_fdtd / magnetics_dc are valid enum values with no MODULES def,
    // so getModule returns the first def (Lab) rather than throwing.
    expect(getModule("optics_fdtd").displayName).toBe("Lab");
    expect(getModule("magnetics_dc").displayName).toBe("Lab");
  });
});
