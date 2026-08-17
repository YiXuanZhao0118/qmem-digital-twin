[← Doc index](README.md)

# System overview

> Related: [data model](data-model.md), [coordinate frames & anchors](anchors.md), [startup runbook](runbook.md)

## What this is

**QMsimulation** (also known as qmem-digital-twin) is a **digital twin of a quantum-memory / cold-atom optics lab**. It models a real quantum-optics table (laser → tapered amplifier → waveplates → PBS → AOM → quantum-memory cell, plus the RF electronics and timing control) as an interactive, physically accurate 3D twin, with beam tracing, polarization simulation and multiphysics simulation.

In the browser you can place and align optical components, wire up optical and RF chains, schedule pulses along a timeline, and watch live how the beam propagates and is acted on by each component. The long-term goal is an Ansys-Workbench-like "integrated multiphysics platform" (optics + electronics + electromagnetics + magnetics + timing) built entirely from open-source solvers, for in-house lab use.

---

## System architecture (three service tiers)

| Tier | Technology | Port | Role |
|---|---|---|---|
| Frontend | React 18 + TypeScript + Vite 6 + three.js 0.170 + zustand + axios | **5173** | 3D viewport, editing UI, per-module workspaces |
| Backend | FastAPI + SQLAlchemy 2.x async + Pydantic v2 + numpy/scipy | **8010** | REST API + WebSocket, optical / multiphysics solvers, persistence |
| Database | PostgreSQL 16 (an isolated local instance under `.local-postgres/`) | **55432** | Persistence for scenes / assets / components / simulation results |

**How they connect:**
- The frontend hard-codes the backend at `http://localhost:8010` (`frontend/src/api/client.ts`, overridable with `VITE_API_BASE_URL`) and calls it **directly, not through the Vite proxy**.
- WebSocket: `ws://localhost:8010/ws/scene` (server → client pushes `component.*` / `object.*` / `simulation_run.*` events; the client only sends `ping`).
- The backend's CORS allowlist is `localhost:5173` and `localhost:3000` (`backend/app/config.py`).
- DB connection string: `postgresql+asyncpg://qmem:qmem_password@localhost:55432/qmem_twin`.
- Asset files: the frontend's `resolveAssetUrl()` builds `http://localhost:8010/assets/files/...`, which the backend serves statically from `assets/`.

> ⚠️ **Corrections to commonly stale information:**
> - The backend port is **8010** (some old docs and the root README say 8000 — that's the docker-mode default; local development uses 8010).
> - `docker-compose.yml` says Postgres **5432**; this project actually uses local **55432** via `scripts/start-local-postgres.ps1`, and Docker isn't installed in this environment. 5432 vs 55432 is the single most common source of confusion.

---

## The app's built-in Help

The **?** at the right of the top bar (`components/help/HelpButton.tsx`) opens a full-screen Help modal (`components/help/HelpModal.tsx`); it is present in both the Lab and the PHY Editor top bars. It has two halves:

| Half | Source | Nature |
|---|---|---|
| **User guide** | `components/help/usageGuide.ts` (hand-written) | How to *operate* the app: the three workspaces, placement/snapping, panels, keyboard shortcuts; takeaways marked with `> **Key —** …` callouts |
| **Architecture** | `docs/introduce/*.md` + `docs/*.md` (verbatim) | What the system *is*: exactly this doc set |

**Invariant: the architecture half must never be hand-copied.** `components/help/helpDocs.ts` uses `import.meta.glob(..., { query: "?raw", eager: true })` to bundle the raw md files into the frontend at build time, so the in-app docs always equal the repo's docs. Consequences:

- Those md files live **outside** the Vite root (`frontend/`), so the dev server needs `server.fs.allow: [".."]` (`frontend/vite.config.ts`) to read them; removing it makes the architecture half of the Help modal 403.
- Grouping and order live in `GROUP_ORDER` in `helpDocs.ts`, mirroring this directory's `README.md`. **Adding an md file requires no code change** — a file not listed in `GROUP_ORDER` lands in the "More" group rather than being silently dropped.
- Relative links inside the docs (`[anchors.md](anchors.md)`) navigate within the modal instead of leaving the app; links to unbundled targets (source paths and so on) degrade to a greyed-out path rather than a dead link.

Rendering uses `react-markdown` + `remark-gfm` (tables); the styling is the `.help-modal*` / `.help-doc*` section of `styles.css`.

---

## Directory structure

```
qmem-digital-twin/
├── frontend/src/
│   ├── components/   # React UI: DigitalTwinViewer (the main scene, ~6000 lines), the panels, the editors
│   │   └── physics/  # per-kind *AdjustControls (Laser/Aom/TaperedAmplifier/Simple)
│   ├── three/        # three.js scene, loadAsset, rayTrace, v3TraceAdapter, beam, placement/
│   ├── kinds/        # per-kind plugin renderers + registries (_plugins.ts, _renderer_bindings.ts)
│   ├── optical/      # TS optics: jones, frames, pose, fiber/, the WIP v3 tracing island (see optics.md)
│   ├── store/        # zustand: sceneStore, kindsStore, (v3)catalogStore
│   ├── utils/        # (v2)bindings, anchorAccess, componentBindings, rfPropagation
│   └── modules/      # the Lab workspace (the only tab) + the Magnetics overlay; the Optics/Electronics/EM tabs were fully removed on 2026-06-10 (folders deleted)
├── backend/
│   ├── app/
│   │   ├── main.py       # FastAPI entry point, ~40 routers mounted under /api/<resource>
│   │   ├── routers/      # one REST router per resource
│   │   ├── models/       # SQLAlchemy ORM (scene, hardware, timing, …)
│   │   ├── optical/      # ★the authoritative optical engine: anchor_tracer (live, anchor-based) + solver (solve_anchor_scene) + anchor_ops/<kind>; rf_resolve (RF graph propagation); the face-based ray_tracer/solver_v3 is legacy (retired after 0106); db_scene_loader, jones, abcd
│   │   ├── solvers/      # multiphysics: optics_seq, magnetics_dc, runner (the Optics/Electronics/EM solvers were removed on 2026-06-10)
│   │   ├── services/     # touchstone, … (onshape_client / instrument_polling are dead code)
│   │   └── schemas*.py   # Pydantic (CamelModel: DB snake_case ↔ API camelCase)
│   ├── alembic/versions/ # migrations 0001..0109 (a linear chain, head 0109)
│   └── data/             # kinds.json (★the authoritative source of per-kind physics parameters), thorlabs_cad_manifest.json
├── assets/
│   ├── catalog/          # component/asset/kind JSON definitions (the seed source; the DB is the runtime truth)
│   └── files/            # stl, glb, cad_sources (CAD binaries never go into the DB)
└── docs/                 # this doc set + aom_align_*.{png,py} (the AOM alignment plotting scripts)
```
