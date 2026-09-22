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
  seed's inbound direction), through the very lenses under optimization. It is
  built by the same `_facet_beam` the tracer uses for the TA's real backward
  emission: `inputSpatialModeX/Y` describe the beam the input facet **emits**,
  with `waistZOffsetMm` measured OUTWARD along the anchor's axisX (`Re q =
  −offset` at the facet). So a mode fitted from a WFS capture of the TA's
  back-emission reproduces that capture in the twin and is, unchanged, the
  optimizer's target. (Mode X is the anchor's axisY — for
  `sacher_tec400_852nm_ta`'s `intercept_in` that is body +z, **vertical**.)
- **The seed must be the time reverse of that beam** (bench derivation,
  2026-09-02): same spot sizes, every wavefront curvature flipped. In the
  tracer's frames the reverse segment shares `s` with the forward one and flips
  `p`, so `mode_match.time_reversed_target` maps the reverse Q at the compare
  plane to the required forward Q as `(xx, yy, xy) → (−xx*, −yy*, +xy*)` — in
  WFS language M and J0 change sign, J45 keeps it. η is the overlap of the seed
  with **that** target; comparing the seed with the reverse beam itself (what
  the model did before 2026-09-02, together with the opposite launch sign)
  rewarded a seed *diverging* where it should converge.
- By reciprocity, η between the fixed forward seed and the conjugated
  back-propagated reference at that one upstream plane **equals the power
  coupled into the TA**; η = 1 ⇔ profiles coincide at every plane between. So
  each score is ONE reverse trace, not a scan. The tracer's TA op computes the
  coupled seed power with the same overlap at the facet
  (`misc_ops._mode_match_eta`, reported on the trace as
  `labSegments[*].taSeedCoupling.etaMode` since 2026-09-22 — see
  [optics.md](optics.md)), so the panel's η and the traced amplified power
  agree. (The BeamScope panel's client-side "TA eta: mode" readout
  (`rayTrace.ts::taSeedModeOverlap`) belongs to the legacy in-browser tracer;
  `v3TraceAdapter` never fills it, so it does not show on the v3 trace.)

The overlap is the general-astigmatism power coupling of two Gaussian beam
matrices (`mode_match.py`):

    η = 4·√(det Im P₁ · det Im P₂) / |det(P₁* − P₂)|,   P = Q⁻¹

= 1 for identical q (waist size, location, astigmatism axis), factorizes into
η_x·η_y for aligned astigmatism, and is sensitive to the relative astigmatism
axis — so a cylindrical lens's roll is a real degree of freedom.

## Files

- `backend/app/optical/mode_match.py` — `gaussian_mode_overlap(Q1, Q2)` and
  `time_reversed_target(Q)` (the phase-conjugate / frame-mirror map above).
- `backend/app/optical/mode_match_model.py` — `build_problem(...)` +
  `ModeMatchProblem.evaluate(config)`. Re-poses lenses **in-memory** (rebuild
  the frozen `V3AnchorBindingSlot`s with a moved `effective_transform`: one
  rigid world motion per object, `x → R·(x − pivot) + pivot + t`, applied to
  **every** slot of that object — `rigid_motion` + `move_transform`; roll =
  `Rotation.from_rotvec(axis·θ)` about the lens's **optical centre**, see
  [The roll pivot](#the-roll-pivot); focal via
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
  frontend applies to the SceneObject pose, MirrorCoupling-style) **plus, since
  2026-09-22, the roll pivot and the absolute SceneObject `pose` the move lands
  on** (`absolute_pose`), so a client never has to reconstruct the rotation
  point. Shape under [The plan's moves](#the-plans-moves).
- `POST /api/v3/solver/mode-match` (`routers/v3_solver.py`) — loads the DB
  scene, traces the seed once, calls `run_mode_match`, returns the plan.
  **The solve runs on a worker thread** (`run_in_threadpool`, 2026-09-22):
  the DB reads (scene + object names and poses) happen first, on the event loop; the
  forward trace and the optimizer then run off it, touching only the loaded
  scene — never the `AsyncSession`, which is bound to the loop. Until then the
  optimizer ran synchronously inside the `async` handler and every other
  request and `/ws/scene` broadcast stalled for the whole solve. Pinned by
  `backend/tests/optical/test_mode_match_endpoint.py` (a request is answered
  while a deliberately blocked solve is still running).

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

## The plan's moves

Each solution's `moves[]` (router `routers/v3_solver.py`, shaped by
`mode_match_service._shape_plan`):

```json
{
  "objectId": "lens0", "name": "LENS0",
  "translateWorldMm": {"x": 0.0, "y": 0.0, "z": -1.5522350119376385},
  "rotateAxisWorld": {"x": 0.0, "y": 0.0, "z": 1.0},
  "rotateDeg": 27.219526706406157,
  "focalMm": null,
  "pivotWorldMm": {"x": 0.0, "y": 0.0, "z": 0.0},
  "pose": {"xMm": 0.0, "yMm": 0.0, "zMm": -1.552235, "rxDeg": 0.0, "ryDeg": 0.0, "rzDeg": -27.219526706}
}
```

(A real move from `test_mode_match_service.py`'s synthetic scene, lens at the
origin with a zero pose. Note `rzDeg` comes out **negative** for a positive
roll about +z — the SceneObject Euler convention maps rz = +90° to +X → −Y
([anchors.md](anchors.md)) — which is exactly the kind of thing a client should
not have to re-derive.)

- The first five fields are unchanged (the web panel reads only those): a
  world translation `t`, a roll of `rotateDeg` about `rotateAxisWorld` (the
  section axis), an optional focal swap.
- `pivotWorldMm` (new) is the lab point the roll turns about; `pose` (new) is
  the SceneObject pose that results — `x → R·(x − pivot) + pivot + t` applied
  to the object's pose at solve time, in the backend pose convention
  (`pose._rotation_of`), angles decomposed as the align endpoints do
  (`align.frames`, 1e-9° grid; a pure translation keeps the stored angles
  verbatim), position on the 1 nm grid. It is exactly the motion
  `ModeMatchProblem` applied while scoring, so `PATCH /api/objects/{id}` with it
  reproduces the reported η. Pinned by
  `test_mode_match_service.py::test_absolute_pose_lands_every_slot_where_the_model_put_it`.
  Like the panel's own resolution, it is absolute against the scene the solve
  read — apply it to that scene, not after further edits.

## The roll pivot

The web panel rolled a lens about its **optical-centre anchor**
(`ModeMatchingPanel.pivotOf`: `optical_center`, else `intercept_in`); the
model rolled the slot about its **transform origin** (the lens asset's CAD
origin under the binding chain). Settled 2026-09-22: **the optical-centre
anchor is right for the tracer**, and the model now uses it
(`mode_match_model.optical_centre_lab`, same precedence as the panel, read off
the traced slots).

- The tracer hit-tests the anchor. Turning about a line through it parallel to
  the beam is a pure roll: the lens stays where the beam crosses it. Turning
  about an asset origin that is off the optical axis also carries the lens
  sideways — a hidden decenter, while decenter is OFF by default.
- That hidden decenter does not show in η (a thin lens's decenter tilts the
  chief ray, it does not change q — the pointing error the objective does not
  penalize, see above), so the old model would report a good η and the twin
  would draw a steered beam after Apply. Pinned by
  `test_mode_match_model.py::test_roll_turns_about_the_optical_centre`.
- For every lens in the scene until now the two points coincide (the entry
  anchor sits at the asset origin — checked on the live `A230TM-B`), so no
  earlier result changes; the difference is for the next asset whose CAD
  origin is off-axis.
- The same change makes the model move **every** traced slot of a moved
  object; it used to re-add only one and drop the rest from the trace.

## Constraints & feasibility

- **The three length knobs — `endpointLocked`, `axialMm`, `lMaxMm` — work
  again (fixed 2026-09-22, commit "Mode match: make endpointLocked / axialMm / lMaxMm do what they are documented to do").** From the Start/range rewrite
  (2026-08-25) until then `run_mode_match` accepted them and ignored them:
  every `optimize` call passed the End as a frozen `DOFSpec()` with
  `endpoint_locked=True` and no `l_max_mm`, and every card echoed
  `lMaxMm: null` / `endpointLocked: true`. Their meaning is the original one
  (the End element — MIRROR5 in the original bench — is an axial-only
  endpoint, locked by default, whose travel trades section length for η under
  a length cap), fitted to the range model. Defaults (`true`, 20, none) are
  exactly the old behaviour, and the web panel sends none of them, so **the
  web is unchanged** (seven default-knob plans compared bit for bit against
  the old code). `run_mode_match` (`mode_match_service.py:179`):
  - `endpointLocked=false` lets the End slide along the section axis in the
    two **best-efficiency** cards (`end_spec`, `:281`): in the **range**
    column only AWAY from Start (`[0, +axialMm]`) — its lenses are bounded by
    the End's current position, and a box-bounded search cannot keep them
    clear of an End that moves in; in the **free** column, which ignores the
    range, both ways (`±axialMm`). The **shortest-footprint** card always
    keeps the End put. A moved End is a move like any other in the plan
    (`moves[]`, with its absolute `pose`); each card echoes whether ITS End
    could move (`endpointLocked`). Needs the End downstream of Start
    (`ValueError` → 400 otherwise, since `+d` must lengthen the section).
    ⚠️ Physically this moves the End mirror along the INCOMING beam, which
    walks the leg after it sideways by the same amount; η is scored on path
    length and does not see that walk — re-steer the downstream leg after
    applying (see [mirror-coupling.md](mirror-coupling.md)). It is opt-in for
    the same reason decenter is.
  - `axialMm` (default 20, ≥ 0) is that travel, and the `±` travel of a
    selected lens the seed does not reach (it has no hit for the range to
    bound — `_range_specs`, `:93`, where the old hard-coded ±20 was).
  - `lMaxMm` (default none, > 0) caps the **section length**: Start (else the
    comparison plane) to the End's seed hit, plus the End's move — what each
    best-efficiency card reports as `lengthMm`. It reaches every `optimize`
    call and every card echoes it. In `optimize()` (`mode_match_optimize.py:161`):
    a locked End with the section already over the limit ⇒ infeasible up
    front (no trace), with that reason; an unlocked End has its upper travel
    clamped to the limit, and when even its lower travel cannot bring the
    section under it (e.g. always in the range column, which cannot shorten)
    ⇒ infeasible up front too (`:209`). The shortest-footprint card is
    skipped when the section is over the limit (it never moves the End, so it
    could not fit, `over_limit`, `:319`). No End ⇒ no section ⇒ no effect.
  - An unlocked End starts its search at the nearest pose inside its travel,
    not at 0 (`optimize._start`, `:272`): the search keeps the best point it
    evaluated, the start included, so a start outside the bounds could come
    back as the answer — with a limit that forces shortening it did.
  - Pinned by `test_mode_match_optimize.py` (the cap, shortening to meet it,
    a limit out of reach), `test_mode_match_service.py` (defaults unchanged,
    each column's End travel and limit reaching `optimize`, a limit below a
    frozen section, shortening only in the free column, `axialMm` on a missed
    lens, an End upstream of Start) and `test_mode_match_endpoint.py` (the
    knobs pass through; negative `axialMm` / non-positive `lMaxMm` are 422).
- ⚠️ **Open (found 2026-09-22): a lens can come back outside its range.** The
  same start-point effect applies to LENSES, and it is not fixed (that would
  change what the web gets): each lens's search starts at its current pose
  (0), and when its bounds exclude 0 the untouched start can win. It does in
  the shortest-footprint search, whose ranges shrink toward Start: on the
  service tests' synthetic scene the `range_shortest` card reports a 27 mm
  footprint (Start → last lens) with **no move**, while its lens sits 30 mm
  from Start. A lens starting inside the 6 mm keep-off margin of Start / End
  can stay there the same way. The fix is to start every search inside its
  bounds (`np.clip` of the start, what `_start` does for the End).
- **Decenter is OFF by default.** Transverse decenter improves the mode-shape
  overlap but steers the chief ray off the lens centre (a pointing error the
  objective does not penalize), which shows up as a deflected beam in the twin.
  Only axial slides + rolls about the beam axis are used unless `decenter_mm > 0`
  is passed explicitly. Defaults live in BOTH `default_lens_dof` and the router's
  `ModeMatchRequest` (they must agree — the request default won a silent bug once).
- `eta_target` is a success threshold, not a search constraint: maximize η, then
  report `feasible` + `best_achievable` + a human `reason` naming which limit
  bit.

## The live scene (re-read 2026-09-22)

**There are no shaping lenses on the seed path any more.** The DBR seed
(`LASER_SOURCE1`, 852.347 nm) runs `LENS_PLANO_CONVEX2` (the A230TM-B
collimating asphere, f = 4.51 mm, right after the laser — upstream of any
Start one would pick) → `MIRROR6` → `WAVEPLATE3` → `ISOLATOR0` → `ISOLATOR1` →
`WAVEPLATE0` → `BEAM_SPLITTER2` → `MIRROR5` → `MIRROR7` →
`TAPERED_AMPLIFIER0` (read off a compute-only `run-from-db` trace; BS2 → MIRROR5
60.6 mm, MIRROR5 → MIRROR7 149.8 mm, MIRROR7 → TA 50 mm). The 2026-08-24 set —
`LENS_CYLINDRICAL3` (f=−24.88), `LENS_CYLINDRICAL0` (f=+40, cyl), `LENS_BICONVEX0`
(f=−25), `MECHANICAL19` (f=+35 thick), with `BEAM_SPLITTER1` in the path — is
no longer in the scene (`BEAM_SPLITTER1` still is, on another branch). So a
Method-1 solve on BS2 → MIRROR5 today answers "No lenses found between Start
and Endpoint."; the MIRROR5 / MIRROR7 pair is steered by
[mirror coupling](mirror-coupling.md) instead.

(Superseded 2026-08-24 path, kept for the η history below:
`BEAM_SPLITTER2 → LENS_CYLINDRICAL3 → (BEAM_SPLITTER1) → LENS_CYLINDRICAL0 →
LENS_BICONVEX0 → MECHANICAL19 → MIRROR5`.)

TA input mode (asset `default_params`, unchanged; **re-fitted 2026-09-02** from the
TA's own back-emission at 25 mm — see `kinds.md` and `docs/ta_seed_modes_0902.md`):
`inputSpatialModeX` (vertical) 80.5 µm @ +266.5 mm, `inputSpatialModeY`
(horizontal) 441 µm @ +1283 mm — the emitted beam converges toward the seed, so
the seed must arrive diverging from virtual waists 266.5 / 1283 mm upstream of
the facet. The η figures quoted before this date (0.08 → 0.70 → 0.877 → 0.93)
were computed against the un-conjugated, opposite-sign reference and the older
`IN_1505` mode; they are not comparable with the corrected model.

Tests: `backend/tests/optical/test_mode_overlap.py`,
`test_mode_match_model.py`, `test_mode_match_optimize.py`,
`test_mode_match_service.py`, `test_mode_match_endpoint.py` (45 as of
2026-09-22, after the length knobs; all DB-free). Endpoint verified live in-process (2026-08).

## Frontend

`frontend/src/components/optical/ModeMatchingPanel.tsx` (+ `ModeMatchingLauncher`
in `ComponentPanel`, panel registered in `WorkspaceProvider` / rendered in
`App`). Auto-detects the seed (`laser_source`) + TA (`tapered_amplifier`), takes
the SELECTED shaping lenses (each with a focal-inventory input; none selected =
Method 1), a Start and an End element, and an η target. **That is all it
sends** (`ModeMatchingPanel.tsx` `solve`): `seedEmitterId`, `taObjectId`,
`movableIds`, `startId`, `endpointId`, `etaTarget`, `focalInventory`, `rollDeg`
— no max length and no endpoint lock (the request type declares
`lMaxMm` / `endpointLocked` / `axialMm`, but the panel never sets them, so it
gets a frozen End and no length cap; a second client can send them — see
Constraints). A **Lock element angles** checkbox (default ON) sends `rollDeg=0` so the optimizer only slides lenses along the beam + swaps focal, never rotating a mount (η ~0.87 vs ~0.93 with roll; `rollDeg=90` when unchecked). Solve → `runModeMatchApi`
(`api/client.ts`); preview applies each move as a ghost via
`previewObjectTransform`; Apply writes SceneObject poses (+ `dynamicSources.focalLengthMm`)
in one `updateSceneObjects` undo step. ⚠️ **The focal half of Apply does not
reach the trace**: the loader keeps a per-instance key that is also an asset
`default_params` key only if the asset lists it in `tunable_params`, and no
lens asset does (0 of 12, all 12 locked — checked 2026-09-22). So a focal swap
the optimizer scored is dropped on load and the traced η after Apply is the
original focal's; changing a lens is really changing its asset. A plan move → pose: translate the object
by `translateWorldMm` and roll it about the lens's optical-centre anchor
(`resolveAnchorPosesLab`) — the same rigid transform the backend applied to
`effective_transform` (the same pivot since 2026-09-22, see
[The roll pivot](#the-roll-pivot); before, the two agreed only because every
lens's entry anchor sat at its asset origin). The panel does not read the
move's `pose` / `pivotWorldMm`; they are for other clients.

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
  inventory) — the Solve button shows a spinner. The server no longer blocks
  while it runs (worker thread, see Files), but the request itself still
  waits for the whole solve; a job/poll API would be the next step for very
  large inventories. Two concurrent solves each take a threadpool worker.
