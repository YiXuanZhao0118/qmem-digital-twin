[← Doc index](introduce/README.md)

# Surface optics — tracing parts through their real faces (plan)

> **Status (2026-09-23): Phases 0–2 landed** — the `assets_3d.surface_model` column, the surface engine (`backend/app/optical/surfaces/`), and its wiring into the anchor tracer. **Phase 3 has started: one asset, `la1509_b_step`, carries a surface model (see "Converted so far"); it is in no scene object, so the lab trace is unchanged.** Every other part still traces through its anchor op as described in [introduce/optics.md](introduce/optics.md). Phase 4 is not started.

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
- **Medium:** exactly one of `n` (constant isotropic), `material` (a name in the library below), or the uniaxial pair `nO` + `nE`. A uniaxial medium — the constant pair or a uniaxial material — requires `opticAxis` (asset-local); an isotropic one refuses it.
- **Materials** (`optical/surfaces/materials.py`, Sellmeier, λ in µm): `N-BK7` (Schott), `fused_silica` (Malitson 1965), and the uniaxial `crystal_quartz` / `calcite` (Ghosh 1999). All within 1e-4 of the handbook indices near 589 nm and at 1064 nm, except calcite n_e, where the fit is 2.7e-4 low (`tests/optical/test_surface_materials.py`).
- **Coating:** `uncoated` (default; Fresnel from the indices) · `ar` (`reflectance` = residual R, angle-independent) · `hr` (`reflectance`) · `partial` (`reflectance` = R of a non-polarizing splitter) · `polarizing` (transmits p, reflects s; optional `extinctionRatioPpDb` / `extinctionRatioSpDb`, same names and meaning as the PBS op's params, `anchor_ops/pbs.py:193-194`).
- **Structure:** at least one surface, unique surface ids, `front ≠ back`, and at least one surface touching `air` (otherwise light can never enter).

Not in the schema yet, on purpose (it lands with the phase that reads it): bulk effects inside a medium (Faraday rotation, the AOM interaction plane — Phase 3).

### Physics per surface (Phase 1 — landed)

`backend/app/optical/surfaces/`: `model.py` (parse the stored JSON), `materials.py`, `geometry.py` (intersection, normal, curvature), `interface.py` (one surface), `trace.py` (`trace_element`, the in-part loop). Everything works in the part's own body frame, on the same `BeamRay` the anchor tracer carries; Phase 2 below is how the tracer calls it.

The chief ray is traced exactly; the Gaussian envelope Q (the complex symmetric 2×2 beam matrix of [introduce/optics.md](introduce/optics.md), `E ∼ exp(−i·k/2·rᵀQ⁻¹r)`, in the canonical `beam_local_sp` frame) is carried paraxially about it, **reduced** (air-equivalent, `Q̂ = Q/n`), so every readout keeps using the vacuum λ and a ray leaving into air carries an ordinary Q.

1. **Intersection** (`geometry.intersect`) — plane, sphere and cylinder in closed form, keeping only the sheet that contains the vertex; conic/asphere by Newton on the sag from the plane hit. Aperture test in the tangent plane. Self-hits are rejected with the anchor tracer's `t_min = 1e-9`.
2. **Local frame** — unit normal from the sag gradient, and the curvature tensor `K` as the second fundamental form in an orthonormal tangent basis — exact off-vertex, not just the vertex curvature. `K > 0` curves toward +axisX. Hitting off-vertex tilts the normal, which is what steers a decentred lens.
3. **Direction** — with `N` oriented along the propagation and `cosθᵢ = N·d`: refraction `d' = μd + (cosθₜ − μcosθᵢ)N` (`μ = n₁/n₂`), reflection `d' = d − 2cosθᵢN`; `sin²θₜ > 1` → total internal reflection.
4. **Q** — in the plane-of-incidence frame (`e_s = d × N`, `p = d × e_s`; the canonical s at normal incidence), with `A = diag(1, e_t·p)` mapping tangent-plane coordinates onto the beam's transverse ones:
   `A₂·Q̂₂⁻¹·A₂ = A₁·Q̂₁⁻¹·A₁ − Δ·K`, `Δ = n_out·(N·d_out) − n_in·(N·d_in)`.
   One law for refraction and reflection. At normal incidence on a sphere it is the textbook `1/q₂ = (n₁/n₂)/q₁ − (n₂−n₁)/(n₂R)`; a concave mirror gets `f = R/2`; at oblique incidence it is Coddington's pair. `K` is rotated into the (s, t) frame first, so a tilted or cylindrical surface fills Q's off-diagonal.
5. **Jones and power** — per branch, amplitudes in the (s, p) frame of *this* plane of incidence; `power_mw` scales by the Jones intensity ratio and the Jones vector is not renormalised (as every anchor op does). A zero-power branch is dropped.
   - `uncoated`: Fresnel, with the transmitted amplitude scaled so `|τ|²` is the power transmittance. `r_p = (n₂cosθᵢ − n₁cosθₜ)/(n₂cosθᵢ + n₁cosθₜ)` for `p = d × e_s` on both sides (so `r_p = −r_s` at normal incidence).
   - `ar`: `√(1 − R)` on both components. `hr`: reflect with `(−√R, +√R)` — the perfect-conductor limit of Fresnel in this basis (the mirror op's `(+1, −1)` is the same up to a global phase). `partial`: reflect `(−√R, +√R)` and transmit `√(1−R)`. `polarizing`: transmit `(√att_p, √(1−att_s))`, reflect `(−√(1−att_p), +√att_s)`, with `att` from the PBS op's `_extinction_atten`.
   - Total internal reflection overrides every coating but `hr`: one reflected branch with the Fresnel TIR coefficients (`cosθₜ = +i·√(sin²θₜ − 1)`, the sign that matches the waveplate op's `e^{+iδ}` on the slow axis). A transmitted branch into `opaque` is absorbed.
   - The reflected fraction at a transmissive surface is not traced (no multiple reflections).
6. **Inside a medium** — `Q̂ += t/n·I` and `path_length_mm += t` (geometric, as the anchor ops count it). **A uniaxial medium stays one ray in v1**: the chief ray refracts with n_o, and the medium applies the Jones retardance `2π·(n_e(θ) − n_o)·t/λ` on the extraordinary axis, with `1/n_e(θ)² = cos²θ/n_o² + sin²θ/n_e²` and θ measured from the optic axis. That is exact to first order in `n_e − n_o` — ample for waveplates (a tilted zero-order quartz HWP matches the exact `k₀L(√(n_e²−sin²θ) − √(n_o²−sin²θ))` to 1e-3 relative). It does **not** split o and e into two rays, so a Glan or Wollaston (large birefringence, TIR selection) needs the split model before those kinds convert (Phase 3). Poynting walk-off is not modelled.
7. **The in-part loop** (`trace_element`) — a queue of (ray, medium). Each ray meets the nearest surface of the part; the side it arrives from must be the ray's current medium. A ray in air that finds nothing is an exit; a ray that arrives on an `opaque` side (the back of a mirror) is absorbed; any other mismatch (a ray in air meeting a lens face from its glass side — the part's rim) or a ray in glass that finds no surface is **lost** with a reason, as is anything past 32 interactions. Air gaps inside one asset work because a ray that re-enters air keeps looking for the part's surfaces. Internal segments are returned with their medium for drawing.
8. **Aperture energy clipping** (`trace._clip`, added 2026-09-23 after the LA1509 conversion). The chief ray must be inside a surface's aperture to hit it at all. A **circular** aperture also clips the Gaussian's power with the lens op's knife-edge function (`aperture.gaussian_circular_aperture_fraction`: `w_eff = √(w_x·w_y)` from the reduced Q at the surface, which is the physical width inside glass too, and the decentre `√(u² + v²)`).
   - **Each path through a part is attenuated by its tightest aperture, not the product of all of them.** The knife-edge model assumes a full Gaussian arriving, and behind the first aperture the wings are already gone. Multiplying would clip a lens's two equal faces twice (0.865² = 0.75 instead of 0.865 for a beam as wide as the aperture).
   - Every circular surface met is recorded in `ElementTrace.clips`, and the removed power in `clipped_mw`.
   - Rectangle / ellipse apertures still clip the chief ray only.

**Verified** (`tests/optical/test_surface_trace.py`, 26 cases; `test_surface_materials.py`, 9; `tests/test_surface_model.py`, 36):

- aperture clipping (`test_surface_trace.py`): a wide beam through a two-face lens is clipped once, by the tighter face (exactly `1 − exp(−2a²/w²)` at the entry × the AR loss), and a smaller exit aperture takes over when it is the tighter one; a decentred beam uses the knife-edge; the ray-traced EFL of a plano-convex is `R/(n−1)` from either side (1e-7), of a biconvex the thick-lens formula, of a plate None, of a negative lens negative;
- the tracer descriptor (`test_surface_tracer.py`): a beam clipped by ~15 % through the LA1509 gives the same `apertureMm` / `wEffMm` / `decenterMm` / `transmittedFraction` / `transmittance` / `combinedFraction` and the same output power as the thick-lens op path (1e-12), with `focalLengthMm` = `R/(n−1)`; end to end on the live API, `la1509_b_step` at 852 nm with a 10 mm beam reports clip 96.03 %, EFL 101.02 mm, and `POST /api/v3/pop` on that descriptor puts the first Airy null at 4.134 µm = `1.22λf/D`;
- tilted plate at 0°/10°/30°/56.3°: lateral shift `L·sinθ·(1 − cosθ/√(n² − sin²θ))` to 1e-12 mm, direction unchanged, geometric path length exact; reverse traversal gives the same shift and power;
- Brewster plate: p lossless, s losing `(1 − r_s²)²`, and Q equal to **Kogelnik's** effective lengths `L√(n²+1)/n²` (sagittal) and `L√(n²+1)/n⁴` (tangential) to 1e-9;
- normal incidence: Fresnel `(1 − R)²` and AR `(1 − R)²` to 1e-14;
- right-angle prism: 90° turn by TIR, power = the two entry/exit faces only; TIR s–p phase = the textbook `2·atan(cosθ√(sin²θ − 1/n²)/sin²θ)` to 1e-12;
- LA1509 at normal incidence: exit Q equals the existing `_thick_lens_abcd` golden to 1e-12 relative, emitted at the back vertex;
- decentred LA1509: deflection `−h/EFL` to 2e-3;
- a tilted spherical surface (25°): the Q-derived sagittal and tangential foci equal Coddington's closed forms to 1e-6, **and** equal where exactly-traced neighbour rays cross the chief ray — 2e-12 sagittal, 7e-7 tangential (the residual is the fan's own coma, first order in its offset);
- cylinder: the unpowered axis is exactly a slab; concave mirror: `f = R/2` to 1e-12; flat 45° mirror; the back of a mirror absorbs;
- PBS cube: s reflected out the side face, p straight through, extinction leaking `10^(−ER/10)` into the other port;
- zero-order quartz HWP (780 nm): (1, 1)/√2 → (1, −1)/√2; retardance drift at 852 nm exact; tilt against the exact formula to 1e-3;
- a missed ray comes back unchanged; a ray through the rim is lost with a reason; `conic` with k = 0 reproduces `sphere` off-axis to 1e-9.

### Tracer integration (Phase 2 — landed)

- **Loader** (`db_scene_loader._surface_model`): `anchor_asset_to_snapshot` parses `surface_model` onto `V3AssetAnchorSnapshot.surface_model`. It stays None for the op-only kinds (`surfaces/model.py:OP_ONLY_KINDS` — the decision list above) and for a stored blob that no longer validates (logged; the part then traces through its anchors). An asset with a surface model but no anchors is still loaded. The component preview (`run-from-component`) goes through the same function.
- **Hit test** (`anchor_tracer.nearest_surface_hit`): a slot with a surface model is hit-tested on **all** its surfaces and **none** of its anchors (`nearest_anchor_hit` skips it); the main loop takes whichever of the two hits is nearer. All surfaces, not just the air-facing ones, so a ray meeting the back of a mirror or a lens rim reaches `trace_element`, which absorbs or loses it.
- **Surface path** (`anchor_tracer._trace_surface_part`): the ray goes into the body frame exactly as for an op (Q and Jones rotated lab→body), `trace_element` runs, and the exits come back to the lab through `_ray_body_to_lab` — **without** the incoming→outgoing `sp_rotation_between_directions` step the op path applies, because the engine already returns Q and Jones in the outgoing frame; doing both would rotate twice. Exits carry `exclude_face_key = "<object>/<binding>/surface_model"`: the in-part loop already exhausted the part's surfaces, so an exit never re-enters it, while a ray coming back from another part (a new key) does.
- **Segments**: the approach segment (its `faceInId` is the entry surface id), then one segment per stretch inside the part with **`LabSegment.medium`** = the media id (or `"air"` for a gap inside the part), serialised as `medium` on every `labSegments` entry (null for ordinary free space; typed in `frontend/src/api/client.ts`). Its Q at start is the reduced Q, so the width readout inside glass is right with the vacuum λ.
- **Lost rays** become `V3SolverResult.warnings` (`"<catalog_id> (<object>): <reason>"`) via the new `AnchorTraceResult.warnings`.
- **API**: `PUT /api/v3/assets3d/{key}` refuses a non-null `surfaceModel` on an op-only kind with 422 (clearing it is always allowed).
- **Clear-aperture descriptor for lens kinds** (`_trace_surface_part`): the approach segment of a `LENS_KINDS` part carries the same `apertureTruncation` dict as the lens-op path, so BeamScope's "Aperture: X% through" and its POP focal-plane view work unchanged. The fields:
  - `apertureMm` / `wEffMm` / `decenterMm`: the entry surface's clip.
  - `transmittedFraction`: the tightest aperture along the path.
  - `combinedFraction`: exit power over incident power.
  - `transmittance`: combined over transmitted, i.e. the coating / Fresnel part.
  - `focalLengthMm`: **the part's own EFL along this ray** (`trace.effective_focal_length`: `−h/Δθ` from exactly traced parallel neighbour rays in both transverse axes, geometric mean). This is the true EFL of a thick lens, not its BFL, and 0 when the part has no focal length (a plate), which switches POP off.
- Not surface-aware yet: the align / mode-match services, which read `asset.anchors` and `focalLengthMm` directly.

**Verified.**

- **Live scene unchanged.** `run-from-db`'s solve, in process, before and after: the same scene digest (144 slots), the same 46 segments, byte-identical JSON once the new, always-null `medium` key is removed.
- **Surface path ≡ op path** (`tests/optical/test_surface_tracer.py`): LA1509 under a rotated + translated pose, traced through its thick-lens op and through its surfaces, leaves at the same point (1e-12 mm), with the same Q (1e-12 relative), Jones (an elliptical input, 1e-12), power and path length. That pins the frame handling of the new path against the old one.
- The in-glass segment runs vertex to vertex in the lab and carries `1/Q̂ = 1/q − (n−1)/R`; a stray anchor on a surface-model asset never fires; a surface plate + an op mirror behind it gives two in-glass segments, one each way; a rim ray becomes a solver warning; the loader cases (no anchors, op-only kinds, an invalid blob, no surface model); the 422.
- Full backend suite: 3034 passed; the 4 `test_rf_cables_endpoints.py` failures are the same as on the untouched tree. Frontend `tsc` clean.

### Converting kinds (Phase 3)

In order: plate / window, polarizer, waveplate (HWP, QWP) → lenses (including cylindrical) → mirror (one HR surface over `opaque`; curved mirrors come for free) → PBS / beam splitter (hypotenuse coating) → Faraday rotator and AOM (need the bulk effects added to `media`). Each conversion authors `surface_model` on the catalog assets of that kind. **Take the geometry from the asset's own mesh**, not the catalog JSONs' retired `faces`: for LA1509-B the JSON assumed the convex side at the entry anchor, and the mesh has it the other way round. Note that the two Glan-Laser prisms (`glan_laser_io3_850`, `glan_laser_io5_850`) are `beam_splitter` kind, and they need the o/e split model before they can convert.

#### Converted so far

| Asset | Converted | Surface model | Before → after |
|---|---|---|---|
| `la1509_b_step` (LA1509-B, used by the "Opt PCX 100.00" component, in no scene object) | 2026-09-23, via `PUT /api/v3/assets3d/la1509_b_step` after the user unlocked it; left unlocked | From the GLB (asset frame = component frame): `flat` plane at z = 0 (glass on +z), `convex` sphere R = −51.5 with its vertex at z = 3.59 (least-squares sphere fit of the dome, R = 51.500, residual 1.7e-7 mm; rim top at z = 1.9995 = the 2.0 mm edge). Both apertures r = 12.7. `N-BK7`. AR 0.25 % per face, keeping today's 0.995 total. The model is pinned in `tests/optical/test_surface_trace.py::la1509_b_step`. | Component preview, 852 nm, 1 mm waist, from 50 mm out. **Flat side first (+z):** focus z = 99.96 → **104.57**; exit moves from the anchor plane (z = 0) to the convex vertex (z = 3.59). **Convex side first (−z):** focus z = −99.96 → **−98.60**. It was a thin lens (its `defaultParams` never had `radiusFrontMm`, so `_is_thick` was false); now it is a thick lens with EFL 101.02 mm at 852 nm (dispersion: 99.65 at n_d), and it is orientation-dependent. Both directions equal `_thick_lens_abcd` to 4e-18. A ray 3 mm off axis now crosses the axis at z = 104.22, 0.35 mm short of the paraxial focus: longitudinal spherical aberration, which the thin lens could not show (it sent that ray to exactly z = 100.0). Live `run-from-db` trace unchanged. |

After a conversion, for that asset:
- `defaultParams` are no longer read by the trace (`focalLengthMm`, `refractiveIndex`, `centerThicknessMm`, `transmittance` stay because the kind schema requires them).
- A mode-match focal-length swap (`mode_match_model`, `focalLengthMm` override) has no effect on it.

To undo a conversion, `PUT` `{"surfaceModel": null}`.

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
