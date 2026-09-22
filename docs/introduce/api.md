[← Doc index](README.md)

# Main API endpoints

> How to start the stack: [runbook.md](runbook.md). Wiring / ports: [overview.md](overview.md).

- `GET /api/health` → `{"ok": true}`; `GET /api/scene` — scene snapshot
- `POST /api/v3/solver/run-from-db` — run the optical trace over the persisted scene (produces beam segments: dir, pol, hit face)
- `POST /api/v3/pop` — **on-demand** physical-optics diffraction: given the beam radius at the lens plus aperture and focal length, returns the focal-plane Airy intensity grid (diffraction rings). Never part of the live trace. See the POP field channel in [optics.md](optics.md)
- `GET /api/v3/catalog/...`, `/api/v3/assets3d`, `/api/v3/components`
- `GET/POST/PATCH/DELETE /api/kinds` — the Kind registry; `GET /api/kinds/op-sets` lists every op-set name a Kind row may reference (exactly what `POST /api/kinds` validates against, so the KIND editor's dropdown can offer code-side op sets that have no Kind row yet)
- `GET/POST/PATCH/DELETE /api/devices` — the device registry (alembic 0123; previously TypeScript files under `frontend/src/devices/`). `GET /api/devices/behavioral-kinds` lists the ElementKinds a device may pin itself to. `slug` is create-only, a `locked` row rejects edits with 422, and DELETE is refused with 409 while an Asset3D still references the slug
- `/api/timing-programs`, `/api/rf-chains/nodes`, `/api/coils`, `/api/magnetics-problems`, `/api/simulation-runs`, `/api/touchstone/parse`, `/api/app-settings/{key}`
- `POST /api/v3/rf/propagation` — the RF readout at one scrub time (compute-only, see below)
- `POST /api/v3/align/mirror-coupling`, `/api/v3/align/isolator`, `/api/v3/align/aom-bragg` — proposed poses from the align solvers (compute-only, see below)
- `POST /api/v3/fibers/{id}/{candidates,connect,apply,disconnect}`, `POST /api/v3/fibers/resnap`, `POST /api/v3/pigtails/{id}/{candidates,apply,disconnect}`, `POST /api/v3/pigtails/resnap` — patch-cable and pigtail ends: plug in, park on a beam, unplug, follow a moved instrument (these WRITE, see below)
- Static: `/assets/files/...`; Swagger: `/docs`; WebSocket: `/ws/scene`
- Conventions: every persisted id is a UUIDv7; CamelModel (DB snake_case ↔ API camelCase).

## Compute-only endpoints for a second client

The web app computes some things in the browser that another client (the qmem-blender add-on) also needs. Rather than a third copy in that client, they are served here. **None of these writes anything**: they read the DB scene and return numbers; applying a result is an ordinary `PATCH /api/objects/{id}` by the caller.

### `POST /api/v3/rf/propagation`

The backend's RF BFS (`rf_resolve.py`) at one scrub time. Router: `backend/app/routers/v3_rf.py:101`. Detail and invariants in [rf.md](rf.md) §4.

Request (the body is optional; no body = `{"scrubTimeNs": null}`):

```json
{ "scrubTimeNs": 1500.0 }
```

`scrubTimeNs` means exactly what it means on `/api/v3/solver/run-from-db`: `null` = scrub stopped, the **rest snapshot** (every PPG at its `restState`, drawn blocks ignored); a number = the timing section containing that time (`level = inInterval XOR restState=="HIGH"`); a time before 0 reads section 0.

Response:

```json
{
  "scrubTimeNs": 1500.0,
  "signalAtPort": {
    "<objectId>|<anchorName>": {
      "frequencyMhz": 80.0, "vpp": 4.456, "powerW": 0.0496,
      "sourceObjectId": "<objectId>", "sourceAnchorName": "CH0",
      "cumulativeGainDb": 19.0, "passthroughObjectIds": ["<ampId>", "<switchId>"],
      "saturated": false
    }
  },
  "connectedPorts": ["<objectId>|<anchorName>", "..."],
  "ppgGateHighObjectIds": ["<ppgObjectId>"],
  "aomDrives": {
    "<aomObjectId>": { "aomFreqMhz": 80.0, "rfDrivePowerW": 0.0496 },
    "<gatedOffAomId>": { "rfDrivePowerW": 0.0 }
  },
  "sectionStartsNs": [0.0, 1000.0, 2000.0]
}
```

- `anchorName` in a port key is `anchor.name ?? anchor.id` (so `CH0`, `RF1`, `rf_in`).
- `powerW = vpp² / (8·50 Ω)`, the conversion the AOM drive uses.
- `connectedPorts` (sorted) is topology — every port with a cable or a PPG attachment, whether or not a carrier arrives.
- `aomDrives` is passed through verbatim from the resolver the solver uses, so it equals what the trace merged onto each AOM at this time. An AOM in manual mode (`properties.aomRfDriveMode == "manual"`) or with nothing plugged into `rf_in` is **absent** (it keeps its own / rated drive); a wired AOM that no carrier reaches at this instant gets `{"rfDrivePowerW": 0.0}` with no frequency key.
- `sectionStartsNs` (sorted) is every block boundary across all TimingPrograms, plus 0.

### The align endpoints — `POST /api/v3/align/*`

Backend ports of the web app's align solvers: `utils/mirrorCoupling.ts`, `utils/isolatorAlign.ts`, `utils/aomAlign.ts`, plus the React call-site logic around them (which anchor, which point, which order / frequency — `MirrorCouplingPanel.tsx`, `AlignToBeamControls.tsx`). Router `backend/app/routers/v3_align.py`; solvers `backend/app/optical/align/` (pure modules + `service.py`, which loads the scene and follows the React call sites). The web app itself still runs its TypeScript copies; the two copies are **pinned to each other at 1e-9 by golden fixtures** — see [mirror-coupling.md](mirror-coupling.md#the-backend-port-and-its-parity-pin).

Common to all three:

- Every pose is a proposed **SceneObject pose**: `{"xMm", "yMm", "zMm", "rxDeg", "ryDeg", "rzDeg"}` in lab mm / deg, angles already on the 1e-9° storage grid. Nothing is written — apply it with `PATCH /api/objects/{id}`. The response echoes the object's `locked` flag; the web app refuses to move a locked object and so should any caller.
- Anchor poses come from the backend's own transform chain (`db_scene_loader._binding_tree_transform` ∘ `pose.pose_to_transform`) through `optical/align/anchor_poses.py`, which walks the binding tree exactly as `utils/anchorPose.resolveAnchorPosesLab` does ([anchors.md](anchors.md#reading-an-anchors-pose-in-lab-mm)).
- A vector is `{"x", "y", "z"}`; a direction must be non-zero (422 otherwise). An unknown object id is 404; a request the solver cannot answer (no mirror face, no align point, not an AOM, …) is 422 with the reason in `detail`. A geometry that simply has **no solution** is not an error: it comes back 200 with `"error": "..."` and a null pose/plan.
- A beam is `{"dir": vec, "ref": vec}` — the propagation direction and any point on the line (e.g. a traced segment's `end − start` and `start`). Picking WHICH beam (the web app clusters trace segments near the align point) is the caller's choice, as it is the user's in the web app.

#### `POST /api/v3/align/mirror-coupling`

Two 45° steering mirrors that land the seed on a port's own axis ([mirror-coupling.md](mirror-coupling.md)).

```json
{
  "mirrorAId": "<the mirror the seed reaches first>",
  "mirrorBId": "<the other one>",
  "inRay": { "origin": {"x": 0, "y": 0, "z": 0}, "dir": {"x": 0, "y": -1, "z": 0} },
  "target": { "objectId": "<port object>", "anchorId": "intercept_in", "anchorName": null },
  "foldMm": null,
  "passThroughObjectIds": ["<optic between B and the port>"]
}
```

- `inRay` is the traced segment that ends on mirror A (`origin` = its start). A/B order is the trace's, not click order (rule R2).
- `target.anchorId` ∈ `intercept_in` / `fiber_in` / `seed` (R4) on a third object; light enters it along **−axisX**. `anchorName` picks among anchors sharing an id.
- `foldMm` is the free DOF of the collinear (U-turn / periscope) branch, mm along the seed from `inRay.origin`; `null` = least total travel. Ignored when the answer is unique.
- `passThroughObjectIds` are re-centred onto the port axis, translate only (the panel's "Also centre pass-through optics"), at `alignSpec.pointMm`, else `intercept_in`, else `intercept_face`, else the first anchor. Locked ones are skipped.

```json
{
  "mirrorA": { "objectId": "A", "name": "MIRROR5", "locked": false,
               "centreCad": {...}, "normalCad": {...}, "centreLab": {...}, "normalLab": {...}, "apertureMm": 12.7 },
  "mirrorB": { "...": "same shape" },
  "inRay": { "origin": {...}, "dir": {...} },
  "targetRay": { "origin": {"x": 40, "y": 0, "z": 0}, "dir": {"x": 0, "y": 1, "z": 0} },
  "touch": {
    "seedOnA":   { "pointLab": {...}, "decentreMm": 2.30, "tMm": 99.5, "inAperture": true, "frontSide": true, "aoiDeg": 45.0 },
    "seedOnB":   { "...": "SpotHit or null" }, "targetOnB": { "...": "" }, "targetOnA": { "...": "" },
    "ok": true, "failures": []
  },
  "plan": {
    "geometry": { "d1": {...}, "centreA": {...}, "centreB": {...}, "normalA": {...}, "normalB": {...},
                  "legLengthMm": 40.0, "freeDof": true, "foldMm": 100.1, "targetStandoffMm": -100.1, "warnings": [] },
    "moveA": { "objectId": "A", "name": "MIRROR5", "pose": { "xMm": 0, "yMm": -100.1, "zMm": 0, "rxDeg": -45, "ryDeg": -90, "rzDeg": 0 },
               "travelMm": 1.967, "rotationDeg": 0.0 },
    "moveB": { "...": "same shape" },
    "beforeDecentreAMm": 2.30, "beforeDecentreBMm": 0.42, "beforeTargetMissMm": 0.10
  },
  "error": null,
  "passThroughMoves": [ { "objectId": "L", "name": "LENS", "pose": {...} } ],
  "passThroughSkipped": [ { "objectId": "L2", "reason": "locked" } ]
}
```

`touch` is the 2×2 precondition at the mirrors' CURRENT poses; the web app refuses to apply unless `touch.ok` (R6), and so should a caller. `plan` is computed regardless (null with `error` when no pair exists, e.g. the seed already lies on the port axis). `failures` and `warnings` are the TS strings verbatim.

#### `POST /api/v3/align/isolator`

"Align to beam" — a point on the beam, a direction along it — as the Object panel runs it for an isolator and for every other pass-through optic.

```json
{ "objectId": "<id>", "beam": { "dir": {...}, "ref": {...} }, "reverse": null, "rollDeg": null }
```

`reverse` (direction along −beam) and `rollDeg` (clockwise about the beam, looking along the direction) default to the object's stored `properties.alignReverse` / `alignRollDeg`. The (point, direction) is resolved in the web app's order (`AlignToBeamControls.resolved`): the Component's `alignSpec` (`pointMm` + non-zero `directionMm`), else the binding tree's front / back polariser centres (`pickPolariserCentre`), else the primary asset's entry anchor with direction −axisX; none of them → 422.

```json
{
  "objectId": "<id>", "name": "ISOLATOR0", "locked": false,
  "alignSource": "alignSpec | polariserCentres | primaryAnchor",
  "pointCadMm": {"x": 0, "y": 0, "z": -13}, "dirCadMm": {"x": 0, "y": 0, "z": 26},
  "reverse": true, "rollDeg": 0.0,
  "pose": { "xMm": 0.714, "yMm": 0.143, "zMm": 3.0, "rxDeg": -90.0, "ryDeg": 78.690068, "rzDeg": 78.690068 },
  "error": null
}
```

#### `POST /api/v3/align/aom-bragg`

The AOM's two-stage Bragg align ([../aom-model.md](../aom-model.md)): interaction centre on the beam, D1 along ±beam, then `+m·θ_B` (+ fine tune) about D3.

```json
{
  "objectId": "<AOM id>",
  "beam": { "dir": {...}, "ref": {...}, "wavelengthNm": 852.347 },
  "order": null, "fineTuneMrad": null, "reverse": null, "rollDeg": null,
  "freqMhz": null, "scrubTimeNs": null,
  "nudgeMrad": null
}
```

Defaults, as `AomBraggSection` resolves them: `order` ← `dynamicSources.diffractionOrder` ← the asset's `diffractionOrder` ← 1; `fineTuneMrad` ← `properties.aomBraggFineTuneMrad` ← 0; `wavelengthNm` ← 780; v / n / L from the asset's `default_params` (4200 m/s, 2.26, 22.4 mm). **`freqMhz`** ← the carrier at the AOM's `rf_in` in the RF snapshot the trace uses at `scrubTimeNs` (`null` = rest; manual-mode AOMs skip this) ← `dynamicSources.aomFreqMhz` ← the asset's `centerFreqMhz` ← 80; `freqSource` says which. `nudgeMrad` additionally returns the rotation-stage nudge of the CURRENT pose (the panel's fine-tune commit sends `new − old`).

```json
{
  "objectId": "<id>", "name": "AOM0", "locked": false,
  "frame": { "D1": {"x": 0, "y": 1, "z": 0}, "D2": {"x": -1, "y": 0, "z": 0}, "D3": {"x": 0, "y": 0, "z": 1}, "centreMm": {...} },
  "order": 1, "fineTuneMrad": 0.0, "reverse": false, "rollDeg": 0.0,
  "wavelengthNm": 780, "freqMhz": 95.0, "freqSource": "request | rfLink | dynamicSources | asset | default",
  "acousticVelocityMps": 4200.0, "refractiveIndex": 2.26, "crystalLengthMm": 22.4,
  "thetaBRad": 0.008822, "tiltRad": 0.008822,
  "readout":      { "thetaInRad": -1.2217, "matchedOrder": 138, "orders": [ { "order": 1, "mismatchRad": -1.2129, "phaseMatch": 0.0 }, { "order": -1, "...": "" } ] },
  "pose":         { "xMm": 13.0, "yMm": 0.0, "zMm": 50.0, "rxDeg": 0.0, "ryDeg": 0.0, "rzDeg": 89.494563 },
  "readoutAfter": { "thetaInRad": -0.008822, "matchedOrder": 1, "orders": [ { "order": 1, "mismatchRad": 0.0, "phaseMatch": 1.0 }, { "...": "" } ] },
  "nudgePose": null,
  "error": null
}
```

`readout` measures the CURRENT pose, `readoutAfter` the proposed one (so `readoutAfter.matchedOrder` shows the CONV-2 flip when the cell runs reversed). Order 0 returns no `pose` and `"error": "Order 0 is the undiffracted beam — …"`. A primary asset that is not an `aom`, or one with no intercept pair / acoustic direction, is 422.

## Fibre and pigtail ends — `POST /api/v3/fibers/*`, `/api/v3/pigtails/*` (these WRITE)

Backend ports of the web store's fibre-end and pigtail-end flows (`store/sceneStore.ts`: `findFiberAlignmentCandidates` / `applyFiberAlignmentCandidate` / `clearFiberEndpointLink` / `resnapFibersLinkedTo`, and the `…Pigtail…` four), so a second client plugs cables in and re-snaps them without a third copy. Routers `backend/app/routers/v3_fibers.py` / `v3_pigtails.py`; flows `backend/app/optical/fibers/service.py`; what they mean physically in [fiber.md](fiber.md#the-backend-port-2026-09-22) and [component.md](component.md). Ports are placed through the tracer's chain (binding tree + SceneObject pose), as the web now does too. Pinned to the TypeScript by golden fixtures at arbitrary poses (`frontend/src/utils/__tests__/fiberParity.test.ts` → `backend/tests/fixtures/fibers/`, 1e-9).

Common to all of them:

- **One transaction per call**, then the `/ws/scene` events the ordinary routers send for the same rows: `object.updated` (SceneObject `properties`), `physics_element.updated` (the fibre PE's `kindParams`), `object_binding.created` / `.updated`. Writes go through the same schemas those routes use (`OpticalElementBase` normalises fibre kindParams via `FiberParams`; `ObjectBindingCreate`), in `optical/fibers/persist.py:73`. A write the schemas refuse is 422 and nothing is committed.
- **What is never written**: any SceneObject pose (so a `locked` object — which freezes the pose — is respected by construction; a locked object's fibre END or pigtail connector still moves, exactly as in the web store), and any Kind / Asset3D / Device / Component row (so `lock_guard` has nothing to guard).
- `end` is `"A"` or `"B"`. For a fibre, End A is spline node 0 (`kindParams.endA`); for a pigtailed instrument, End A is the `intercept_in` port connector and End B `intercept_out`.
- A **port target** is `{"objectId", "anchorName", "anchorId"?}` — a fibre RECEPTACLE, i.e. an anchor declaring a female fibre `connectorType` (`isFiberPortConnectorType`) and a direction (axisX or the legacy `directionBodyLocal`), matched on `anchor.name ?? anchor.id` (+ `anchorId` when two share a name). A **beam target** is `{"beam": BeamSegment}`. Exactly one of the two.
- A **BeamSegment** is the web's `BeamSegmentLab`, in lab mm, from the caller's own trace (which beam a face goes onto is the user's pick, as for `/api/v3/align/*`):

  ```json
  { "beamId": "trace:<emitter8>:o<order|x>:<source8>", "aMm": [0, 0, 880], "bMm": [400, 0, 880],
    "displayLabel": "TA0 +1-order @ 852 nm", "emitterObjectId": "<id>", "aomOrder": 1,
    "branch": "main", "wavelengthNm": 852.3, "sourceObjectId": "<id>" }
  ```

  Only `beamId`, `aMm`, `bMm` are required. `beamId` is the dedup identity — every `trace:…` segment sharing `emitterObjectId` + `aomOrder` + `branch` is one beam chain and collapses to its closest hop, exactly as the web picker does. A segment whose `sourceObjectId` is the object being aligned is skipped (a part never snaps to its own output).
- `toleranceMm`: on `candidates`, default **25** (the web's window), `null` = unlimited. On `connect` / `apply`, default `null` — the caller named the target, so no distance check; pass a number to refuse a far one (422 with the distance).
- 404 unknown object; 422 with the reason in `detail` for: no fibre spline (no `fiberNodes`, no Component `fiberNodes`, no fibre PE `endA/endB`), no pigtail connector for that end, a target that is not a fibre port (the message lists the object's ports), a part's own port, a zero-length segment, beyond `toleranceMm`.
- **Re-snaps never unlink.** A link whose target object or anchor cannot be resolved is skipped and left exactly as it is (the rule from [rf.md](rf.md) §7). Only `disconnect` and a beam placement drop a link.

### Fibres

`POST /api/v3/fibers/{id}/candidates` — compute-only, the picker (`findFiberAlignmentCandidates`, `service.py:135`):

```json
{ "end": "B", "toleranceMm": 25, "beamSegments": [ { "beamId": "trace:…", "aMm": [..], "bMm": [..] } ] }
```

```json
{
  "objectId": "<fibre>", "name": "FIBER0", "locked": false, "end": "B", "toleranceMm": 25,
  "candidates": [
    { "beamId": "port:<det>:fiber_in", "distMm": 7.81,
      "projectedPortLab": [-900.02, -137.38, 980.05],
      "newPosMmBody": [..], "newHandleMmBody": [..], "newOutwardBody": [..],
      "displayLabel": "🔌 DETECTOR0 · OPTICAL IN (FC/PC)",
      "port": { "targetObjectId": "<det>", "targetAnchorId": "fiber_in", "targetAnchorName": "OPTICAL IN (FC/PC)" } },
    { "beamId": "trace:…", "distMm": 12.4, "projectedPortLab": [..],
      "newPosMmBody": [..], "newHandleMmBody": [..], "newOutwardBody": [..],
      "aomOrder": null, "displayLabel": "…", "emitterObjectId": "…", "branch": "main", "wavelengthNm": 852.3 }
  ]
}
```

Closest first. `projectedPortLab` is where the optical face lands; `newPosMmBody` / `newHandleMmBody` the endpoint node and its body-side handle (fibre body frame). A beam candidate always has `aomOrder` (possibly `null`) and carries the segment's label fields; a port candidate has `port` and no `aomOrder`.

`POST /api/v3/fibers/{id}/connect` — plug one end into a receptacle (the contract's name for `apply` with a port target):

```json
{ "end": "B", "target": { "objectId": "<det>", "anchorName": "OPTICAL IN (FC/PC)", "anchorId": null }, "toleranceMm": null }
```

`POST /api/v3/fibers/{id}/apply` — the same for a port **or** a beam: `{ "end", "target": {port} | {"beam": BeamSegment}, "toleranceMm"? }`. Both return:

```json
{ "object": { "...SceneObjectOut": "", "properties": { "fiberNodes": [..], "fiberEndpoints": { "B": { "targetObjectId": "<det>", "targetAnchorId": "fiber_in", "targetAnchorName": "OPTICAL IN (FC/PC)" } } } },
  "physicsElement": { "...OpticalElementOut": "", "kindParams": { "endB": { "posMm": [..], "tensionHandleMm": [..], "...": "" } } },
  "candidate": { "...the candidate applied, shaped as in candidates": "" } }
```

What it writes (`service.py:166`, = `applyFiberAlignmentCandidate`): the whole `properties.fiberNodes` array (materialised from the Component's / the PE's endpoints if the object had none) with the touched endpoint's `posMm` and body-side handle replaced; `properties.fiberEndpoints[end]` set to the port (port target) or **removed** (beam target — a free-space placement is not a connection); and the fibre PE's `kindParams.endA|endB.posMm` + `tensionHandleMm` — **the write the solver reads** (`_synth_fiber_slot`); `physicsElement` is `null` when the object has no fibre PE. A port lands one `FIBER_MATING_GAP_MM` (0.01 mm) short of the port plane, End A facing −axisX, End B +axisX.

`POST /api/v3/fibers/{id}/disconnect` — `{ "end": "A" }` → `{ "object": SceneObjectOut, "changed": true }`. Drops `fiberEndpoints[end]` only; the cable stays where it is (a dangling patch cable is a real bench state — unlike a coax, it is not deleted). `changed: false` and nothing written when that end had no link.

`POST /api/v3/fibers/resnap` — `{ "movedObjectIds": ["<det>", "..."] }` (`resnapFibersLinkedTo`, `service.py:227`):

```json
{ "resnapped": [ { "objectId": "<fibre>", "end": "B", "targetObjectId": "<det>", "targetAnchorId": "fiber_in", "targetAnchorName": "OPTICAL IN (FC/PC)" } ],
  "updated": [ SceneObjectOut ], "physicsElements": [ OpticalElementOut ] }
```

Every linked end whose target is in `movedObjectIds` is re-derived from the port's LIVE pose (handle magnitude 30 mm, as the web's `resolveLinkedFiberEndpoint`) and written through the apply path; idempotent. Call it after committing a pose change, as the web does on every committed move.

### Pigtails

`POST /api/v3/pigtails/{id}/candidates` — `{ "end", "toleranceMm"?, "beamSegments"? }` (`findPigtailAlignmentCandidates`, `service.py:303`):

```json
{
  "objectId": "<eom>", "name": "EOM0", "locked": false, "end": "B", "portAnchor": "intercept_out",
  "bindingId": "<the port_out ComponentBinding>", "toleranceMm": 25,
  "portLab": { "posMm": [-1332.343, -308.2286, 994.5095], "axisXMm": [..] },
  "candidates": [
    { "key": "port:<det>:fiber_in", "distMm": 7.81, "targetPosLab": [..], "targetAxisXLab": [..],
      "displayLabel": "🔌 DETECTOR0 · OPTICAL IN (FC/PC)", "port": { "targetObjectId": "<det>", "targetAnchorId": "fiber_in", "targetAnchorName": "OPTICAL IN (FC/PC)" } },
    { "key": "trace:…", "distMm": 12.0, "targetPosLab": [..], "targetAxisXLab": [..], "aomOrder": null, "...label fields": "" }
  ]
}
```

`portLab` is the connector's mating face now — the face the loader re-seats the device's port onto. `targetPosLab` / `targetAxisXLab` are where it will land and look.

`POST /api/v3/pigtails/{id}/apply` — `{ "end", "target": {port} | {"beam": BeamSegment}, "toleranceMm"? }` (`applyPigtailAlignmentCandidate`, `service.py:337`):

```json
{ "object": { "...SceneObjectOut": "", "properties": { "bindingFiberNodes": { "<bindingId>": [..] }, "pigtailEndpoints": { "intercept_out": { "targetObjectId": "<det>", "targetAnchorId": "fiber_in", "targetAnchorName": "OPTICAL IN (FC/PC)" } } } },
  "objectBinding": { "componentBindingId": "<bindingId>", "localXMmDelta": -410.1, "localYMmDelta": -170.85, "localZMmDelta": -11.42,
                     "localRxDegDelta": -180.0, "localRyDegDelta": -164.0, "localRzDegDelta": -180.0,
                     "asset3dIdOverride": null, "properties": {}, "id": "…", "objectId": "<eom>", "createdAt": "…", "updatedAt": "…" },
  "candidate": { "...": "" } }
```

The CONNECTOR moves, as an `ObjectBinding` delta on its binding (`effective = baseline + delta`, all six axes written, angles wrapped to (−180, 180]; the row's `asset3dIdOverride` / `properties` are carried over); the instrument's pose does not change. The pigtail's last node is re-welded to the connector's cable root in `properties.bindingFiberNodes[bindingId]` when the binding (or the instance) has a jacket. `pigtailEndpoints[portAnchor]` is set (port) or removed (beam). A receptacle mate lands one mating gap downstream (End A) / upstream (End B) of the port plane.

`POST /api/v3/pigtails/{id}/disconnect` — `{ "end" }` → `{ "object", "changed" }`; the connector stays put.

`POST /api/v3/pigtails/resnap` — `{ "movedObjectIds" }` → `{ "resnapped": [ { "objectId", "end", "portAnchor", "targetObjectId", "targetAnchorId", "targetAnchorName" } ], "updated": [SceneObjectOut], "objectBindings": [ObjectBindingOut] }`.

There is **no `/api/v3/fibers/connect-ports`**: the web app has no flow that creates a patch cable between two ports (a cable is placed from the parts library, then each end is plugged in), so there is nothing to port.
