[← Doc index](README.md)

# Outstanding work — the optics backlog

> **Scope.** Forward-looking work that is *deliberately* not done yet, each with a definition of done. This is not the same list as [known-issues.md](known-issues.md) (defects and stale state — things that are simply *wrong*) or `CLEANUP_AUDIT.md` at the repo root (dead code and renaming). If an item here turns out to be a defect rather than a decision, move it there.
>
> Opened **2026-08-20**, out of the general-astigmatism upgrade (Steps 1 → 2f in [optics.md](optics.md)). Every entry below was reached and characterised during that work — nothing here is speculative.

---

## 1 · Optics engine

### 1.1 The beam profile's horizontal mirror

`beamTensor.displayToBeamFrame` ([beamTensor.ts:189](../../frontend/src/optical/beamTensor.ts)) makes the profile's absolute orientation *derived* rather than assumed, and its six-direction test pins that a beam wide along `+s` is drawn wide on the display axis labelled with s's world axis. What it does **not** pin is a reflection: for a beam along lab +x, `+p` is lab **−y**, so the horizontal display axis increases leftward.

An intensity profile is symmetric, so this is invisible unless the beam is **decentred** or in an **odd-order HG mode** — which is exactly why it has never been noticed and why it is not urgent.

- **Anchor**: `profileSample` in [BeamScopePanel.tsx:934](../../frontend/src/components/optical/BeamScopePanel.tsx); the note in [optics.md](optics.md) §Step 2f.
- **Done when**: an odd-order HG (or a deliberately decentred) beam is put on screen and the bright lobe is confirmed to sit on the labelled `+` side — or the sign is corrected and a test asserts the lobe's side, not just its axis.
- **Invariant to preserve**: whatever the sign, `displayToBeamFrame` must keep reproducing `sampleIntensity(y, -x)` exactly for a beam along +x, since that is the historical behaviour every table-plane beam has been read against.

### 1.2 `_mode_match_eta` is separable, a rolled seed is not

The TA overlap integral takes the product of two 1-D overlaps against `inputSpatialModeX/Y`. Since Step 2b it rotates the seed into the anchor basis first, so the axes line up — but a seed whose astigmatism is **rolled** relative to the waveguide mode (`q_seed.xy != 0`) is not separable at all, and only the anchor-frame diagonal is used.

- **Anchor**: the "Remaining approximation" note in [misc_ops.py:262](../../backend/app/optical/anchor_ops/misc_ops.py), inside `_mode_match_eta` ([misc_ops.py:247](../../backend/app/optical/anchor_ops/misc_ops.py)).
- **Done when**: the overlap is the full 2-D Gaussian overlap of two general-astigmatic modes, with a test showing it agrees with the separable form to machine precision at zero roll and diverges from it at 45°.
- **Why it matters here**: this is the term that decides how much seed light the TA actually amplifies, and the beam-shaping work that motivated the whole upgrade exists to raise it (see §3.2).

### 1.3 `solvers/generalized_abcd.py` still splits q per axis

That module already has `m_rotation` and `m_cylindrical_rotated`, so its **chief-ray** side handles cross-axis coupling via the full 5×5. Its **q** side does not: `apply_operator` takes the diagonal ABCD sub-blocks and propagates two scalar q's, with the limitation written into its own docstring.

It is a standalone solver — reachable from `collins_fft` / `hg_modes`, and `lens/physics.py` imports only `m_thin_lens` — so it did not block the live tracer and was left alone.

- **Anchor**: `apply_operator` ([generalized_abcd.py:563](../../backend/app/solvers/generalized_abcd.py)); the limitation note at [generalized_abcd.py:577](../../backend/app/solvers/generalized_abcd.py).
- **Done when**: it propagates a `QMatrix` through the full blocks, and `test_generalized_abcd` gains a rotated-cylindrical case whose result matches the anchor tracer's for the same optic.
- **Note**: the algebra it needs already exists in `beam_ray.q_matrix_after_abcd`; this is a migration, not a derivation.

### 1.4 Observation, not yet a task: the adapter pins `mSquared: 1`

`v3TraceAdapter` folds √(M²) into `waist0Um` and publishes `mSquared: 1` on the `BeamState`. The widths come out right; the **divergence** of a high-M² beam does not follow from a waist that has been pre-scaled. Pre-existing, unrelated to the astigmatism work, and not investigated — recorded here only so the next reader does not mistake it for an accident.

---

## 2 · Measurements that unblock the model

These are lab tasks, not code. The model is currently as good as the data allows, and each of these raises that ceiling.

### 2.1 `d(z)` beam-profiler scan (ISO 11146) — highest value

`M² = 1` is **pinned, not measured**, for both the DBR and the Sacher TA. A single-plane Shack–Hartmann gives two numbers per axis (pupil radius, wavefront RoC) while `GaussianMode` needs three, so `waistUm` and `mSquared` are degenerate — only the far-field divergence was ever observed.

- **Done when**: a ≥8-point `d(z)` scan through a waist exists for each source and `mSquared` on the device rows carries a fitted value instead of 1.
- **Where it lands**: `spatialModeX/Y.mSquared` on the device + asset rows; see [kinds.md](kinds.md) for the fit already recorded for both sources.

### 2.2 Decide whether the TA input's 0.21 λ astigmatism is real

The measured `Z(2,2)` sits on the ellipse's **short** axis, which is exactly where a circular analysis pupil overhanging an elliptical beam would put a spurious term (those lenslets carry ~1 % of the intensity).

- **Done when**: two tests have been run — (a) set the WFS pupil manually to ~1.5 mm so it fits **inside** the beam's short axis and re-measure; (b) rotate the sensor 45° about the optical axis and re-measure. If the astigmatism axis follows the sensor it is an instrument artifact; if it stays with the lab frame it is real.
- **Consequence**: it decides whether the beam-shaping design must *cancel* that astigmatism or can ignore it.

### 2.3 Export the DBR's Zernike CSV

The DBR coefficients currently on record were **read off a photograph of the WFS screen** (±0.005), which is what makes its astigmatism axis 99.2° ± 9.1° — an uncertainty large enough that the de-rotation could not be distinguished from doing nothing.

- **Done when**: the same CSV export used for the TA (`IN_1505`) exists for the DBR and the fit is re-run from it.

---

## 3 · Catalog and scene

### 3.1 The unused `dbr_tosa` asset

Two assets point at the `dbr_tosa` device: `TS-2000-A` (`9f31ea60…`), which the scene's *"DBR"* component actually binds, and `dbr_tosa` (`7bc82d8d…`), which nothing in the scene uses. The measured facet mode was written to the first and deliberately **not** to the second, because it is unknown whether that row is a different physical unit or a stale duplicate.

- **Done when**: someone who knows the hardware says which it is — then either the same fit is applied, or the row is retired.
- **Note**: both rows are `locked`; edits go through the documented unlock → PUT → relock with explicit human authorisation.

### 3.2 The beam-shaping optics are not in the scene

The measured TA seed coupling is ~0.1 % (3.46 mW of seed in, 0.004 mW out), because a ~1.4 mm collimated beam overlaps a few-µm waveguide mode almost not at all. That is `_mode_match_eta` correctly reporting a real mode mismatch — and correcting it is the design the whole general-astigmatism upgrade was built to support.

- **Done when**: the anamorphic shaper is placed in the scene and the traced coupling matches the design calculation.
- **Now possible**: since Step 2b the engine can model a cylindrical telescope at an arbitrary roll angle, which it could not before — `lens_cylindrical` + the rotated power tensor, see [optics.md](optics.md).

---

## Related

- [optics.md](optics.md) — the full account of the general-astigmatism upgrade these items came out of
- [known-issues.md](known-issues.md) — defects and stale state, as opposed to planned work
- [kinds.md](kinds.md) — the device rows and the spatial-mode fits referenced above
