[← Doc index](README.md)

# Mirror coupling — two 45° mirrors into a port

> The tool that answers "where do I bolt these two mounts so the seed lands on the TA's axis". Solver: [`frontend/src/utils/mirrorCoupling.ts`](../../frontend/src/utils/mirrorCoupling.ts) (pure, unit-tested). UI: [`frontend/src/components/optical/MirrorCouplingPanel.tsx`](../../frontend/src/components/optical/MirrorCouplingPanel.tsx). Anchor poses: [`frontend/src/utils/anchorPose.ts`](../../frontend/src/utils/anchorPose.ts). Frames in [anchors.md](anchors.md); the single-optic align it complements is in [placement.md](placement.md).
>
> Added 2026-08-24. **Frontend only** — no backend change, no migration, no Kind edit.

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
| collinear and `Δ⊥ = 0` | The lines coincide; two mirrors have nothing to correct. Refused. |

The 2×2 solve, with `w = P_tgt − P_in`, `a = w·d0`, `b = w·dT`, `c = d0·dT`:

```
s = (a − c·b) / (1 − c²)        C_A = P_in + s·d0
u = (c·a − b) / (1 − c²)        C_B = P_tgt + u·dT
```

⚠️ **The bench's common case is the DEGENERATE one.** The live DBR → TA path has `d0 = −y` and `dT = +y` — exactly anti-parallel — so the free-DOF branch is not an edge case to bolt on later; it is the branch that runs. Any change here must keep it.

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

Only ONE line can be satisfied, so an optic between B and the port that is itself off-axis stays off-axis. The panel lists them with their miss, and a ticked-by-default **"Also centre pass-through optics on the new axis"** translates each onto the new line (`computeTranslateOnlyPose`) inside the same batch. Focusing kinds are flagged: a lens left off-centre will steer the chief ray, which the solve assumed nothing does.

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

- **`anchorPose.resolveAnchorPosesLab` must agree with the backend.** Asset body → Component CAD uses the binding's raw **XYZ** Euler (`bindingTreeObject.applyBindingLocalTransform`); Component CAD → lab uses the SceneObject's **YXZ-remapped** convention (`optical/frames.rotateLabDir`). Mixing them up puts every solved pose somewhere the tracer disagrees with. Pinned in `utils/__tests__/mirrorCoupling.test.ts` against MIRROR5's traced hit point and reflection — both backend outputs.
- **`apertureMm` is a RADIUS**, matching `anchor_tracer.intersect_anchor`.
- **The free-DOF default must stay least-travel.** It is the only thing keeping a U-turn solve from sliding the pair an arbitrary distance down the beam.

## Related

- [placement.md](placement.md) — the snap engine, the single-optic align, and the batched-write iron rule
- [anchors.md](anchors.md) — the three frames and the anchor optical interface
- [optics.md](optics.md) — the solver this feeds, and the TA's mode-overlap model
- [todo.md](todo.md) — §3.2, the beam shaping that the geometry alone cannot fix
