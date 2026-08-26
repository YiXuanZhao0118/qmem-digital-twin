[← 文件索引](README.md)

# Mode matching — shaping the DBR seed into the TA

TA **seed-injection** mode matching: a train of shaping lenses must be placed
so the DBR seed, at the tapered-amplifier (TA) input facet, matches the TA's
own input mode. Perfect match ⇒ seed and (reverse-propagated) TA mode share the
same spot everywhere along the section — the bench "walk it in backwards"
procedure, solved as a layout problem. Same objective serves the future fibre
couple. Sibling: [`optics.md`](optics.md) (the q-tracer this rides on),
[`fiber.md`](fiber.md) (the Marcuse coupling this generalises).

## The physics, and why it is cheap to optimize

- **Forward seed q** at a plane just upstream of the first shaping lens is
  FIXED — set by the source + upstream isolators, none of which the optimizer
  touches. One forward trace captures it.
- **Reverse reference**: a virtual beam launched at the TA input facet carrying
  the TA asset's declared `inputSpatialModeX/Y`, propagating back OUT along −(the
  seed's inbound direction), through the very lenses under optimization. Its
  real part flips sign vs the input-beam convention (`laser_source._q_from_mode`
  uses `q_re = −waistZOffset`; reversing propagation negates it → `q_re =
  +waistZOffset`).
- By reversibility, η between the fixed forward seed and the back-propagated
  reference at that one upstream plane **equals the power coupled into the TA**;
  η = 1 ⇔ profiles coincide at every plane between. So each score is ONE reverse
  trace, not a scan.

The overlap is the general-astigmatism power coupling of two Gaussian beam
matrices (`mode_match.py`):

    η = 4·√(det Im P₁ · det Im P₂) / |det(P₁* − P₂)|,   P = Q⁻¹

= 1 for identical q (waist size, location, astigmatism axis), factorizes into
η_x·η_y for aligned astigmatism, and is sensitive to the relative astigmatism
axis — so a cylindrical lens's roll is a real degree of freedom.

## Files

- `backend/app/optical/mode_match.py` — `gaussian_mode_overlap(Q1, Q2)`.
- `backend/app/optical/mode_match_model.py` — `build_problem(...)` +
  `ModeMatchProblem.evaluate(config)`. Re-poses lenses **in-memory** (rebuild
  the frozen `V3AnchorBindingSlot` with a shifted `effective_transform`; roll =
  premultiply `Rotation.from_rotvec(axis·θ)` about the lens centre; focal via
  `dynamic_sources['focalLengthMm']`) and re-runs the exact `trace_ray_anchor_scene`
  on the reverse ray only — no analytic lens model to drift from the
  authoritative physics, no DB round-trip. `dynamic_overrides` cannot move an
  object (pose lives on the SceneObject), which is why re-posing edits the slot
  transform directly. The scene is pruned to the ~15 objects the reverse ray
  visits (safe: forward isn't re-traced in the loop) and the reverse trace runs
  at `power_threshold_mw=1e-7` — the path to the compare plane is a WEAK branch
  (BS1 kicks most of the reverse beam out), so a higher threshold deletes the
  very segment η is read from. ~3–4 ms/eval.
- `backend/app/optical/mode_match_optimize.py` — `optimize(problem, specs, …)`.
  Per-element `DOFSpec` (axial / decenter / roll bounds; `None` freezes). Search
  = multi-resolution coordinate descent + Powell polish, multi-start. Stage 2:
  when a `focal_inventory` is given and Stage 1 misses `eta_target`, rank each
  focal combo with a cheap axial-only descent, full-solve the top few.
- `backend/app/optical/mode_match_service.py` — `run_mode_match(scene,
  forward_result, …)`: DB-independent glue that builds the problem, computes the
  section length, optimizes, and shapes a JSON plan whose per-element move is a
  WORLD-space translation + roll-about-the-section-axis + focal (what the
  frontend applies to the SceneObject pose, MirrorCoupling-style).
- `POST /api/v3/solver/mode-match` (`routers/v3_solver.py`) — loads the DB
  scene, traces the seed once, calls `run_mode_match`, returns the plan.

## Start / range / methods (2026-08-25)

The optimizer works within a **Start→End** range (both are scene elements the
user picks; Start is a beam-splitter/mirror upstream of the lenses, End the
section-end mirror). Per-lens axial bounds keep each lens's beam-hit inside
`[Start+margin, End-margin]`.

- **Method 1** (no lens selected): `run_mode_match` auto-detects the lens-kind
  objects whose seed-hit sits between Start and End and optimizes those.
- **Method 2** (lenses selected): optimizes them, returning a `range` column
  (within Start→End) AND a `free` column (ignore Start/End, wide bounds).

Each column yields a **best-efficiency** card and, when the target is reachable,
a **shortest-footprint** card: MIRROR5 stays put and the lenses are packed
toward Start (warm-started from the max-η config via `optimize(warm_config=…,
fixed_focal=…)`), reporting the smallest span the lenses can occupy while still
meeting η. `run_mode_match` returns `{mode, detectedLenses, spanMm, solutions:[
{key,label,column,eta,lengthMm,feasible,reason,moves,…}]}`; the panel renders the
columns side by side with a Preview/Apply per card.

## Constraints & feasibility

- `l_max_mm` bounds the BS2→MIRROR5 section length. MIRROR5 is a movable
  endpoint with an axial-only DOF, **locked by default**; unlocked, its axial
  bound is clamped so length ≤ `l_max_mm`. Locked and already too long ⇒
  immediate infeasible with that reason.
- **Decenter is OFF by default.** Transverse decenter improves the mode-shape
  overlap but steers the chief ray off the lens centre (a pointing error the
  objective does not penalize), which shows up as a deflected beam in the twin.
  Only axial slides + rolls about the beam axis are used unless `decenter_mm > 0`
  is passed explicitly. Defaults live in BOTH `default_lens_dof` and the router's
  `ModeMatchRequest` (they must agree — the request default won a silent bug once).
- `eta_target` is a success threshold, not a search constraint: maximize η, then
  report `feasible` + `best_achievable` + a human `reason` naming which limit
  bit.

## The live scene (2026-08-24)

Path `BEAM_SPLITTER2 → LENS_CYLINDRICAL3 → (BEAM_SPLITTER1) → LENS_CYLINDRICAL0
→ LENS_BICONVEX0 → MECHANICAL19 → MIRROR5` carries only the DBR seed
(`LASER_SOURCE1`, 852 nm) on its way into `TAPERED_AMPLIFIER0`. Shaping lenses:
CYL3 f=−24.88, CYL0 f=+40 (cyl, power axis body-y), BICONVEX0 f=−25, MECH19 f=+35
thick. TA input mode (asset `default_params`): `inputSpatialModeX` 278.4 µm @
−986 mm, `inputSpatialModeY` 314.9 µm @ +1102 mm — strongly astigmatic. Current coupling **η ≈ 0.08**; repositioning alone reaches **≈ 0.70** (the
astigmatism is extreme), and the focal inventory is the lever beyond — a live
end-to-end run with CYL3/CYL0 focal inventories reached **η = 0.877** (Stage 2
picked CYL3 −40, CYL0 +60) in ~27 s / ~6.9k evals. Section length ≈ 134 mm.

Tests: `backend/tests/optical/test_mode_overlap.py`,
`test_mode_match_model.py`, `test_mode_match_optimize.py`,
`test_mode_match_service.py` (21, DB-free). Endpoint verified live in-process.

## Frontend

`frontend/src/components/optical/ModeMatchingPanel.tsx` (+ `ModeMatchingLauncher`
in `ComponentPanel`, panel registered in `WorkspaceProvider` / rendered in
`App`). Auto-detects the seed (`laser_source`) + TA (`tapered_amplifier`), takes
the SELECTED shaping lenses (each with a focal-inventory input), plus η target /
max length / endpoint mirror + lock; a **Lock element angles** checkbox (default ON) sends `rollDeg=0` so the optimizer only slides lenses along the beam + swaps focal, never rotating a mount (η ~0.87 vs ~0.93 with roll). Solve → `runModeMatchApi`
(`api/client.ts`); preview applies each move as a ghost via
`previewObjectTransform`; Apply writes SceneObject poses (+ `dynamicSources.focalLengthMm`)
in one `updateSceneObjects` undo step. A plan move → pose: translate the object
by `translateWorldMm` and roll it about the lens's optical-centre anchor
(`resolveAnchorPosesLab`) — the same rigid transform the backend applied to
`effective_transform`.

**A move is a DELTA from the geometry at solve time, so the panel resolves it to
an ABSOLUTE pose once** (`planFromSolution`, `ModeMatchingPanel.tsx:87`), when the
solve returns, against `useSceneStore.getState().scene`. Preview and Apply both
write that stored pose, never `obj.xMm + t.x` recomputed at click time. Invariant:
Apply is idempotent — clicking it twice, or after a manual nudge, lands on the
same place instead of stacking another delta (before 2026-08-26 it re-added the
offset on every click, so the lenses walked away from the optimizer's η). Belt
and braces: once any card is applied, `appliedKey` disables Apply on *all* cards
in that result — the other cards' targets were planned from the pre-Apply
baseline, so you re-solve to plan from where the scene now is.

Each card lists, per lens, its **position along the beam** rather than a bare
shift magnitude: the optical centre projected on the plan's beam axis
(`move.rotateAxisWorld`), measured from the Start element (the seed when Start is
`(none)`), as `before → after mm (±delta)` — plus `⊥` when decenter is on. Two
candidate columns are then comparable by where the lenses END UP, which a
`|translate|` per row cannot show (two very different layouts can list similar
shift magnitudes). The numbers are frozen in the same snapshot as the poses, so
they keep describing the plan after it is applied. Browser-verified: panel renders with live scene data,
detects LASER_SOURCE1 / TAPERED_AMPLIFIER0, lists the 4 lenses, and POSTs to the
endpoint.

## TODO

- UX: the solve is multi-second (~11 s repositioning, ~27 s with a focal
  inventory) — the Solve button shows a spinner; consider a fully non-blocking
  run for very large inventories.
