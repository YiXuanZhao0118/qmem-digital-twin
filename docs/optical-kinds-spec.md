# Optical Kinds — Parameter & UI Spec

> Status: **Plan only — no code changes yet.** Captured 2026-05-17 from ycchenlab requirements gathering.

## 1. Scope & vocabulary

- **Emitter (optical)** = `laser_source`, `tapered_amplifier`
- **Passive (optical)** = every other optical kind: `mirror`, `dichroic_mirror`, `lens_biconvex`, `lens_plano_convex`, `lens_cylindrical`, `waveplate`, `polarizer`, `beam_splitter`, `fiber_coupler`, `fiber`, `fiber_end`, `isolator`, `aom`, `eom`, `nonlinear_crystal`, `saturable_absorber`, `detector`, `camera`, `spectrometer`, `wavemeter`, `beam_dump`
  - This redefines "Passive" to **everything non-Emitter** (broader than the existing `catalog_group="Passive"` filter, which only covers 12 kinds).

## 2. Requirements

### R1 — Aperture coverage
Every Passive kind **must** declare an aperture, **except `fiber`**.
- `fiber` itself is a wrapper; its apertures live on the paired `fiber_end` siblings.
- Aperture is per-anchor (stored under `needs_aperture: [<anchorId>, …]`).

### R2 — Wavelength fields
- Every Emitter must carry `centerWavelengthNm: number` (nm).
- Every Passive must carry `wavelengthRangeNm: [minNm, maxNm]` (inclusive nm range).

### R3 — PHY Editor authority
The **PHY Editor → Optical → Components** tab is the **only** place to edit:
- Fast / slow axis directions (e.g. `fastAxisDegBeamLocal`, `slowAxisDegInBodyFrame`, `coatingNormalBodyLocal`, `transmissionAxisDegBeamLocal`)
- Aperture geometry — **shape limited to `rectangle` or `ellipse`** (circle deprecated UX-wise but type kept for back-compat per decision 2026-05-17)

### R4 — Objects panel authority
Every other parameter must be editable in the objects-panel optical card (`<section class="physics-panel physics-panel-optical">`). Fast/slow axis fields are **hidden** here (R3 owns them).

## 3. Current state (audit, 2026-05-17)

Source of truth: [`backend/data/kinds.json`](../backend/data/kinds.json).

### 3.1 Aperture (`needs_aperture`)

| Kind | Currently has aperture? | R1 says |
|---|---|---|
| laser_source | — | Emitter, N/A |
| tapered_amplifier | — | Emitter, N/A |
| mirror | ❌ | needs add |
| dichroic_mirror | ❌ | needs add |
| lens_biconvex | ❌ | needs add |
| lens_plano_convex | ❌ | needs add |
| lens_cylindrical | ❌ | needs add |
| waveplate | ❌ | needs add |
| polarizer | ❌ | needs add |
| beam_splitter | ❌ | needs add |
| fiber_coupler | ❌ | needs add |
| fiber | ✅ both ends | keep (but R1 excludes fiber) |
| fiber_end | ✅ tip | keep |
| isolator | ❌ | needs add |
| aom | ✅ in+out | keep |
| eom | ❌ | needs add |
| nonlinear_crystal | ❌ | needs add |
| saturable_absorber | ❌ | needs add |
| detector | ❌ | needs add |
| camera | ❌ | needs add |
| spectrometer | ❌ | needs add |
| wavemeter | ❌ | needs add |
| beam_dump | ❌ | needs add |

**Net change**: add `needs_aperture` to **17 kinds** (every Passive except `fiber`, `fiber_end`, `aom`).

### 3.2 Wavelength fields

| Kind | Current field | R2 target |
|---|---|---|
| laser_source | `centerWavelengthNm: 780.241` ✅ | keep |
| tapered_amplifier | (none) ❌ | add `centerWavelengthNm` |
| mirror | (none) | add `wavelengthRangeNm` |
| dichroic_mirror | `cutoffWavelengthNm: 700` only | add `wavelengthRangeNm` (cutoff stays) |
| lens_biconvex / lens_plano_convex / lens_cylindrical | (none) | add `wavelengthRangeNm` |
| waveplate | (none) | add `wavelengthRangeNm` |
| polarizer | (none) | add `wavelengthRangeNm` |
| beam_splitter | (none) | add `wavelengthRangeNm` |
| fiber_coupler | (none) | add `wavelengthRangeNm` |
| fiber | `operatingWavelengthRangeNm: [770, 790]` | **rename** to `wavelengthRangeNm` |
| fiber_end | (none) | add `wavelengthRangeNm` |
| isolator | (none) | add `wavelengthRangeNm` |
| aom | (none) | add `wavelengthRangeNm` |
| eom | (none) | add `wavelengthRangeNm` |
| nonlinear_crystal | (none) | add `wavelengthRangeNm` |
| saturable_absorber | (none) | add `wavelengthRangeNm` |
| detector | (none) | add `wavelengthRangeNm` |
| camera | (none) | add `wavelengthRangeNm` |
| spectrometer | `wavelengthRangeNm: [400, 1100]` ✅ | keep |
| wavemeter | (none) | add `wavelengthRangeNm` |
| beam_dump | (none) | add `wavelengthRangeNm` |

**Naming decision**: use `wavelengthRangeNm` (spectrometer convention), `fiber` renames its existing field.

**Net change**: TA adds `centerWavelengthNm`; **18 Passive kinds** add `wavelengthRangeNm`; `fiber` renames; `spectrometer` already conformant.

### 3.3 Aperture shape

- Type union already supports all three shapes (`V2ApertureCircle | V2ApertureEllipse | V2ApertureRectangle`) in [`frontend/src/types/digitalTwin.ts:1138-1141`](../frontend/src/types/digitalTwin.ts).
- UI currently hard-codes `shape: "circle"` when writing aperture (see [`_shared.tsx:294`](../frontend/src/components/physics/_shared.tsx)). No shape picker exists.
- Per 2026-05-17 decision: **keep all three** in the type system; the PHY Editor UI exposes only rectangle + ellipse going forward, but loads/displays legacy `circle` apertures without forcing conversion.

### 3.4 PHY Editor

- Frame exists ([`frontend/src/components/PhyEditor.tsx`](../frontend/src/components/PhyEditor.tsx)) with `Optical → Kinds / Components` rail.
- `ComponentEditor.tsx` is mounted but does **not** currently surface aperture-shape or fast/slow-axis controls.

### 3.5 Objects panel `.physics-panel-optical`

- CSS class is **dynamically generated** by `PhysicsElementPanel.tsx:113` from `physics-panel physics-panel-${domain}` — so the class exists at runtime when `domain === "optical"`.
- No CSS rule actually targets `.physics-panel-optical` in [`styles.css`](../frontend/src/styles.css) (only `.physics-panel` and `.physics-panel-rf`).
- Per-kind `*AdjustControls` modules exist in `frontend/src/components/physics/` (`MirrorAdjustControls`, `WaveplateAdjustControls`, `BeamSplitterControls`, `LensControls`, `LaserSourceControls`, `AomAdjustControls`, `TaperedAmplifierAdjustControls`) but `PhysicsElementPanel` only renders `AlignToBeamSection` — the parameter editors aren't wired in.

## 4. Proposed change list

### A. `backend/data/kinds.json`
1. **Add `needs_aperture`** to 17 kinds (all Passive except `fiber`, `fiber_end`, `aom` which already have it). Each kind picks the anchor(s) the beam interacts with — usually `intercept_in`, sometimes both `intercept_in` and `intercept_out` for transmissive elements.
2. **Add `wavelengthRangeNm: [minNm, maxNm]`** to 18 Passive `default_params`.
3. **Rename** `fiber.default_params.operatingWavelengthRangeNm` → `wavelengthRangeNm`.
4. **Add** `tapered_amplifier.default_params.centerWavelengthNm` (suggested default: 780).
5. **Regenerate** manifest via `scripts/export_kinds_manifest.ts`.

Default aperture seeds (suggested):
- mirror / dichroic_mirror: rectangle 25.4×25.4 mm (1" optic)
- lenses: ellipse / circle, 25.4 mm dia
- waveplate / polarizer: ellipse 25.4 mm
- beam_splitter: rectangle 25.4×25.4 mm
- fiber_coupler: ellipse 5 mm (matches `modeFieldDiameterUm` × N)
- isolator: ellipse 5 mm clear aperture
- eom / nonlinear_crystal / saturable_absorber: rectangle, kind-specific
- detector / camera: rectangle, sensor-size dependent
- spectrometer / wavemeter: ellipse, slit/fiber-input dependent
- beam_dump: ellipse 10 mm

Default `wavelengthRangeNm` seeds: pick broad operating bands — e.g. broadband mirrors `[400, 1100]`, dichroic short-pass / long-pass set around `cutoffWavelengthNm`, fiber `[770, 790]` (kept), spectrometer `[400, 1100]` (kept).

### B. Backend schema + migration
1. `backend/app/schemas.py`: add `wavelengthRangeNm: tuple[float, float]` to optical kind-param models.
2. New alembic migration: backfill `kindParams` on existing rows; rename `fiber.operatingWavelengthRangeNm` → `wavelengthRangeNm` in stored JSON.
3. Update `backend/tests/test_kinds_manifest.py` expected shape.

### C. PHY Editor → Optical → Components
1. `ComponentEditor.tsx`: per-anchor aperture editor with **shape selector** (`rectangle` | `ellipse`; legacy `circle` shown read-only or auto-converted on save).
2. New "Fast/slow axis" sub-section that surfaces every axis-direction field present in the active kind's `intrinsic_param_keys` (waveplate `fastAxisDegBeamLocal`, fiber-end `slowAxisDegInBodyFrame`, beam_splitter `coatingNormalBodyLocal`, polarizer / isolator `transmissionAxisDegBeamLocal`, aom `acousticAxisBodyLocal` + `rfPropagationDirectionBodyLocal`).
3. UI gate: these fields **only** render in PHY Editor; the objects panel hides them.

### D. Objects panel `.physics-panel-optical`
1. `PhysicsElementPanel.tsx`: route the registered element to its kind-specific AdjustControls component (currently imported but unused).
2. AdjustControls modules each: render every editable param **except** the axis fields owned by PHY Editor.
3. `styles.css`: add `.physics-panel-optical` styling (mirror the `.physics-panel-rf` chrome with a green accent).

### E. Tests
1. `backend/tests/test_kinds_manifest.py` — assert every non-Emitter optical kind has `wavelengthRangeNm`; every non-Emitter non-fiber has non-empty `needs_aperture`.
2. New `backend/tests/test_kind_params_partition.py` case: axis fields appear in `intrinsic_param_keys` so they're identifiable as "PHY Editor only" by the UI.
3. Frontend tests under `frontend/src/kinds/__tests__/plugin_alignment.test.ts` — extend the exhaustiveness check.

## 5. Out-of-scope (deferred)

- Wavelength-dependent transmission curves (the new `wavelengthRangeNm` is a single window; spectral curves stay future work).
- Aperture-shape geometric validation against beam profile (ray-tracer still treats aperture as a single max half-extent today).
- Removing `V2ApertureCircle` from the type system.
- Migrating existing scene-debug fixtures (one-time data fix once schema lands).

## 6. Open questions

1. Should `dichroic_mirror` keep `cutoffWavelengthNm` alongside `wavelengthRangeNm`, or replace it with two ranges (`reflectionBandNm`, `transmissionBandNm`)?
2. For `aom` and `eom`, should `wavelengthRangeNm` be the **AR-coating** band, or the **diffraction-efficient** band? They can differ.
3. Should fast/slow-axis edits in PHY Editor propagate to all instances of the same Kind, or stay per-object? Current behaviour mixes — `waveplate.fastAxisDegBeamLocal` is a `state_param` (per-object) while fiber-end `slowAxisDegInBodyFrame` is in `default_params` (per-kind default but each object holds its own copy).

---

**Next step**: get the open questions answered, then execute changes A→E. Recommended order: A → B → tests → C → D, each as a separate commit so the audit trail is reviewable.
