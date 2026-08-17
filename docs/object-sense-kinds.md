# Object Sense — every kind and how it behaves (consolidated reference)

> This file inventories how each of the **31 physics kinds** is **drawn** and **acts on the beam** inside **Object Sense** (the main 3D viewport `DigitalTwinViewer`'s rendering plus the backend v3 anchor trace that draws the beam). Of those, `fiber_connector` / `rf_cable_connector` (2026-06-12, alembic `0114`) are the catalog kinds for cable connectors and are physics passthrough (they never take part in a trace on their own), with no Object-Sense rendering of their own yet — the 9 physical connector Asset3D rows landed in `0115` (5 fiber + 4 RF), but binding-tree rendering and the procedural RF female models are wired up in a later phase (see the cable-connector section of [kinds.md](introduce/kinds.md)). The main table below therefore still lists the 29 kinds that have render/trace behaviour.
> Produced by a multi-agent sweep of the whole codebase, then verified item by item against the source by an independent critic (confidence: high). Last consolidated: 2026-06-10.
> Authoritative sources: `backend/data/kinds.json` (kind parameters), `backend/app/optical/anchor_ops/` (trace ops), `frontend/src/three/loadAsset/` (rendering).

---

## 0. The Object Sense pipeline (the whole thing at once)

**Render dispatch** (`DigitalTwinViewer.tsx` → `three/loadAsset/index.ts`): for each SceneObject, `shouldRenderViaBindings()` first decides between the **binding tree** (composite components such as the isolator) and the **legacy single asset** `loadAssetObject`. `loadAssetObject`'s dispatch order:
`optical_table` → `kindId==="fiber"` (spline) → `rf_cable/sma_cable` (spline) → `procedural://isolator_body` → `procedural://glan_polarizer_prism` → **`primitive://` or no asset** (looking up `pluginForComponentType().renderer` by `component.kindId`, or a 100×100×80 grey box if there is none) → **file extension** (`.stl/.glb/.gltf/.obj`). STL special-case builders: BB1E03, WPHSM05, PBS252, AD9959, isolator. Colour via `colorForComponent`: device-state colouring → `properties.colorHex` → the `switch(kindId)` colour table → the default slate `#64748b`.

**The trace pipeline** (`trace_ray_anchor_scene` in `backend/app/optical/anchor_tracer.py`): a BFS. Each ray finds its `nearest_anchor_hit` (recognising only **PRIMARY_ANCHOR_IDS** = `intercept_in` / `intercept_out` / `intercept_face` / `interaction_center` / `optical_center`) → `get_anchor_op(kind)` dispatches by table lookup (**no `switch(kind)`**; no op found → treated as a sink) → the ray goes lab→body with free-space q propagation applied → `op(BeamRay, ctx)` returns the outgoing rays → body→lab → pushed back onto the queue. **A sink returns `[]`** (the beam terminates); **a branching op returns ≥2** (PBS, AOM orders). `solver.solve_anchor_scene` runs the seeded emit pass first, then the TA ASE pass.

**Parameter merging** (later wins): `asset.default_params` ← `dynamic_sources` (the legacy laser beam in properties) ← **the `dynamic_sources` column** (containing only keys flagged in the Asset's `tunable_params`, migration 0113) ← **`rf_drive`** (resolved by the backend's `rf_resolve.hydrate_aom_rf_drive`) ← the request's `dynamic_overrides`.

**Output back to the viewport**: `labSegments[]` → `three/v3TraceAdapter.ts` → `window.__rayTraceDebug` → `renderRayTraces()` draws them as `THREE.Line`s coloured by wavelength.

**Anchor-op registration** happens via `register_anchor_op` at import time in `anchor_ops/__init__.py`; `laser_source` and `tapered_amplifier` (ASE) are the solver's **emitters** and are not in the BFS dispatch table.

---

## 1. The main table (29 kinds)

| kind | Class | Trace role | Primary anchor | Anchor op | Effect on the beam (summary) | Status |
|---|---|---|---|---|---|---|
| **laser_source** | emitter | emit | intercept_out | `emit_laser_source.py` | Emits 1 ray per intercept_out; wavelength/power/polarization/waist come from dynamic→default, with the Jones vector referenced to the anchor's axisY | full |
| **tapered_amplifier** | emitter | passthrough + ASE | intercept_in/out | `misc_ops.tapered_amplifier_anchor_op` + `emit_ta_ase_rays` | Four-factor seed amplification (TE polarization × mode overlap × gain saturation × driver); emits ASE in both directions when there is no seed | ⚠ partial |
| **mirror** | passive | passthrough | intercept_face | `mirror.py:mirror_anchor_op` | Reflection (flipping propagation), Jones r_s=+1 / r_p=−1 flipping handedness, ×reflectivity 0.99; **a flat mirror, no focusing** | full |
| **dichroic_mirror** | passive | passthrough | intercept_face | (the same mirror op) | **Identical to mirror**; ×0.95, with **no wavelength splitting** (cutoff/passband do nothing) | ⚠ partial |
| **lens_biconvex** | passive | passthrough | intercept_in | `lens.py:lens_anchor_op` | A spherical thin-lens ABCD on both axes: θ′=θ−offset/f, q′=q/(1−q/f), f = focalLengthMm 100 | full |
| **lens_plano_convex** | passive | passthrough | intercept_in | (the same lens op) | **Mathematically identical to biconvex** (no plano-convex asymmetry) | full |
| **lens_cylindrical** | passive | passthrough | intercept_in | `lens.py:lens_cylindrical_op` | **Focuses on axisY only**, axisZ passes through → producing astigmatism; only qx is updated | full |
| **waveplate** | passive | passthrough | intercept_in | `waveplate.py:waveplate_anchor_op` | Fast/slow-axis Jones retardance (180° HWP by default); the fast axis is the anchor's axisY + a per-object fastAxisDeg | full |
| **polarizer** | passive | passthrough | intercept_in | `polarizer.py:polarizer_anchor_op` | Attenuates jones[1] (the blocked axis) by the extinction ratio, × Malus for power; **does not read the transmissionAxis angle** | ⚠ partial |
| **glan_polarizer** | passive | passthrough | intercept_in | (the same polarizer op) | Same as polarizer (55 dB extinction); **no TIR side-rejected beam, no incidence-angle curve** | ⚠ partial |
| **faraday_rotator** | passive | passthrough | optical_center | `misc_ops.faraday_anchor_op` | A fixed-angle 45° non-reciprocal Jones rotation (which does not cancel on the return trip); usually lives inside an isolator binding tree | full |
| **beam_splitter** | passive | **branch** | intercept_face | `pbs.py:pbs_anchor_op` | Splits into 2 by the incident Jones vector: p transmitted + s reflected; **ignores the polarizing flag** (a 50/50 non-polarizing BS is mistakenly treated as a PBS) | ⚠ partial |
| **aom** | active | **branch** | interaction_center | `aom.py:aom_anchor_op` | Bragg: splits into several diffraction orders by RF frequency/power, each order with freq_offset += m·f_RF; no RF → the 0 order passes straight through. **Hybrid: also an RF sink** | full |
| **eom** | active | passthrough | intercept_in | `misc_ops.eom_anchor_op` | A Jones phase of δ=π·V/Vπ computed from driveVoltageV; **phase only, no sidebands, not connected to the RF graph** | ⚠ partial |
| **nonlinear_crystal** | active | passthrough | intercept_in | `misc_ops.nonlinear_crystal_op` | **A pure slab passthrough stub**, no SHG/conversion | 🔴 stub |
| **saturable_absorber** | active | passthrough | intercept_in | `misc_ops.saturable_absorber_op` | An intensity-dependent transmittance T; **every parameter key is mismatched → it always uses the op's defaults** | 🔴 stub |
| **detector** | sink | sink | intercept_in | `misc_ops._terminal_sink_op` | Returns `[]` and absorbs; no responsivity or readout | sink-only |
| **camera** | sink | sink | intercept_in | `_terminal_sink_op` | As above; no imaging model | sink-only |
| **spectrometer** | sink | sink | intercept_in | `_terminal_sink_op` | As above; **does not read wavelengthNm** | sink-only |
| **wavemeter** | sink | sink | intercept_in | `_terminal_sink_op` | As above; no measurement output | sink-only |
| **beam_dump** | sink | sink | intercept_in | `_terminal_sink_op` | The standard terminator; declares thermal but has no heat-load model | sink-only |
| **rf_source** | rf | not ray-traced | rf_out (CH0–3) | `rf_resolve.build_rf_propagation` (seed) | The RF graph seed: each rf_out emits an RfSignal (from channels[] or the default 80 MHz / amp 1.0), vpp = amp × 1.0 V | full |
| **rf_amplifier** | rf | not ray-traced | rf_in/rf_out | `rf_resolve._rf_amplifier_transfer` | Linear gain ×10^(gainDb/20) with a hard clamp at outputPowerMaxDbm (setting the saturated flag) | full |
| **rf_switch** | rf | not ray-traced | rf_in/RF1/RF2/ttl_in | `rf_resolve._rf_switch_transfer` | TTL routing: the throw is decided by sampling the upstream PPG's TimingProgram at the scrub instant, plus insertion loss | full |
| **rf_cable** | rf | not ray-traced | rf_in/rf_out | `rf_resolve._read_cables` (**an edge**) | **Not a node but a graph edge**: builds undirected adjacency from rfCableEndpoints and **copies the signal losslessly** | ⚠ partial |
| **programmable_pulse_generator** | rf | not ray-traced | rf_out (TTL) | the `rf_resolve` TTL pre-pass | **Carries no carrier**: gates the rf_switch's routing from its TimingProgram intervals at the scrub instant | ⚠ partial |
| **horn_antenna** | rf | not ray-traced | aperture | **none** (unregistered) | **Completely inert**: not registered as a sink, not in the RF graph, and has no renderer | 🔴 stub |
| **fiber** | passive/optical | passthrough | intercept_in/out | `fiber.py:fiber_anchor_op` | Two-port Marcuse coupling (mode overlap × Fresnel × attenuation), resetting the exit to the fundamental-mode q; **parameter keys mismatched, and no PM or bend loss** | ⚠ partial |
| **fiber_coupler** | passive/optical | **sink** | intercept_in | (the same fiber op) | **Only `intercept_in` → it can't find the other end → returns `[]` and becomes a sink**; couplingEfficiency does nothing | 🔴 stub |

Status legend: **full** physically usable ｜ **⚠ partial** works but with major simplifications/gaps ｜ **🔴 stub** effectively unimplemented ｜ **sink-only** terminating by design.

---

## 2. Object Sense render cross-reference (how each is drawn)

| kind | Render path | Colour / material |
|---|---|---|
| laser_source | primitive→`renderLaser`, a 260×90×80 box | ⚠ this kindId falls through to the default grey (only the legacy `laser` is teal) |
| tapered_amplifier | primitive→`createTaperedAmplifier` (a Boosta Pro or a procedural chip) | Materials hard-coded (copper fins + ceramic + a gold cone) |
| mirror | STL: `buildBB1E03MirrorObject` (a pink coating + green glass), otherwise generic | `mirror`→`#c4b5fd` |
| dichroic_mirror | The same dispatch as mirror (no dedicated builder) | ⚠ no colour-table case → the default grey |
| lens_* | **No special-case builder**; loads the asset by extension, or a generic box | ⚠ only `lens` is blue; `lens_biconvex/...` → the default grey |
| waveplate | STL: `buildWphsm05WaveplateObject` (a black anodized mount + a green plate) | Black anodized |
| polarizer | No special case → generic | ⚠ the default grey |
| glan_polarizer | `procedural://glan_polarizer_prism` (two calcite prisms + an air gap) | Crystal material |
| faraday_rotator | Usually inside an isolator binding tree | (the isolator housing dominates) |
| beam_splitter | STL: `buildPbs252BeamSplitterObject` (clear/frosted glass + a diagonal iridescence), otherwise generic | ⚠ generic → the default grey |
| aom | primitive→`createAom` (a procedural AA MT80 model) | `aom`→amber `#f59e0b` |
| eom | ⚠ no renderer → a **generic grey box** | `eom`→`#e879f9` (box colour only) |
| nonlinear_crystal / saturable_absorber | ⚠ no renderer → a generic grey box | the default grey |
| detector/camera/spectrometer/wavemeter/beam_dump | ⚠ no renderer → a generic grey box | the default grey |
| rf_source | STL: `buildAd9959PcbObject`, or primitive→`createDdsAd9959Pcb` (a green PCB + 4 SMAs) | DDS materials |
| rf_amplifier | primitive→`renderRfAmplifier` (a ZHL model / generic) | **Thermal colouring**: red above 45 °C |
| rf_switch | primitive→`createRfSwitch` (a ZYSWA with 4 connectors) | `#c8ccd0` |
| rf_cable | early branch→`createSmaShortCable` (a Bezier spline) | `#c4a884` brown |
| programmable_pulse_generator | ⚠ no renderer → a generic grey box | the default grey |
| horn_antenna | ⚠ no renderer → a generic grey box (the promised cos^n lobe is unconnected) | the default grey |
| fiber | early branch on `kindId==="fiber"`→`createFiberSplineObject` (TubeGeometry + an FC ferrule) | By fiberType: PM blue / SM yellow / MM orange |
| fiber_coupler | No special case → a generic grey box | the default grey |

---

## 3. Systemic issues worth consolidating (cross-kind ailments)

The recurring, horizontal problems worth handling in one consolidated pass:

**A. Parameter-contract drift (the most widespread and highest-impact)** — several ops read keys that don't match `kinds.json`'s default_params, so the numbers in the panel/catalog **never reach the trace** and the op silently uses hard-coded defaults:
- `tapered_amplifier`: the ASE op reads `aseForwardMw` / `aseBackwardMw` while kinds.json has `ase.{powerMw,...}` → **an unseeded TA actually emits 0 ASE** (the worst case).
- `fiber`: the op reads `coreMfdUm` / `attenuationDbPerKm` / `lengthM` while kinds.json has `endA/endB.modeFieldDiameterUm` + `attenuationCurve[]` → editing attenuation/MFD does nothing.
- `saturable_absorber`: the op reads `smallSignalTransmittance` / … while kinds.json has `saturationIntensityWPerCm2` / `modulationDepth` / … → nothing works.
- `nonlinear_crystal`: the op defaults lengthMm to 1.0 while the catalog seeds 10.
- `lens_*`: the op reads `focalLengthMm` while the Object panel writes `focalMm` → focal-length edits never reach the trace.
→ **Direction**: a canonical key mapping per kind plus a param-contract check at startup (keys ⊆ the set the op reads).

**B. Parallel legacy physics (`kinds/<kind>/physics.py` + `registry.py`) not on the v3 path** — waveplate/faraday/glan_laser/polarizer/fiber all still have an old `register_kind` op, yet `anchor_tracer` never imports `app.optical.registry`. Duplicated and misleading. → **This is plan item H4 (retire the dead code).**

**C. Incomplete colour table / renderer coverage** — `colorForComponent`'s `switch(kindId)` only covers a subset, so most kindIds fall through to the default grey (laser_source, all three lens kinds, dichroic, polarizer, faraday, beam_splitter, …); several kinds have no procedural renderer → a generic grey box (eom, nonlinear, saturable, the five sinks, PPG, horn, fiber_coupler). → **Direction**: complete the colour table plus a kind→visual registry.

**D. Physics declared but not implemented (what the kind promises ≠ what the trace does)** — dichroic wavelength splitting, Glan TIR rejection, the beam_splitter's polarizing flag / split ratio, arbitrary polarizer angles, EOM amplitude/sidebands, nonlinear conversion, saturable dynamics, sink measurement readouts, rf_cable loss, horn radiation. → **This is the Phase E (capability expansion) backlog.**

**E. Anchor contracts that don't match op requirements** — the `beam_splitter` kind template lacks the `intercept_face` the op needs (it relies on the asset providing it); `fiber_coupler` has only `intercept_in` → degenerating into a sink; the Glan's `intercept_out` is not in the PRIMARY set. → **Direction**: align each kind's anchor contract with the anchors its op actually dispatches on.

**F. Stale docstrings (correct behaviour, wrong comment)** — mirror says `reflection_surface` (it is intercept_face), lens says `optical_center` (it is intercept_in), emit says `emit_point` (it is intercept_out), misc_ops says "backward ASE not implemented" (it is bidirectional already), fiber says `tip_a/tip_b`. → **A docstring sweep.**

**G. horn_antenna is completely inert** — it is neither registered as a sink (`get_anchor_op` returns None), nor in the RF graph, nor given a renderer. An RF chain terminating at a horn dangles. → A decision is needed: wire it up as a real RF load, or mark it a pure placeholder.

---

## Appendix: the core files

- Trace: `backend/app/optical/anchor_tracer.py`, `solver.py`, `anchor_ops/{mirror,lens,waveplate,polarizer,pbs,aom,fiber,misc_ops,emit_laser_source}.py`, `aom_physics.py`, `rf_resolve.py`
- Rendering: `frontend/src/three/loadAsset/index.ts`, `loadAsset/stl_builders/*`, `loadAsset/materials.ts`, `kinds/_renderer_bindings.ts`, and each `kinds/<kind>/renderer.ts`
- Parameters: `backend/data/kinds.json` (physics_plugins[].default_params)
