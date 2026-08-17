# The measured benchmark dataset — measurement protocol

> [← Doc index](introduce/README.md) ｜ Corresponds to [`objectives.md`](objectives.md) §7-1, O-4 and F-2
>
> **Why this document exists**: `objectives.md` sets the target "simulated values within < 5 % of lab measurements" (O-4 optical, F-2 RF).
> That target **cannot be accepted today**, because there is no pinned set of measured values to compare against. This file defines what to measure, how to measure it,
> where the resulting numbers go, and how a case moves from "to be measured" to "gating CI".
>
> The inner target (< 0.1 % against analytic solutions, O-3/F-1) does not need this dataset; it is already covered by purely numerical unit tests.

---

## 1. What makes a benchmark case valid

**The number itself is the least important part.** A measurement recorded without its conditions is one that, six months later, nobody can reason about when it disagrees with the model,
so the only available response is to loosen the threshold — which is the same as abolishing the target. Every case must therefore carry:

| Field | Why it is non-negotiable |
|---|---|
| `value` + `unit` | The measured number |
| `uncertainty` | Instrument precision + the spread of repeated measurements. **If the measurement uncertainty is already close to 5 %, this case cannot be used to accept a 5 % target** |
| `date` | The lab drifts. An expired benchmark gets re-measured, not a looser threshold |
| `instrument` | Model + calibration date. A power meter set to the wrong wavelength is a systematic bias |
| `operator` | Someone has to be findable when it disagrees |
| `conditions` | See the required conditions listed per case in §3. **This is the most commonly omitted field and the most common reason a discrepancy can't be traced** |

The principle for `conditions`: **every parameter the model reads must have its experimental counterpart recorded.**
Each case below lists exactly which `defaultParams` it exercises.

---

## 2. The case list

Ordered by how much physics each one pins down. The first four are recommended first.

### Optical (O-4)

#### O-4.1 Fibre coupling efficiency ★priority
- **What to measure**: laser → aspheric lens → fibre, measuring η = P_out / P_in.
- **How**: with a power meter, first measure the free-space power before the lens (P_in), then the output at the fibre's far end (P_out). Same power meter, same wavelength setting.
- **Required conditions**: wavelength (nm), fibre model and length, connector type (PC/APC), the coupling lens's catalog_id, the incident beam's 1/e² diameter and divergence, and the best-after-alignment value vs the typical value.
- **Model parameters exercised**: the `fiber` op's `coreMfdUm` (default 5.3), `numericalAperture` (0.13), `coreRefractiveIndex` (1.46), `attenuationDbPerKm` (4.0) and `lengthM`; plus the lens's thick-lens geometry.
- **Why it's a priority**: coupling efficiency simultaneously tests beam propagation, the lens ABCD and the mode-overlap integral — the single measurement that verifies the most layers at once.

#### O-4.2 AOM first-order diffraction efficiency ★priority
- **What to measure**: with the cell aligned at the Bragg angle, the +1 order's power divided by the incident power.
- **How**: block the other orders and measure +1; then measure the straight-through power with no RF as the denominator.
- **Required conditions**: RF frequency (MHz), **RF drive power (dBm, measured at the AOM's connector, not at the source's output)**, wavelength, incident beam diameter, and the incidence angle (relative to normal).
- **Model parameters exercised**: the `aom` op's `crystalLengthMm` (22.4), `refractiveIndex` (2.26), `acousticVelocityMps` (4200), `baseEfficiency` and `rfPowerMaxW`.
- **Note**: `crystalLengthMm` was fixed at 22.4 mm by alembic 0120, and this case tests that value directly.

#### O-4.3 Inter-order power ratio vs detuning
- **What to measure**: with the optical path fixed, sweep the RF frequency and record how the +1 / 0 order power ratio varies with detuning (at least 5 frequency points).
- **Required conditions**: as O-4.2, plus the frequency and corresponding power at each point.
- **Model parameters exercised**: order-aware Bragg matching (see [`aom-model.md`](aom-model.md)). This is the only measurement that can verify whether the signed per-order matching is correct.

#### O-4.4 Isolator forward/backward extinction ★priority
- **What to measure**: the forward insertion loss (dB) and the backward isolation (dB).
- **How**: forward, measure P_out/P_in; backward, inject light into the output end and measure what gets through.
- **Required conditions**: wavelength, **the incident polarization direction relative to the isolator's transmit axis** (see the traps in §4), and ambient temperature (the Faraday rotation angle drifts with temperature).
- **Model parameters exercised**: the `pbs` op's `extinctionRatioPpDb` / `extinctionRatioSpDb` and the `faraday_rotator`'s `rotationDeg` (45).

#### O-4.5 Glan prism extinction ratio
- Measured as in O-4.4, but for a single Glan's transmit / reject axes.
- **Required conditions**: the incident polarization angle (swept over at least the transmit axis ±90°).

#### O-4.6 TA gain saturation curve
- **What to measure**: at a fixed drive current, sweep the seed power and record the output power (at least 6 points, covering the linear region through saturation).
- **Required conditions**: drive current (A), seed wavelength, the alignment state of the seed beam against the TA mode, and the housing temperature.
- **Model parameters exercised**: `smallSignalGainDb` (30), `saturationPowerMw`, `outputPowerMaxMw`.

#### O-4.7 Lens focal-plane waist
- **What to measure**: the 1/e² waist (µm) in the back focal plane of a lens of known focal length (e.g. the A230TM-B).
- **How**: a beam profiler or knife-edge scan along z, taking the minimum.
- **Required conditions**: the incident beam's diameter and divergence, the wavelength, and the distance from the measurement plane to the lens's back vertex.
- **Model parameters exercised**: the thick-lens ABCD (`radiusFrontMm` / `radiusBackMm` / `refractiveIndex` / `centerThicknessMm`) + POP diffraction.

### RF (F-2)

#### F-2.1 AD9959 channel output voltage
- **What to measure**: each channel's output Vpp (into 50 Ω), sweeping `amplitudeScale` over at least 4 points.
- **Required conditions**: frequency, the amplitudeScale setting, the load impedance, and the oscilloscope's bandwidth and probe attenuation ratio.
- **Model parameters exercised**: `fullScaleVpp` (1.0).

#### F-2.2 Amplifier gain and compression
- **What to measure**: the ZHL-1-2W+'s output vs input power, swept out to the 1 dB compression point.
- **Required conditions**: frequency, input power (dBm), supply voltage, housing temperature.
- **Model parameters exercised**: the `rf_amplifier`'s gain / saturation parameters.

#### F-2.3 Coax insertion loss
- **What to measure**: RG316's loss vs length at the working frequency (e.g. 80 MHz), for at least 2 lengths.
- **Required conditions**: frequency, length, connector type, and the measurement method (VNA or a power-meter difference).
- **Model parameters exercised**: the cable loss model (see [`introduce/cable.md`](introduce/cable.md)).

#### F-2.4 Switch isolation and insertion loss
- **What to measure**: the ZYSWA-2-50DR's RF1/RF2 insertion loss and its channel-to-channel isolation.
- **Required conditions**: frequency, the TTL control state, supply.

#### F-2.5 RF drive power → diffraction efficiency ★priority
- **What to measure**: sweep the AOM's RF drive power and record the first-order diffraction efficiency (at least 5 points, out to saturation).
- **Required conditions**: as O-4.2.
- **Why it's a priority**: it is the **only case spanning F-2 and O-4** — it verifies the RF chain's power calculation and the optical diffraction model right at their junction, which is also where people most often ask in practice "why doesn't the simulation match reality?".

---

## 3. Where the data lives

`backend/tests/fixtures/bench/<case-id>.json`; the format is documented in the [`README.md`](../backend/tests/fixtures/bench/README.md) and `_template.json` in that directory.

A case's life cycle:

```
measured: null          →  to be measured. CI lists it but does not gate
        ↓  (measure it; fill in the value and conditions)
measured: { ... }       →  ready. CI now requires the corresponding comparator to exist, or it fails
        ↓  (implement the comparator)
CI compares simulation vs measurement  →  fails when it exceeds tolerance_pct
```

**Not one comparator is implemented yet — deliberately.** The shape of the first real data point (which quantity along the optical path to compare, which field of the solver output to take it from) is a guess until the data exists, and writing it early means writing it wrong.
`test_bench_cases.py` fails loudly when somebody fills in a `measured` without a matching comparator, which turns "time to write the comparator" into a gating condition.

---

## 4. Known traps (the kind that waste a whole round)

- **No recorded polarization direction → the isolator/Glan data is void.** A misdiagnosis that keeps recurring in the memories: "glan2 shouldn't transmit but it does" is almost always the incident polarization landing on the reject axis, not a frame bug (see the related entries in [`float64-audit.md`](float64-audit.md) and the `isolator_glan_input_pol_gotcha` memory). Before measuring, establish and record the incident polarization angle relative to the transmit axis.
- **Measure RF power at the component's connector**, not from the source's front-panel reading. Cable loss and mismatch eat several dB, and the model computes what the component actually receives.
- **Measuring an AOM without a Bragg align gives a bogus ~2 % result.** The old straight-through alignment method is obsolete; press the two-stage Bragg align once before measuring.
- **The power meter's wavelength setting**, if forgotten, introduces a 5–15 % systematic bias — exactly the magnitude being accepted.
- **Don't accept cases whose uncertainty exceeds the threshold.** Rather than take a ±8 % measurement to verify a 5 % target, mark it as still to be measured.

---

## 5. Current state

| | Count |
|---|---|
| Cases defined | 12 (O-4 ×7, F-2 ×5) |
| Cases with measured data | **0** |
| Comparators implemented | **0** |

⇒ **O-4 and F-2 cannot currently be accepted.** This is not a gap that can be closed by writing code — it needs lab time.
The recommendation is to do the four ★priority cases first (O-4.1, O-4.2, O-4.4, F-2.5); they cover the most model layers.
