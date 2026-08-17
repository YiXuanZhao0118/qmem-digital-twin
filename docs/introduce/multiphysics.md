[← Doc index](README.md)

# The multiphysics module system

> Time-domain evolution is in [timing.md](timing.md); optics module details in [optics.md](optics.md).

**Modules** are the switchable top-level workspaces (frontend `modules/<name>/`, registered in `modules/_registry.ts`, switched by `ModuleSwitcher.tsx`; the Run button inside each module's workspace runs its solver).

**The Lab tab doubles as the Scene menu (2026-08-14)**: a tab with `status: "available"` gets an extra caret; clicking it opens `.module-tab-menu` (reusing the `.window-menu` styling, from `ModuleSwitcher.tsx:70`), which holds what used to be `SceneToolbar`'s "Scene" group — Initial Setup / PHY Editor. SceneToolbar is left with only its View and Status groups. **Follow-up on 2026-08-14**: "Add text annotation" moved back out of that menu into SceneToolbar's View group, as an `.icon-button` matching Display overlays (`lucide-react` `Type`, `size=17`), sitting to the **left** of the Display-overlays eye button (from `SceneToolbar.tsx:168`). Initial Setup's open state moved into the store (`sceneStore.initialSetupOpen` + `setInitialSetupOpen`) because the trigger lives in ModuleSwitcher while the panel is still drawn by `SceneToolbar`. Invariant: that panel must portal to `<body>` (`position: fixed`, with `top` set inline from the measured bottom edge of `.top-bar`) — `.top-bar-toolbar` is `overflow: hidden`, so an absolutely positioned popover left inside the toolbar gets clipped (`DisplayPopover` portals for the same reason).

**Currently (after 2026-06-10) Lab is the only top-level tab**:

| Module | Contents | Backend solver | Library |
|---|---|---|---|
| **Lab** (the only tab) | The main 3D optics lab (default) | `optics_seq` → v3 anchor tracer | — |
| Magnetics (**an overlay panel inside Lab**, not its own tab) | DC coils / magnetic field | `magnetics_dc` | magpylib v5 Biot-Savart (Helmholtz verified) |

> ⚠️ **Removed modules (2026-06-10, deleted outright)**: the three tabs **Optics** (`optics_cavity` cavities + `optics_crystal` nonlinear crystals), **Electronics** (`spice` circuits/SPICE) and **EM** (`em_fem` electromagnetics/antennas) were removed wholesale — the frontend `modules/{optics_cavity,electronics,em}/` folders were deleted, the corresponding imports and branches in `_registry.ts` / `App.tsx` were deleted, the backend solvers (`optics_cavity` / `optics_crystal` / `spice` / `em_fem`) and routers (`/api/optics-cavity`, `/api/optics-crystal`, `/api/circuits`) were deleted, the `SimulationModule` enum is down to `optics_seq` / `optics_fdtd` / `magnetics_dc`, and the `circuits` table plus `rf_chain_nodes.linked_circuit_id` were dropped by **migration 0109** (which also purged the leftover `simulation_runs` rows). **Kept**: the `em_problems` / `meshes` / `touchstone` tables and routes, and the `SshWorkstationRunner` infrastructure (no module uses it today).

**Design principle**: don't rebuild the shell — extend the existing SceneObject tree plus per-module sidecar tables.

**The SolverRunner abstraction** (`solvers/runner.py` Protocol: submit/cancel/status): `InProcessRunner` (optics, millisecond scale), `ContainerRunner` (ngspice/MEEP subprocesses), `SshWorkstationRunner` (palace running on the lab workstation over SSH). `simulation_runs.runner_kind` records which one dispatched the run.

**Sidecar tables (additive)**: `simulation_runs` (0036), ~~`circuits` (0037)~~ (dropped in 0109), `em_problems` + `meshes` (0038), `coils` + `magnetics_problems` (0039).

**The EM workstation (Phase C, removed together with the EM tab on 2026-06-10; kept here as history)**: 13700K + 128 GB + RTX 4070 Ti, Windows + WSL2 + Docker Desktop; palace ran from the `awslabs/palace` image; the flow was SSH → SCP mesh + config.json → `docker run palace` → SCP back `port-S.csv` → `palace_io.parse_palace_sparams`. The env vars `WORKSTATION_HOST` / `WORKSTATION_KEY_PATH` / `WORKSTATION_PALACE_IMAGE` and `SshWorkstationRunner` are still in the code but no module uses them.
