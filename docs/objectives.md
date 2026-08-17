# qmem-digital-twin — quantified objectives

> Created **2026-08-17**. This file defines the project's **quantified acceptance targets**, not a description of the current state.
> For the current state and architecture see [`docs/introduce/README.md`](introduce/README.md).
> Every target here carries three things: **a numeric threshold + a measurement method + how CI gates it**. Anything missing one of those is not a target and lives in §7, "still to be quantified".

---

## 1. Scope and general rules

| Item | Decision |
|---|---|
| Subsystems covered | Optical solving and rendering, RF and multiphysics, the asset pipeline (BUILD), the data layer and API (**all four**) |
| Acceptance mechanism | **CI gating** — every target maps to an automated test/benchmark; exceeding it fails and blocks the merge |
| Reference hardware (performance targets) | A discrete-GPU desktop: **RTX 3060 / Ryzen 5 5600 class or better**, a 1920×1080 window |
| Reference hardware (correctness targets) | Hardware-independent; every CI runner must pass |

**General rule:** performance targets depend on hardware, so CI gating comes in two parts — (a) hardware-independent **deterministic proxy metrics** (draw-call count, triangle count, CPU frame-build time, pure solver compute time) gate on ordinary runners; (b) real FPS and end-to-end latency are measured and gated on a **pinned reference machine** (a self-hosted runner). See §6.

---

## 2. Acceptance summary

| ID | Target | Threshold | Gating tier |
|---|---|---|---|
| **R-1** | Interactive FPS | 60 FPS (frame time ≤ 16.7 ms), p95 ≥ 45 FPS | reference machine |
| **R-2** | Render resolution | 1920×1080 native, dpr capped at 1.5, MSAA×4 | ordinary runner |
| **R-3** | No degradation while interacting | No resolution drop or shadow disabling during drag/orbit | reference machine |
| **R-4** | Per-Asset3D geometry budget | LOD0 ≤ 500k tris / ≤ 20 MB GLB | ordinary runner |
| **R-5** | LOD tiers | LOD1 ≤ 100k, LOD2 ≤ 20k tris, switched by **screen-space error ≤ 1 px** | ordinary runner |
| **R-6** | Scene scale | **No cap on component count**; R-1 is held with instancing + frustum/occlusion culling + LOD | reference machine |
| **R-7** | Scene load | A cached scene interactive in < 3 s | reference machine |
| **R-8** | Cold start | < 10 s (including the DB connection + the first GLB fetch) | reference machine |
| **O-1** | Optical spatial accuracy (position) | Within **1 µm** of the analytic solution | ordinary runner |
| **O-2** | Optical spatial accuracy (angle) | Within **0.1 µrad** of the analytic solution | ordinary runner |
| **O-3** | Physics numerics (inner) | Within **0.1 %** of the analytic solution | ordinary runner |
| **O-4** | Physics numerics (outer) | Within **5 %** of lab measurement | ordinary runner (pinned dataset) |
| **O-5** | Solve latency | Parameter change → optical path redrawn, p95 < **500 ms** | reference machine |
| **F-1** | RF numerics (inner) | Within 0.1 % of the analytic solution | ordinary runner |
| **F-2** | RF numerics (outer) | Within 5 % of measurement | ordinary runner (pinned dataset) |
| **F-3** | RF topological correctness | Propagation BFS connectivity 100 % correct | ordinary runner |
| **B-1** | BUILD geometric fidelity | LOD0 within 0.05 mm maximum deviation from the source CAD | ordinary runner |
| **B-2** | BUILD conversion time | ≤ 60 s per asset in the browser; oversized parts go through offline `cascadio` | reference machine |
| **A-1** | API latency | Read endpoints p95 < **300 ms @ 10 concurrent** | reference machine |
| **A-2** | Concurrent users | **5–10 people** in the lab on the same scene with no data corruption | ordinary runner |
| **A-3** | Data-layer correctness | Migrations reversible; a write to a locked row always 422s | ordinary runner |

---

## 3. Rendering targets (R)

### R-1 Interactive FPS — 60 FPS on a discrete-GPU desktop
- **Definition**: measure the frame-time histogram over a scripted fixed camera path (a 60 s orbit + 2 zooms + 1 component drag).
- **Threshold**: p50 ≤ 16.7 ms, **p95 ≤ 22.2 ms (= 45 FPS)**, worst single frame ≤ 50 ms (an occasional GC is allowed).
- **Measurement**: Playwright + `requestAnimationFrame` sampling, discarding the first 3 s of warm-up.
- **CI**: on the reference-machine runner, compared against a pinned baseline; a > 10 % regression fails.

#### Measured, 2026-08-17 — comfortably inside budget, but vsync-clamped

Hand-measured on the development machine over a 4 s scripted orbit (synthetic pointer drag on the canvas), sampling `requestAnimationFrame` deltas and counting real draw calls by wrapping the WebGL context's `drawElements` / `drawArrays`. **Not a CI baseline** — different hardware from §1's reference machine, and a short run rather than the 60 s path above.

| Metric | Measured | Threshold | |
|---|---|---|---|
| Frame time p50 | **4.2 ms** | ≤ 16.7 ms | 4× headroom |
| Frame time p95 | **4.6 ms** | ≤ 22.2 ms | 4.8× headroom |
| Worst single frame | **7.3 ms** | ≤ 50 ms | 6.8× headroom |
| Draw calls / frame | **avg 119, max 125** | ≤ 2000 (R-6) | 6 % |
| Triangles / frame | avg 1.69 M | (no cap) | |

⚠️ **The p50 is clamped by vsync, not by the renderer.** The display runs at 240 Hz (4.17 ms), and the app drew 959 of 960 available frames during the drag — so 4.2 ms is an *upper bound* on the true cost, and the real headroom is larger than the table suggests by an unknown margin. Do not quote 4.2 ms as "rendering costs 4.2 ms".

Two things this measurement pinned down that the static count in §R-6 could not:
- **On-demand rendering works as claimed**: over an idle second the page took 242 rAF ticks and issued **zero** draw calls.
- **Real draw calls are ~2× the scene-graph count** (119 vs 66) because the `DirectionalLight`'s shadow map re-renders the scene. §R-6's walk only estimates the main pass, so treat it as a lower bound on the real draw list — still 6 % of budget either way.

### R-2 Render resolution — native 1080p + MSAA×4
- Render buffer = CSS size × min(devicePixelRatio, **1.5**).
- WebGLRenderer antialiasing = MSAA×4 (`antialias: true` + samples=4).
- **CI**: a unit test asserting the renderer settings and the dpr clamp; no GPU required.

### R-3 No degradation while interacting
- During drags, orbits and aligns it **must not** dynamically drop resolution, nor disable shadows or post-processing.
- This closes off the "trade image quality for FPS" escape route — FPS must be earned through the geometry budgets in R-4–R-6.

### R-4 / R-5 Per-asset geometry budget — three LOD tiers

| Tier | Triangles | GLB size | Typical use |
|---|---|---|---|
| LOD0 | ≤ 500k | ≤ 20 MB | selected / close |
| LOD1 | ≤ 100k | ≤ 5 MB | medium |
| LOD2 | ≤ 20k | ≤ 1 MB | far / scene overview |

- The LOD0 cap is aligned with the measured floor (a 1353-part board measured 464k tris / 18.5 MB).
- **CI**: on asset upload/import, check all three tiers exist and fit their budgets; a missing tier fails.

#### The switching metric is screen-space **error**, not screen-space size

The "Typical use" column above is descriptive only — **the tier is not chosen by camera distance.** Distance (or projected object size) is the wrong metric because it is not scale-free: a 2 m optical table and a 12.7 mm mirror filling the same number of pixels need completely different triangle densities, and for any object large enough to contain the camera inside its bounding sphere the distance term collapses to 0 and pins it at LOD0 forever.

The tier is chosen by how many pixels the tier's own **geometric error** projects to:

```
px_error = ε_world × viewportHeight / (2 × d × tan(fov/2))
choose the coarsest tier whose px_error ≤ τ,  τ = 1 px
```

- **`ε_world`** — that tier's maximum deviation from LOD0, in mm. It is produced at generation time (meshoptimizer's `simplify()` returns it as the second element of its result tuple; `MeshoptSimplifier.getScale()` converts the relative value to absolute) and **stored per tier** in `asset_lods.error_mm`. LOD0's ε is 0 by definition. This is the same quantity B-1 measures, so the spec and the runtime switch agree on one number.
- **`d`** — distance from the camera to the object's **world AABB surface** (`Box3.distanceToPoint`, clamped at the near plane), **never** to its centre. The centre form is the degenerate case above.
- Object size does not appear in the formula. Large and small assets are handled by the same rule with no special case.
- **Hysteresis 15 %** on each threshold, so an object sitting on a boundary cannot thrash between tiers.

Calibration check: the 1353-part board's LOD2 measures ε ≈ 1.8 mm; at 1080p / fov 50° that is 1.0 px at 2 m and 4.2 px at 0.5 m — i.e. τ = 1 px reproduces roughly the distances the table above describes, while scaling correctly for assets of any size.

**Known limitation of the metric.** `ε` is a quadric error bound, not a perceptual one: thin plates, hole grids and slender posts can vanish without ε growing much (see the note at `three/loadAsset/stl_builders/analog_devices_ad9959_pcbz.ts:120`). In the extreme, a **gentle** decimation of a regular surface reports ε of exactly **0** — measured: a 131k-triangle icosphere reduced to 100k returns 0, while the same mesh at 293k returns 0.0022 — because the collapsed vertices still lie on the original surface. A zero-ε tier is treated as free and always wins, which is correct if the metric is believed and is the same under-reporting in its limiting case. Two guards, neither of which is expressible in the formula:
- the **selected** object always renders at LOD0;
- an asset may pin a floor via `asset_lods` policy (see R-5 policy below), for parts whose features quadric error under-reports.

#### R-5 per-asset policy

Uniform whole-asset LOD is always wrong somewhere on a very large asset (stand at one corner of the table and the far end is dragged to LOD0 with you). Rather than chunking — which is essentially a hand-rolled virtual-geometry system and is **deliberately out of scope** — each asset carries a policy:

| Policy | Meaning | For |
|---|---|---|
| `auto` (default) | pure px_error rule | ordinary components |
| `pin_lod0` | never coarsen | parts whose features quadric error under-reports |
| `cap_lod1` | never load LOD0 | large background structure (optical table, chassis) |
| `exclude` | no LOD at all | procedural / spline geometry (fiber, rf_cable) — cheap already, and their AABB is huge but nearly empty |

Chunking is revisited only if measurement shows a single large asset is the actual bottleneck. For the optical table the expected win is not triangle count at all but **draw calls** — LOD2 generation merges by material, which is what R-6's ≤ 2000 draw-call budget actually responds to.

### R-6 Scene scale — no cap on component count
- No limit is placed on the number of components; gating uses the following **deterministic proxy metrics** instead (ordinary runner, headless scene construction):
  - draw calls ≤ **2000** (merging same-type components with instancing)
  - per-frame CPU scene traversal ≤ **4 ms**
  - frustum culling must be effective: off-screen components must not enter the draw list
- Actual FPS is policed by R-1 on the reference machine.

#### Measured, 2026-08-17 — the proxy metrics are nowhere near their budgets

Hand-measured on the development machine against the live lab scene (26 components). **Not a CI baseline**: the numbers below come from one scene on one machine, so treat them as a sanity reading, not as the pinned figures §6 wants on the reference runner.

| Metric | Measured | Budget | |
|---|---|---|---|
| Draw calls | **66** | ≤ 2000 | 3 % |
| Visible triangles | **683 129** | (no total cap) | |
| Meshes / lines | 44 / 22 | | |
| Unique geometries / materials | 61 / 64 | | |
| Hidden meshes still in the graph | 63 (4 740 tris) | | negligible |

Method: walk the rendered scene graph, count each visible `Mesh` (plus one per extra material group) and `Line`. It needs no GPU and is the same shape as the headless count the CI gate would compute — but it counts **the main pass only**. The live measurement in §R-1 recorded 119 real draw calls against this 66, the difference being the `DirectionalLight`'s shadow map re-rendering the scene, so **treat this walk as a lower bound on the real draw list**, not the upper bound frustum culling alone would make it.

Where the triangles are: `ad9959` alone is 238 802 (35 %), and the three RF cables carry 271 766 between them (40 %) — almost all of it `bnc_male` connectors at 64.7k each. **Those connectors bypass LOD entirely**: a cable renders through `buildSceneObjectFromBindings`' spline branch and its connectors are built by the procedural cable renderer, never reaching `loadAssetObject`'s GLB path where the LOD node is created. That is the one obvious remaining lever — and by these numbers it is not worth pulling.

**Reading: geometry is not this scene's constraint.** Neither R-4/R-5 (see the P2 result in §7-3) nor R-6 is close to binding. Any future "the viewer feels slow" report should be measured before anything here is optimised further — the cost is more likely shadows, the beam-tube rebuilds, or React/CPU work than the draw list.

R-1 has since been measured too — see the block under §R-1. Same conclusion, with far more headroom than these static counts alone could show.

### R-7 / R-8 Load times
- **R-7 scene load < 3 s**: from entering the route to "first interactive" (components can be clicked). GLBs go through an IndexedDB cache + meshopt compression.
- **R-8 cold start < 10 s**: with the cache cleared and a cold DB connection, to the same interactivity criterion.
- **Measurement**: the Playwright performance timeline, taking the median of 5 runs.

---

## 4. Optical targets (O)

### O-1 / O-2 Spatial accuracy — 1 µm / 0.1 µrad

This is **the single most engineering-demanding line in the document**, and its direct consequences have to be written down as hard design constraints:

- **The solve path must be float64 end to end.** 0.1 µrad = 1×10⁻⁷ rad, while float32's relative precision is about 1.2×10⁻⁷ — a direction vector stored as float32 anywhere consumes the entire error budget on the spot.
- Therefore: anchor poses (position + axisX/axisY) are **float64 everywhere** — in the DB, in JSON serialization and inside `anchor_tracer`; serialization must not truncate (at least 15 significant digits).
- **The physics path must never consume render-mesh coordinates.** GLB vertices are float32 and exist only for rendering; an optical interface's position may only come from the anchor definition. (This echoes an existing lesson: `loadAsset`'s bbox-centering once desynced the mesh from its raw CAD anchor.)
- A position error ≤ 1 µm over a 1 m optical path ⇒ the transform chain's accumulated error must stay below 1×10⁻⁶ relative, so chained matrix multiplication has to stay in float64.
- **CI**: build an analytic reference case per kind (plane-mirror reflection, thin-lens imaging, the Bragg diffraction angle, Faraday rotation) and assert position ≤ 1 µm and direction ≤ 0.1 µrad.

### O-3 Inner numerics — within 0.1 % of analytic
- Subjects: Gaussian beam propagation (w(z), R(z), Gouy), the Jones matrix chain, Bragg diffraction efficiency, the fibre coupling overlap integral, and aperture truncation (the knife-edge erf).
- **CI**: purely numerical unit tests, hardware-independent, always green.

### O-4 Outer numerics — within 5 % of measurement
- Subjects: **end-to-end quantities along a whole optical path** (laser → fibre coupling efficiency, the AOM's ±1 order power ratio, isolator forward/backward extinction, TA gain).
- Requires a set of **pinned measured benchmark cases** (scene JSON + measured value + measurement date + instrument), stored in `backend/tests/fixtures/bench/`.
- **CI**: load the benchmark scene, run the solver, compare against the measurement, and fail on a deviation > 5 %.
- ⚠️ That set of benchmark cases **does not exist yet** and is the largest prerequisite in this specification (see §7).

### O-5 Solve latency — p95 < 500 ms
- **Definition**: from the user releasing the mouse / submitting a parameter change to the optical polyline finishing its update on screen.
- Budget breakdown: assembling the request in the frontend ≤ 30 ms ｜ network round trip ≤ 20 ms (local) ｜ `/api/v3/solver` ≤ 300 ms ｜ frontend redraw ≤ 100 ms ｜ 50 ms of slack.
- Showing a provisional optical path (a geometric approximation) **while** dragging is not bound by this target.
- **CI**: the backend solver's pure compute time gates on an ordinary runner (≤ 300 ms on a standard 20-component scene); the end-to-end 500 ms gates on the reference machine.

---

## 5. RF / multiphysics, BUILD, and the data layer

### F — RF uses the same two-tier standard as optics
- **F-1 inner < 0.1 %**: against analytic solutions — transmission-line attenuation, impedance-mismatch reflection, the amplifier gain-compression model, the AD9959 phase accumulator's output frequency.
- **F-2 outer < 5 %**: against measurement — power along the chain (Vpp ↔ dBm), AOM drive power → diffraction efficiency, cable length → insertion loss. It likewise needs pinned measured benchmark cases.
- **F-3 topological correctness 100 %**: the propagation BFS's connectivity must be exactly right (laser powered off → the TA has no light → the AOM has no output; the switch/AMP produce nothing). There is no tolerance here — one wrong case fails.
  - A known trap: the BFS must use **primaryAsset** semantics and must not honour `asset_3d_id_override` (frontend and backend have to keep the same iron rule).

### B — The BUILD asset pipeline
- **B-1 geometric fidelity ≤ 0.05 mm**: LOD0's maximum Hausdorff distance from the source CAD. The point is to stop decimation from eating into O-1's 1 µm budget — **but note: 0.05 mm is the tolerance of the *render* geometry; optical interface accuracy is guaranteed by the anchors (§O-1), and the two are separate paths.**
- LOD1 / LOD2 have no geometric **tolerance** — but each one's actual deviation **is measured and stored** (`asset_lods.error_mm`), because R-5's switching rule consumes it. Recorded, not gated.
- **Authoring surfaces never see a coarsened mesh.** The PHY Editor (ASSET3D / COMPONENT previews) and BUILD always load LOD0 and never switch tiers. Face-picking already sits at the ~5 mrad triangulation limit ([float64-audit.md](float64-audit.md) §2.2); authoring an anchor against a decimated mesh would degrade the one precision breach that is still open. Physics itself is unaffected either way — the tracer reads only anchors, never mesh vertices (§O-1).
- **B-2 conversion time ≤ 60 s**: the in-browser occt-import-js path. An oversized STEP beyond the WASM address-space limit (243 MB was measured to crash) **must go through offline `cascadio`** and is not counted against this threshold.
- **CI**: run the conversion over pinned STEP samples and assert the three LOD triangle counts, LOD0's Hausdorff distance, and the conversion time.

### A — The data layer and API
- **A-1 p95 < 300 ms @ 10 concurrent**: load-test the read endpoints (`/api/v3/assets3d`, `/api/kinds`, `/api/v3/scenes/*`, …) at 10 concurrent for 60 s.
- **A-2 5–10 concurrent users**: requires an explicit write-conflict strategy — optimistic locking (version / ETag + `If-Match`), returning 409 on conflict rather than letting the later write win. **Not implemented yet** (see §7).
- **A-3 data correctness**:
  - Every alembic migration can `downgrade` to the previous revision (CI runs upgrade→downgrade→upgrade).
  - Revision ids ≤ 32 characters (a landmine already stepped on).
  - Any non-unlocking write to a locked row must return **422** (`lock_guard` is implemented; a regression test has to hold it).

---

## 6. The CI gating plan

Two pipelines:

> **Status (2026-08-17): `ci-correctness` exists** — [`.github/workflows/ci-correctness.yml`](../.github/workflows/ci-correctness.yml), the repo's first workflow.
> `ci-performance` **does not exist yet** (it needs a pinned reference machine, see §7-5).

**(a) `ci-correctness` (every PR, ordinary runner)**
- All the unit/integration tests for O-1, O-2, O-3, F-1, F-3 and A-3
- The pinned benchmark comparisons for O-4 and F-2 — ⚠️ **currently only a structural gate** (`test_bench_cases.py` validates the fixture format, rejects data whose uncertainty is too large, and fails when a measured value exists with no comparator). **The actual simulation-vs-measurement comparison is not implemented, because there is no measured data yet**; see §7-1
- The static / deterministic proxy assertions for R-2, R-4, R-5, R-6 and B-1
- All green is required to merge.

**(b) `ci-performance` (after merge to main + nightly, on the pinned reference machine as a self-hosted runner)**
- R-1, R-3, R-7, R-8, O-5, B-2, A-1
- Compared against a pinned baseline; **a > 10 % regression fails and blocks the next release** (it does not gate PRs, to avoid hardware jitter killing them).
- Each run writes its numbers into `docs/perf-baseline.json`; changing them requires human sign-off.

---

## 7. Still to be quantified / prerequisites (not yet gating)

In priority order:

1. **Build the measured benchmark dataset** — the prerequisite for O-4 and F-2. **The measurement protocol and case list are written: [`docs/bench-dataset.md`](bench-dataset.md)** (12 cases: O-4 ×7, F-2 ×5, each listing the conditions to record and which `defaultParams` it exercises); the data's home and format are in [`backend/tests/fixtures/bench/`](../backend/tests/fixtures/bench/README.md), with the structural gate in `backend/tests/test_bench_cases.py`.
   **But there are 0 measured values and 0 comparators so far — a gap that can only be closed with lab time, not with code.** The recommendation is to do the four ★priority cases first (O-4.1 fibre coupling, O-4.2 AOM first-order efficiency, O-4.4 isolator extinction, F-2.5 RF drive → diffraction efficiency).
2. ~~**The float64 end-to-end audit**~~ — **completed 2026-08-17**; results in [`docs/float64-audit.md`](float64-audit.md). Conclusion: the machine path through DB/API/tracer is float64-clean end to end; every breach is in the PHY Editor's authoring UI. **Breach A (`mmText`'s `toFixed(3)`, quantizing position to 1 µm and direction to ~870 µrad) was fixed the same day.** One fundamental limitation remains — **face-picking cannot author µrad-level axes because of mesh triangulation error (~5 mrad), so O-2's anchors must be authored numerically through the device registry**; the remaining repairs (input field step, a two-tier authoring policy, CI guards, a scan for existing corrupted data) are in §3 of that file.
3. ~~**The LOD1/LOD2 pipeline**~~ — **all three phases done 2026-08-17**; the outcome is that the geometry budgets turned out not to bind (see §R-6's measured block):
   - ~~**P0 (generation + storage)**~~ — the `asset_lods` sidecar table (alembic 0122), BUILD emitting all three tiers with their measured `error_mm`, and the manifest delivered on both the catalog and the scene payload. Storage is a **separate table on purpose**: most catalog assets are `locked`, and any write to a non-`locked` column of `assets_3d` is rejected 422 by `lock_guard`, so putting the manifest in `properties` would make "generate a LOD" a human unlock action. A derived render artifact is not the asset's ground truth and must not need one.
   - ~~**P1 (runtime switching)**~~ — the px_error evaluator in `DigitalTwinViewer`'s `animate()` loop, the single-child LOD container, and a per-container tier cache. Implementation map and the traps it avoids are in [`introduce/rendering.md`](introduce/rendering.md) §LOD.
   - ~~**P2 (backfill)**~~ — `frontend/scripts/backfill-lods.ts` (`npm run backfill:lods`). Writes only the new table, so locked rows stayed untouched. **Measured outcome: only 4 of 24 GLB assets warrant a tier at all** — 18 are already under the 20k LOD2 budget, and `ad9959` resists simplification (both tiers stall at 89 % of LOD0). The R-4/R-5 budgets were set from a 464k-triangle import experiment, not from the shipped catalog, so R-5 is now *on* but mostly inert by construction. **That is the honest reading: the geometry budgets are not currently the constraint on this scene.** Draw calls were then measured to check the other half of that claim — 66 against a 2000 budget, see §R-6 — so **neither geometry metric is binding, and no further LOD work is justified without a measured slowdown to chase.**
4. **Optimistic locking / a write-conflict strategy** — the prerequisite for A-2; there is currently no version column and no `If-Match` support.
5. **A pinned reference machine** — R-1, O-5 and A-1 need a self-hosted runner; without one the performance targets can only be measured by hand, which is exactly what §R-1 and §R-6 now record. Those hand readings sit 4–6× inside budget, so **the missing runner is no longer a risk that something is secretly slow — it is only the missing gate against future regression.** Priority should be judged on that basis.
6. **Aspects with no target yet**: memory ceiling, GPU VRAM ceiling, mobile support, offline mode, accessibility. Deliberately left unset this time.

---

## 8. Known tensions (contradictions that have to be traded off in design)

| Tension | Explanation | The current resolution |
|---|---|---|
| 1 µm accuracy ↔ float32 geometry | GLB/three.js are float32 and the precision budget doesn't fit | Physics and rendering take **two separate paths**: physics trusts only the anchors (float64), rendering trusts the mesh |
| 60 FPS ↔ unlimited component count | No cap on components yet a hard frame-rate threshold | Three LOD tiers + instancing + culling, with proxy metrics (draw calls / CPU time) as the early warning |
| No degradation while interacting (R-3) ↔ 60 FPS | It closes off the "drop quality to keep frames" retreat | All the pressure is transferred onto the geometry budgets (R-4–R-6) |
| CI gating ↔ performance jitter | FPS is not reproducible on a shared runner | Performance moves to the pinned reference machine, in a post-merge pipeline, compared against a baseline rather than an absolute |
| The 5 % measurement target ↔ experimental drift | The measured benchmark itself moves with the state of the lab | Benchmark cases must pin their measurement date and conditions; an expired one gets re-measured, never a looser threshold |

---

## Notes

- Once a performance or accuracy number is in CI, changing the threshold requires editing this file and justifying it in the PR — never quietly loosening it inside a test.
- The division of labour between this file and [`docs/introduce/`](introduce/README.md): introduce describes **what is**, this file defines **what to reach**. When they conflict, introduce is authoritative for the current state and this file is the target.
