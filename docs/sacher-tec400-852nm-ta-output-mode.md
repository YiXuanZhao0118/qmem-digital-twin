# Sacher TEC400 852 nm TA — output spatial mode

Where the amplified beam's transverse state comes from, how the stored values
were measured, and why `mSquared` is still 1.0.

- Asset: `b12b42ef-df78-4543-9d8c-605046cac067` (`Sacher_TEC400_852nm_TA`),
  `assets_3d.default_params.outputSpatialModeX/Y`.
- Live scene: physics element `ae4cf5a2-f52e-4216-8255-31d4c97e8280`
  (object `TAPERED_AMPLIFIER0`, component `Opt TA TEC400`) — same values.
- Consumed by `app/optical/anchor_ops/misc_ops.py:tapered_amplifier_anchor_op`
  via `_q_at_waist_mm`.
- Reproduce the current values: `python docs/ta_out_wfs_cyl.py`.
- Reproduce the 2026-08-19/20 analysis below it: `python docs/ta_out_m2.py`.

## Stored values

Applied 2026-08-22 from the 2026-08-21 cylindrical-lens capture (the row is
`locked`; it was unlocked, written, re-locked):

| | `waistUm` | `waistZOffsetMm` | `mSquared` | half-divergence |
|---|---|---|---|---|
| `outputSpatialModeX` | 229.6 | −126.7 | 1.0 | 1.18 mrad |
| `outputSpatialModeY` | 3.96 | −12.91 | 1.0 | 68.5 mrad |

**The two axes are nothing alike.** The horizontal is all but collimated — 0.90
mm across and spreading at 1.18 mrad, a large (230 µm) waist sitting far behind
the aperture. The vertical is a bare diverging facet, 3.96 µm, but its waist is
**12.9 mm behind `intercept_out`**, not on it. Nothing in the housing was
measured to say where that waist is; it is what the optics require.

Verified against the solver: the first `labSegment` off `intercept_out` carries
`qx = 12.91 + 0.0578i` and `qy = 126.7 + 194.38i`, and forward-propagating the
stored pair returns the capture it was built from — 0.898 mm horizontal and
1.768 mm vertical at z = 200 mm, to three decimals (`ta_out_wfs_cyl.py` §4).

Note the frame difference when reading a `labSegment`: its `qx`/`qy` are in the
beam-local (s, p) basis, and `beam_local_sp` builds **s from `GLOBAL_UP =
(0,0,1)`** — so for this beam (direction `(−1,0,0)`) `qx` is *vertical* and `qy`
is *horizontal*, the opposite order to `outputSpatialModeX/Y`, which live in the
`intercept_out` anchor's (axisY, axisZ) basis. Same physics, different labels.

Superseded values, and why they were wrong:

| | `waistUm` | `waistZOffsetMm` | note |
|---|---|---|---|
| `outputSpatialModeX` | 4.88 | 0.0 | 2026-08-20. Root B on **both** axes — right for the vertical (bar the waist offset), 47× too divergent for the horizontal |
| `outputSpatialModeY` | 2.13 | 0.0 | — waist pinned to the facet because one width cannot place it |
| `outputSpatialModeX` | 78.8 | +1031.3 | 2026-08-19. Built to make `w = 3.50 mm` at z = 15 mm |
| `outputSpatialModeY` | 140.8 | −1800.9 | — the `a = 3.5 mm` pupil error, baked in |

Both `emit_ta_ase_rays` and `tapered_amplifier_anchor_op` read these same two
keys (`_facet_beam`: *"ASE leaves through the same facet and collimator as the
amplified beam"*), so ASE and seeded output always share the mode — one fix
covers both.

`waistUm` is the **real** waist radius, not the embedded one: `_q_at_waist_mm`
stores `zR = pi*w0^2/(M2*lam)` and readout multiplies the embedded width by
`sqrt(M2)` (`BeamRay.width_mult_*`), so the two cancel. Both modes are
expressed in the `intercept_out` anchor's (axisY, axisZ) basis — mode X is body
+y (horizontal), mode Y is body +z (vertical).

## Provenance: the 2026-08-21 cylindrical-lens capture

Thorlabs WFS30-5C/M + MLA150-5C, 16:58:46, exported as `tst.csv`. Geometry, z
from `intercept_out` along the output axis: an **f = 50 mm cylindrical lens with
power on the vertical axis at z = 100 mm**, sensor at **z = 200 mm**. The point
of the lens is that it shrinks the vertical enough to land on the sensor at all.

Read off the file: pupil radius **a = 0.701 mm** (the software sets it from the
beam centroid — no assumed pupil this time, which is what sank `OUT_1520`),
beam diameters **0.898 mm × 1.768 mm**, and

| CSV Index | (Order, Frequency) | coefficient |
|---|---|---|
| 5 | (2, 0) defocus | +3.192 |
| 6 | (2, 2) astig 0/90 | −4.248 |
| 4 | (2, −2) astig 45 | −0.534 |

⚠️ **The CSV's `Index 1` is piston**, so its Index is the ANSI `j` of
`ta_out_m2.py` **plus one**. Reading the bar chart off a photo of the panel gets
this wrong by one place and silently swaps defocus for astigmatism.

The same `1/R_x`, `1/R_y` formulas as above give **R_x = +442.3 mm** and
**R_y = +13.44 mm** (this file's sign convention, R > 0 = diverging; Thorlabs
negates the whole block). Cross-checks against the file's own arithmetic: mean
power −38.343 dpt vs `Fourier M = −38.361`, J0 +36.082 vs `36.093`, astigmatism
axis within 0.02° of `Optometric Axis = 3.583` modulo the 90° convention offset.

### The two axes land on opposite sides of the dynamic-range limit

| axis | lens? | edge slope over the 1.402 mm pupil | |
|---|---|---|---|
| horizontal (x) | no | **1.6 mrad** | well inside the 14.4 mrad limit |
| vertical (y) | yes | **52.2 mrad** | 3.6× over — the fit is invalid |

The vertical failure is visible in the raw `*** WAVEFRONT ***` grid, not just
inferred. Down the `x = 0.000` column the wavefront **folds back**:

```
y:  0.000  -0.150  -0.300  -0.450  -0.600  -0.750  -0.900  -1.050  -1.200  -1.350
W:  0.000  -2.371  -6.036  -9.981 -13.205 -15.329 -15.988 -14.105  -9.356  -1.732
```

A parabola does not turn around. That is spot crossover, and it is **structural,
not bad luck**: 100 mm = 2f, so the lens images the vertical ~1:1 onto z ≈ 190 mm
and the sensor sits 10 mm off a focus. Moving the sensor does not help — past
that focus the vertical diverges at 86 mrad. To measure the vertical wavefront
the lens has to **collimate** it, not focus it: `LJ1960L1` (f = 20.01) at
≈ 7 mm from `intercept_out` gives a 2.7 mm collimated vertical; the f = 50 at
≈ 37 mm gives 6.9 mm, which needs the full 1936 × 1216 readout rather than the
768 × 768 window this capture used.

### So each axis is derived a different way

**Horizontal** — `w` and `R` are both measured at the same plane and both are in
range, so `q` is fully determined by one capture with no external input:
229.6 µm at −126.7 mm.

**Vertical** — the wavefront is discarded. Two **size** readings, no
Shack-Hartmann slope anywhere in the chain: `2w = 3.820 mm` at z = 15 mm free
(the 2026-08-20 panel) and `2w = 1.768 mm` at z = 200 mm through the lens. Two
equations, two unknowns → 3.96 µm at −12.91 mm, which reproduces the 15 mm
reading as **3.823 mm** against the measured 3.820. Two captures a day apart
through completely different optics, agreeing to 0.05%.

Feeding the discarded vertical wavefront in anyway would have given 5.64 µm /
−18.4 mm — the same branch, 16% off at 15 mm. That is the size of the error the
over-range fit introduces.

### A slope-free proof that the vertical waist is not on the facet

Independent of every Zernike coefficient. At 2f the lens images the vertical
waist onto the sensor, so where that waist sits controls the spot size there:

| `waistZOffsetMm` (at the superseded `w0` = 2.13 µm) | 2w at the sensor |
|---|---|
| 0.0 — waist on the facet | **0.004 mm** |
| −5.0 | 1.273 mm |
| −20.0 | 5.093 mm |

Measured: **1.768 mm**. A waist sitting on `intercept_out` would have put a
4 µm spot on the sensor. It did not.

### The horizontal disagrees with 2026-08-20 by 3×

Stated plainly because it is unresolved. The new `outputSpatialModeX` predicts
**0.568 mm** at z = 15 mm; the 2026-08-20 panel recorded `Dia_x = 1.667 mm`. The
vertical from the same two sessions agrees to 0.05%, so this is not a global
scale error — it is specific to the horizontal path.

The new value is the better-supported one: it comes from a single plane where
both `w` and `R` were measured inside the sensor's range, while the 2026-08-20
number is a bare width with no curvature. But a 3× discrepancy on one axis only
is what a **lens in the horizontal path** looks like, and the live scene has
`Opt PL F 100mm` 96 mm downstream of `intercept_out` and `Opt CL 150.00` at
112 mm. If either was in the beam during the capture, `outputSpatialModeX`
has to be re-derived with it in the model.

Note also that the horizontal waist is poorly conditioned even taking the
capture at face value: `R_x = 442 mm` is the difference of `4√3·c4 = +22.115`
and `−2√6·c5 = −20.811`, i.e. 1.304 out of ~22. A ±0.15-wave error on either
coefficient moves `waistUm` over 160–360 µm and `waistZOffsetMm` over −22 to
−171 mm. What is robust is the **divergence, 0.64–1.92 mrad**, and the directly
measured `2w = 0.898 mm` at the sensor. "Nearly collimated" is safe; the waist
location is not.

## Provenance: OUT_1520

Thorlabs WFS30-5C/M + MLA150-5C, 2026-08-19, 1.5 cm downstream of the output
aperture, 15-term ANSI Zernike fit. Defocus and 0/90 astigmatism give the
two-axis wavefront radius over a pupil of radius `a`:

```
1/R_x = (4*sqrt(3)*c4 + 2*sqrt(6)*c5) * lam / a^2
1/R_y = (4*sqrt(3)*c4 - 2*sqrt(6)*c5) * lam / a^2
```

At `a = 3.5 mm` that is `R_x = −1016.8 mm`, `R_y = +1818.8 mm`; inverting the
Gaussian at `w = a = 3.5 mm` gives exactly the two rows in the table above, and
forward-propagating them returns `w = 3.50 mm` and both radii at z = 15 mm. So
the stored pair is unambiguously the 15:20 capture (`OUT_1459` would have given
(358.4 µm, +4615.7 mm) and (75.5 µm, −958.7 mm)) — derived correctly from a
premise that turns out to be false.

## The pupil is not 3.5 mm

`a = 3.5 mm` was never measured. It was inferred from "the spot fills the
sensor's short axis" (sensor 11.34 × 7.13 mm). The WFS panel's own beam-diameter
readout (2026-08-20) says otherwise:

```
Dia_x = 1.667 mm   ->  w_x = 0.834 mm       (model currently emits w = 3.50 mm)
Dia_y = 3.820 mm   ->  w_y = 1.910 mm        on BOTH axes at z = 15 mm
```

The beam covers roughly a quarter of the sensor's short axis. Two consequences,
and the second is worse than the first:

1. **Size.** The modelled beam is 2–4× too fat, which is what shows up in the
   3D view.
2. **Curvature.** `1/R` scales as `1/a^2`, so `R_x` and `R_y` are wrong too —
   by a factor of ~3 to ~18 depending on what the pupil actually was.

And the pupil also sets the trefoil edge slope `dW/dr|r=a = 8.485*c6*lam/a`,
which is the criterion for whether the capture was inside the sensor's dynamic
range (`MLA150-5C`, pitch 150 µm, f = 5.2 mm → `theta_max = 14.4 mrad`):

| assumed pupil a | R_x | R_y | mode X (w0 / off) | mode Y (w0 / off) | m6 edge slope |
|---|---|---|---|---|---|
| 3.500 mm (README) | −1016.8 | 1818.8 | 307.5 µm / +893.4 mm | 255.9 µm / −1771.2 mm | 8.9 mrad ok |
| 1.910 mm (= w_y) | −302.8 | 541.7 | 97.8 µm / +313.6 mm | 76.8 µm / −525.8 mm | **16.3 OVER** |
| 1.372 mm (mean) | −156.2 | 279.4 | 50.7 µm / +170.6 mm | 39.7 µm / −264.3 mm | **22.7 OVER** |
| 0.834 mm (= w_x) | −57.7 | 103.1 | 18.8 µm / +72.6 mm | 14.6 µm / −88.1 mm | **37.3 OVER** |
| elliptical a_x/a_y | −57.7 | 541.7 | 18.8 µm / +72.6 mm | 76.8 µm / −525.8 mm | **16.3 OVER** |

(mode columns use the *measured* `w_x` / `w_y` at z = 15 mm, not `a`.)

**Every pupil consistent with the measured spot size puts the capture over the
dynamic-range limit.** The 8.9 mrad in the first row was the only thing that
graded `OUT_1520` "marginal" instead of "invalid" — with a real pupil it joins
`OUT_late` as spot-crossover data, and it is the whole fit that is suspect, not
just the residual. `OUT_1459` fails the same way (its `c6` is 4.023).

So: do not re-derive the mode from these Zernike coefficients at any pupil.
What is left standing is the panel's beam diameter, which is measured directly
from the spot centroid and does not go through the Shack-Hartmann fit.

## One width, two roots

A single `w(z₁)` does not determine a Gaussian — it is a quadratic in `w₀²`,

```
w(z)² = w₀² + (z·lam/(pi·w₀))²      ->    u² - w(z)²·u + (z·lam/pi)² = 0,  u = w₀²
```

and both roots reproduce the measured spot exactly at z = 15 mm:

| | w(15 mm) | root A: `w₀` / divergence | root B: `w₀` / divergence |
|---|---|---|---|
| horizontal | 0.834 mm | 833.5 µm / 0.325 mrad | 4.88 µm / 55.6 mrad |
| vertical | 1.910 mm | 1910.0 µm / 0.142 mrad | 2.13 µm / 127.3 mrad |

Root A is a collimated beam whose waist happens to sit at the measurement plane;
root B is a bare diverging facet whose waist sits at the aperture. They separate
immediately downstream — at z = 500 mm root A is still 0.85 × 1.91 mm while root
B is 27.8 × 63.7 mm.

**The observation that the beam diverges strongly in the vertical picks root B**,
in both ASE and seeded operation. That also makes the ratio right: 127.3 / 55.6
= 2.3, fast axis over slow axis, with the fast (vertical) axis normal to a
horizontal junction — and it is why a cylindrical lens sits 18 mm from the
aperture rather than somewhere convenient.

Root A was written here first, on the argument that with nothing constraining
the curvature the least-committal choice was "collimated". That was the wrong
default: for a TA, a collimated output is the claim that needs evidence, not the
null hypothesis.

**Superseded per axis by the 2026-08-21 capture.** Root B holds for the
vertical, near enough — 68.5 mrad rather than 127.3, with the waist 12.9 mm
behind the aperture instead of on it. The horizontal is **neither root**: it
measures 1.18 mrad, four times flatter even than root A, on a 230 µm waist.
Both roots were forced through "the waist is somewhere near z = 15 mm"; once
curvature is measured, that constraint goes away. The lesson stands and gets
sharper — one width per axis was never enough, and the fix was not to pick the
better root but to measure `R`.

## Why `mSquared` stays 1.0

Independently of the pupil question. `OUT_1520` leaves 4.58 waves RMS in modes
6..15 once defocus and astigmatism are removed. Converting that to a beam
quality factor uses the exact second-moment invariant for `E = A·exp(i·phi)`
with a Gaussian `A`, at the ideal beam's waist plane:

```
M_x^2 = sqrt(1 + 4[<x^2><phi_x^2> - <x·phi_x>^2])     phi in rad, x in mm
```

intensity-weighted, mean tilt removed. It matches a brute-force FFT of the same
field to every printed digit and returns exactly 1.000 for pure defocus and pure
astigmatism (those are carried by `qx`/`qy`, so nothing is double-counted).

Applied to `OUT_1520`: **M²_x = 65.5, M²_y = 67.7** — not a number that can go
into an asset. That is sensitivity, not a bug: at `w = 3.5 mm` and 852 nm the
diffraction-limited half-divergence is only 0.0775 mrad, so a lone 0.55-wave
spherical term (3.6 mrad edge slope) is already M² = 16.

| j | mode | c (waves) | M²_x | M²_y |
|---|---|---|---|---|
| 6 | Trefoil Y | 4.30 | 58.1 | 58.1 |
| 15 | Pentafoil Y | −1.15 | 22.2 | 22.2 |
| 12 | Spherical | −0.55 | 16.2 | 16.2 |
| 14 | Quadrafoil X | 0.68 | 11.2 | 11.2 |
| 8 | Coma X | −0.42 | 11.3 | 5.8 |

The decisive check is the same estimator across all columns. `M² − 1` depends
only on the coefficients in waves, not on the pupil radius (slope ∝ `c·lam/a`,
diffraction divergence ∝ `lam/(pi·a)`, ratio = `pi·c`), so this table survives
the pupil problem intact:

| column | residual RMS | M²_x | M²_y |
|---|---|---|---|
| IN_1505 (a collimated beam we call *good*) | 0.218 | **4.1** | **3.7** |
| OUT_1459 (the only digits-off-the-panel set) | 4.151 | 53.9 | 61.8 |
| OUT_1520 | 4.582 | 65.5 | 67.7 |

A seed beam with near-zero defocus that couples fine still computes to M² = 4,
off residuals (trefoil −0.155, pentafoil 0.110) read from bar-chart heights at
±0.01. The method amplifies read-off error into beam quality. On the output side
4.30 of the 4.58 waves is mode 6, whose `c6/c5` ratio is locked at
1.91 / 2.00 / 2.00 across three captures — real trefoil is invariant under free
propagation, so that is a fit artifact, and the dynamic-range table above now
says why.

One thing the stored values still get wrong, deliberately: with
`mSquared = 1.0` the modelled vertical **near field** is a 3.96 µm waist, while
a real TA facet is 100–200 µm across on the slow axis. The far-field `w(z)` is
right either way, so everything the scene renders is correct — but note the
2026-08-21 result moved this from a cosmetic worry to a real one, because the
vertical waist is now placed 12.9 mm *inside* the housing, where the model draws
a beam that physically is not there. Fixing it needs the same `d(z)` scan as
`mSquared` itself.

The horizontal no longer has this problem: at 229.6 µm it is already facet-sized,
which is a quiet corroboration that the 2026-08-21 horizontal inversion is
measuring something real rather than a fit artifact.

## What is still open

1. **The horizontal 3× conflict** (see the 2026-08-21 section). Resolving it is
   a bench question, not an analysis one: was `Opt PL F 100mm` / `Opt CL 150.00`
   in the beam during the capture?
2. **`mSquared`, still 1.0.** Neither capture constrains it. `d_x(z)` and
   `d_y(z)` from a knife edge or beam profiler at ≥4 axial positions gives
   waist, position and M² per axis directly, with no pupil assumption and no
   Shack-Hartmann dynamic range to exceed.
3. **The vertical wavefront has never been measured in range.** Collimate it
   first — `LJ1960L1` (f = 20.01) at ≈ 7 mm from `intercept_out`. That would
   also give an independent check on `waistZOffsetMm = −12.91`, which currently
   rests on two size readings and nothing else.
4. **Astigmatism principal-axis rotation.** `OUT_1520` saw +6°, `tst.csv` sees
   3.58°; `qxy`/`m2xy` exist on `BeamRay` but no op writes them non-zero, so the
   model cannot carry either.
