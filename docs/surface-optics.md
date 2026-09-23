[← Doc index](introduce/README.md)

# Surface optics — tracing parts through their real faces (plan)

> **Status (2026-09-23): Phases 0–2 landed** — the `assets_3d.surface_model` column, the surface engine (`backend/app/optical/surfaces/`), and its wiring into the anchor tracer. **Phase 3 is done:**
> - **Converted (23):** 12 lenses (the A230TM-B collimator, 4 plano-convex, 6 cylindrical, and the biconcave LD2297), both Casix waveplates, the BB1-E03 mirror, the four cubes, both Glan-laser prisms, and both Faraday rotators. See "Converted so far".
> - **Kept on its op by decision:** the AOM.
> - **The lab trace changed:** the whole seed path is now surface models, and the A230TM-B moved to its real spacing with the DBR mode re-fitted (see "Effect on the lab trace").
> - **Phase 4 is under way:** the backend fits a clicked face and meshes a model (`POST /api/v3/surfaces/fit`, `/sheets`); the Blender add-on authors surface models with them; the web PHY Editor shows one, read-only.

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
| Which kinds move to surfaces | Every free-space optical part. **Kept on today's op:** `tapered_amplifier`, `laser_source`, the sinks (`detector`, `camera`, `spectrometer`, `wavemeter`, `beam_dump`), `fiber` / `fiber_coupler` / `fiber_connector` (Marcuse overlap coupling stays), `eom` (the only EOM asset, `eospace_pm_0k1_nir`, is fibre-pigtailed), and — decided when converting, 2026-09-23 — `aom` (see "Converting kinds"). |
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

Nullable JSONB (alembic `0141_asset_surface_model`); **NULL = no surface model**, the part keeps its anchor op. Validated by `SurfaceModelV3` in `backend/app/schemas_v3.py` on `PUT /api/v3/assets3d/{key}`; returned raw as `surfaceModel` on `Asset3DV3Out`, except that a stored blob which no longer validates is served as null. Only a write outside the API can store one, and the tracer ignores it too (`Asset3DV3Out._serve_invalid_surface_model_as_null`). All geometry is asset-local mm, in the same frame as `anchors[]`.

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
- **Materials** (`optical/surfaces/materials.py`, Sellmeier, λ in µm): `N-BK7` (Schott), `fused_silica` (Malitson 1965), and the uniaxial `crystal_quartz` / `calcite` (Ghosh 1999). All within 1e-4 of the handbook indices near 589 nm and at 1064 nm, except calcite n_e, where the fit is 2.7e-4 low (`tests/optical/test_surface_materials.py`). Plus `S-NPH1_MOLD`, the A230TM-B's molded glass, from the Zemax archive's own catalogue (n_d 1.797892 exactly).
- **Coating:** `uncoated` (default; Fresnel from the indices) · `ar` (`reflectance` = residual R, angle-independent) · `hr` (`reflectance`) · `partial` (`reflectance` = R of a non-polarizing splitter) · `polarizing` (transmits p, reflects s; optional `extinctionRatioPpDb` / `extinctionRatioSpDb`, same names and meaning as the PBS op's params, `anchor_ops/pbs.py:193-194`).
- **Structure:** at least one surface, unique surface ids, `front ≠ back`, and at least one surface touching `air` (otherwise light can never enter).

- **Faraday rotation** (an isotropic medium only): `faradayRotationDegPerMm` + `magneticAxis` (asset-local), both or neither. A ray travelling `t` along `k` has its Jones vector re-expressed by `rotate_jones(−ρ·t·(k·b̂))`. This is the faraday op's handedness (reversed on 2026-06-12), and it is non-reciprocal: out and back accumulates twice the rotation.

Not in the schema, on purpose: an AOM interaction plane (the AOM keeps its op — see "Converting kinds").

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
   - `ar`: `√(1 − R)` on both components. `hr`: reflect with `(+√R, −√R)`. This is **the mirror op's convention**, so a converted mirror leaves the Jones vector exactly as the op did; the perfect-conductor Fresnel limit is the same up to a global phase. `partial`: reflect `(+√R, −√R)` and transmit `√(1−R)`. `polarizing`: transmit `(√att_p, √(1−att_s))`, reflect `(+√(1−att_p), −√att_s)`, with `att` from the PBS op's `_extinction_atten`.
   - Total internal reflection overrides every coating but `hr`: one reflected branch with the Fresnel TIR coefficients (`cosθₜ = +i·√(sin²θₜ − 1)`, the sign that matches the waveplate op's `e^{+iδ}` on the slow axis). A transmitted branch into `opaque` is absorbed.
   - The reflected fraction at a transmissive surface is not traced (no multiple reflections).
6. **Inside a medium** — `Q̂ += t/n·I` and `path_length_mm += t` (geometric, as the anchor ops count it), with the index of the ray's own eigenmode. **Uniaxial media split light into o and e rays** (the single-chief-ray model this replaced, on 2026-09-23, was exact only to first order in `n_e − n_o`):
   - **Entry.** Light going into a uniaxial medium, transmitted or reflected, becomes an **o** ray (index n_o, polarization `d × c`) and an **e** ray (index `n_e(θ)`, `1/n_e(θ)² = cos²θ/n_o² + sin²θ/n_e²`, θ from the optic axis c to its own wave vector, solved iteratively because the direction it refracts to sets θ). Each ray refracts with its own index, gets its own Fresnel factors, and carries the projection of the field onto its own polarization. A mode below `MODE_POWER_FLOOR` (1e-20 of the incident power) is dropped. Along the optic axis the two coincide and it stays one ray.
   - **Inside and out.** A ray keeps its eigenmode, and each interface uses that mode's index: total internal reflection selects by mode, which is what a Glan does. A reflection into a uniaxial medium re-splits, so mode conversion is included.
   - **Recombination** (`trace._merge_coherent`). Rays that leave the part parallel (1 − cos < 1e-12) and overlapping (lateral offset < 1e-3 of the beam radius) are added coherently. Each carries the optical phase `k₀·n·t` it gathered since entering the part, referred to one wavefront. The fast (lowest-phase) ray keeps its phase, as the waveplate op does, and the power follows the summed Jones intensity. A waveplate at any tilt therefore comes out exact: a tilted zero-order quartz HWP matches `k₀L(√(n_e²−sin²θ) − √(n_o²−sin²θ))` to 5e-12, where it was 1e-3 before. A calcite plate at 30° instead gives two separate beams, the right distance apart.
   - Poynting walk-off (the e ray's energy leaving its wave vector) is **not** modelled: a ray travels along its wave vector. So a normal-incidence beam displacer does not displace, and a Wollaston's split comes only from refraction at its tilted interface.
   - **Faraday**: see the medium schema above; the rotation is applied along the whole path in the medium.
7. **The in-part loop** (`trace_element`) — a queue of (ray, medium, eigenmode, phase, tightest aperture so far). Each ray meets the nearest surface of the part; the side it arrives from must be the ray's current medium. A ray in air that finds nothing is an exit; a ray that arrives on an `opaque` side (the back of a mirror) is absorbed; any other mismatch (a ray in air meeting a lens face from its glass side — the part's rim) or a ray in glass that finds no surface is **lost** with a reason, as is anything past 32 interactions. Air gaps inside one asset work because a ray that re-enters air keeps looking for the part's surfaces. Internal segments are returned with their medium for drawing.
8. **Aperture energy clipping** (`trace._clip`, added 2026-09-23 after the LA1509 conversion). The chief ray must be inside a surface's aperture to hit it at all. The aperture also clips the Gaussian's power, with `w_eff = √(w_x·w_y)` taken from the reduced Q at the surface (which is the physical width inside glass too):
   - A **circle** uses the lens op's knife-edge function (`aperture.gaussian_circular_aperture_fraction`) with the decentre `√(u² + v²)`.
   - A **rectangle** uses `aperture.gaussian_rect_aperture_fraction`: two 1-D slits multiplied, which is exact for a round Gaussian on an axis-aligned rectangle (checked against a Richardson-extrapolated 2-D integral to 1e-8).
   - **Each path through a part is attenuated by its tightest aperture, not the product of all of them.** The knife-edge model assumes a full Gaussian arriving, and behind the first aperture the wings are already gone. Multiplying would clip a lens's two equal faces twice (0.865² = 0.75 instead of 0.865 for a beam as wide as the aperture).
   - Every circular surface met is recorded in `ElementTrace.clips`, and the removed power in `clipped_mw`.
   - An ellipse still clips the chief ray only.

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
- cylinder: the unpowered axis is exactly a slab; concave mirror: `f = R/2` to 1e-12; flat 45° mirror; the back of a mirror absorbs, and so does the `1 − R` an HR coating lets through to its `opaque` backing (it went unrecorded in `absorbed_mw` until 2026-09-23);
- PBS cube: s reflected out the side face, p straight through, extinction leaking `10^(−ER/10)` into the other port;
- zero-order quartz HWP (780 nm): (1, 1)/√2 → (1, −1)/√2; retardance drift at 852 nm exact; tilt against the exact formula to 1e-9 (5e-12 measured);
- birefringence: a calcite plate at 30° splits a 45° beam into an s (e) and a p (o) beam, parallel, half the power each, separated by exactly `L·(tanθ_e − tanθ_o)·cosθ`; a Glan-type calcite pair with a 40° air gap sends the o ray out of the escape face by TIR (lossless) and the e ray straight through with the exact s Fresnel loss `(1 − R_s)²` of its two gap faces — the geometry of a Glan-Foucault, whose s-polarized e ray loses 55 % there; a crossed compound quartz plate retards by `k₀Δn(L₁ − L₂)`;
- Faraday (`test_surface_tracer.py`): a TGG rod as a surface model gives faraday_anchor_op's Jones vector forward and backward (1e-12), and out-and-back through 45° turns s into p; a quartz plate with `fastAxisDeg` = 30, from the asset or from the instance, gives the waveplate op's Jones vector (1e-10);
- a missed ray comes back unchanged; a ray through the rim is lost with a reason; `conic` with k = 0 reproduces `sphere` off-axis to 1e-9.

### Tracer integration (Phase 2 — landed)

- **Loader** (`db_scene_loader._surface_model`): `anchor_asset_to_snapshot` parses `surface_model` onto `V3AssetAnchorSnapshot.surface_model`. It stays None for the op-only kinds (`surfaces/model.py:OP_ONLY_KINDS` — the decision list above) and for a stored blob that no longer validates (logged; the part then traces through its anchors). An asset with a surface model but no anchors is still loaded. The component preview (`run-from-component`) goes through the same function.
- **Hit test** (`anchor_tracer.nearest_surface_hit`): a slot with a surface model is hit-tested on **all** its surfaces and **none** of its anchors (`nearest_anchor_hit` skips it); the main loop takes whichever of the two hits is nearer. All surfaces, not just the air-facing ones, so a ray meeting the back of a mirror or a lens rim reaches `trace_element`, which absorbs or loses it.
- **Surface path** (`anchor_tracer._trace_surface_part`): the ray goes into the body frame exactly as for an op (Q and Jones rotated lab→body), `trace_element` runs, and the exits come back to the lab through `_ray_body_to_lab` — **without** the incoming→outgoing `sp_rotation_between_directions` step the op path applies, because the engine already returns Q and Jones in the outgoing frame; doing both would rotate twice. Exits carry `exclude_face_key = "<object>/<binding>/surface_model"`: the in-part loop already exhausted the part's surfaces, so an exit never re-enters it, while a ray coming back from another part (a new key) does.
- **Segments**: the approach segment (its `faceInId` is the entry surface id), then one segment per stretch inside the part with **`LabSegment.medium`** = the media id (or `"air"` for a gap inside the part), serialised as `medium` on every `labSegments` entry (null for ordinary free space; typed in `frontend/src/api/client.ts`). Its Q at start is the reduced Q, so the width readout inside glass is right with the vacuum λ.
- **Lost rays** become `V3SolverResult.warnings` (`"<catalog_id> (<object>): <reason>"`) via the new `AnchorTraceResult.warnings`.
- **API**: `PUT /api/v3/assets3d/{key}` refuses a non-null `surfaceModel` on an op-only kind with 422 (clearing it is always allowed).
- **Clear-aperture descriptor for lens kinds** (`_trace_surface_part`): the approach segment of a `LENS_KINDS` part carries the same `apertureTruncation` dict as the lens-op path, so BeamScope's "Aperture: X% through" and its POP focal-plane view work unchanged. The fields:
  - `apertureMm` / `wEffMm` / `decenterMm`: the entry surface's clip. For a rectangle, `apertureMm` is its inscribed-circle radius (half the smaller side); that is the number the readout shows.
  - `transmittedFraction`: the tightest aperture along the path.
  - `combinedFraction`: exit power over incident power.
  - `transmittance`: combined over transmitted, i.e. the coating / Fresnel part.
  - `focalLengthMm`: **the part's own EFL along this ray** (`trace.effective_focal_length`: `−h/Δθ` from exactly traced parallel neighbour rays in both transverse axes, geometric mean). This is the true EFL of a thick lens, not its BFL. It is 0 when either axis has no power (`|1/f| < 1e-9`), which switches POP off: a plate, or **a cylindrical lens**. The old op path gave a cylindrical lens its `focalLengthMm`, and BeamScope drew a round-aperture Airy pattern for it, which is not the physics of a line focus. Leaving it off is deliberate.
- Not surface-aware yet: the align / mode-match services, which read `asset.anchors` and `focalLengthMm` directly.

**Verified.**

- **Live scene unchanged.** `run-from-db`'s solve, in process, before and after: the same scene digest (144 slots), the same 46 segments, byte-identical JSON once the new, always-null `medium` key is removed.
- **Surface path ≡ op path** (`tests/optical/test_surface_tracer.py`): LA1509 under a rotated + translated pose, traced through its thick-lens op and through its surfaces, leaves at the same point (1e-12 mm), with the same Q (1e-12 relative), Jones (an elliptical input, 1e-12), power and path length. That pins the frame handling of the new path against the old one.
- The in-glass segment runs vertex to vertex in the lab and carries `1/Q̂ = 1/q − (n−1)/R`; a stray anchor on a surface-model asset never fires; a surface plate + an op mirror behind it gives two in-glass segments, one each way; a rim ray becomes a solver warning; the loader cases (no anchors, op-only kinds, an invalid blob, no surface model); the 422.
- Full backend suite: 3034 passed; the 4 `test_rf_cables_endpoints.py` failures are the same as on the untouched tree. Frontend `tsc` clean.

### Converting kinds (Phase 3)

In order: plate / window, polarizer, waveplate (HWP, QWP) → lenses (including cylindrical) → mirror (one HR surface over `opaque`; curved mirrors come for free) → PBS / beam splitter (hypotenuse coating) → Faraday rotator and AOM (need the bulk effects added to `media`). Each conversion authors `surface_model` on the catalog assets of that kind. **Take the geometry from the asset's own mesh**, not the catalog JSONs' retired `faces`: for LA1509-B the JSON assumed the convex side at the entry anchor, and the mesh has it the other way round. The two Glan-Laser prisms (`glan_laser_io3_850`, `glan_laser_io5_850`) are `beam_splitter` kind; they converted once the o/e split landed.

#### Converted so far

| Asset | Converted | Surface model | Before → after |
|---|---|---|---|
| `la1509_b_step` (LA1509-B, used by the "Opt PCX 100.00" component, in no scene object) | 2026-09-23, via `PUT /api/v3/assets3d/la1509_b_step` after the user unlocked it; left unlocked | From the GLB (asset frame = component frame): `flat` plane at z = 0 (glass on +z), `convex` sphere R = −51.5 with its vertex at z = 3.59 (least-squares sphere fit of the dome, R = 51.500, residual 1.7e-7 mm; rim top at z = 1.9995 = the 2.0 mm edge). Both apertures r = 12.7. `N-BK7`. AR 0.25 % per face, keeping today's 0.995 total. All four models are pinned in `tests/optical/test_surface_trace.py::PLANO_CONVEX_ASSETS` (and the cylinders below in `CYLINDRICAL_ASSETS`). | Component preview, 852 nm, 1 mm waist, from 50 mm out. **Flat side first (+z):** focus z = 99.96 → **104.57**; exit moves from the anchor plane (z = 0) to the convex vertex (z = 3.59). **Convex side first (−z):** focus z = −99.96 → **−98.60**. It was a thin lens (its `defaultParams` never had `radiusFrontMm`, so `_is_thick` was false); now it is a thick lens with EFL 101.02 mm at 852 nm (dispersion: 99.65 at n_d), and it is orientation-dependent. Both directions equal `_thick_lens_abcd` to 4e-18. A ray 3 mm off axis now crosses the axis at z = 104.22, 0.35 mm short of the paraxial focus: longitudinal spherical aberration, which the thin lens could not show (it sent that ray to exactly z = 100.0). Live `run-from-db` trace unchanged. |
| `la1027_b_step` (LA1027-B, f = 35, in the "Opt PCX 34.99" component — bound with rz = 90°, which the round lens does not notice — and in no scene object) | 2026-09-23. **Unlocked by Claude at the user's explicit request** ("你直接解鎖"), then converted with the same `PUT`; left unlocked. | Same structure as LA1509: flat at z = 0, `convex` vertex at z = **7.23**, R = −**18.02** (sphere fit 3.4e-7 mm), rim top 1.994. | Flat first: focus 35.00 → **42.58**. Convex first: −35.00 → **−30.56**. EFL 35.35 at 852 nm. |
| `la1131_b_step` (LA1131-B, f = 50, in no component or scene object) | 2026-09-23, same as above. | Vertex at z = **5.34**, R = −**25.75** (fit 2.6e-7), rim top 1.990. | Flat first: 50.00 → **55.85**. Convex first: −50.00 → **−46.97**. EFL 50.51. |
| `la1951_b_step` (LA1951-B, f = 25.4, in no component or scene object) | 2026-09-23, same as above. | Vertex at z = **11.74**, R = −**13.08** (fit 5.6e-7, after dropping 26 rim-bottom vertices that sliver triangles had misfiled as dome), rim top 1.790 — a near-hemisphere, 76° at the rim. | Flat first: 25.00 → **37.40**. Convex first: −25.00 → **−17.88**. EFL 25.66. The biggest shift: a 11.74 mm thick lens is far from thin. |

**Cylindrical lenses** (2026-09-23, all six unlocked by Claude at the user's explicit request, and left unlocked). None is in a scene object; each sits in one component (LJ1960L1 in two), and all bindings are at identity pose.
- **Geometry:** a RANSAC circle fit of each GLB's cylinder (residual ≤ 1.6e-7 mm). A plain fit had been dragged off by the 0.14 mm 45° chamfers on the flat face's edges. In every lens the cylinder axis is body x, the curvature is along body y (the same as the old op's focusing axis, the anchor's axisY), the optical axis is z, and the flat face is at z = 0.
- **Model:** a `plane` plus a `cylinder` with `axisY` = +y. Both faces have rectangular apertures: the full width along y by the full length along x. `N-BK7`, AR 0.25 % per face. The line focus below is for the powered (y) axis, at 852 nm with a 1 mm waist.

| Asset | Vertex z, signed R | Aperture y × x | Line focus, flat side first | Line focus, curved side first |
|---|---|---|---|---|
| `lj1328l2_b_step` | 5.22, −10.34 | 15 × 30 | 20.01 → **25.50** | −20.01 → **−16.83** |
| `lj1402l1_b_step` | 2.61, −20.67 | 10 × 12 | 40.00 → **43.16** | −40.00 → **−38.82** |
| `lj1934l1_b_step` | 3.64, −77.52 | 20 × 22 | 149.83 → **155.53** | −149.83 → **−149.47** |
| `lj1960l1_b_step` | 3.29, −10.34 | 10 × 12 | 20.01 → **23.57** | −20.01 → **−18.10** |
| `lk1426l1_b_step` (concave) | 2.00, +12.86 | 10 × 12 | −24.88 → **−23.22** (virtual) | 24.88 → **26.55** (virtual) |
| `lk1900l1_b_step` (concave) | 2.00, +13.12 | 16 × 18 | −25.39 → **−23.73** (virtual) | 25.39 → **27.06** (virtual) |

- **A data error the conversion removes:** `lj1960l1_b_step`'s `intercept_in` anchor has `apertureMm` = **1.0**. The lens op read that as a 1 mm-radius circle on a 10 × 12 mm lens, so a 1 mm beam lost 14 % (0.860 instead of 0.995). The surface model uses the real rectangle. The anchor itself is untouched.
- **Stale anchors:** four of the six still carry a blank 1 mm `intercept_out` at the body origin, left over from the "seed from kind on open" bug ([introduce/asset.md](introduce/asset.md)). It is inert now that the surfaces are hit-tested instead, and it is left untouched.
- **Verification:** each lens was dry-run before it was written: the powered axis against `_thick_lens_abcd` (1e-12, both directions), the unpowered axis against a pure slab `q + d/n`, no cross term, no EFL. The live component previews agree, each reporting the clip with `focalLengthMm` = 0.

All four were **thin lenses** before (none had `radiusFrontMm`, so the op never took its thick branch). The before/after foci are for an 852 nm beam with a 1 mm waist, starting 50 mm out, with the asset at identity pose. Every conversion was dry-run against `_thick_lens_abcd` in both directions (1e-12) before it was written; the `GET` rows from before each write are kept outside the repo, and the live `run-from-db` trace was byte-identical afterwards. The measuring and converting scripts were one-off and are not in the repo: `measure_lens.py` classifies the GLB's triangles by normal and fits a free sphere, reporting the centre offset from the axis.

**The rest** (2026-09-23; all unlocked by Claude at the user's explicit request — "全部幫我做完" after "你直接解鎖" — and left unlocked). Each was dry-run against its own op before writing: the split ratios, extinction leakage and output directions match, and so do the Jones vectors up to a global phase and the AR amplitude — mirror 3e-16, waveplates ≤ 3e-12, TGG rods 1e-16. The models are pinned in `tests/optical/test_surface_catalog_parts.py`.

| Asset | Geometry (source) | Model | vs its op |
|---|---|---|---|
| `ld2297_b_step` | GLB: biconcave, vertices z = ∓1.5, R = 39.57 both (fit 1.4e-7) | N-BK7, AR 0.25 % | **f ≈ −38 mm**, not the −25 of its `focalLengthMm` (and its kind says `lens_biconvex`) — the model follows the CAD |
| `casix_zowp_852_hwp` / `_qwp` | GLB: 2.1 mm plate, faces z = ±1.05 | **cemented compound zero-order**: two quartz plates with crossed optic axes (y then x), L₁ + L₂ = 2.1, L₁ − L₂ = λ/2Δn (λ/4Δn) at 852 nm; fast axis x = the anchor's axisY; aperture the anchor's 11.43 | retardance exactly 180° / 90° at 852 nm (the op's `retardanceDeg`), now dispersive and tilt-exact; the crossed interface reflects 8e-6 |
| `bb1_e03_step` | GLB: coated face z = 0 (the anchor plane), 6 mm thick | one `hr` surface R = 0.99 over `opaque` | identical (the back now absorbs instead of reflecting) |
| `bs041_step`, `pbs055`, `pbs122_step`, `pbs252_step` | GLB: cubes of 12.7 / 5 / 12.7 / 25.4 mm about the origin; hypotenuse through it with the anchor's normal | four AR side faces + a `partial` (R = 0.1) or `polarizing` hypotenuse; BS041 N-BK7, the PBSs n = 1.693 | same split and directions, × AR |
| `glan_laser_io3_850` / `io5_850` | **procedural (no mesh)**: from the params — length 5 / 7.5 mm, gap normal = `coatingNormalBodyLocal` (38.5° from z), gap corner to corner so a = L·\|n_z/n_x\| (6.3 / 9.4 mm), 20 µm air gap | two calcite prisms, optic axis x (Glan-Taylor/laser: e is p at the gap), escape faces at x = ±a/2 | the same polarization (x) passes; it now loses the p Fresnel of the two gap faces (4.7 % at 38.5°, past Brewster and near the e critical angle — real Glan-lasers pass ~90–95 %); the rejected ray refracts out of the escape face (the op gave its in-glass direction); extinction is now ideal (the op leaked 10^(−ER/10)) |
| `io_5_850_hp_middle_piece`, `tornos_isolator_middle_piece` | **the GLB is only the housing**: a TGG rod from the params — `lengthMm` 18 centred on `optical_center`, along its axisX, the anchor's aperture | n = 1.95, 45°/18 mm Faraday along the anchor's axisX, AR = `arResidualR` (0.5 %) or 0.25 % | the op's Jones vector (1e-16), × AR |

**`a230tm_b_step` — from Thorlabs' Zemax prescription** (A230TM-B, the seed laser's collimator; converted 2026-09-23 after the user downloaded `A230TM-B-Zemax-ZMX.zmx` and `-ZAR.zar` and asked for the lens to go to its real spacing).

- **Why not the CAD.** The GLB holds only the one curved face, and a fit of it is 2 µm off (the other lenses fit to 1e-7). With the glass unknown it would have been a guess, so the lens was held back until the prescription arrived.
- **The prescription** (ZMX surfaces 2–3): an even asphere, CURV 0.2874630 (R = 3.4787 mm), conic −0.12630, r⁴ … r¹⁰ = −1.2606e-3, −1.09e-4, 3.2256e-7, −7.8344e-7, then **2.94 mm of S-NPH1_MOLD**, then a flat. The design has the collimated beam entering the asphere, then 1.991392 air + a 0.25 mm BK7 diode window + 0.668612 air to the emitter, at 780 nm. So **it is a plano-convex, flat side to the diode**, as the CAD shows.
- **The glass.** The `.zar` is Zemax's archive: 48-byte headers, 600-byte UTF-16 names, and variable-width LZW entries. The decoder was checked by rebuilding the `.zmx` byte for byte. Its `RPO.AGF` gives S-NPH1_MOLD as Sellmeier 1: K = (1.72039395, 0.35905958, 1.95245396), L = (0.0137918186, 0.0669088725, 136.641902) µm², catalogue n_d 1.797892. That is now `materials.py:S-NPH1_MOLD` (n = 1.77623 at 780 nm, 1.77165 at 852.347 nm).
- **The model.** Flat at z = 0 (aperture 3.17, the Zemax semi-diameter), asphere vertex at z = 2.94 (aperture 2.475, the Zemax stop = the mount's clear aperture). The radius and polynomial change sign because Zemax z runs toward the diode (−z here); the conic doesn't. AR 0.25 % per face.
- **Checks** (`test_surface_catalog_parts.py`):
  - Against the GLB dome: within 1 µm inside the clear aperture (the CAD vertex sits 0.6 µm lower).
  - EFL: 4.4816 mm at 780 nm and **4.5082 mm at 852 nm** (Thorlabs: 4.51).
  - A collimated beam focuses **2.82635 mm** behind the flat at 780 nm. The Zemax design's air-equivalent emitter distance is 2.82544 mm, so they agree to 0.9 µm.
- **Why the old model was not a plano-convex.** The thick-lens equivalent (`radiusFrontMm` 2.3244 / `radiusBackMm` 10.308 / n 1.59, [introduce/optics.md](introduce/optics.md)) solved EFL = 4.51 **with BFL = WD = 2.53 mm** taken as a lens-surface distance. Thorlabs measures WD from the **mount's end face**, and the GLB has that face 0.381 mm in front of the flat. So 2.910 − 0.381 = **2.529**: the prescription, the CAD and the datasheet agree, and the lens is a plain plano-convex.

**The real spacing and the re-fit** (the part that matters for a 4.5 mm collimator: a 10 µm error in the source distance moves the output waist by f²/Δz ≈ 2 m, so no model predicts collimation from nominal positions — it has to be calibrated against the measured beam, which this repo already does, [ta_seed_modes_0902.md](ta_seed_modes_0902.md)):

1. **Moved.** The `LENS_PLANO_CONVEX2` object was moved along the beam from 4.980471 mm to **2.910000 mm** between the DBR's `intercept_out` and the flat, which is the design's emitter distance. That is y −516.615 → −518.685471 in the lab. The object's position lock was lifted for the move and put back.
2. **Re-fitted.** The DBR facet mode on `ts_2000_a` (a locked row, unlocked at the user's request and left unlocked) was re-fitted exactly as `ta_seed_modes_0902.py --fit` does, against the WFS measurement. The waists barely change: **2.1609 µm / +0.0696 mm** vertical and **3.2702 µm / +0.0800 mm** horizontal, where they were 2.164 / +0.032 and 3.278 / +0.042. The offsets stay tens of µm, about the 84 µm air-equivalent shortening of the diode window the twin does not model.
3. **Why both steps.** Converting the lens **without** re-fitting sends the TA mode overlap from 0.216 to **0.00025**. Converting it at the old 4.98 mm spacing and re-fitting keeps η but needs an unphysical +2.13 mm source offset. Doing both keeps η and the geometry true.

After the change the collimated seed reads 1.460 × 1.339 mm at 525 mm and 1.578 × 1.552 mm at 675 mm (vertical × horizontal). Those are the bench fit's own widths, since the fit pins the post-lens q; the measurements were 1.468 × 1.317 and 1.570 × 1.571. `--fit` run afterwards returns the stored mode (cost 5.5e-22).

The AOM is the only free-space part that keeps its op.

**The AOM stays on its op.** Its physics — Bragg order selection with the per-order sinc², the RF drive resolved from the cable graph, the Doppler shift, the `acoustic_axis` anchor that the Bragg-alignment tooling reads — all lives in `anchor_ops/aom.py`. The crystal faces would add only Fresnel loss and a tiny refraction at near-normal incidence, and putting the op's external-angle convention inside a refracting crystal would take a translation layer that could get it wrong. `aom` joined `OP_ONLY_KINDS`, so the API refuses a surface model on it.

**Data issues found on the way** (reported, not changed — the rows are the user's):
- `pbs122_step` carries calcite indices (`refractiveIndex_o/e` = 1.66 / 1.48) and the Glan prisms' extinction ratios. It is modelled as an N-SF1 cube (n = 1.693) like PBS055/PBS252.
- `pbs055` and `pbs252_step` have `coatingNormalBodyLocal` = (1, 1, 0)/√2, while their mesh and `intercept_face` anchor have the hypotenuse at (1, −1, 0)/√2. The mesh and anchor win.
- `ld2297_b_step`: see the table.
- `lj1960l1_b_step`'s 1 mm anchor aperture: see the cylindrical block.

#### Effect on the lab trace (2026-09-23, same scene before and after, 236 slots)

The seed path — A230TM → BB1-E03 → HWP → PBS055 / TGG / PBS055 isolator → HWP → PBS122 → mirrors → BS041 → mirrors → the TA — now runs through surface models everywhere except the A230TM, the TA and the laser.

| | before | after |
|---|---|---|
| lab segments | 46 | 100 (the in-glass stretches are drawn) |
| seed power at the TA facet | 11.893 mW | **11.368 mW** (−4.4 %: the 0.25 % AR assumed on each of ~18 faces the op path treated as lossless) |
| TA mode-overlap η | 0.2137 | **0.2160** (+1 %: the beam now crosses real glass) |
| coupled seed | 2.542 mW | 2.456 mW |
| TA forward output | 478.2 mW | **467.7 mW** (−2.2 %) |
| isolator-port detector | 24.63 mW | 24.38 mW |
| warnings / errors | none | none |

The live `run-from-db` API gives the same numbers after the backend restart. To undo any one part, `PUT {"surfaceModel": null}`.

**Then the A230TM-B** (same day, same scene plus the lens moved to its real spacing): lab segments 100 → 102, TA mode overlap η 0.21600 → **0.21568** (−0.15 %), seed at the facet 11.3684 → 11.3685 mW, coupled 2.4555 → 2.4519 mW, TA forward output 467.68 → **467.23 mW**; no warnings. The live API agrees.

After a conversion, for that asset:
- `defaultParams` are no longer read by the trace (`focalLengthMm`, `refractiveIndex`, `centerThicknessMm`, `transmittance` stay because the kind schema requires them).
- A mode-match focal-length swap (`mode_match_model`, `focalLengthMm` override) has no effect on it.

To undo a conversion, `PUT` `{"surfaceModel": null}`.

Open questions to settle there:

- **Locked assets.** Most catalog assets are `locked`; `lock_guard` 422s writing `surface_model` on them. Each conversion needs the user to unlock the rows (or explicitly authorise a migration, as 0126/0127/0134/0135/0137 were).
- **Params the surfaces make redundant** (`focalLengthMm`, a waveplate's retardance, `refractiveIndex`, `lengthMm`): once a surface model exists they become derived. Proposed: ignored by the trace, and checked against the computed value with a warning when they disagree.
- **Per-instance rotation of a waveplate** — done (`anchor_tracer._instance_model`): `fastAxisDeg` from `default_params ⊕ dynamic_sources` turns every optic axis in the model about the `intercept_in` anchor's axisX (axisY → axisZ), as the op turns its fast axis. So author a waveplate's optic axes as they are at `fastAxisDeg` = 0, with the fast axis on the anchor's axisY.

### Authoring and display (Phase 4)

- Backend, for every client (qmem-blender ARCHITECTURE.md rule 2): `POST /api/v3/surfaces/fit` fits a plane, sphere or cylinder to the smooth mesh region around a clicked triangle and returns a surface (vertex, axisX out of the part, signed R, a circle or rectangle aperture); `POST /api/v3/surfaces/sheets` meshes each surface of a model with its real sag, validating it with `SurfaceModelV3` first ([introduce/api.md](introduce/api.md)). Checked on the converted GLBs: clicking each stored face off-centre gives back its R to 1e-5 and its vertex to ~4e-5 mm (the mesh's own offset), every flat as a plane; the A230TM's asphere is not a model it knows (a sphere, rms 1.7e-2 mm).
- Blender add-on (`qmem-blender`, `phy_asset` → **Surfaces**): **landed 2026-09-23** — click a face to add a surface (front `air`, back the part's medium) or refit the selected one; delete; media, coatings and conics as JSON; each surface drawn as a sheet from `/sheets`, which also shows a 422 before the save; saved as `surfaceModel` on the asset's PUT only when it changed; a locked asset is read-only. Its README has the details. In-medium segments draw like any other: its beams mirror the web's, and a distinct look is a decision for both viewers.
- Web frontend: **showing it landed 2026-09-23, read-only** — the PHY Editor's ASSET3D form lists the surfaces and draws each one in its preview with its real sag, colour-coded and labelled on its air side, so a lens's two faces read apart ([introduce/asset.md](introduce/asset.md)). Still to do: editing `surfaceModel` there, and drawing the in-medium segments.

## Related

- [introduce/optics.md](introduce/optics.md) — the live anchor tracer this plan extends
- [introduce/anchors.md](introduce/anchors.md) — anchor frames and apertures
- [introduce/asset.md](introduce/asset.md) — the Asset3D row that carries `surface_model`
- [introduce/migrations.md](introduce/migrations.md) — `0141_asset_surface_model`
