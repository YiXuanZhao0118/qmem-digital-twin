[← Doc index](introduce/README.md)

# Surface optics — tracing parts through their real faces (plan)

> **Status (2026-09-23): Phase 0 landed (the `assets_3d.surface_model` column + its schema). Phases 1–4 are not started.** Nothing in the live tracer reads `surface_model` yet; every part still traces through its single anchor as described in [introduce/optics.md](introduce/optics.md).

## Why

Today every optical part except the thick lens is **one plane** — the primary anchor — where the kind's op applies one whole-part transform (`anchor_tracer.py:457-711`, ops in `optical/anchor_ops/`). There is no Snell refraction, no angle-dependent Fresnel, no dispersion; refractive index appears only as an `L/n` slab step and inside the thick-lens ABCD. Consequences that matter on the bench and that the model cannot show:

- a tilted plate / waveplate / PBS does not displace the beam, and adds no astigmatism;
- a decentred lens does not steer the beam, and a tilted thick lens is traced as untilted (`optics.md` "thick-lens model");
- waveplate retardance is a typed number, not `2π·(n_e − n_o)·L/λ` at the actual incidence angle;
- no Fresnel loss, no Brewster angle, no total internal reflection;
- slab path length is counted twice: slab ops add `L/n` to q but restart the ray on the entry anchor plane, so the next air gap re-counts the part's thickness (`pbs.py:210-216` says so deliberately).

The goal: a part is a set of **real surfaces with media between them**, and the beam is traced through each surface — e.g. a HWP is *face A → birefringent quartz of thickness L → face B*.

## Decisions (2026-09-23)

| Question | Decision |
|---|---|
| Which kinds move to surfaces | Every free-space optical part. **Kept on today's op:** `tapered_amplifier`, `laser_source`, the sinks (`detector`, `camera`, `spectrometer`, `wavemeter`, `beam_dump`), `fiber` / `fiber_coupler` / `fiber_connector` (Marcuse overlap coupling stays), and `eom` (the only EOM asset, `eospace_pm_0k1_nir`, is fibre-pigtailed). |
| Multiple reflections (etalon / ghosts) | **Not in v1.** One transmitted (or one reflected) pass; the power a partial reflection takes is lost, and the ghost ray is not traced. |
| Why this is not a return to the retired `faces[]` | 0106 retired the face path for consolidation (the anchor tracer had become the only caller), not because the physics was wrong. The one physics reason on record — `optics.md` "Why one anchor rather than two surfaces": the tracer propagates q as **air** between anchors — is exactly what the sub-trace below removes: the medium between faces is traced inside the element, never by the main loop. |
| Aberrations | Out of scope. The Gaussian beam is propagated paraxially **about an exactly-traced chief ray**, so focus, tilt/decentre astigmatism, displacement and Fresnel are captured; spherical aberration and coma are not. The Collins/POP solver (`solvers/`, not wired to the tracer) is the escalation path if needed. |

## The model

A part with a surface model is **surfaces + media**, not an ordered list: each surface names the medium on either side of it, and inside a medium the next surface is found geometrically (nearest hit among the surfaces bounding that medium). That one rule covers every case without per-kind sequencing:

- a plate or waveplate: A (air | quartz) and B (quartz | air);
- a lens: A (air | glass, sphere R₁) and B (glass | air, sphere R₂);
- a PBS cube: entry face → hypotenuse (glass | glass, polarizing coating, splits into T and R) → each branch finds its own exit face;
- a beam entering from B simply meets B first — reverse traversal needs no special case;
- a mirror: one surface (air | `opaque`) with an HR coating; what the coating transmits is absorbed.

### Data: `assets_3d.surface_model` (Phase 0 — landed)

Nullable JSONB (alembic `0141_asset_surface_model`); **NULL = no surface model**, the part keeps its anchor op. Validated by `SurfaceModelV3` in `backend/app/schemas_v3.py` on `PUT /api/v3/assets3d/{key}`; returned raw as `surfaceModel` on `Asset3DV3Out`. All geometry is asset-local mm, in the same frame as `anchors[]`.

```jsonc
{
  "media": {
    "quartz": { "nO": 1.5384, "nE": 1.5474, "opticAxis": {"x": 0, "y": 1, "z": 0} },
    "glass":  { "n": 1.5168 }          // or { "material": "N-BK7" } once Phase 1 adds the library
  },
  "surfaces": [
    {
      "id": "A",
      "positionMmBodyLocal": {"x": 0, "y": 0, "z": 0},      // vertex
      "axisXBodyLocal":      {"x": 0, "y": 0, "z": 1},      // surface normal
      "axisYBodyLocal":      {"x": 0, "y": 1, "z": 0},      // transverse reference
      "shape":    { "type": "plane" },
      "aperture": { "shape": "circle", "radiusMm": 5.0 },
      "front": "quartz",                                    // medium on the +axisX side
      "back":  "air",                                       // medium on the −axisX side
      "coating": { "type": "ar", "reflectance": 0.0025 }
    }
  ]
}
```

Conventions (enforced by the validator unless noted):

- **Reserved media ids:** `air` (the ambient, n = 1) and `opaque` (a ray transmitted into it is absorbed). Neither may appear as a key of `media`. Every `front` / `back` must be a reserved id or a `media` key, and every `media` entry must be used by some surface.
- **Axes:** `axisX` is the surface normal at the vertex; `axisY` is the transverse reference (the curvature direction of a `cylinder`, the width of a `rectangle` aperture); `axisZ = axisX × axisY` is derived, not stored. Both stored axes must be unit length and orthogonal (tolerance 1e-4).
- **Shape and sign of R:** `plane` (no radius) · `sphere` (`radiusMm`) · `cylinder` (`radiusMm`, curved along axisY only) · `conic` (`radiusMm`, `conic` k, optional `asphericCoeffs` = A₄, A₆, … in the even-asphere sag). **`radiusMm > 0` puts the centre of curvature on the +axisX side** (vertex + R·axisX). With axisX along the propagation direction this is the usual optics convention: a biconvex lens has R₁ > 0, R₂ < 0.
- **Aperture:** `circle` needs `radiusMm` (explicitly a *radius* — the anchor field `apertureMm` is ambiguous, see [introduce/anchors.md](introduce/anchors.md)); `rectangle` / `ellipse` need full `widthMm` (along axisY) and `heightMm` (along axisZ). Measured in the surface's tangent plane.
- **Medium:** exactly one of `n` (constant isotropic), `material` (a library name — not checked until the Phase 1 library exists), or the uniaxial pair `nO` + `nE`, which requires `opticAxis` (asset-local).
- **Coating:** `uncoated` (default; Fresnel from the indices) · `ar` (`reflectance` = residual R, angle-independent) · `hr` (`reflectance`) · `partial` (`reflectance` = R of a non-polarizing splitter) · `polarizing` (transmits p, reflects s; optional `extinctionRatioPpDb` / `extinctionRatioSpDb`, same names and meaning as the PBS op's params, `anchor_ops/pbs.py:193-194`).
- **Structure:** at least one surface, unique surface ids, `front ≠ back`, and at least one surface touching `air` (otherwise light can never enter).

Not in the schema yet, on purpose (each lands with the phase that reads it): bulk effects inside a medium (Faraday rotation, the AOM interaction plane — Phase 3), the material library (Phase 1).

### Physics per surface (Phase 1)

The chief ray is traced exactly; the Gaussian envelope Q (the complex symmetric 2×2 beam matrix of [introduce/optics.md](introduce/optics.md), `E ∼ exp(−i·k/2·rᵀQ⁻¹r)`) is carried paraxially about it, **reduced** (air-equivalent, `Q̂ = Q/n`) so every readout keeps using the vacuum λ.

1. **Intersection** — plane and sphere in closed form, cylinder in closed form in its curved section, conic/asphere by Newton iteration on the sag. Aperture check in the tangent plane.
2. **Local frame** — unit normal `N` and curvature tensor `K` (2×2, in the tangent plane) at the hit point. Hitting off-vertex tilts `N`, which is what makes a decentred lens steer the beam.
3. **Direction** — vector Snell with `μ = n₁/n₂`, `cosθᵢ = −N·d`: `d' = μd + (μcosθᵢ − cosθₜ)N`; `sin²θₜ > 1` → total internal reflection. **Reflection is the same formula with n₂ = −n₁**, so HR coatings and TIR reuse the refraction code.
4. **Q** — in the plane-of-incidence frame (tangential t, sagittal s), with `Aᵢ = diag(cosθᵢ, 1)`, `Aₜ = diag(cosθₜ, 1)`, phase matching on the surface gives
   `Aₜ·Q̂₂⁻¹·Aₜ = Aᵢ·Q̂₁⁻¹·Aᵢ − (n₂cosθₜ − n₁cosθᵢ)·K`.
   At normal incidence on a sphere this reduces to the textbook `1/q₂ = (n₁/n₂)/q₁ − (n₂−n₁)/(n₂R)`; at oblique incidence it is Coddington's pair (tangential and sagittal focal lengths). `K` is rotated into the (t, s) frame first, so a tilted or cylindrical surface fills Q's off-diagonal.
5. **Jones and power** — Fresnel `t_s`, `t_p` (or the coating's) in the (s, p) frame of *this* plane of incidence; power × T. The reflected fraction is dropped (no multiple reflections).
6. **Inside a medium** — `Q̂ += L/n·I`, `path_length += n·L`. A uniaxial medium resolves the ray into o and e (`1/n_e(θ)² = cos²θ/n_o² + sin²θ/n_e²`, θ from the optic axis). Where the two directions coincide within the beam (a waveplate near normal incidence) they stay **one ray** and the medium applies the Jones retardance `2π·(n_e(θ) − n_o)·L/λ`; where they separate (Glan, Wollaston) they become two rays. The exact threshold is a Phase 1 decision; Poynting walk-off is not modelled in v1.
7. **Termination** — a ray that enters `opaque` is absorbed; a ray that finds no bounding surface inside its medium, or exceeds a small internal-hit budget, is dropped and reported (a malformed surface model, not a physics result).

Phase 1 is a standalone module (`optical/surfaces/`), **not wired into the tracer**. Done when these pass:

- tilted plate: lateral shift `L·sinθ·(1 − cosθ/√(n² − sin²θ))`, direction unchanged, path length exact;
- Brewster: `R_p = 0` at `θ_B = atan(n₂/n₁)`; TIR past the critical angle;
- LA1509 at normal incidence (R = 51.5 / ∞, n = 1.5168, d = 3.6): same Q as the existing thick-lens golden (`_thick_lens_abcd`);
- tilted lens: tangential/sagittal focal lengths vs Coddington;
- decentred lens: deflection ≈ `d/f`;
- zero-order quartz HWP at normal incidence: retardance π at the design λ, and its drift with λ and tilt.

### Tracer integration (Phase 2)

- A slot whose asset has a `surface_model` is hit-tested on its **outer surfaces** (those with `air` on one side) instead of its primary anchors; everything else is unchanged. The sub-trace runs inside the element and hands the exiting ray(s) back to the main loop, which only ever propagates through air — this is what removes the double-counted slab.
- Segments inside the element are returned with a medium tag so the web frontend and the Blender add-on can draw them.
- Assets without a surface model keep their anchor op; both paths coexist until Phase 3 is complete.
- Done when: the whole backend suite is green, and a live `run-from-db` trace is identical before and after for a scene whose assets carry no surface model.

### Converting kinds (Phase 3)

In order: plate / window, polarizer, waveplate (HWP, QWP) → lenses (including cylindrical) → mirror (one HR surface over `opaque`; curved mirrors come for free) → PBS / beam splitter (hypotenuse coating) → Faraday rotator and AOM (need the bulk effects added to `media`). Each conversion authors `surface_model` on the catalog assets of that kind — the catalog JSONs still carry the retired `faces` data, a usable starting point for positions.

Open questions to settle there:

- **Locked assets.** Most catalog assets are `locked`; `lock_guard` 422s writing `surface_model` on them. Each conversion needs the user to unlock the rows (or explicitly authorise a migration, as 0126/0127/0134/0135/0137 were).
- **Params the surfaces make redundant** (`focalLengthMm`, a waveplate's retardance, `refractiveIndex`, `lengthMm`): once a surface model exists they become derived. Proposed: ignored by the trace, and checked against the computed value with a warning when they disagree.
- **Per-instance rotation of a waveplate** (`fastAxisDeg` is tunable today): the optic axis in `media` is asset-local, so the instance's `fastAxisDeg` must rotate it about the surface normal to keep rotation mounts working.

### Authoring and display (Phase 4)

- Blender add-on (`qmem-blender`): pick mesh faces, fit a sphere / plane (vertex, normal, R), and write a surface; draw the in-medium segments.
- Web frontend: show and edit `surfaceModel` in the PHY Editor; draw the in-medium segments.

## Related

- [introduce/optics.md](introduce/optics.md) — the live anchor tracer this plan extends
- [introduce/anchors.md](introduce/anchors.md) — anchor frames and apertures
- [introduce/asset.md](introduce/asset.md) — the Asset3D row that carries `surface_model`
- [introduce/migrations.md](introduce/migrations.md) — `0141_asset_surface_model`
