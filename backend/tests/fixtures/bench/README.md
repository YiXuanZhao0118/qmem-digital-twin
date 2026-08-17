# Bench fixtures — pinned laboratory measurements

Backing store for **O-4** (optical, simulated vs measured < 5 %) and **F-2**
(RF, same) in `docs/objectives.md`. What to measure and how is in
[`docs/bench-dataset.md`](../../../../docs/bench-dataset.md) — read that first;
this file only documents the JSON shape.

One case per file, named `<case-id>.json`. `_template.json` is the skeleton and
is itself validated by `tests/test_bench_cases.py`, so it must stay parseable.

## Shape

```jsonc
{
  "id": "aom-first-order-efficiency",   // must equal the filename stem
  "spec": "O-4.2",                      // section id in docs/bench-dataset.md
  "quantity": "power_ratio",            // what is being compared, see below
  "description": "…one line…",
  "tolerance_pct": 5.0,                 // O-4 / F-2 both sit at 5

  "measured": null,                     // null = still to be measured
  // …or, once measured:
  // "measured": {
  //   "value": 0.83,
  //   "unit": "ratio",
  //   "uncertainty": 0.02,             // absolute, same unit
  //   "date": "2026-08-20",
  //   "instrument": "Thorlabs S121C + PM100D, cal 2026-03",
  //   "operator": "…",
  //   "conditions": {                  // everything the model reads
  //     "wavelengthNm": 780.24,
  //     "rfDriveDbm": 30.0,
  //     "rfFrequencyMhz": 80.0,
  //     "beamDiameterMm": 1.2,
  //     "ambientC": 22.0
  //   }
  // }
}
```

### `quantity`

A short vocabulary rather than free text, so a comparator can be written per
kind rather than per case:

| value | meaning | unit |
|---|---|---|
| `power_mw` | absolute optical power at a point | mW |
| `power_ratio` | ratio of two powers (efficiency, transmission) | ratio, 0–1 |
| `extinction_db` | ratio expressed in dB (isolation, extinction) | dB |
| `waist_um` | 1/e² beam radius | µm |
| `voltage_vpp` | RF amplitude into a stated load | V |
| `loss_db` | insertion loss | dB |

Add a row here before using a new one — `test_bench_cases.py` rejects unknown
values so the vocabulary cannot drift silently.

## Uncertainty gate

A case whose `uncertainty` is not comfortably below `tolerance_pct` cannot
verify that tolerance, so the test rejects it rather than letting it look like
coverage. Concretely: `uncertainty / |value|` must be **≤ half** the tolerance
(≤ 2.5 % for a 5 % target).

## Comparators

None are implemented yet, deliberately — see `docs/bench-dataset.md` §3. A
fixture that carries `measured` data but has no comparator makes the test
**fail**, which is the intended signal that the harness has to catch up with
the data. Do not work around it by leaving the data out.
