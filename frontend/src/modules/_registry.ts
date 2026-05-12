/**
 * Module registry — Phase A of the multiphysics platform.
 *
 * Drives the top-bar ModuleSwitcher: which tabs to show, what they're
 * called, whether they're enabled in this build, and what to render as
 * placeholder for the not-yet-implemented ones.
 *
 * The ``id`` field matches the backend ``SimulationModule`` enum
 * (``app.schemas.SimulationModule``) so the same value can be passed
 * directly to ``POST /api/simulation-runs``. Phase B/D may add sub-tools
 * within a single tab (e.g. Optics → sequential / FDTD), which would
 * live as sub-tabs inside ``OpticsWorkspace`` rather than new top-level
 * modules.
 *
 * See docs/MULTIPHYSICS_PLAN.md.
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
  {
    id: "optics_cavity",
    displayName: "Optics",
    description:
      "Pure optical-cavity simulator: linear / ring Fabry-Perot, FSR + Finesse + linewidth, Airy transmission spectrum, and stability g-parameter. Build a cavity from mirror reflectivities and a length, or pull mirrors from the Lab scene.",
    status: "available",
    phase: "A",
    phaseLabel: "Optics calc",
  },
  {
    id: "spice",
    displayName: "Electronics",
    description:
      "ngspice-backed circuit simulation. Write a SPICE netlist (Phase B) or build it visually (Phase E), then look at transient / AC / DC sweep waveforms.",
    status: "available",
    phase: "B",
    phaseLabel: "Phase B",
  },
  {
    id: "em_fem",
    displayName: "EM",
    description:
      "palace FEM solver for RF / microwave structures (antenna, waveguide, cavity). Mesh from STEP/STL via Gmsh; runs on the lab workstation over SSH.",
    status: "available",
    phase: "C",
    phaseLabel: "Phase C",
  },
];

/** Lookup helper. Falls back to the first module if id isn't found. */
export function getModule(id: SimulationModule): ModuleDef {
  return MODULES.find((m) => m.id === id) ?? MODULES[0];
}
