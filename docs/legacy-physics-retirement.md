# Legacy Per-Object Physics Retirement Plan

> Status: **planning → execution**. Started 2026-05-30.
> Goal (user rule): **physical parameters live on Asset3D, Component stores none,
> SceneObject stores per-instance coefficients only**. Retire the legacy
> per-object physics path so `Asset3D.default_params` is the single source of
> truth, with no data loss ("只留完整資料的data").

## Background — why this exists

Two parallel optical stacks coexist today:

- **v3 anchor tracer** (`app/optical/*`) — reads physics from
  `Asset3D.default_params`; per-instance overlay from
  `SceneObject.dynamic_sources`. Honors the rule.
  Entry: `POST /api/simulations/optical/run` (`simulations.py:42`, already v3).
- **legacy chain solver** (`app/solvers/optical_solver.py` + `optics_seq.py`
  + `rf_propagation.py`) — reads physics from per-object
  `physics_elements.kind_params`. Violates the rule.
  Entries still live:
  - `POST /api/simulations/optical/transient/run` (`simulations.py:131`) — a
    **stub** (ungated, `factors={obj:1.0}`, empty `object_traces`).
  - `POST /api/simulation-runs` `module="optics_seq"` (the **Lab "Run"** button,
    `SolverConsole.tsx` → `runner.py:59` → `optics_seq.run` → `solve_chain`).
    This one **persists BeamSegments**; v3 `/optical/run` does not.

`Component.properties` carries physics (waveplateKindParamsOverride,
wavelengthCenterNm, isolatorKindParamsOverride, AOM crystal constants, TA / RF
amp specs) **solely** to seed `physics_elements.kind_params` via the bootstrap
`default_kind_params_for_component` (`components.py:495`) +
`auto_create_physics_element_for_object` (`components.py:717`). Nothing reads
that physics for compute except the legacy solver. Frontend
`KindParamsEditor` + adjust panels still edit `kind_params` (live consumer).

## Data-completeness check (per "keep complete data")

- v3 components (waveplate / laser / isolator): asset `default_params` already
  holds the **complete** physics — verified identical to the Component copies.
  Stripping the Component duplicates loses nothing.
- legacy `seed.py` components — **refined after checking the catalog**:
  - `toptica_boosta_pro` → v3 asset `tapered_amplifier/toptica_boosta_pro.json`
    **already has complete `default_params`** (gainLinear, saturationPowerMw,
    centerWavelengthNm…). Component copy is a safe duplicate.
  - AOM → v3 asset `aom/aa_mt80_a1_5_ir.json` **already complete**
    (acousticVelocityMps, refractiveIndex, figureOfMeritM2, baseEfficiency…).
    Safe duplicate.
  - **Genuine gap (no v3 asset / no complete home):** RF amps `ZHL-42W+` &
    `ZHL-1-2W+`, and the bare TA chip `toptica_ta_0690_0500_2`. These are the
    only parts that need new v3 assets authored before their physics can be
    stripped without loss. ← Phase 3 scope is now just these.

## Phases (ordered; verify against the running stack between phases)

### Phase 1 — Retire legacy solvers + re-point endpoints — ✅ DONE (2026-05-30)

**Landed:**
- `optics_seq.run` rewritten to drive the v3 anchor tracer (no `solve_chain`,
  no BeamSegment writes). The Lab "Run" now reports v3 segment counts.
- `POST /optical/transient/run` re-pointed to v3 (`simulations.py`); dropped the
  legacy `solve_chain` loop + BeamSegment persistence. `persistSegments` is now a
  no-op (warns).
- Deleted `app/solvers/optical_solver.py`, `app/solvers/rf_propagation.py`.
- Deleted tests `test_optical_solver.py`, `test_rf_propagation.py`,
  `test_optical_envelope.py`; trimmed the 3 legacy `hydrate_aom_rf_drive` cases
  from `test_v2_phase7_aom.py`.
- **⚠ Removed with `optical_solver.py`:** the pulse-envelope / dispersive
  propagation math (`PulseEnvelopeArrays`, `propagate_envelope` GVD/TOD split-step,
  `q_at_z`, `cw_envelope_from_polarization`, `Beam`). No live consumer remained
  (only the legacy solve_chain + its test used it). **Recoverable from git** if v3
  later wants time-domain pulse propagation.

**Verified live (all return 8 segments, 0 errors):** `/optical/run`,
`/optical/transient/run` (was 0 segs + 7 spurious warnings → now 8),
`/simulation-runs` optics_seq (completed, segmentCount 8), `/v3/solver/run-from-db`
(frontend beam source). Test suite collects clean (504); only 2 pre-existing,
unrelated `test_kinds_manifest` failures (expects 30 kinds, 28 exist).

#### Original plan
- Rewrite `optics_seq.run` to drive the **v3 anchor tracer** while preserving the
  `SimulationRun` contract and BeamSegment persistence the Lab UI expects
  (v3 currently defers segment persistence — must add a segment mapping or the
  Lab beam list regresses). **Needs app verification: Lab beams still render.**
- Re-point `POST /optical/transient/run` to v3 (it is a stub; keep response shape).
- Delete `app/solvers/optical_solver.py`, `app/solvers/rf_propagation.py`;
  reduce `optics_seq.py` to the v3 adapter (drop `hydrate_*` if unused).
- Delete dead tests: `test_optical_solver.py`, `test_rf_propagation.py`,
  `test_kind_params_partition.py` (pins dead `partition_kind_params`).
- Verify: Lab Run + transient Run still work end-to-end.

### Phase 2 — Strip v3-component physics — ✅ DONE (2026-05-30)

**Landed:**
- Removed `wavelengthCenterNm` + `notes.waveplateKindParamsOverride` from the
  waveplate / laser / isolator component catalog JSONs (asset `default_params`
  holds the authoritative copies).
- `seed_v3_assets.py` no longer copies `wavelengthCenterNm` /
  `waveplateKindParamsOverride` into `Component.properties` (keeps `sourceUrl`,
  `clearApertureMm` geometry).
- Migration `0094_strip_component_physics` scrubbed those keys from existing
  rows → **0 components carry physics keys**.

**Verified:** JSON valid, seed compiles, migration applied (0093→0094), v3 beam
still 8 segments / 0 errors on `/optical/run` + `/v3/solver/run-from-db`.

Note: until Phase 5, a *newly-created* waveplate's legacy kind-params editor
shows generic defaults (bootstrap no longer finds the override); the v3 beam
stays correct (reads the asset).

#### Original plan
- Catalog JSON: remove `wavelengthCenterNm` + `notes.waveplateKindParamsOverride`
  from `assets/catalog/components/{waveplate,laser_source,isolator}/*.json`.
- `seed_v3_assets.py:128-136`: stop copying `wavelengthCenterNm` /
  `waveplateKindParamsOverride` into `Component.properties`.
- Alembic migration: scrub those keys from existing `components.properties` rows.

### Phase 3/4 (component data) — ✅ DONE (2026-05-30)

Discovery: the only remaining physics-on-Component was **4 legacy dev-DB rows**
(`catalog_id IS NULL`, not in the v3 catalog): BoosTA pro, MT80-A1.5-IR AOM ×2,
ZHL-1-2W+. **No new assets needed** — each bound Asset3D already held the
authoritative physics (ZHL rf_amp asset has full gainDb/noiseFigureDb/freqRange;
MT80 has acousticVelocityMps; BoosTA has its v3 gain model).

Migration `0095_legacy_component_physics`:
- Step 1: migrate AOM per-instance operating state
  (`braggTiltAngleDegBodyLocal`, `diffractionOrder`, `acousticAxisBodyLocal`) →
  `SceneObject.dynamic_sources` (its correct home per the rule).
- Step 2: strip all 27 physics keys from `components.properties` (kept geometry /
  catalog metadata + `physics_capabilities`).

**Verified:** **0 components carry any physics key**; v3 beam unchanged (8 segs).
The migrated Bragg-tilt state lived on an *orphan* MT80 row (no SceneObject); the
live AOM object was already physics-free, so nothing was lost and the beam is
unaffected. Frontend reads none of these keys.

**✅ The user's rule is now satisfied in data:** Asset3D holds physics, Component
holds none, SceneObject holds per-instance coefficients.

Remaining is legacy *machinery* (not data ownership): seed.py blocks, the
PhysicsElement bootstrap, the frontend kind-params editor, and the
`physics_elements` physics columns.

#### Original Phase 3 plan
- New Asset3D catalog JSON (with `default_params`) + Component JSON for:
  TA chip, BoosTA pro, ZHL-42W+, ZHL-1-2W+, and the AOM if not already v3.
- Move the physics now in `seed.py` `Component.properties` →
  asset `default_params`. Keep geometry/aperture (`clearApertureMm`, dims) where
  the frontend mesh code reads it (e.g. `aaoptoelectronic_mt80.ts:20`).

### Phase 4 — Remove the bootstrap + strip remaining Component physics
- Delete `DEFAULT_KIND_PARAMS`, `default_kind_params_for_component`,
  and the `kind_params` population in `auto_create_physics_element_for_object`
  (`components.py:144-822`).
- Strip physics from `seed.py` component blocks; remove `*KindParamsOverride`
  builders.
- Alembic migration: scrub physics keys from all `components.properties`.

### Phase 5 — Frontend editor migration
- Migrate `KindParamsEditor` + non-V2 adjust panels (lens, dichroic, fiber, eom,
  nonlinear_crystal) from editing `physics_elements.kind_params` to editing
  `Asset3D.default_params` (the `Asset3DV3Editor` pattern). V2 kinds already
  round-trip through SceneObject bindings (`physics_elements.py:256-381`).

### Phase 6 — Drop physics columns (last)
- Alembic migration dropping `kind_params` / `intrinsic_params` / `state_params`
  from `physics_elements` (created 0007/0014/0049); update `models/physics.py`.
- Keep the `physics_elements` **table** — it still holds PPG `timingProgramId`
  and optical-chain participation/topology (non-physics).

## Safe-to-delete vs. live-consumer (from full mapping)

SAFE once Phase 1 lands: `optical_solver.py`, `rf_propagation.py`, the
`optics_seq` hydrators, `partition_kind_params`, the three legacy solver tests.

LIVE consumers needing migration first: frontend `KindParamsEditor` /
non-V2 adjust panels; the Lab Run + transient endpoints (re-point, don't just
delete); `physics_elements.py` CRUD (kept for the bindings UI + PPG/topology).
