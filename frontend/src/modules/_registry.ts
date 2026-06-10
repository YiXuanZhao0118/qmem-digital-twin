/**
 * Module registry — Phase A of the multiphysics platform.
 *
 * Drives the top-bar ModuleSwitcher: which tabs to show and what they're
 * called.
 *
 * The ``id`` field matches the backend ``SimulationModule`` enum
 * (``app.schemas.SimulationModule``) so the same value can be passed
 * directly to ``POST /api/simulation-runs``.
 *
 * As of 2026-06-10 the only top-level tab is the integrated Lab
 * (``optics_seq``). See docs/MULTIPHYSICS_PLAN.md.
 */
import type { SimulationModule } from "../types/digitalTwin";

export type ModuleStatus = "available" | "coming_soon";

export type ModuleDef = {
  /** Backend module enum value AND the React key. */
  id: SimulationModule;
  /** Top-bar label. */
  displayName: string;
  /** One-line description shown on the placeholder card. */
  description: string;
  /** "available" = workspace renders. "coming_soon" = ModulePlaceholder
   *  is shown instead with the phase tag. */
  status: ModuleStatus;
  /** Which plan phase delivers this module (rendered on placeholder). */
  phase: "A" | "B" | "C" | "D";
  /** Short tag rendered next to the module name. */
  phaseLabel: string;
};

export const MODULES: ModuleDef[] = [
  {
    id: "optics_seq",
    displayName: "Lab",
    description:
      "Integrated 3D lab workspace — every device, beam path, fiber route, magnetics overlay, and PulseBlaster channel binding lives here. Other modules surface their inputs/results back into this scene via Linked Schematics.",
    status: "available",
    phase: "A",
    phaseLabel: "Integrated",
  },
  // Optics (optics_cavity), Electronics (spice), and EM (em_fem) were removed
  // on 2026-06-10 — frontend tabs/workspaces, backend solvers/routers, the
  // SimulationModule enum values, and the circuits table are all gone.
];

/** Lookup helper. Falls back to the first module if id isn't found. */
export function getModule(id: SimulationModule): ModuleDef {
  return MODULES.find((m) => m.id === id) ?? MODULES[0];
}
