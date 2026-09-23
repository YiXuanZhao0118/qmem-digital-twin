[← Doc index](README.md)

# Mirror coupling — two 45° mirrors into a port

> The tool that answers "where do I bolt these two mounts so the seed lands on the TA's axis". Solver: [`backend/app/optical/align/mirror_coupling.py`](../../backend/app/optical/align/mirror_coupling.py) (pure), served as `POST /api/v3/align/mirror-coupling` ([`backend/app/routers/v3_align.py`](../../backend/app/routers/v3_align.py)). UI: [`frontend/src/components/optical/MirrorCouplingPanel.tsx`](../../frontend/src/components/optical/MirrorCouplingPanel.tsx), which calls it through [`frontend/src/api/align.ts`](../../frontend/src/api/align.ts). Anchor poses: [`frontend/src/utils/anchorPose.ts`](../../frontend/src/utils/anchorPose.ts) on the web, [`anchor_poses.py`](../../backend/app/optical/align/anchor_poses.py) on the backend. Frames in [anchors.md](anchors.md); the single-optic align it complements is in [placement.md](placement.md).
>
> Added 2026-08-24 as a frontend-only tool, ported to the backend 2026-09-22, and **since 2026-09-23 the web app CALLS that port and its TypeScript copy is deleted** — there is one implementation. See [One implementation, and what pins it](#one-implementation-and-what-pins-it).

## What it does

Select two steering mirrors. The panel finds the seed beam arriving at the first one and the port the chain ends at, then solves both mirrors' **positions and orientations** so that

1. the angle of incidence is exactly **45.000°** on each mirror,
2. the spot sits on each mirror's **centre** (decentre 0), and
3. the outgoing beam **is** the destination port's own axis.

Everything is closed form. Nothing is iterated, so (1)–(3) hold exactly, not to a tolerance.

## Why the problem is well posed

Write the input line `L_in = (P_in, d0)`, the middle leg direction `d1`, and the target line `L_tgt = (P_tgt, dT)` with `dT` pointing INTO the destination.

45° on both mirrors means each reflection turns the beam by 90°:

```
d1 · d0 = 0      and      d1 · dT = 0
```

and the reflection law then fixes both normals with nothing left to choose:

```
nA = unit(d1 − d0)        nB = unit(dT − d1)
```

"Spot on the mirror centre" means the centres lie ON the rays: `C_A ∈ L_in`, `C_B ∈ L_tgt`, with `C_B − C_A ∥ d1`. How many solutions that has depends only on `d0` vs `dT`:

| Case | Solution |
|---|---|
| `\|d0 × dT\| > 0` (generic) | `d1 = unit(d0 × dT)`; `C_A`, `C_B` from a 2×2 solve. **Unique.** |
| `dT = ±d0` (collinear) | A U-turn or a periscope. `d1` is still pinned — it must be the perpendicular offset `Δ⊥` between the two parallel lines — but the pair can **slide along `d0` together**. **One free DOF**, surfaced as the *Fold position* field and defaulted to least total travel. |
| **near**-collinear (the unique answer exists but sits off the bench) | Same free-DOF branch, plus a warning quantifying what that costs. See [Why the branch is picked on distance, not angle](#why-the-branch-is-picked-on-distance-not-angle). |
| collinear and `Δ⊥ = 0` | The lines coincide; two mirrors have nothing to correct. Refused. |

The 2×2 solve, with `w = P_tgt − P_in`, `a = w·d0`, `b = w·dT`, `c = d0·dT`:

```
s = (a − c·b) / (1 − c²)        C_A = P_in + s·d0
u = (c·a − b) / (1 − c²)        C_B = P_tgt + u·dT
```

⚠️ **The bench's common case is the DEGENERATE one.** The live DBR → TA path has `d0 = −y` and `dT = +y` — exactly anti-parallel — so the free-DOF branch is not an edge case to bolt on later; it is the branch that runs. Any change here must keep it.

## Why the branch is picked on distance, not angle

`1 − c²` **is** `sin²θ`, so the unique branch's conditioning dies long before `sinTheta` reaches any epsilon you would call "collinear". A sine threshold alone therefore picks the wrong branch over a wide band — and the bench lives in that band, because a beam only has to clip one decentred lens to pick up a few thousandths of a degree.

That is what happened to the live DBR → TA path on 2026-08-27 (it had worked on 2026-08-24). A decentred `LENS_BICONVEX0` in the telescope ahead of MIRROR5 left the seed **0.00196°** off −y while the TA's port axis was still exactly +y:

```
|d0 × dT| = 3.42e-5      34x COLLINEAR_SIN_EPS (1e-6)  ->  "not collinear"
1 - c²    = 1.17e-9      s = -1_459_701 mm, u = +1_459_618 mm
                         both centres 1.46 KM up the beam, 4.8 nm apart
                         -> "the two mirror centres come out on top of each other"
```

Both answers are correct; only one is on a table. So the branch is chosen by **where the answer lands**, not by the angle ([`mirror_coupling.py:254`](../../backend/app/optical/align/mirror_coupling.py#L254)): solve the unique branch first, and if either line parameter exceeds `MAX_SOLVE_SPAN_MM` (5 m, [`mirror_coupling.py:53`](../../backend/app/optical/align/mirror_coupling.py#L53)) fall through to the free-DOF branch. `COLLINEAR_SIN_EPS` still guards the division itself.

What the fallback costs, and why it is stated rather than swallowed: `C_B = C_A + Δ⊥` puts `C_B` on the perpendicular to `L_in`, not on `L_tgt`, so with `d0` and `dT` not quite anti-parallel the beam reaches the port on a line **parallel to** its axis, offset by the residual. The outgoing *direction* is still exactly `dT` (`normalB = unit(dT − d1)` reflects `d1` onto `dT` for any `d1`), 45° stays exact on A, and B absorbs half the residual (44.99902° in the live case). The warning names the residual angle and the miss in mm — 0.005 mm here — because whether µm matter is the user's call, not the solver's. Pinned by the `solve` cases of [`backend/tests/fixtures/align/mirror_coupling.json`](../../backend/tests/fixtures/align/mirror_coupling.json) (which include both *the exact solve runs off the bench* and *the exact answer is on the bench, however shallow*), asserted by [`test_align_parity.py`](../../backend/tests/optical/test_align_parity.py) and by `backend/tests/optical/test_align_endpoints.py`.

The real fix for that scene is upstream: centre `LENS_BICONVEX0` and the lens inside MECHANICAL19, and `sinTheta` drops back to 1e-16 where the exact collinear branch runs.

## The precondition: both beams touch both mirrors

The panel leads with a 2×2 table, and refuses to solve until all four cells pass:

|  | Mirror A | Mirror B |
|---|---|---|
| **Seed beam** | live trace hits A | its reflection hits B |
| **Reverse reference ray** | its reflection off B hits A | back-projected port axis hits B |

The **reverse reference ray** is the port's own axis run backwards through both mirrors *at their current poses*. That is the bench procedure — send the TA's light back down the path and overlap it with the seed on both mirrors — written as a check. It is drawn in the viewer as a dashed cyan polyline (`sceneStore.mirrorCouplingGhost` → the `mirror-coupling-overlay` group under `labRoot`).

A cell passes when the crossing lands inside the mirror's clear-aperture **radius** (`anchor.apertureMm`, backend semantics: `r > aperture` misses) and in front of the ray's origin.

Why gate on this at all: when a mirror is far out, a solve that satisfies the three conditions would fling a mount across the table. Rough in by hand, then solve exactly — the panel names the failing cell and the miss in mm so you know which way to nudge.

## Rules

| # | Rule |
|---|---|
| R1 | Selection is exactly two `mirror` / `dichroic_mirror` objects. |
| R2 | A/B order comes from the **trace**, not click order (A is whichever the seed reaches first). |
| R3 | A traced segment must terminate on A. Several → a picker; segments coming back from B are excluded. |
| R4 | The target is an anchor with a direction: `intercept_in`, `fiber_in` or `seed`. Propagation into it is **−axisX** (axisX on an entry face is the outward normal). Objects upstream of A on the same trace are dropped from the picker. |
| R5 | Nothing between B and the destination may bend the beam by more than `DEVIATION_TOL_DEG` (0.05°) — otherwise the port's axis is not the line B must aim at, and the panel says which element bends it. |
| R6 | The 2×2 touch table passes. |
| R7 | Geometry exists (see the table above), with warnings when A lands upstream of the source, B lands past the port, or the two bodies would foul. |
| R8 | **Minimal disturbance**: the rotation is the SHORTEST rotation carrying the current normal onto the target one, pre-multiplied onto the existing quaternion. A round mirror is symmetric about its normal, so its roll is physically meaningless — but the mount and the user's mental picture are not. A mirror already aimed right is not spun at all. |
| R9 | One `updateSceneObjects` batch → **1 commit, 1 undo entry**, one re-solve ([placement.md](placement.md)'s iron rule). Locked objects are refused. |

## Pass-through optics

Only ONE line can be satisfied, so an optic between B and the port that is itself off-axis stays off-axis. The panel lists them with their miss, and a ticked-by-default **"Also centre pass-through optics on the new axis"** translates each onto the new line (`passThroughObjectIds` → the response's `passThroughMoves`, `align/point_dir.compute_translate_only_pose`) inside the same batch. Locked ones are skipped and reported in `passThroughSkipped`. Focusing kinds are flagged: a lens left off-centre will steer the chief ray, which the solve assumed nothing does.

## What this is NOT

- **Not a knob simulator.** A bolted mount only offers tip/tilt; those 4 DOF can hit the target line but cannot also hold 45° and a centred spot. This answers "where should the mounts be". A rotation-only *walk the beam* mode would be a separate solver.
- **45/45 is fixed, deliberately.** With both angles free the middle direction lies on a cone and the problem stops being well posed.
- Mounts and posts follow only through a **rigid group** (`utils/rigidGroup.ts`, expanded inside `updateSceneObjects`); anything outside one stays put. In the live scene MECHANICAL17 / MECHANICAL18 do follow, because they share a rigid group with their mirrors.

## Worked example (the live DBR → TA path, 2026-08-24)

```
seed        MIRROR5 → (0,−1,0) from (−298.9266, −453.5190, 908.8316)
target      TAPERED_AMPLIFIER0 · intercept_in at (−261.4350, −363.3235, 908.8316), axis +y
            ⇒ anti-parallel: free-DOF branch, Δ⊥ = 37.492 mm along +x, fold default 34.771 mm

                       before            after
  spot decentre        2.33 / 0.29 mm    0.00 / 0.00 mm
  angle of incidence   45.00 / 45.00°    45.00 / 45.00°   (already right; only positions were wrong)
  target axis miss     0.21 mm           0.00 mm

  MIRROR7   (−297.4142, −489.1494, 909.7603) → (−298.9266, −488.2896, 908.8316)   1.97 mm, no rotation
  MIRROR8   (−261.0181, −487.4298, 908.8316) → (−261.4350, −488.2896, 908.8316)   0.96 mm, no rotation
  WAVEPLATE2 0.45 mm off the new axis → centred (tick box)
```

0.21 mm is a total miss for a TA whose input mode is a few µm across — this is the geometry half of the ~0.1 % seed coupling recorded in [todo.md](todo.md) §3.2 (the other half is the mode mismatch a beam shaper has to fix).

## Invariants worth defending

- **`anchorPose.resolveAnchorPosesLab` must agree with the backend.** Asset body → Component CAD uses the binding's raw **XYZ** Euler (`bindingTreeObject.applyBindingLocalTransform`); Component CAD → lab uses the SceneObject's **YXZ-remapped** convention (`optical/frames.rotateLabDir`). Mixing them up puts every solved pose somewhere the tracer disagrees with. Pinned in `utils/__tests__/anchorPose.test.ts` against MIRROR5's traced hit point and reflection — both backend outputs — and, on the Python side, by `anchor_poses.json`.
- **`apertureMm` is a RADIUS**, matching `anchor_tracer.intersect_anchor`.
- **The free-DOF default must stay least-travel.** It is the only thing keeping a U-turn solve from sliding the pair an arbitrary distance down the beam.
- **Never pick the branch on `sinTheta` alone.** It is `1 − c²` that the solve divides by, and a scene only needs a few thousandths of a degree of stray pointing to land in the band where the "unique" answer is real, useless, and self-refuting. Distance decides; see the section above.

## One implementation, and what pins it

The align solvers used to live only in the web app. A second client of the backend (the qmem-blender add-on) needs them, and its rule is *no third implementation*: a solver it needs is ported into the backend and served, never rewritten in the client. Three were ported on **2026-09-22**, all compute-only (request / response shapes in [api.md](api.md#the-align-endpoints--post-apiv3align)); on **2026-09-23** the web app was rewired onto them and its TypeScript copies were **deleted**, so there is now exactly one implementation and nothing left to drift:

| Deleted TypeScript | Python (`backend/app/optical/align/`) | Endpoint | The web's caller |
|---|---|---|---|
| `utils/mirrorCoupling.ts` (635 lines) + `MirrorCouplingPanel.tsx`'s face / target / pass-through picks | `mirror_coupling.py` + `service.mirror_coupling_align` (`service.py:220`) | `POST /api/v3/align/mirror-coupling` | `api/align.alignMirrorCouplingApi` |
| `utils/isolatorAlign.ts` (285 lines) + `AlignToBeamControls.resolved` | `point_dir.py` + `service.resolve_align_point_dir` (`service.py:323`) | `POST /api/v3/align/isolator` | `api/align.alignPointDirApi` |
| `utils/aomAlign.ts` (263 lines) + `AomBraggSection`'s parameter picks | `aom_bragg.py` + `service.aom_bragg_align` (`service.py:415`) | `POST /api/v3/align/aom-bragg` | `api/align.alignAomBraggApi` |
| — (`utils/anchorPose.ts` STAYS: the store, the RF cable resolver, the mode-matching panel and the align panels' own picking all read anchor poses with it) | `anchor_poses.py` (on `db_scene_loader._binding_tree_transform`) | — (shared by all three) | — |

### What stayed on the web side

Picking, and only picking — which beam, which seed segment, the A/B order (rule R2 reads it off the trace), the target list and its ordering, the panels and their state. Everything those picks are fed INTO crossed:

- `MirrorCouplingPanel` sends `{mirrorAId, mirrorBId, inRay, target, foldMm, passThroughObjectIds}` and renders the response's `touch`, `plan`, `passThroughMoves` verbatim. It still resolves each mirror's `intercept_face` locally, but only to sort the target list by distance from B and to refuse a mirror with no usable face before a solve is attempted — never for geometry.
- `AlignToBeamControls` gets `(point, direction)` from the isolator endpoint's `pointCadMm` / `dirCadMm` (that resolution is the endpoint's; the panel has no copy of it) and only lifts it into lab to measure beam candidates against. The per-object `reverse` / `rollDeg`, the AOM's diffraction order and its fine-tune value are the panel's controls and are **sent with every request**, so what is on screen and what the solver used cannot disagree — the panel persists them fire-and-forget, so the stored row can be a write behind.
- The AOM's θ_B, drive frequency, Bragg frame and incidence readout all come from ONE `aom-bragg` call, so "where it should sit" and "where it sits now" are never measured by two different copies of the maths.

### The async seam

The solvers were synchronous calls; they are now HTTP. Both panels debounce by 200 ms, guard against an out-of-order answer with a sequence number, show the backend's own `detail` on a 4xx (`api/client.apiErrorMessage`), and clear `busy` in a `finally` so nothing can park on "Solving…". Mirror coupling disables Preview and Apply until a solve has landed. **Undo is untouched**: applying is still the same `updateSceneObjects` / `updateSceneObject` write it always was — one batch, one commit, one undo entry (R9) — the pose it writes merely arrives from the wire instead of from a local function.

One consequence worth knowing: the endpoints read each object's pose from the **database**. The store writes through (`updateObjectApi` is awaited before the local scene is patched), so the two agree at rest, but an uncommitted pose — a drag in flight, a `previewObjectTransform` ghost — is invisible to them. That is the intent (a ghost is not where the object is), but it is a real difference from the in-process solvers, which read the store.

### The parity fixtures are now frozen goldens

`backend/tests/fixtures/align/*.json` were generated by `frontend/src/utils/__tests__/alignParity.test.ts` running the REAL TypeScript over every case the unit tests pinned plus seeded-random ones — both solve branches, exact and near anti-parallel lines, ry = ±90° gimbal poses, anti-parallel `setFromUnitVectors` flips, the warning strings. **That generator went with the TypeScript it ran.** The fixtures themselves are kept and **committed unchanged**: they are the frozen record of what the web app did before the rewire, and `backend/tests/optical/test_align_parity.py` (415 cases) still asserts the Python reproduces every one of them within **1e-9** (measured: 1.8e-12 mm worst case, Euler angles bit-identical).

So the invariant changed shape rather than going away:

- **Before**: two copies, regenerate the fixtures from the TS and make the Python follow.
- **Now**: one copy, and the fixtures are a **regression pin on the Python**. Nothing regenerates them. A deliberate change to an align solver's behaviour must edit the affected fixture entries by hand (or re-record them from the new Python) **and say so in the commit** — an accidental change fails `test_align_parity.py` loudly, which is the whole point of keeping them.
- `backend/tests/optical/test_align_endpoints.py` covers the HTTP layer the web now depends on (shapes, the 404/422 refusals, the U-turn case) and is the test to extend when an endpoint's contract changes.

What made 1e-9 achievable rather than approximate, and why the Python still reads like a transcription: the parts that branch or format were **transcribed**, not re-derived (`align/ts_compat.py`) — three.js r170's `setFromUnitVectors` (its anti-parallel axis choice picks WHICH 180° turn a reversed optic gets), `setFromRotationMatrix`, `Vector3.normalize` (multiply by `1/len`), `frames.sceneObjectEulerFromQuaternion` (conditioned at the gimbal pole since 2026-09-22, and pinned on its own by `euler.json`; before, its `asin` + fixed `|cos β| > 1e-8` cut read rounding noise at ry = ±90°, and the U-turn bench fixture `pairs[2]` planned mirror A with its normal **45° wrong** — both copies identically, so parity never noticed; see [anchors.md](anchors.md), Pose quantization), `Math.round` (ties to +∞) and `toFixed` (half away from zero on the exact binary value). Those transcriptions are now load-bearing on their own account: they are what makes the fixtures meaningful as a record. Where the two sides place points and directions under a pose, the Python uses the backend's own chain (`pose.point_body_to_lab`), which is what [anchors.md](anchors.md) already requires `anchorPose.ts` to equal.

Checked end to end on the live scene (2026-09-22, read-only): all 73 objects' anchor poses and role centres agreed with `resolveAnchorPosesLab` within 1e-9, and the MIRROR5 / MIRROR7 → TAPERED_AMPLIFIER0 coupling, ISOLATOR0's align and AOM0's Bragg align came out identical to the web app's then-TypeScript flow. That check is what licensed deleting the TypeScript a day later.

## Related

- [api.md](api.md) — the backend align endpoints' request / response shapes
- [placement.md](placement.md) — the snap engine, the single-optic align, and the batched-write iron rule
- [anchors.md](anchors.md) — the three frames and the anchor optical interface
- [optics.md](optics.md) — the solver this feeds, and the TA's mode-overlap model
- [todo.md](todo.md) — §3.2, the beam shaping that the geometry alone cannot fix
