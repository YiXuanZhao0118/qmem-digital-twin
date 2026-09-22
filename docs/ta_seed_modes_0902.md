# Seed and TA-input spatial modes — 2026-09-02

Where the current `TS-2000-A.spatialModeX/Y` (DBR seed) and
`Sacher_TEC400_852nm_TA.inputSpatialModeX/Y` (TA input mode) come from, and
the two conventions that were settled with them. Reproduce every number with
`python docs/ta_seed_modes_0902.py` (`--fit` re-runs the DBR back-propagation
against the live collimator model). Output side of the TA: see
[sacher-tec400-852nm-ta-output-mode.md](sacher-tec400-852nm-ta-output-mode.md).

## Two conventions

1. **Thorlabs WFS30 sign.** `P > 0` (RoC > 0) is a **diverging** beam, so
   `R_gauss = +1000/P` and `1/q = 1/R − iλ/(πw²)`. Settled on 2026-09-02 by
   fitting the raw DBR beam at two planes 150 mm apart: only that sign fits both
   (`χ² 0.3–0.6` vs `14–64` for the opposite).
2. **Twin sign.** A `GaussianMode`'s `waistZOffsetMm` is measured along the
   emit anchor's **outward** `axisX`: `Re q = −waistZOffsetMm` at the anchor.
   For the TA's `intercept_in` that is the direction of the beam the facet
   *emits* (backward ASE / seeded re-emission), i.e. back toward the seed.
   `_facet_beam` (backward emission), `mode_match_model` (optimizer reference)
   and `misc_ops._mode_match_eta` (coupled power) all read it this way since
   2026-09-02; before that the optimizer launched with the opposite sign.

And the axis trap: **mode X sits on the anchor's `axisY`**. For both the TA's
`intercept_in` and the DBR's `intercept_out` that axis is body +z = **vertical**
in the scene (the tracer's beam-local `s` is also vertical for any horizontal
beam, so a `labSegment`'s `qx` is vertical too). WFS x (horizontal) therefore
goes into mode **Y**, WFS y (vertical) into mode **X**. The 2026-08-20 DBR fit
had put the horizontal radius into `spatialModeX`.

## TA input mode — from the TA's own back-emission

Capture `repump input3.csv`, 2026-09-01 15:35, WFS30-5C facing the TA, 25 mm
outward of `intercept_in` (bench "TA − 25 mm"), TA unseeded. The file's own
full-pupil optometric block is over range (`Cyl −10.2 dpt`, 4.6 waves PV,
spot shift 51 µm) — the usable numbers are the beam diameters and a **core
(r < 0.5 mm) fit** of the raw wavefront: `1.781 × 1.635 mm`, `P_x −0.60 dpt`,
`P_y −4.10 dpt`. Negative = **converging** as it leaves the TA: the TA's
internal collimator over-collimates, more so vertically.

Propagating each axis back 25 mm to the facet and reading `(w₀, offset)`:

| | measured @ 25 mm | `waistUm` | `waistZOffsetMm` | meaning |
|---|---|---|---|---|
| `inputSpatialModeX` (vertical, WFS y) | 1.635 mm, −4.10 dpt | **80.5** | **+266.5** | emitted beam converges to an 80 µm waist 266 mm in front of the facet |
| `inputSpatialModeY` (horizontal, WFS x) | 1.781 mm, −0.60 dpt | **441.0** | **+1283** | nearly collimated, waist 1.28 m out |

Round-trip check in the live trace: the TA's backward segment leaves
`intercept_in` with `q_vert = −266.5 + 23.9i`, `q_horiz = −1283 + 717i` and at
25 mm reads **1.635 × 1.781 mm, −4.10 / −0.60 dpt** — the capture, to the digit.

**What the seed must be** (bench derivation, same day): the time reverse of
that beam — same spot, curvatures flipped, so at TA − 25 mm the seed should read
`1.781 × 1.635 mm, P +0.60 / +4.10 dpt` (diverging, as if from a 0.16 mm
vertical waist 242 mm upstream). In the twin this is `mode_match.time_reversed_target`
(`(xx, yy, xy) → (−xx*, −yy*, +xy*)`; M and J0 flip, J45 keeps its sign), applied
both by the mode-matching optimizer at its compare plane and by the TA op at
the facet. See [introduce/mode-matching.md](introduce/mode-matching.md).

Caveat carried over from the bench: the 15:35 core fit's `P_y` wandered between
−2.8 and −4.7 dpt with the fit radius; ±0.5 dpt on it alone moves a perfect
bench design to η ≈ 0.85. A cleaner TA back-emission capture (exposure at
50–80 % of saturation, spot shift < 75 µm) is the open item.

Superseded: `IN_1505` (2026-08-19) `{278.4 µm, −986 mm}` / `{314.9 µm, +1102 mm}` —
a fit of the *seed* beam of that day, not of the TA.

## DBR seed — from two planes, back through the twin's collimator

`dbr21.csv` (bench path 525 mm from the DBR exit) and `dbr27.csv` (675 mm),
2026-09-02, same exposure, nothing between them. Joint Gaussian fit
(λ = 852 nm), virtual waists behind the exit face:

| axis | w₀ | waist at | 2w @ 525 (meas) | 2w @ 675 (meas) |
|---|---|---|---|---|
| horizontal (WFS x) | 0.338 mm | −195 mm | 1.339 (1.317) | 1.551 (1.571) |
| vertical (WFS y) | 0.510 mm | −457 mm | 1.460 (1.468) | 1.578 (1.570) |

The twin emits from the facet and collimates with the separate
`LENS_PLANO_CONVEX2` object (f 4.51, n 1.59, 2.75 mm thick, 4.98 mm from the
facet), so the stored mode is the facet mode that makes **that model** produce
the fitted beam: a least-squares fit on `(w₀, offset)` per axis against the
tracer, bench hole 0 taken as the collimator's exit surface (a 5–8 mm
ambiguity in that origin shifts a waist that sits 195–457 mm away, i.e. < 1 %
in width anywhere on the bench).

| | `waistUm` | `waistZOffsetMm` |
|---|---|---|
| `spatialModeX` (vertical) | **2.164** | **+0.032** |
| `spatialModeY` (horizontal) | **3.278** | **+0.042** |

Live trace after the write: 1.458 × 1.333 mm at 525 and 1.576 × 1.545 mm at
675 (vertical × horizontal). As with every mode in this catalog, `M² = 1` is
pinned, not measured — `waistUm` here is an *effective* facet waist.

Superseded: the 2026-08-20 single-plane values `{1.746 µm}` / `{1.896 µm}`
(both at 0.0), which also had the two axes swapped relative to the anchor basis.

## Rows written (2026-09-02, via the API, `TS-2000-A` unlocked → written → relocked)

- `assets_3d` `b12b42ef…` (`Sacher_TEC400_852nm_TA`) `inputSpatialModeX/Y`
- `assets_3d` `9f31ea60…` (`TS-2000-A`) `spatialModeX/Y`
- `devices` `sacher_tec400_852nm_ta` and `dbr_tosa` (PHY-editor seed templates)
- `physics_elements` of `TAPERED_AMPLIFIER0` (`kindParams` copy)
