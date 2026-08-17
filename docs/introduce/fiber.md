[← Doc index](README.md)

# Fiber — optical fibre (single object + per-instance spline)

> Related: [optics.md](optics.md) (how the coupling physics enters the trace), [anchors.md](anchors.md) (the endpoint anchors are derived from the spline), [kinds.md](kinds.md) (fiber / fiber_coupler), [cable.md](cable.md) (RF cables use the same spline/endpoint architecture).
> Code: `optical/fiber/`, `three/loadAsset/fiber/`, `utils/fiber{Alignment,BodyEndpointResolver,AnchorResolver}.ts`, backend `optical/anchor_ops/fiber.py`.

## Data model (single-object model, post-0056)

One fibre = **one SceneObject** (one row in the Outliner). The poses of both ends A/B are embedded in `PE.kindParams.endA` / `endB` (body-local):

- `posMm` — **the back of the connector (the junction between wire and ferrule) = the spline endpoint = the mesh origin**.
- `tensionHandleMm` — the **single source of truth** for the outward direction and the Bezier tangent (it also sets the ferrule's orientation).
- `rotDeg` — **only the ferrule's visual roll**; it does not rotate the wire tangent.
- Plus the per-end physics fields: `numericalAperture`, `modeFieldDiameterUm`, `coreDiameterUm`, `connectorType` (FC/SC/…), `polish` (PC/APC/UPC), …

> **The optical tip ≠ posMm**: `tip = posMm + outward · FIBER_FERRULE_TIP_MM`, with `outward = -unit(tensionHandleMm)` and `FIBER_FERRULE_TIP_MM = 36.28 mm` (the housing length of the Thorlabs FC 30126A9). All anchor positions and directions are derived from the spline by `resolveAnchorPosition()` / `resolveAnchorDirection()` in `fiberAnchorResolver.ts` (those anchors are marked `derivedFromFiberEndpoint`).

**Migration history**: `0052` split one fibre into three SceneObjects (`fiber_end_a` / body / `fiber_end_b`) → `0056` **collapsed it back to a single object**, baking the endpoint poses into kindParams and deleting the fiber_end objects. Moving or rotating the fibre now carries both ends with it.

## Rendering (`three/loadAsset/fiber/`)

`createFiberSplineObject()` (`spline.ts`) builds a Group:
- **The tube**: `buildFiberCurvePath()` (`curve.ts`) assembles CubicBeziers from `FiberNode[]` (each with `handleInMm` / `handleOutMm`) → a `TubeGeometry` (radius `radiusMm`). The jacket colour follows fiberType (SM yellow, PM blue, MM orange).
- **The two FC connectors**: a cached STL from `thorlabs_30126a9_fc_connector.ts`, with `applyFiberFerruleOrientation()` mating the connector's +Y to outward.
- **Endpoint locking**: capability profile `fiber: { endpointSplineNodesLocked: true }` — the spline endpoints (node 0 / N−1) can only be moved with the **Align End A / B** buttons, while intermediate nodes drag freely.
- `refreshFiberWrapperGeometry()` swaps the tube in place when nodes or radius change, instead of rebuilding the whole wrapper.
- **Jacket radius belongs to the Component layer** (2026-08-14): it is adjusted only in the COMPONENT editor's `CableAppearanceEditor` (`Component.properties.cableAppearance.radiusMm`, `ComponentsEditor.tsx:1224`); the Object panel's `FiberEditor` no longer has a per-instance "Jacket radius" slider (nor `sceneStore.updateFiberRadius`). Reading still falls through `cableAppearance.radiusMm` → `SceneObject.properties.radiusMm` (legacy leftover data) → `Component.properties.radiusMm` → 1.0 (`spline.ts:167`).

## Alignment (`utils/fiberAlignment.ts`)

`computeFiberEndAlignment()` / `findFiberEndAlignmentCandidates()`: project the ferrule's current **tip** onto each beam segment, keep the candidates within `toleranceMm` (25 mm), and back out the new spline node (End A entering with `outward=-beam_tangent`, End B exiting with `outward=+beam_tangent`, `node = tip - outward·36.28`), with the Bezier handle aligned to the beam direction. The other end and the body pose stay put. The projection math is a pure function shared by Align A/B and the per-end port editor.

**The single entry point for reading endpoints is `sceneStore.resolveEffectiveFiberNodes(obj, component, physicsElements)`**: it prefers `SceneObject.properties.fiberNodes` (≥2) → `Component.properties.fiberNodes` (≥2) → otherwise rebuilds them from the fiber PE's `kindParams.endA/endB` via `syncFiberNodesFromKindParams()`. **This step is what makes a connector-component fibre alignable at all** — freshly instantiated it has only `kindParams.endA/endB` and no cached `fiberNodes` (the backend's `default_kind_params_for_component` seeds only kindParams), so the old code, which read `properties.fiberNodes` directly, hit its `length<2` early return and Align did "absolutely nothing". `findFiberAlignmentCandidates`, `applyFiberAlignmentCandidate`, `setFiberPortLabPose`, `FiberPortPoseEditor` and FiberEditor's node count all go through this resolver.

**Writes must be double writes**: endpoint edits (applying an Align, or editing the port pose) must, besides writing `properties.fiberNodes`, also sync the endpoint into `kindParams.endA/endB` (`posMm` = junction, `tensionHandleMm` = handle) — done by the shared helper `sceneStore.syncFiberEndpointToKindParams()`. Writing only `fiberNodes` is a dead end: on load, `syncFiberNodesFromKindParams()` overwrites the endpoints from kindParams and the edit springs back.

## Optical physics (backend `anchor_ops/fiber.py`)

Two anchors: `intercept_in` (A) / `intercept_out` (B). Closed-form v1 coupling, with no internal ray tracing. The coupling efficiency is `η = η_mode · η_Fresnel · η_α`:
- `η_mode` — the Marcuse Gaussian overlap: `exp(-r²/w₀²)·exp(-θ²/θ_NA²)`, with `w₀ = MFD/2`, `θ_NA = asin(NA)`, and r/θ taken from the hit's transverse offset and tilt.
- `η_Fresnel` — the two air-glass surfaces: `(1-R)²`, `R=((n-1)/(n+1))²`.
- `η_α` — Beer-Lambert: `10^(-α·L/10)`, with `α=attenuationDbPerKm` and `L=lengthM`.

The outgoing ray: origin = the exit anchor's position, direction = the exit anchor's axisX (**the fibre forces the fundamental mode and erases the incoming tilt**), q reset to purely imaginary (the exit face is the waist), power ×= η.

### The intercept slot of a connector-component fibre is *synthesized* by the backend (2026-06-13)

`fiber_anchor_op` only fires when a ray hits an anchor whose id is `intercept_in` / `intercept_out`. But the new connector-component fibre binds two `fiber_connector` assets (whose anchors are `connect_in` / `connect_out`, whose op is passthrough, and whose `connect_*` are not in `anchor_tracer.PRIMARY_ANCHOR_IDS`) — so there is **no** `fiber`-kind slot with `intercept_in/out` anywhere in the scene, and the beam sails straight through without coupling.

The fix lives in the backend loader: for every object with `comp.kind_id=="fiber"`, `db_scene_loader.load_anchor_scene_from_db` **synthesizes a `fiber`-kind slot** (`_synth_fiber_slot`) from that fibre's PhysicsElement `kindParams.endA/endB`:
- `intercept_in` ← endA, `intercept_out` ← endB; `position = posMm + outward·tip_mm`, `outward = −unit(tensionHandleMm)`. `posMm` (the junction) and outward come from the **per-instance truth Align wrote into kindParams** (where the connector actually sits — the loader does not read the static Asset3D anchor).
- **Both the optical-face offset `tip_mm` and the hit aperture come from the `connect_in` anchor of that end's bound connector asset** (`_connector_tip_and_aperture`): `tip_mm = |connect_in − connect_out|`, `aperture = connect_in.apertureMm`. **That is, the synthesized `intercept_in/out` land exactly on the `connect_in` you defined on the asset (= the fibre's collection face = the beam waist)** — editing the asset's connect_in position/aperture moves the optical face and the acceptance window together. With no connector it falls back to 36.28 / `endX.apertureDiameterMm`. The aperture only decides whether something counts as a hit; η is still set by the Marcuse overlap.
- `default_params` are mapped from kindParams into the keys the op reads: `coreMfdUm←modeFieldDiameterUm`, `numericalAperture`, `coreRefractiveIndex←glassIndexAtDesignLambda`, `attenuationDbPerKm←attenuationCurve[0].dbPerKm`, `lengthM←` the spline length.
- The two `fiber_connector` passthrough slots still exist and are harmless (`connect_*` is never hit).
- Scope: currently Lab only (`run-from-db`); the COMPONENT preview (`load_anchor_scene_from_component`) does not synthesize yet. `fiber_coupler` (a single anchor) takes the original path. Tests: `backend/tests/optical/test_fiber_connector_coupling.py`.

## Kinds: fiber vs fiber_coupler

| kind | Role | Anchors | Alignment |
|---|---|---|---|
| `fiber` | A bidirectional patch cable (two optical ports) | `intercept_in` + `intercept_out` | per-end Align buttons (`align_variant: none`, tol 25 mm) |
| `fiber_coupler` | Free-space ↔ fibre coupling / collimation | `intercept_in` only | translate-to-beam (single anchor) |

The two **share** `fiber_anchor_op` (backend `register_anchor_op("fiber"/"fiber_coupler", …)`); they differ in anchor count and alignment method. Representative fiber defaultParams: PM, NA 0.13, MFD 5.3 µm, design 780 nm, 5 dB/km, min bend 25 mm.

## Known issues / cautions

- **posMm is the connector's back junction, not the optical tip** (clarified 2026-05-17; an old comment wrongly said posMm = emission point).
- Endpoint locking → endpoints move only via the Align A/B buttons, which prevents endpoint drift.
- The `fiber_end` kind was mothballed after 0056 (only the manifest entry remains, so old data still parses).
- `utils/__tests__/fiberAlignment.test.ts` and `fiberBodyEndpointResolver.test.ts` are known pre-existing reds (see [known-issues.md](known-issues.md)).
