# AOM diffraction model (MT80-A1.5-IR)

Datasheet-calibrated model for the acousto-optic modulator. Single source of
truth shared by the production anchor op, the v3 kind op, the panel, and the
`/api/v3/solver/aom-sidebands` endpoint.

- Backend: `app/optical/aom_physics.py` (efficiency + per-order Bragg matching +
  RF readers), `app/optical/aom_sideband.py` (multi-order spread),
  `anchor_ops/aom.py` (production trace), `kinds/aom/physics.py` (v3 op).
- Frontend: `optical/kinds/aom/physics.ts` (shared model + panel fallback +
  parity), `optical/kinds/aom-v3/physics.ts`, `utils/aomAlign.ts` (positioning
  geometry), `components/physics/AlignToBeamControls.tsx` (`AomBraggSection`).
- Asset params: `kinds/aom/index.ts` defaults; per-asset in `assets_3d.default_params`
  (migrations `0100`–`0102`).

## Bragg matching (which order the cell is pointed at)

Momentum conservation with `|k_out| = |k_in|` and `k_out = k_in + m·K·â`
(`â` = acoustic propagation direction) constrains **only** the component of the
input along the acoustic axis:

```
k̂_in · â = −m · sin θ_B        ⟺   θ_in = −m · θ_B      (matched incidence)
k̂_out · â = +m · sin θ_B                                 (out = in + 2·m·θ_B·â)
```

so **+1 and −1 are matched at tilts 2·θ_B apart** — a real cell has to be
rotated to the side of the order you want, and rotating it trades one order for
the other. The condition depends on `k̂·â` alone, so a beam traversing the
crystal backwards is matched at the same signed incidence (no traversal sign).

The per-order phase-matching factor is the sinc² of the residual:

```
θ_in    = asin(k̂ · â⊥)                       # signed, â projected ⟂ optical axis
Δ_m     = θ_in − (−m·θ_B)
detune_m= sinc²(dk·L/2),  dk = K·cos θ_B_int·(Δ_m / n),  K = 2π f / v
```

`aom_physics.acoustic_incidence_rad` / `bragg_matched_incidence_rad` /
`bragg_order_detune`, mirrored 1:1 in `optical/kinds/aom/physics.ts`
(`acousticIncidenceRad` / `braggMatchedIncidenceRad` / `braggOrderDetune`) and
pinned by the parity golden `aom_plus1_order.json`.

> Changed 2026-08-14. The previous model measured an **unsigned** deviation from
> the crystal's optical axis, i.e. "on-axis = matched, for every order" — ±1 were
> indistinguishable and tilting could only ever lose efficiency. Existing scenes
> whose AOM was aligned straight through are therefore off-Bragg by θ_B and need
> one "Bragg align" click (below). Assets with neither an `acoustic_axis` anchor
> nor `rfPropagationDirectionBodyLocal` keep the old unsigned behaviour.
>
> How sharp the penalty is depends on `crystalLengthMm`: the external half-width
> to the first sinc² null is `n·v/(f·L)`. At L = 1.6 mm (datasheet interaction
> length) that is ±74 mrad ≫ θ_B, so the cell is only weakly order-selective;
> the live `aa_mt80_a1_5_ir` asset row carries **L = 25 mm**, giving ±4.7 mrad —
> narrower than θ_B, so alignment dominates the efficiency there.

## Alignment / positioning

Object panel → Align → the AOM-only **Bragg** block (`AomBraggSection`). Two
stages, matching `docs/aom_align_*.py`:

1. **Stage 1** — the ordinary point+direction align: interaction centre
   (midpoint of `intercept_in`/`intercept_out`) onto the beam, optical axis
   `D1` along ±beam (`properties.alignReverse`), optional roll.
2. **Stage 2** — rotate `+m·θ_B` about `D3 = D1 × D2` around that centre, so the
   beam lands on the matched incidence for the selected order.

Body triad (`utils/aomAlign.resolveAomBraggFrame`): `D1` = intercept_in →
intercept_out, `D2` = the `acoustic_axis` anchor's axisX (else the
`rfPropagationDirectionBodyLocal` / `acousticAxisBodyLocal` param), re-orthogonalised
against `D1`; `D3 = D1 × D2`. MT80: `D1 = +Y`, `D2 = −X`, `D3 = +Z`.

- **Order** comes from the per-instance `dynamicSources.diffractionOrder` — the
  same value the solver traces, so the panel and the beam can't disagree.
- **Fine tune (mrad)** (`properties.aomBraggFineTuneMrad`) rotates about `D3`
  around the interaction centre, i.e. walks the rotation stage without leaving
  the beam. The readout reports the **measured** incidence, so a hand-dragged
  cell reads correctly too.
- **Sign convention CONV-2 (lab-fixed)**: "+1" always tilts the same way, so the
  diffracted beam always leaves on the same side of the table. Consequence: with
  `alignReverse` (beam through the cell backwards) that same tilt Bragg-matches
  order **−m** — physically what a reversed cell does. The panel reports
  `matchedOrder` and warns when it differs from the selected order.

## Efficiency

On-Bragg first-order diffraction efficiency (the caller then multiplies by the
per-order `detune_m` above):

```
η(P, f, λ) = peak · sin²( (π/2)·√( P / P_peak(λ) ) ) · G(f)
P_peak(λ)  = rfPowerForPeakW · (λ / peakRefWavelengthNm)²        # P ∝ λ²
G(f)       = exp( -ln(1/0.75) · ((f − centerFreqMhz) / freqShiftBandwidthMhz)² )
```

- `peak` = `baseEfficiency` — the datasheet PEAK efficiency (>85 %, nom 90 %).
- **RF amplitude**: `sin²((π/2)√(P/P_peak))` is the datasheet *relative
  efficiency vs RF power* curve — 0 at P=0, peak at P=P_peak, rolls back over
  if over-driven. `P_peak` scales as λ² (more power needed at longer λ);
  `rfPowerForPeakW = 2.2 W` is the rating at `peakRefWavelengthNm = 1100 nm`,
  so peak at 780 nm needs ≈ 1.1 W.
- **RF frequency**: `G(f)` is the carrier-frequency bandwidth — 1.0 at the
  design centre (`centerFreqMhz = 80`), ≈0.75 at ±`freqShiftBandwidthMhz`
  (±15 MHz), matching the variable-shift spec (>80 %@F0, >60 % over range).
- **RF off**: `P` is the resolved RF drive power. No RF source → assume the
  rated operating point (P = P_peak → peak η). An explicit **P = 0** (RF turned
  off) → η = 0. `requiresRfDrive = true` makes "no RF source" → η = 0 instead
  of rated.

> NOTE — two distinct "bandwidths": `freqShiftBandwidthMhz` (±15 MHz) is the RF
> *carrier* bandwidth above. `modulationBandwidthMhz` (10 MHz) is the analog
> *amplitude*-modulation −3 dB bandwidth (temporal, rise-time limited) — it is
> NOT used by the static efficiency model.

## Multi-order sidebands

```
v   = 2·√(η)                                  # Raman-Nath phase-mod depth
I_m = sideband_intensities_on_bragg(selected, η, v, maxDiffractionOrder)
```

`v` is tied to the drive, so the spread grows with RF and collapses to v=0
(only the 0 order) when RF is off. Each diffracted order is then scaled by its
OWN `detune_m` (so the tilt decides which sideband survives) and the 0 order
takes whatever is left.

**Visibility** (drawn beam / panel table row): order `m` is shown iff
`m == 0` OR `m == diffractionOrder` (selected) OR
`I_m ≥ sidebandVisibilityThreshold` (default 1 %), within
`±maxDiffractionOrder`. If `η ≈ 0` (RF off / gated) only the 0-order
passthrough is drawn.

> CAVEAT: MT80 is a Bragg cell (Klein–Cook Q ≈ 5), so physically it is mostly
> 0 + the selected order; the ±2/±3 sidebands are a Raman-Nath approximation
> kept for visualisation.

## Asset params (MT80-A1.5-IR)

| param | value | role |
|---|---|---|
| `baseEfficiency` | 0.85 | peak η (datasheet >85 %) |
| `rfPowerForPeakW` | 2.2 | P_peak (max RF power) |
| `peakRefWavelengthNm` | 1100 | λ_ref for P_peak ∝ λ² |
| `centerFreqMhz` | 80 | design centre for G(f) |
| `freqShiftBandwidthMhz` | 15 | RF carrier half-bandwidth |
| `rfPowerMaxW` | 2.2 | hardware clamp |
| `requiresRfDrive` | false | no RF → rated (not off) |
| `acousticVelocityMps` | 4200 | TeO₂-L; Bragg angle + Doppler |
| `crystalLengthMm` | 1.6 | off-Bragg detune geometry (⚠ the live asset row says **25**; that narrows the angular acceptance from ±74 to ±4.7 mrad — see the Bragg-matching note) |
| `rfPropagationDirectionBodyLocal` | [−1, 0, 0] | acoustic axis `D2` (order fan-out + Bragg incidence) when there is no `acoustic_axis` anchor |
| `modulationBandwidthMhz` | 10 | analog amp-mod BW (unused by η) |
| `figureOfMeritM2` | 34.5e-15 | TeO₂-L (legacy; unused by η) |

Bragg angle (external, lab frame): `θ_B = asin(λ·f / (2·v))` → 2θ_B ≈ 14.9 mrad
at 780 nm / 80 MHz (datasheet "separation 0→1" >13.3 mrad). Doppler: order `m`
shifts the optical frequency by `m·f`.
