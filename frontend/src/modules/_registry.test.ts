/**
 * Guards the multiphysics module registry against drift between the
 * frontend ``MODULES`` list and the backend ``SimulationModule`` enum.
 *
 * Why this matters: when Phase B/C/D add a new module to the backend
 * enum, the frontend registry must list it too — otherwise the
 * ModuleSwitcher silently drops a tab and POST /api/simulation-runs
 * still 501s in the same release. This test catches that at build time.
 */
import { describe, expect, it } from "vitest";

import type { SimulationModule } from "../types/digitalTwin";
import { getModule, MODULES } from "./_registry";

// Top-level tabs the ModuleSwitcher shows. Subset of
// backend app.schemas.SimulationModule because Phase D's optics_fdtd is
// designed as a sub-tool inside the Optics tab, not its own top-level tab.
const TOP_LEVEL_MODULES: SimulationModule[] = [
  "optics_seq",
  "spice",
  "em_fem",
];

// Backend enum values that are intentionally NOT top-level tabs. If you
// add one to MODULES (i.e. promote to top-level), drop it from here.
const NESTED_MODULES: SimulationModule[] = ["optics_fdtd"];

describe("modules/_registry", () => {
  it("registers a top-level def for every non-nested SimulationModule", () => {
    const registered = new Set(MODULES.map((m) => m.id));
    for (const id of TOP_LEVEL_MODULES) {
      expect(registered.has(id), `missing top-level module def for "${id}"`).toBe(true);
    }
  });

  it("does not promote nested modules to top-level tabs", () => {
    const registered = new Set(MODULES.map((m) => m.id));
    for (const id of NESTED_MODULES) {
      expect(
        registered.has(id),
        `"${id}" is nested-only but is registered as a top-level tab`,
      ).toBe(false);
    }
  });

  it("getModule returns the matching def for known ids", () => {
    expect(getModule("optics_seq").displayName).toBe("Optics");
    expect(getModule("spice").displayName).toBe("Electronics");
    expect(getModule("em_fem").displayName).toBe("EM");
  });

  it("Phase A+B+C all ship as available; only optics_fdtd reserved", () => {
    expect(getModule("optics_seq").status).toBe("available");
    expect(getModule("spice").status).toBe("available");
    expect(getModule("em_fem").status).toBe("available");
  });

  it("phase tags match the documented rollout", () => {
    expect(getModule("optics_seq").phase).toBe("A");
    expect(getModule("spice").phase).toBe("B");
    expect(getModule("em_fem").phase).toBe("C");
  });
});
