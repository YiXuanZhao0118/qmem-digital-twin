# Tapered Amplifier (TA) Physics Model — Design

> Status: **DESIGN LOCKED (2026-05-31) — implementing.** Decisions in §7 resolved.
>
> **Locked decisions:** ASE = **6b** (emit ASE only when the TA has no upstream
> seed; seeded → forward gain, no ASE). Direction = **forward A→B only** (no
> backward B→A pass). Polarization = **gain-axis projection** (amplify only the
> gain-axis component, output linear along the gain axis with finite extinction).
> Axis frame = **asset defines `gainAxisDegBodyLocal`; SceneObject defines a
> per-instance rotation around the beam-propagation axis** (waveplate fast-axis
> convention). Readout = **v3 `lab_segments` telemetry** at facets A and B (no DB
> schema change).
>
> Goal (user): model both **seeded and unseeded** operation, define **INPUT and
> OUTPUT as two beam directions**, and read **power + polarization** at each.

## 1. Current state (v1)

- `tapered_amplifier_anchor_op` ([misc_ops.py:91](../backend/app/optical/anchor_ops/misc_ops.py))
  fires on the single `intercept_in` anchor: `P_out = min(P_in · 10^(G0dB/10),
  P_sat)`, `G0dB = smallSignalGainDb (default 30)`, `P_sat =
  saturationPowerMw (default 500)`. **Forward only, polarization untouched, no
  ASE, no unseeded emission.**
- Asset `toptica_boosta_pro`: faces `A` (seed, body −z) → `B` (output, body +z),
  transition `A→B` op `ta_amplify`; `default_params`: `gainLinear 100`,
  `saturationPowerMw 50`, `nominalOutputPowerW 2.0`, `centerWavelengthNm 780`,
  `driveCurrentMaxA 4.0`, `requiresElectricalDrive`. (Note: the op reads
  `smallSignalGainDb`, the asset stores `gainLinear` — a unit mismatch to fix.)
- The v3 anchor tracer only fires ops when a ray **hits a face**, so a source
  that emits with *no* incoming beam (unseeded ASE) is not expressible today
  except via the emitter-seeding path used by `laser_source`.

## 2. Physical picture

A semiconductor TA amplifies the **TE / gain-axis** polarization in a single
forward pass:

- **Seeded** (beam enters the seed port): the input component along the gain
  axis is amplified with saturated gain; the output is strongly linearly
  polarized along the gain axis. Backward ASE is partly suppressed because the
  seed extracts the inversion.
- **Unseeded** (no seed): broadband **ASE** is emitted out **both** facets
  (forward dominant), linearly polarized along the gain axis.
- Direction matters: the **seed/backward facet** (`A`, −z) and the
  **forward/output facet** (`B`, +z) behave differently.

## 3. Proposed `default_params`

```jsonc
{
  "smallSignalGainDb": 20.0,       // unsaturated single-pass gain G0 (replaces gainLinear; 20 dB ≈ 100×)
  "saturationPowerMw": 50.0,       // P_sat (already present)
  "outputPowerMaxMw": 2000.0,      // hard clamp = rated max (BoosTA pro ~2 W)
  "aseForwardMw": 5.0,             // ASE out forward facet B when unseeded
  "aseBackwardMw": 5.0,            // ASE out seed facet A when unseeded
  "gainAxisDegBodyLocal": 0.0,     // TA polarization (TE) axis, body frame
  "polarizationExtinctionDb": 20.0,// output extinction along gain axis
  "centerWavelengthNm": 780,
  "aseBandwidthNm": 5.0,           // metadata for the ASE spectral width
  "requiresElectricalDrive": true
}
```

## 4. Faces / transitions / anchors

- Keep faces `A` (seed/backward, −z) and `B` (forward/output, +z).
- Transitions (bidirectional):
  - `A → B`  op `ta_amplify`  — forward: amplify a seed entering the seed facet.
  - `B → A`  op `ta_amplify`  — backward: amplify a beam entering the output
    facet (e.g. a back-reflection); same saturated-gain law, output polarized
    along the gain axis, exits A.
- Unseeded ASE makes the TA a **conditional emitter** (see §6).

## 5. Power + polarization law (per pass)

Given input ray with power `P_in` and Jones `E_in`:

1. **Polarization projection** onto the gain axis `â(gainAxisDegBodyLocal)`:
   `P_coupled = P_in · |E_in · â|²` (only the gain-axis component is amplified).
2. **Saturated gain** (replaces the v1 hard clamp):
   `P_out = P_sat · ln(1 + (P_coupled / P_sat) · (G0 − 1)) + P_ASE_dir`,
   `G0 = 10^(smallSignalGainDb/10)`, then clamp to `outputPowerMaxMw`.
3. **Output polarization**: linear along `â`, with finite extinction
   `polarizationExtinctionDb` (small orthogonal leak).
4. `P_ASE_dir` = the directional ASE floor (forward/backward), scaled down by
   seed extraction when seeded.

## 6. Solver / tracer changes (the architectural part)

- **Seeded forward/backward**: works in the existing framework (ray hits a
  face → op emits the amplified ray). The op gains polarization + saturated-gain
  logic. **No solver change.**
- **Unseeded ASE**: requires the TA to seed the ray queue like an emitter. Two
  options (decision in §7):
  - **(6a) Always-emit + subtract-on-seed**: register the TA as an emitter that
    always injects forward (and optionally backward) ASE rays; when a seed is
    also present, the seeded pass dominates and ASE is suppressed. Cleanest
    physics, but needs the emitter-seeding path to know "did a seed arrive?".
  - **(6b) Emit-if-no-seed**: a pre-pass detects whether each TA object receives
    an upstream beam; if not, seed ASE rays from its facets. Simpler, but adds a
    pre-pass dependency.

## 7. Open decisions (need your call before I implement)

1. **Unseeded ASE**: do option **6a** (always-emit, suppress on seed) or **6b**
   (emit only when no seed), or **defer ASE** (v2 = seeded bidirectional only,
   unseeded later)?
2. **Backward direction**: model `B→A` backward amplification now, or only
   forward `A→B` + ASE for v2?
3. **Polarization**: is "amplify only the gain-axis component, output linear
   along gain axis" the behavior you want, or should the TA pass input
   polarization through (gain only)?
4. **INPUT/OUTPUT read-out**: where should power+polarization be surfaced —
   as v3 `lab_segments` telemetry at the A and B facets (the beam-scope reads
   them), or also persisted on the SceneObject for the panel? 
5. **`gainLinear` vs `smallSignalGainDb`**: standardize on `smallSignalGainDb`
   (and migrate the BoosTA asset), correct?

## 8. Phased implementation (once §7 is settled)

1. Asset `default_params` update (gain unit fix + new fields) — JSON + targeted
   DB sync (the §-anchors-safe sync, not a full re-seed).
2. `ta_amplify` op: polarization projection + saturated gain + output pol +
   directional ASE add; bidirectional `A↔B`.
3. (If 6a/6b) emitter-seeding hook for unseeded ASE.
4. INPUT/OUTPUT telemetry on the A/B facet segments.
5. Tests: seeded gain/saturation, polarization projection + extinction,
   unseeded ASE both facets, backward pass.
