# QMsimulation / qmem-digital-twin — doc index

> This directory is the project's documentation. What used to be a single "complete walkthrough" (`docs/README.md`) was split by topic into the per-concept files below on **2026-06-10**; this file is now the **index and guide**.
>
> **These md files are also displayed inside the app**: the Architecture half of the Help modal (top bar, right, **?**) renders these very files verbatim — not a hand-copied duplicate — so editing them here *is* editing the in-app help. The mechanism is described in ["The app's built-in Help" in overview.md](overview.md).
> (The repo root also has a larger English `README.md`, but parts of it are stale — for architecture and concepts this directory wins. Per-file cleanup suggestions are in `CLEANUP_AUDIT.md` at the root.)

---

## Guide to the docs

### Start here
- [System overview · overview.md](overview.md) — what this is, the three service tiers, the directory structure

### The core data model (the system's spine)
- [Data model · data-model.md](data-model.md) — the four layers, the param-ownership rule, the merge order
- [Asset3D · asset.md](asset.md) — the geometry + physics ground-truth layer
- [BUILD · build.md](build.md) — in-browser CAD→GLB, producing an Asset3D (Geometry Builder)
- [Component / ComponentBinding · component.md](component.md) — catalog template + binding tree
- [SceneObject · object.md](object.md) — the scene-instance layer
- [Frames & anchors · anchors.md](anchors.md) — the three frames, the transform chain, the anchor optical interface (direction + aperture)

### Rendering and optics
- [Render pipeline · rendering.md](rendering.md) — how the frontend builds the scene
- [Kind taxonomy · kinds.md](kinds.md) — 31 kinds + domain/category + the contract of each kind
- [Optical physics model · optics.md](optics.md) — polarization, the solver, the RF tracer, the TA
- [Fiber · fiber.md](fiber.md) — optical fibre: single object + spline, endpoint alignment, coupling physics

### Multiphysics and time
- [Multiphysics modules · multiphysics.md](multiphysics.md) — only the Lab tab + the Magnetics overlay remain (Optics/Electronics/EM were removed)
- [Time-domain simulation · timing.md](timing.md) — Sequence, scrub time, AD9959, the RF chain
- [RF subsystem overview · rf.md](rf.md) — the panoramic RF index: kinds/devices/panels/propagation BFS/cable, with current state and blind spots
- [RF cable · cable.md](cable.md) — coax: single object + spline, endpoint linking, RF graph propagation
- [Placement & snapping · placement.md](placement.md) — the placement and snapping engine

### Ops and reference
- [Main API endpoints · api.md](api.md)
- [Startup & development runbook · runbook.md](runbook.md)
- [The Alembic migration chain · migrations.md](migrations.md)
- [Known stale / outstanding items · known-issues.md](known-issues.md)
- [Outstanding work · todo.md](todo.md) — the optics backlog: what is deliberately not done yet, each with a definition of done

### Standing topic papers (one level up, in `docs/`)
- [Quantified objectives · ../objectives.md](../objectives.md) — the acceptance thresholds for FPS / resolution / optical accuracy / latency / LOD / API and how CI gates them (**targets**, not the current state)
- [Measured benchmark dataset · ../bench-dataset.md](../bench-dataset.md) — the measurement protocol behind O-4/F-2's "within <5% of measurement" and the list of 12 cases (0 measured values so far)
- [float64 end-to-end audit · ../float64-audit.md](../float64-audit.md) — the anchor-pose precision audit (2026-08-17): the machine path is clean, the breach is the PHY Editor's authoring UI + the triangulation limit of face-picking
- [AOM model · ../aom-model.md](../aom-model.md) + `../aom_align_*.png` / `../aom_align_*.py` (the AOM alignment plotting scripts and figures)
- [Sacher TEC400 852 nm TA output mode · ../sacher-tec400-852nm-ta-output-mode.md](../sacher-tec400-852nm-ta-output-mode.md) + `../ta_out_wfs_cyl.py` / `../ta_out_m2.py` — the WFS wavefront data behind `outputSpatialModeX/Y`, and why `mSquared` stays 1.0 (pinned, not measured — one plane gives `w` and `R` per axis, two numbers for `GaussianMode`'s three). The stored pair is the **2026-08-22 re-fit** from the 2026-08-21 cylindrical-lens capture, verified against the solver; run `../ta_out_wfs_cyl.py` to reproduce it. `../ta_out_m2.py` reproduces the superseded 2026-08-19/20 analysis, including the inferred 3.5 mm pupil that capture falsified
- [Object Sense kinds · ../object-sense-kinds.md](../object-sense-kinds.md)

---

## Appendix: what these docs were consolidated from

The content above was consolidated from the following original `docs/` files (removed after the 2026-06-01 consolidation):
**Architecture** — `ARCHITECTURE_OVERVIEW.md`, `vibe coding.md`, `frame-anchor-architecture.md`;
**Optics/physics** — `optical-schema-v2.md`, `optical-kinds-spec.md`, `asset-physics-model.md`, `asset-physics-implementation.md`, `asset-params-inventory.md`, `legacy-physics-retirement.md`, `tapered-amplifier-model.md`, `phase-3b-review.md`;
**Multiphysics/timing/placement** — `MULTIPHYSICS_PLAN.md`, `MULTIPHYSICS_PROGRESS.md`, `PHYSICS_TIME_DESIGN.md`, `PHYSICS_TIME_CHECKPOINT.md`, `PLACEMENT_DESIGN.md`, `PLACEMENT_PROGRESS.md`, `AD9959_TIMING_INTEGRATION.md`, `PHASE_C_WORKSTATION_SETUP.md`.

`docs/aom_align_*.png` and `aom_align_*.py` (the scripts and figures for the AOM alignment plots) are kept.

> How to resolve version conflicts between docs: when older documents contradict each other, the newest wins — `frame-anchor-architecture.md` (0093) > `ARCHITECTURE_OVERVIEW.md` (0043) > `vibe coding.md` (~0020); v3 supersedes v2; `PhysicsElement` supersedes the old `OpticalElement`; `ComponentBinding` is the shipped implementation of the planned `anchorBindings`.
