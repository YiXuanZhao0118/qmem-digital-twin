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
- `POST /api/v3/rf-cables/connect`, `/resnap`, `/{id}/disconnect`, `/{id}/align-candidates`, `/{id}/align` and `POST /api/v3/ppg/attach`, `/{id}/detach` — the web's RF-cable / PPG store flows, served to a second client (these WRITE; see the last section)
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

## Write endpoints for a second client: RF cables and PPGs

Backend ports of the web app's coax-cable and Programmable Pulse Generator flows (`store/sceneStore.ts` and the utils they call), served so the qmem-blender add-on does not grow a third copy. Routers `backend/app/routers/v3_rf_cables.py` / `v3_ppg.py`; pure plans `backend/app/optical/rf_cables/flows.py`; DB side `rf_cables/service.py`. The web app itself still runs its TypeScript; the two are **pinned to each other by golden fixtures the real TypeScript writes** (`frontend/src/utils/__tests__/rfCableParity.test.ts` → `backend/tests/fixtures/rf_cables/{pure,flows}.json`, asserted by `backend/tests/optical/test_rf_cables_parity.py`: 1e-9 on poses / nodes, exact on the cable variant, the PPG component, rule rejections and delete sets). Behaviour and the TS quirks carried over are in [rf.md](rf.md) §7 and [cable.md](cable.md).

Common to all of them:

- **Unlike the section above, these write.** Each request is ONE transaction, committed once, then the same `/ws/scene` events the generic routers send (`object.updated`, `collection_member.updated`, `physics_element.updated`, `timing_program.updated`, `object.deleted`, `physics_element.updated {deleted: true}`, `timing_program.deleted`). Where the web issues several requests (create the cable, PUT end A, PUT end B), the endpoint writes their final state in one go, so a failure leaves nothing behind. Rows are created through the same code as `POST /api/objects` (`routers/objects.py` `insert_scene_object`: unique name, else `<KIND><n>`; the master collection unless `collectionId` names one; the auto-created PhysicsElement) and deleted through the same code as `DELETE /api/objects/{id}` (`remove_scene_object`: the PhysicsElement, and a PPG's TimingProgram).
- **A port** is `{"objectId": "<uuid>", "anchorName": "CH0", "anchorId": "rf_out"}` — `anchorName` is `anchor.name ?? anchor.id` (`CH0`, `RF1`, `RF IN`, `rf_in`); `anchorId` is optional and only needed when two of the object's ports share a name. A port must be one the RF Link panel offers: an `rf_in` / `rf_out` / `ttl_*` / `trigger_*` anchor anywhere in the object's binding tree (multi-root Components like the EOM included) on an object whose PhysicsElement kind takes part in RF Link.
- **Errors**: 4xx with `{"detail": "<code>: <message>"}`; clients may branch on the code.

  | code | status | when |
  |---|---|---|
  | `object_not_found` | 404 | an id names no SceneObject |
  | `port_not_found` / `ambiguous_port` | 422 | the object offers no such port / two, and no `anchorId` given |
  | `same_object`, `role_mismatch`, `connector_undefined`, `domain_mismatch` | 422 | connect: the RF Link panel's drop rules (an output joins an input; both SMA/BNC; the SAME signal domain) |
  | `port_busy` | 409 | a cable end or PPG already claims that port (either port, for a connect) |
  | `no_cable_component` / `no_ppg_component` | 422 | no rf_cable / no usable PPG catalog Component |
  | `not_an_rf_cable`, `not_a_ppg`, `not_a_gate_input` | 422 | the id / port is the wrong kind of thing |
  | `target_not_in_range` | 422 | align: that port is not a candidate within `toleranceMm` |
  | `locked` | 409 | a delete would remove a `locked` SceneObject (refused whole) |

  A name clash on the new PPG (`CH<n>` taken) is the plain 409 of `POST /api/objects`.
- **Locks**: SceneObject `locked` means what it does on `PUT / DELETE /api/objects` — pose frozen, row undeletable, `properties` writable. So re-snapping / aligning a locked cable rewrites its nodes (as the web does), a locked PPG is not re-mounted, and a delete that reaches a locked object is refused whole. No flow writes a Kind / Asset3D / Device / Component row.

### `POST /api/v3/rf-cables/connect`

`createRfCableBetweenPorts` behind the panel's drop gate (`flows.plan_connect`, `flows.py:161`). Request order does not matter — the OUT port is the source.

```json
{ "a": { "objectId": "<dds>", "anchorName": "CH1" },
  "b": { "objectId": "<amp>", "anchorName": "rf_in" },
  "collectionId": null }
```

Response `{"object": SceneObjectOut}` — the new cable (`RF_CABLE<n>`, identity rotation, at the two ports' midpoint) whose properties carry both links and the mated spline:

```json
{ "object": { "id": "...", "name": "RF_CABLE7", "componentId": "<RF cable SMA>",
  "xMm": -1225.129, "yMm": 766.872, "zMm": 730.9465, "rxDeg": 0, "ryDeg": 0, "rzDeg": 0,
  "properties": {
    "rfCableEndpoints": {
      "A": { "targetObjectId": "<dds>", "targetAnchorId": "rf_out", "targetAnchorName": "CH1" },
      "B": { "targetObjectId": "<amp>", "targetAnchorId": "rf_in", "targetAnchorName": "rf_in" } },
    "rfCableNodes": [
      { "posMm": [321.63, 25.322, -21.7015], "handleOutMm": [0, 30, 0] },
      { "posMm": [-296.18, 0.128, 21.7015], "handleInMm": [30, 0, 0] } ] },
  "...": "the rest of SceneObjectOut" } }
```

The cable Component is the first catalog `rf_cable` whose end A / B connector families (from its `end_a` / `end_b` connector assets) match source / target, else one matching the other way round (its end A then goes on the TARGET), else the first `rf_cable`. Each node sits the bound connector's `|connect_in − connect_out|` behind its port along the port's outward axis, handle 30 mm, so the connector's mating face is ON the port.

### `POST /api/v3/rf-cables/{id}/disconnect`

The web's cable-end unlink (`clearRfCableEndpointLink`): a cable either joins two ports or does not exist, so unlinking either end **deletes the cable**, through the web's delete cascade (`flows.plan_delete_objects`, `flows.py:393`: objects linked to a doomed one, PPGs plugged into one, legacy PPGs wired only through doomed cables). An end with no link is a no-op — a destructive action only on a fact positively established ([rf.md](rf.md) §7).

```json
{ "end": "A" }
```

```json
{ "object": null, "deletedObjectIds": ["<cable>"], "deletedTimingProgramIds": [] }
```

On a no-op, `object` is the untouched cable and both lists are empty.

### `POST /api/v3/rf-cables/resnap`

`resnapRfCablesLinkedTo` (`flows.py:241`), called after objects moved: every cable end linked to a moved object is re-mated (same math as connect), and — a backend addition the web does not need, since it re-derives the mount at render time — every PPG plugged into a moved object (or moved itself) is re-mounted, so its STORED pose stays on its port (`flows.plan_ppg_mounts`, `:296`).

```json
{ "movedObjectIds": ["<amp>"] }
```

```json
{ "updated": [ { "id": "<cable>", "properties": { "rfCableNodes": ["..."], "rfCableEndpoints": {} }, "...": "" } ] }
```

Only rows that actually change are written and returned; a second call is `{"updated": []}`.

### `POST /api/v3/rf-cables/{id}/align-candidates` (compute-only)

`findRfCableAlignmentCandidates` (`flows.py:323`): every `rf_in` / `rf_out` anchor on any other object within `toleranceMm` (default 25) of this end, nearest first. Distances are measured from the end's current connector mating face, and `newPosMmBody` / `newHandleMmBody` mate that face onto the port, both with the end's bound connector length (the SMA's 25.45 mm), as connect and resnap do.

```json
{ "end": "B", "toleranceMm": 100 }
```

```json
{ "candidates": [
  { "distMm": 57.623, "newPosMmBody": [-321.506, 723.0, -398.335], "newHandleMmBody": [30, 0, 0],
    "targetName": "RF_AMPLIFIER0", "targetObjectId": "<amp>", "targetAnchorName": "rf_in", "targetAnchorId": "rf_in" },
  { "distMm": 62.175, "...": "the amp's rf_out, then the next ports out to 100 mm" } ] }
```

### `POST /api/v3/rf-cables/{id}/align`

`applyRfCableAlignmentCandidate` on the candidate for `target` (the nearest, if two share a name and no `anchorId` is given); writes the end's node + handle and its link.

```json
{ "end": "B", "target": { "objectId": "<amp>", "anchorName": "rf_in" }, "toleranceMm": 25 }
```

Response `{"object": SceneObjectOut}` (the cable).

### `POST /api/v3/ppg/attach`

`createPpgAtPort` + `createProgrammablePulseGenerator` behind the panel's `canSpawnPpgHere` (`flows.plan_ppg_attach`, `flows.py:527`): the target must be an empty `ttl_in` / `trigger_in` with an SMA/BNC connector. The PPG Component is the first `programmable_pulse_generator` whose `properties.connectorType` equals the port's family and whose primary asset carries `rf_out`.

```json
{ "target": { "objectId": "<switch>", "anchorName": "ttl_in" }, "collectionId": null }
```

```json
{ "object": { "id": "<ppg>", "name": "CH2", "componentId": "<PPG BNC MALE>",
    "xMm": -1273.376, "yMm": 770.745, "zMm": 699.415, "rxDeg": 0, "ryDeg": -90, "rzDeg": 0,
    "properties": { "ppgAttachment": { "targetObjectId": "<switch>", "targetAnchorId": "ttl_in", "targetAnchorName": "ttl_in" } },
    "...": "" },
  "timingProgram": { "id": "<program>", "name": "CH2", "intervals": [], "...": "" },
  "mounted": true }
```

Written in one transaction: the TimingProgram (`CH<number of PPGs>`, empty), the object (same name), its PhysicsElement (`kindParams` as the web writes them, normalised by the same schema → `{"timingProgramId", "restState": "LOW", "outputDomain": "rfout"}`) and the attachment. The pose is the **mounted** pose (`utils/ppgMounting.ts`, ported as `rf_cables/ppg_mount.py`: `rf_out` mated onto the port, backed off by the asset's `matingProtrusionMm`), where the web stores its 3D-cursor spawn pose and draws the mount live. `mounted: false` when the mount does not resolve (the port is not on the target's primary asset — a multi-root instrument); the PPG then stands at the target object's pose.

### `POST /api/v3/ppg/{id}/detach`

The panel's "Disconnect" on a PPG — the only sanctioned way to remove one: the PPG is deleted through the web's delete cascade and its TimingProgram with it. No body.

```json
{ "deletedObjectIds": ["<ppg>"], "deletedTimingProgramIds": ["<program>"] }
```
