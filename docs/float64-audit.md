# The float64 end-to-end audit — anchor pose precision

> Audit date: **2026-08-17**. Corresponds to prerequisite item 2 in §7 of [`docs/objectives.md`](objectives.md).
> Audit goal: verify that an anchor pose stays float64 all the way from **DB → API → tracer**, well enough to support **O-1 (position ≤ 1 µm)** and **O-2 (angle ≤ 0.1 µrad)**.

---

## 0. Conclusion

**The machine path (DB / API / solver) is already clean float64 and needs no changes.**
**Every precision loss happens in the human authoring UI (the PHY Editor's anchor editor).**

That is the good news — the repairs are confined to one file, `Asset3DEditor.tsx`, rather than a cross-layer rework.

| Stage | Verdict |
|---|---|
| DB column types | ✅ clean |
| Pydantic / JSON serialization | ✅ clean |
| Backend tracer / pose math | ✅ clean |
| The device-registry authoring path | ✅ clean |
| The frontend align write-back path | ✅ clean |
| **The PHY Editor anchor write path** | ~~❌ breach A~~ → ✅ **fixed (2026-08-17)**, see §2.1 |
| **PHY Editor face-picking** | ❌ **breach B: a fundamental limit that cannot be fixed** → ✅ now graded visibly in the UI (2026-08-17), see §2.2 |
| PHY Editor input spinner granularity | ~~⚠️ breach C~~ → ✅ **fixed (2026-08-17)**, see §2.3 |
| The RF cable cache digest | ⚠️ a 17 µrad invalidation threshold; acceptable in the RF domain |

---

## 1. The clean stages (verified one by one)

### 1.1 DB columns

- **`assets_3d.anchors`** — `JSONB` ([`models/hardware.py:106`](../backend/app/models/hardware.py#L106)).
  Postgres stores jsonb numbers as `numeric`, i.e. arbitrary precision, so float64 round-trips losslessly.
- **`objects.x_mm / y_mm / z_mm / rx_deg / ry_deg / rz_deg`** — `sa.Float()`
  ([`models/scene.py:42-47`](../backend/app/models/scene.py#L42), created in `0001_initial_schema.py:56-61`).
  The compiled DDL, measured:
  ```
  sa.Float() DDL -> FLOAT
  ```
  Postgres always reads an unqualified `FLOAT` as **`double precision` (float8)**. **Not `real`.**
- Precision headroom: near 90°, float64's absolute precision is about 1.4×10⁻¹⁴ degrees = 2.5×10⁻¹⁶ rad, which is **9 orders of magnitude** looser than 0.1 µrad (10⁻⁷ rad). Storing angles in degrees is not a problem at all.

### 1.2 Pydantic / JSON

- `Vec3V3.x/y/z: float` ([`schemas_v3.py:23-26`](../backend/app/schemas_v3.py#L23)) = a Python `float` = float64.
- All four Vec3 fields of `AnchorV3` ([`schemas_v3.py:88-115`](../backend/app/schemas_v3.py#L88)) use that same type, with **no `Decimal`, no custom encoder and no `round`**.
- JSON number serialization (Python `repr` / pydantic-core) uses the shortest round-tripping representation, so float64 → JSON → float64 is bit-identical.

### 1.3 Backend math

- Across a whole-backend grep for `float32|float16|astype|dtype=`, **there is not a single float32 on the geometry/optics path**.
  The only float32 is [`pop_field.py:210`](../backend/app/optical/pop_field.py#L210) `out.astype(np.float32)` — an intensity image for POP display, which never enters geometry.
- [`pose.py`](../backend/app/optical/pose.py)'s rotation matrices are `dtype=float` (= float64), and `scipy.spatial.transform.Rotation` is float64 internally. Point/direction transforms and `compose_transforms` are float64 throughout.
- A whole-backend grep for `round(` hits only `magnetics_dc.py` (magnetic field display output, `round(v, 6)`), `schemas.py:2301` (timing snapped to TIMING_RESOLUTION_NS, deliberate) and `pop_pass.py` (pixel indices). **Zero hits on the anchor / pose path.**

### 1.4 The device-registry authoring path

`materialize_device_anchors` at [`services/device_seed.py:69-111`](../backend/app/services/device_seed.py#L69) reads with a bare `float()` and does its Gram-Schmidt orthogonalization in float64, with no quantization anywhere.
**This is currently the only way to author an anchor to 0.1 µrad** (see the conclusion of §2.2).

### 1.5 The frontend align write-back

- `syncFiberEndpointToKindParams` ([`sceneStore.ts:207-242`](../frontend/src/store/sceneStore.ts#L207)) moves the `node.posMm` / `tau` arrays directly, with no formatting.
- There is **zero `Float32Array`** under `frontend/src/optical/`.
- three.js's `Vector3` / `Matrix4` / `Quaternion` elements are all JS numbers = float64; only `BufferAttribute` is float32, and the physics path never reads it (see §2.2).

---

## 2. The breaches

### 2.1 Breach A — `mmText()` quantized anchor writes to 1e-3 ✅ fixed

> **Status: fixed 2026-08-17.** `mmText` was deleted and all three write paths now use the same lossless `n()`
> (`String(value)`) as the load side. `Asset3DEditor.tsx` no longer contains `mmText`, and `tsc --noEmit` passes.
> A comment was added where `n()` is defined explaining why it must stay lossless, so nobody reintroduces `toFixed`.
> The original analysis is kept below as a record.

The original [`Asset3DEditor.tsx:362-364`](../frontend/src/components/Asset3DEditor.tsx#L362):

```ts
function mmText(value: number): string {
  return Number(value.toFixed(3)).toString();
}
```

It was applied on **three write paths** (not display formatting — it wrote into `draft.anchors`, which saves straight into the DB):

| Path | Quantized fields | Impact |
|---|---|---|
| `moveFace` | position px/py/pz | **1 µm quantization** |
| `autoPlaceFace` | position + **axisX (nx/ny/nz)** | 1 µm + **~870 µrad** |
| `orthogonalizeAnchorY` | **axisY (yx/yy/yz)** | **~870 µrad** |

**Quantifying the error:**
- **Position**: `toFixed(3)` = 0.001 mm = **1 µm**. O-1's entire error budget, **consumed by a single write**.
- **Direction**: rounding a unit vector's components to 1e-3 gives a worst-case component error of 5×10⁻⁴, and the three components compose into an angular error of up to √3 × 5×10⁻⁴ ≈ **8.7×10⁻⁴ rad ≈ 870 µrad** — roughly **8700× over** O-2's 0.1 µrad budget.

**The trigger surface is larger than it looks.** `orthogonalizeAnchorY` is attached to the `onBlur` of all six axisX **and** axisY inputs ([3224–3226](../frontend/src/components/Asset3DEditor.tsx#L3224) / [3231–3233](../frontend/src/components/Asset3DEditor.tsx#L3231)) — so merely tabbing through the axisX fields rewrote axisY to 3 decimal places.

**The saving grace: loading is lossless.** Reading from the DB into the form goes through `n()` ([:126-128](../frontend/src/components/Asset3DEditor.tsx#L126)) = `String(value)`, a complete float64 round trip. **So only anchors that were actually "touched" are corrupted; an untouched one saves with its original value.** How much of the existing DB is affected depends on the editing history and needs a measured audit (see §4).

### 2.2 Breach B — face-picking derives anchors from a float32 mesh

`detectFaceCenterFromHit` ([`Asset3DEditor.tsx:375-571`](../frontend/src/components/Asset3DEditor.tsx#L375)) reads vertices with `target.fromBufferAttribute(positionAttr, vertIdx)` ([:405](../frontend/src/components/Asset3DEditor.tsx#L405)) — and `positionAttr` is a `Float32Array`. Both the centre and the normal are computed from those float32 vertices and then written into the anchor by `autoPlaceFace`.

**Quantified term by term:**

| Error source | Magnitude | Against O-1/O-2 |
|---|---|---|
| float32 vertices → **position** | at a 100 mm part scale: 100 × 1.19×10⁻⁷ ≈ **0.012 µm** | ✅ within budget |
| float32 vertices → position (CAD origin far from the part, coordinates ~5000 mm) | ≈ **0.6 µm** | ⚠️ approaching the budget |
| float32 vertices → **normal** (1 mm triangle edge, 50 mm coordinates) | δ/L ≈ 6×10⁻⁶ rad = **6 µrad**; averaging N triangles reduces it to 6/√N µrad, so N ≈ 3600 would be needed to reach 0.1 µrad | ❌ over budget in practice |
| **The triangulation itself** (not a floating-point error) | B-1 permits 0.05 mm of geometric deviation; a 0.05 mm sag over a 10 mm face ≈ **5 mrad = 5×10⁴ µrad** of normal error | ❌ **50 000× over budget** |

**This is the most important conclusion of the audit:**

> **Face-picking fundamentally cannot author a µrad-level anchor axis — the dominant error is mesh triangulation, not the floating-point format.**
> Even if the whole path were made float64, a normal picked on a curved surface is still "the triangle's normal", not "the CAD surface's normal".
>
> ⇒ **An anchor that has to satisfy O-2 must be authored numerically through the device registry** (`materialize_device_anchors`, §1.4), from datasheet / CAD nominal values, never by mouse. Face-picking can only place things to "geometry grade" (~0.05 mm / ~mrad), which suits mechanical positioning and visualization but not optical-interface axes.

#### The countermeasure that landed: the PHY Editor grades each anchor's authority (2026-08-17)

Breach B itself cannot be "fixed" — it is the physical ceiling of mesh triangulation. What can be done is to **make the grade visible**, so nobody assumes a mouse-picked axis is precise.
Two badges (`pos` / `axis`) were added under each row's `anchor_id` in the anchor table, with the grade derived **live** by comparing the draft against the device template (`gradeAnchor`, `Asset3DEditor.tsx`) — **no schema change, no new column**:

| Badge | Meaning |
|---|---|
| `●` **device** (green) | The device template declares this field and the draft still matches it. Numerically authored from datasheet / CAD — **the only grade that can carry 1 µm / 0.1 µrad** |
| `◐` **overridden** (amber) | The template declares it but the draft has departed — overridden by a face-pick, a drag or a typed value. Its precision equals whatever overrode it, never better |
| `○` **geometry** (grey) | There is no device, or the template leaves this field to the user. Face-picking is limited to ~mrad by triangulation |

The key to the comparison: **an anchor's `id` is the template's `role`** (`materialize_device_anchors` writes `role → id`), with `name` distinguishing repeated roles (AD9959 CH0..CH3, rf_switch RF1/RF2). The tolerances `GRADE_DIR_TOL_RAD = 1e-6` and `GRADE_POS_TOL_MM = 1e-6` sit far below face-pick error (~mrad / ~0.05 mm) and far above float64 round-trip noise.

**A useful side effect of the design**: the badge flips from `device` to `overridden` the instant a face-pick happens, which turns "the face-pick warning" into a permanent display rather than a one-shot dialog; and old values quantized by the retired `toFixed(3)` also show as `overridden`, so this doubles as the UI version of §3-5's "scan for existing corrupted data".

**It is display only and never blocks a save.** Whether to upgrade it into a hard gate on optical kinds is left for later.

**Measured (2026-08-17, 27 assets)**: only 3 have device templates leaving fields unauthored, and all three are RF —
`minicircuits_zhl_1_2w_plus` (pos 0/2), `minicircuits_zyswa_2_50dr` (dir 0/4, pos 0/4) and `ppg` (pos 0/1).
**Every optical anchor's position and axis is numerically authored by a device template**, so O-2 is met across the current catalog.
(Note: the comment at the top of `_device.ts` saying "only the AD9959 has measured coordinates" is out of date.)

### 2.3 Breach C — the inputs' `step="0.01"` ✅ fixed

> **Status: fixed 2026-08-17.** The nine anchor position / axisX / axisY inputs now use
> `ANCHOR_STEP = "0.001"`: one arrow-key press on a position is **1 µm** (= the O-1 budget), and on a direction
> component ≈ **1 mrad** — ten times finer than before. The three aperture fields keep `0.01` (a clip radius, outside the O-1/O-2 budget).
> Verified on the machine: the position spinner went 141.85 → 141.851 (Δ = 0.001 mm).

Originally `<input type="number" step="0.01">`: one arrow-key press was **10 µm** on a position and **10 mrad** on a direction component.
It is not a hard quantization (an arbitrary typed value passes), but it is the default granularity the UI demonstrates to the user, which contradicts a µm/µrad target.

**A latent trap missed during the audit and only found while fixing it (important):**

`step` is not only the spinner increment; it is also an **HTML validity constraint** — a value off the step grid raises `stepMismatch`.
After breach A was fixed, the fields hold 17-digit values (`-0.5734623443633284`), which by rights should become `:invalid` immediately. **Measured, they don't**, because:

> The HTML spec's **step base** comes from the **`value` content attribute** when there is no `min` attribute; React's controlled input mirrors the value into that attribute, so "the value is its own base" and always lands on the grid.

The measured evidence (same field, only the `value` attribute removed):

| State | `stepMismatch` |
|---|---|
| Rendered normally by React (with the `value` attribute) | `false` |
| After a manual `removeAttribute("value")` | `true` — "the two nearest valid values are -0.58 and -0.57" |

⇒ **Invariant: these anchor inputs must stay controlled (`value={...}`).** The moment they become uncontrolled
(`defaultValue`, or hand-managed DOM values), every full-precision anchor value turns `:invalid`.
That is also the only safe premise for "keeping a finite `step` rather than switching to `step="any"`" — and it is written into the comment on `ANCHOR_STEP`.

### 2.4 Observation D — the RF cable cache digest (acceptable)

[`DigitalTwinViewer.tsx:3815`](../frontend/src/components/DigitalTwinViewer.tsx#L3815) and `:3880` build a cache-invalidation digest string with `.toFixed(3)`.
Meaning: when the target object's pose moves less than 0.001 mm / 0.001° (= **17 µrad**), the cable endpoint cache is not recomputed.
**This is a cache threshold, not a stored value** — the comment already marks it `raw-anchor-ok: digest of stored body-frame value`. The RF domain has no µrad requirement, so it is **judged acceptable, but worth recording**: copying the same pattern onto an optical path later would violate O-2 outright.

---

## 3. Recommended repairs (in priority order)

1. ~~**Remove `mmText` from the write paths**~~ — ✅ **done 2026-08-17.** All three call sites (`moveFace` / `autoPlaceFace` / `orthogonalizeAnchorY`) use the same lossless `n()` as the load side; `mmText` had no other use in the file and was deleted. Breach A is gone.
2. ~~**Change `step` to `any`**~~ — ✅ **done 2026-08-17, but not with `any`.** It became `ANCHOR_STEP = "0.001"`: `step="any"` makes Chrome's arrow keys fall back to a step of 1.0 (a disaster for a direction component in [-1,1]), while a finite step cannot misjudge validity in a controlled input (see §2.3). Position and direction both use 0.001; aperture stays at 0.01.
3. ~~**Land the policy: two grades of anchor authoring**~~ — ✅ **done 2026-08-17 (display layer).** The PHY Editor shows a per-anchor `device` / `overridden` / `geometry` badge; see §2.2. It shipped as three grades rather than the two originally envisaged: `overridden` (once device-grade, since overridden) is in practice the state most worth seeing. What is still undecided is whether to upgrade it into a **hard save gate** on optical kinds.
4. ~~**CI guards**~~ — ✅ **done 2026-08-17.** [`.github/workflows/ci-correctness.yml`](../.github/workflows/ci-correctness.yml) (the repo's first workflow, with a postgres service on the backend job). Three rules across two files:
   - [`backend/tests/test_anchor_precision_guard.py`](../backend/tests/test_anchor_precision_guard.py) — bit-identical serialization, bit-identical DB round trips (anchors + object pose), and `information_schema` assertions that `objects.x_mm…rz_deg` are `double precision` and `assets_3d.anchors` is `jsonb`. All with `==`, never `approx`. It also carries a **self-guard**: verifying that the witness values themselves really do detect float32 and 3-decimal rounding, so nobody can turn the test into a no-op by swapping the constants for integers.
   - [`frontend/src/components/__tests__/anchorWritePath.guard.test.ts`](../frontend/src/components/__tests__/anchorWritePath.guard.test.ts) — scans every `updateAnchor(...)` call site (extracting arguments by balanced parentheses) and forbids `toFixed` / `toPrecision` / `Math.round`; asserts `mmText` does not exist; asserts all nine anchor inputs use `ANCHOR_STEP` (≤ 0.001) and stay controlled (the §2.3 invariant).
   - **Verified to block**: reverting `moveFace`'s `px: n(position.x)` to `toFixed(3)` made the guard fail immediately with its reason printed; restoring it went green again.
5. ~~**Measure how much existing data is corrupted**~~ — ✅ **scan completed 2026-08-17: across all 27 assets / 23 with anchors / 41 anchors, 0 victims of breach A were found.** Read-only; no data was modified (locked rows were never touched).

   **The axis vectors (123 of them) — the conclusion is definitive, not merely "nothing found":**
   - 113 are axis-aligned (`(±1,0,0)` and the like). Such vectors **have no decimals to truncate**, so `toFixed(3)` is the identity on them — they therefore **cannot** have been corrupted by breach A.
   - The remaining 10 non-trivial vectors all have `||v|−1|` < 1e-9 (float64 grade). A unit vector quantized to 3 decimals is off in magnitude by ~1e-4 (e.g. `(0.7071,0.7071,0)` → `(0.707,0.707,0)`, a residual of 1.5e-4). All clean.

   **Positions (41 of them) — compared row by row against the device templates:**
   | Category | Count | Notes |
   |---|---|---|
   | Exactly matching the template | 27 | clean |
   | 8–63 mm away from the template | 7 | **deliberate measured values, not rounding**. 3-decimal rounding can cause at most a 5e-4 mm error, 4–5 orders of magnitude smaller |
   | Unverifiable | 7 | the `zhl_1_2w` / `zyswa_2_50dr` / `ppg_sma` device templates declare no position (see the measured table in §2.2), so there is nothing to compare against |

   **Why it is this clean**: breach A only occurs when somebody touched an anchor in the PHY Editor and saved. The vast majority of anchors were generated on the backend in float64 by `materialize_device_anchors` (§1.4), and 17 of the 23 assets with anchors are locked (frozen after review) — so the window in which they could be touched was narrow to begin with.

   ~~⚠️ Those 7 "away from the template" anchors expose a limitation of the §2.2 badges~~ — ✅ **the device templates were backfilled on 2026-08-17.**

   The problem was: the AD9959's 4 `rf_out`s and the AOM's 3 anchors have **hand-measured values on the asset side and nominal placeholders on the template side**, while the badge's semantics assume the template is the truth — an assumption that does not hold for these rows, so the *more* accurate data was labelled `◐ overridden`.

   What was backfilled (in `frontend/src/devices/`, syncing **template ← asset**; not a single asset row was touched):

   | device | Field | Old template (nominal) | New (measured, from the locked asset) |
   |---|---|---|---|
   | `ad9959` | 4 × `rf_out` positions | `x=82.55`, y evenly spaced −30/−10/+10/+30, z=4 | `(55.1, 21.7, 2)` / `(33.3, 27.8, 2)` / `(34.5, −31, 2)` / `(55.058, −24.7, 2)` |
   | `ad9959` | 4 × `rf_out` directions | `+X` (the board edge) | **`+Z`** (vertical SMA jacks on the board face — 90° off) |
   | `aa_mt80_a1_5` | the two optical faces | `z = ∓0.8`, directions ∓Z | **`y = ∓11.2`, directions ∓Y** |
   | `aa_mt80_a1_5` | `rf_in` position | `x=45.5` (bbox max / the mating face) | `x=37.174` (the flange, the asset's value) |
   | `ppg_sma` | `rf_out` direction | `+X` | **`+Z`** (90° off; outside the original scope, fixed in passing) |

   Two incidental findings:
   - The AOM's `±0.8` implies a **1.6 mm** optical-face separation — exactly the old `crystalLengthMm` that alembic 0120 abolished. The same file's `defaultParams.crystalLengthMm: 22.4` comment explicitly says "equals this device's intercept_in → intercept_out separation", so the template was previously **self-contradictory**.
   - `ppg_sma`'s wrong direction only surfaced while sweeping the direction fields; comparing positions alone had missed it.

   ~~The remaining 7 fields are undeclared in the `zhl_1_2w` / `zyswa_2_50dr` / `ppg_sma` templates~~ — ✅ **completed the same day, backfilled after verifying against the GLB geometry.**

   These three devices have no nominal values to copy, so the GLB actually used for rendering was measured directly: take 0.5 mm cross-sections along the connector axis and see where the cross-section jumps from housing to connector.

   | device | Backfilled value | GLB evidence |
   |---|---|---|
   | `zhl_1_2w` | `(±47.2, 0, 0)` | The housing ends at x=44.5; 44.5→47.0 is an **empty recess**, and the connector body runs 47.0→55.5. 47.2 is exactly the connector's base; the whole section's centroid is (0.000, 0.000) = the connector axis |
   | `zyswa_2_50dr` | `(±9.525, ±4.7, 0)` ×4 | The housing face lies between x = 9.5 and 10.0; the vertex mass of the connector barrels at \|x\| 14–20 concentrates at **y = ±4.7** |
   | `ppg_sma` | `(0, 0, 4.8)` | The axis (x,y)=(0,0) matches to three decimals; **but this scan cannot pin z=4.8 to a feature** (the housing's top face is around z≈5.8 and the connector runs 6.3→13.8) — the weakest-evidenced of the three |

   ⚠️ **One misjudgement along the way is worth recording**: at one point the conclusion was "the asset values are wrong" (ZYSWA's transverse offset should be ±4.191, ZHL's ±44.45). That came from using the **procedural builders** (`createRfSwitch` / `createMinicircuitsZhl12wPlus`) as the reference — but all three assets are in fact **baked GLBs**, and the procedural code is only their outdated CAD ancestor (the GLB's x extent is 3 mm longer than the builder's). Once the GLBs were measured instead, all three assets' values were corroborated. **The lesson: the `primitive://` renderers of these kinds are no longer a source of truth — to verify geometry, measure the file actually loaded from `assets/files/glb/`.**

   Verification: across all assets, **41/41 positions and 41/41 directions agree with their templates, with 0 divergences and 0 undeclared**; in the PHY Editor all 7 anchor badges on those three devices read `● device`.

---

## 4. Not covered

- **The quantization footprint in the existing DB data has not been measured** (recommendation 3-5; it needs the stack running).
- **The live DB's actual `information_schema` types have not been verified** — this audit inferred float8 from the compiled SQLAlchemy DDL (Postgres's definition of `FLOAT` is unambiguous, so the risk is low); recommendation 3-4 should add the real query.
- The precision of the optical polyline returned by the frontend's `v3TraceAdapter` was not audited (that is a display path and never writes back to an anchor).
