# AOM diffraction model (MT80-A1.5-IR)

Datasheet-calibrated model for the acousto-optic modulator. Single source of
truth shared by the production anchor op, the v3 kind op, the panel, and the
`/api/v3/solver/aom-sidebands` endpoint.

- Backend: `app/optical/aom_physics.py` (efficiency + RF readers),
  `app/optical/aom_sideband.py` (multi-order spread), `anchor_ops/aom.py`
  (production trace), `kinds/aom/physics.py` (v3 op).
- Frontend: `optical/kinds/aom/physics.ts` (panel fallback + parity),
  `optical/kinds/aom-v3/physics.ts`.
- Asset params: `kinds/aom/index.ts` defaults; per-asset in `assets_3d.default_params`
  (migrations `0100`–`0102`).

## Efficiency

On-Bragg first-order diffraction efficiency (the caller then multiplies by the
off-Bragg incidence-angle `detune`):

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
(only the 0 order) when RF is off. The 0 order takes the remainder after the
diffracted orders (scaled by the off-Bragg `detune`).

**Visibility** (drawn beam / panel table row): order `m` is shown iff
`m == 0` OR `m == diffractionOrder` (selected) OR
`I_m ≥ sidebandVisibilityThreshold` (default 1 %), within
`±maxDiffractionOrder`. If `η·detune ≈ 0` (RF off / fully off-Bragg) only the
0-order passthrough is drawn.

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
| `crystalLengthMm` | 1.6 | off-Bragg detune geometry |
| `modulationBandwidthMhz` | 10 | analog amp-mod BW (unused by η) |
| `figureOfMeritM2` | 34.5e-15 | TeO₂-L (legacy; unused by η) |

Bragg angle (external, lab frame): `θ_B = asin(λ·f / (2·v))` → 2θ_B ≈ 14.9 mrad
at 780 nm / 80 MHz (datasheet "separation 0→1" >13.3 mrad). Doppler: order `m`
shifts the optical frequency by `m·f`.
