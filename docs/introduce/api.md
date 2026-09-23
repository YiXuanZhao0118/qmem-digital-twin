[← Doc index](README.md)

# Main API endpoints

> How to start the stack: [runbook.md](runbook.md). Wiring / ports: [overview.md](overview.md).

- `GET /api/health` → `{"ok": true}`; `GET /api/scene` — scene snapshot
- `POST /api/v3/solver/run-from-db` — run the optical trace over the persisted scene (produces beam segments: dir, pol, hit face)
- `POST /api/v3/solver/mode-match` — the seed→TA mode-matching optimizer; seconds long, run on a worker thread so the server keeps answering meanwhile. Each move carries its roll pivot and absolute target `pose` (shape in [mode-matching.md](mode-matching.md#the-plans-moves)); optional `endpointLocked` (default true) / `axialMm` (default 20) / `lMaxMm` (default none) let the End element move and cap the section length ([mode-matching.md](mode-matching.md#constraints--feasibility))
- `POST /api/v3/pop` — **on-demand** physical-optics diffraction: given the beam radius at the lens plus aperture and focal length, returns the focal-plane Airy intensity grid (diffraction rings). Never part of the live trace. See the POP field channel in [optics.md](optics.md)
- `GET /api/v3/catalog/...`, `/api/v3/assets3d`, `/api/v3/components`
- `GET/POST/PATCH/DELETE /api/kinds` — the Kind registry; `GET /api/kinds/op-sets` lists every op-set name a Kind row may reference (exactly what `POST /api/kinds` validates against, so the KIND editor's dropdown can offer code-side op sets that have no Kind row yet); `GET /api/kinds/roles` — every physics kind's port contract from the manifest (see below)
- `GET/POST/PUT/DELETE /api/components` (`PUT` takes every create field, `exposedFaces` included; a `locked` row refuses every change but to `locked` itself with 422) and its binding tree: `GET/POST /api/components/{id}/bindings`, `GET/PUT/DELETE /api/component-bindings/{id}` — the writes answer the owning Component's 422 while it is `locked` (`{"detail": "Component 'X' is locked (human-confirmed complete). Unlock it first before editing. Rejected fields: ['bindings']."}`, or `['bindings.local_x_mm', …]` for a PUT). See [component.md](component.md)
- `GET/POST/PATCH/DELETE /api/devices` — the device registry (alembic 0123; previously TypeScript files under `frontend/src/devices/`). `GET /api/devices/behavioral-kinds` lists the kinds a device may pin itself to — the manifest's ElementKinds and passive plugin ids **plus every existing `kinds` row** (`isolator`, `mechanical`, `unclassified`, user kinds); `POST` / `PATCH` validate `behavioralKind` against exactly that set (400 otherwise, `routers/devices.py:39`). `slug` is create-only, a `locked` row rejects edits with 422, and DELETE is refused with 409 while an Asset3D still references the slug
- `/api/timing-programs` (`POST` and `PUT` both reject an unordered / overlapping `intervals` list with 422, see [timing.md](timing.md)), `/api/rf-chains/nodes`, `/api/coils`, `/api/magnetics-problems`, `/api/simulation-runs`, `/api/touchstone/parse`, `/api/app-settings/{key}`
- `POST /api/v3/rf/propagation` — the RF readout at one scrub time (compute-only, see below)
- `POST /api/v3/align/mirror-coupling`, `/api/v3/align/isolator`, `/api/v3/align/aom-bragg` — proposed poses from the align solvers (compute-only, see below)
- `POST /api/v3/rf-cables/connect`, `/resnap`, `/{id}/disconnect`, `/{id}/align-candidates`, `/{id}/align` and `POST /api/v3/ppg/attach`, `/{id}/detach` — the web's RF-cable / PPG store flows, served to a second client (these WRITE; see the last section)
- `POST /api/v3/fibers/{id}/{candidates,connect,apply,disconnect}`, `POST /api/v3/fibers/resnap`, `POST /api/v3/pigtails/{id}/{candidates,apply,disconnect}`, `POST /api/v3/pigtails/resnap` — patch-cable and pigtail ends: plug in, park on a beam, unplug, follow a moved instrument. **The web app calls these too since 2026-09-23** — there is no TypeScript copy (these WRITE, see below)
- `POST /api/v3/objects/delete` — delete objects together with the web's cascade (linked rf_cables, plugged-in PPGs, orphaned legacy PPGs, their TimingPrograms) in one transaction; `dryRun` answers without deleting (this WRITES, see below)
- `POST /api/v3/anchors/traced` — every anchor pose exactly as the tracer receives it (compute-only, see below)
- Static: `/assets/files/...`; Swagger: `/docs`; WebSocket: `/ws/scene`
- Conventions: every persisted id is a UUIDv7; CamelModel (DB snake_case ↔ API camelCase).

## Compute-only endpoints for a second client

The web app computes some things in the browser that another client (the qmem-blender add-on) also needs. Rather than a third copy in that client, they are served here. **None of these writes anything**: they read the DB scene and return numbers; applying a result is an ordinary `PATCH /api/objects/{id}` by the caller.

### `POST /api/v3/rf/propagation`

The backend's RF BFS (`rf_resolve.py`) at one scrub time. Router: `backend/app/routers/v3_rf.py:109`. Detail and invariants in [rf.md](rf.md) §4.

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
    "<aomObjectId>": { "aomFreqMhz": 80.0, "rfDrivePowerW": 0.0496, "eta": 0.0764 },
    "<gatedOffAomId>": { "rfDrivePowerW": 0.0, "eta": 0.0 }
  },
  "sectionStartsNs": [0.0, 1000.0, 2000.0]
}
```

- `anchorName` in a port key is `anchor.name ?? anchor.id` (so `CH0`, `RF1`, `rf_in`).
- `powerW = vpp² / (8·50 Ω)`, the conversion the AOM drive uses.
- `connectedPorts` (sorted) is topology — every port with a cable or a PPG attachment, whether or not a carrier arrives.
- `aomDrives` is passed through verbatim from the resolver the solver uses, so it equals what the trace merged onto each AOM at this time. An AOM in manual mode (`properties.aomRfDriveMode == "manual"`) or with nothing plugged into `rf_in` is **absent** (it keeps its own / rated drive); a wired AOM that no carrier reaches at this instant gets `{"rfDrivePowerW": 0.0}` with no frequency key.
- `aomDrives[*].eta` (2026-09-22) is the **on-Bragg first-order efficiency** the tracer's AOM op applies with that drive: the op's own `on_bragg_first_order_efficiency` (`anchor_ops/aom.py:139`, `η = baseEfficiency·sin²((π/2)√(P/P_peak(λ)))·G(f)`), over the AOM slot exactly as `load_anchor_scene_from_db` hands it to the tracer at this `scrubTimeNs` (asset `default_params` + the slot's dynamic sources, the drive merged in). The op takes λ per ray; the readout takes the scene's emitter wavelength — the single wavelength the laser sources emit (as the tracer emits them: hidden emissions skipped, dynamic sources over the asset), a TA's own wavelength only when there is no laser emission, else **780 nm** (`aom_readout.scene_emitter_wavelength_nm`, [rf.md](rf.md) §3). Per-order angle detune is NOT in it (that depends on the beam's incidence, which only a trace knows). Absent only for an AOM the tracer has no slot for (an asset with no anchors).
- `sectionStartsNs` (sorted) is every block boundary across all TimingPrograms, plus 0.

### `POST /api/v3/anchors/traced`

Every anchor in lab mm **exactly as the tracer's loader hands it to the tracer** — `db_scene_loader.load_anchor_scene_from_db` (`:701`), the same `V3AnchorScene` `/api/v3/solver/run-from-db` traces, projected through each slot's `effective_transform`. Router: `backend/app/routers/v3_anchors.py:91`. No request body (poses do not depend on the scrub time).

```json
[
  {
    "objectId": "<objectId>", "anchorId": "intercept_in", "anchorName": "OPT IN", "bindingId": "modulator",
    "posLab": {"x": 368.0, "y": 0.0, "z": 910.0},
    "axisXLab": {"x": -1.0, "y": 0.0, "z": 0.0}, "axisYLab": {"x": 0.0, "y": 1.0, "z": 0.0},
    "apertureMm": 0.0025, "synthesized": false
  },
  {
    "objectId": "<aomId>", "anchorId": "interaction_center", "anchorName": "interaction_center", "bindingId": "body",
    "posLab": {"...": ""}, "axisXLab": {"...": ""}, "axisYLab": {"...": ""},
    "apertureMm": 1.5, "synthesized": true
  }
]
```

- Where it differs from the stored anchors run through the binding chain — i.e. what [anchors.md](anchors.md)'s `resolveAnchorPosesLab` / `anchor_poses.py` give — is exactly where the loader rewrites: a **pigtail's ports re-seated onto the fibre connector** bound at them (`_port_connector_anchors`, `:341`: position, axisY and aperture from the connector's mating face; axisX keeps the device's sense; the anchor keeps its id and name, `synthesized: false`), the **AOM's `interaction_center`** derived as the midpoint of its faces when the asset stores none (`synthesized: true`), a **connector fibre's coupling ports** built from its PhysicsElement `kindParams.endA/endB` into a slot of their own (`_synth_fiber_slot`, `:530`, `bindingId: "fiber_body"`, `synthesized: true`) — see [fiber.md](fiber.md). (Per-instance asset swaps are no difference: both honour them.) And where the loader leaves things out: non-`asset` bindings, hence **everything inside a spliced sub-Component** (the align walk does include those), and assets whose anchors lack the tri-axis frame.
- `anchorName` = the stored `name ?? id` (the identity cables and fibre links store). `bindingId` is the slot's binding id **as every trace segment reports it** (`bindingId` in `run-from-db`'s `labSegments`): the ComponentBinding's `role`, else its UUID, so a client can join the two.
- `apertureMm` is the clear-aperture **radius** the hit test clips at (`0` = none declared). A `fiber_connector` slot's own anchors (`fiber_out` / `fiber_root`, `connect_*`) are listed too — they are in the scene but never hit (not in `PRIMARY_ANCHOR_IDS`).
- Order: the loader's (objects, then each object's asset bindings, then each asset's anchors; a synthesized fibre slot after its object's bindings).

### `GET /api/kinds/roles`

The port roles and signal domains of every **physics** kind, straight from the kinds manifest (`backend/data/kinds.json` via `kinds_manifest.load_manifest`, i.e. the export of `frontend/src/kinds/<kind>/index.ts`), in plugin registration order (= `element_kinds`). Router: `backend/app/routers/kinds.py:113`. No DB read. So a client reads the contract instead of copying `kinds.json` (the qmem-blender RF graph did). Passive (mechanical) plugins have no ports and are not listed, and neither are DB-only `kinds` rows (`isolator`, `mechanical`, `unclassified`, …), which have no plugin.

```json
[
  {
    "kind": "rf_switch",
    "primaryDomain": "rf",
    "defaultPhysics": ["rf"],
    "requiredAnchors": ["rf_in", "rf_out", "ttl_in"],
    "optionalAnchors": [],
    "portDomains": { "rf_in": "rf", "rf_out": "rf", "ttl_in": "ttl" },
    "roles": {
      "rf_in":  { "min": 1, "max": 1,    "domain": "rf",  "direction": true, "aperture": false, "fastAxis": false },
      "rf_out": { "min": 1, "max": null, "domain": "rf",  "direction": true, "aperture": false, "fastAxis": false },
      "ttl_in": { "min": 1, "max": 1,    "domain": "ttl", "direction": true, "aperture": false, "fastAxis": false }
    }
  }
]
```

- `roles[*]` is the TS `RoleSpec` (`kinds/_plugin.ts`): `min` 0 = optional, ≥ 1 = required; `max` 1 = single port, N = bounded, **`null` = unbounded multiport** (a DDS's `rf_out`, a switch's throws). The three flags are always present (the manifest omits a false one). `roles` is `null` for a kind that authors no roles map (none today).
- `portDomains` is the plugin's **explicit** map only; an anchor id missing from it takes the caller's heuristic, as in the web app (`rfLinkPorts.resolveRfLinkPortDomain`). Note the PPG: its `rf_out` declares `ttl`, and the web app treats it as `rfout` ([rf.md](rf.md) §1).
- The manifest carries **no connector types**: a port's `connectorType` (`sma_female`, `fc_apc_female`, …) lives on each asset's anchor, not on the kind.

### The align endpoints — `POST /api/v3/align/*`

Backend ports of the web app's align solvers: `utils/mirrorCoupling.ts`, `utils/isolatorAlign.ts`, `utils/aomAlign.ts`, plus the React call-site logic around them (which anchor, which point, which order / frequency — `MirrorCouplingPanel.tsx`, `AlignToBeamControls.tsx`). Router `backend/app/routers/v3_align.py`; solvers `backend/app/optical/align/` (pure modules + `service.py`, which loads the scene and follows the React call sites). The web app itself still runs its TypeScript copies; the two copies are **pinned to each other at 1e-9 by golden fixtures** — see [mirror-coupling.md](mirror-coupling.md#the-backend-port-and-its-parity-pin).

Common to all three:

- Every pose is a proposed **SceneObject pose**: `{"xMm", "yMm", "zMm", "rxDeg", "ryDeg", "rzDeg"}` in lab mm / deg, angles already on the 1e-9° storage grid. Nothing is written — apply it with `PATCH /api/objects/{id}`. The response echoes the object's `locked` flag; the web app refuses to move a locked object and so should any caller.
- Anchor poses come from the backend's own transform chain (`db_scene_loader._binding_tree_transform` ∘ `pose.pose_to_transform`) through `optical/align/anchor_poses.py`, which walks the binding tree exactly as `utils/anchorPose.resolveAnchorPosesLab` does ([anchors.md](anchors.md#reading-an-anchors-pose-in-lab-mm)) — including a per-instance asset swap (`ObjectBinding.asset3dIdOverride`), which both honour the way the tracer's loader does.
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
- **A port** is `{"objectId": "<uuid>", "anchorName": "CH0", "anchorId": "rf_out"}` — `anchorName` is `anchor.name ?? anchor.id` (`CH0`, `RF1`, `RF IN`, `rf_in`); `anchorId` is optional and only needed when two of the object's ports share a name. A port must be one the RF Link panel offers: an `rf_in` / `rf_out` / `ttl_*` / `trigger_*` anchor anywhere in the object's binding tree (multi-root Components like the EOM included) on an object whose PhysicsElement kind takes part in RF Link. **Every port is posed through its binding chain** (`ports.port_poses`, `backend/app/optical/rf_cables/ports.py:226`: binding transforms, the instance's `ObjectBinding` deltas and asset swaps) — the pose `POST /api/v3/anchors/traced` reports for it (since 2026-09-22; before, the anchor in its own asset's frame, exact only on an identity root binding — [rf.md](rf.md) §7 item 5).
- **Errors**: 4xx with `{"detail": "<code>: <message>"}`; clients may branch on the code.

  | code | status | when |
  |---|---|---|
  | `object_not_found` | 404 | an id names no SceneObject |
  | `port_not_found` / `ambiguous_port` | 422 | the object offers no such port / two, and no `anchorId` given |
  | `same_object`, `role_mismatch`, `connector_undefined`, `domain_mismatch` | 422 | connect: the RF Link panel's drop rules (an output joins an input; both SMA/BNC; the SAME signal domain) |
  | `port_busy` | 409 | a cable end or PPG already claims that port (either port, for a connect) |
  | `no_cable_component` / `no_ppg_component` | 422 | no rf_cable / no usable PPG catalog Component |
  | `not_an_rf_cable`, `not_a_ppg`, `not_a_gate_input` | 422 | the id / port is the wrong kind of thing |
  | `port_unplaceable` | 422 | connect / attach: the panel offers the port (catalog tree) but this instance's asset swap removed it, so it has no pose (`flows._placed`, `flows.py:123`) |
  | `target_not_in_range` | 422 | align: that port is not a candidate within `toleranceMm` |
  | `locked` | 409 | a delete would remove a `locked` SceneObject (refused whole) |

- **Locks**: SceneObject `locked` means what it does on `PUT / DELETE /api/objects` — pose frozen, row undeletable, `properties` writable. So re-snapping / aligning a locked cable rewrites its nodes (as the web does), a locked PPG is not re-mounted, and a delete that reaches a locked object is refused whole. No flow writes a Kind / Asset3D / Device / Component row.

### `POST /api/v3/rf-cables/connect`

`createRfCableBetweenPorts` behind the panel's drop gate (`flows.plan_connect`, `flows.py:178`). Request order does not matter — the OUT port is the source.

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

`resnapRfCablesLinkedTo` (`flows.py:252`), called after objects moved: every cable end linked to a moved object is re-mated (same math as connect), and — a backend addition the web does not need, since it re-derives the mount at render time — every PPG plugged into a moved object (or moved itself) is re-mounted, so its STORED pose stays on its port (`flows.plan_ppg_mounts`, `:299`).

```json
{ "movedObjectIds": ["<amp>"] }
```

```json
{ "updated": [ { "id": "<cable>", "properties": { "rfCableNodes": ["..."], "rfCableEndpoints": {} }, "...": "" } ] }
```

Only rows that actually change are written and returned; a second call is `{"updated": []}`.

### `POST /api/v3/rf-cables/{id}/align-candidates` (compute-only)

`findRfCableAlignmentCandidates` (`flows.py:326`): every `rf_in` / `rf_out` anchor on any other object within `toleranceMm` (default 25) of this end, nearest first. Distances are measured from the end's current connector mating face, and `newPosMmBody` / `newHandleMmBody` mate that face onto the port, both with the end's bound connector length (the SMA's 25.45 mm), as connect and resnap do.

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

`createPpgAtPort` + `createProgrammablePulseGenerator` behind the panel's `canSpawnPpgHere` (`flows.plan_ppg_attach`, `flows.py:540`): the target must be an empty `ttl_in` / `trigger_in` with an SMA/BNC connector. The PPG Component is the first `programmable_pulse_generator` whose `properties.connectorType` equals the port's family and whose primary asset carries `rf_out`.

```json
{ "target": { "objectId": "<switch>", "anchorName": "ttl_in" }, "collectionId": null }
```

```json
{ "object": { "id": "<ppg>", "name": "CH2", "componentId": "<PPG BNC MALE>",
    "xMm": -1273.376, "yMm": 770.745, "zMm": 699.415, "rxDeg": 0, "ryDeg": -90, "rzDeg": 0,
    "properties": { "ppgAttachment": { "targetObjectId": "<switch>", "targetAnchorId": "ttl_in", "targetAnchorName": "ttl_in" } },
    "...": "" },
  "timingProgram": { "id": "<program>", "name": "CH2", "intervals": [], "...": "" } }
```

Written in one transaction: the TimingProgram (named `CH<number of PPGs>`, stepped past any object name already taken — names are unique case-insensitively — and empty), the object (same name), its PhysicsElement (`kindParams` as the web writes them, normalised by the same schema → `{"timingProgramId", "restState": "LOW", "outputDomain": "rfout"}`) and the attachment. The pose is the **mounted** pose (`utils/ppgMounting.ts`, ported as `rf_cables/ppg_mount.py`: `rf_out` mated onto the port, backed off by the asset's `matingProtrusionMm`), where the web stores its 3D-cursor spawn pose and draws the mount live. The port is resolved anywhere in the target's binding tree, so a multi-root instrument (the EOM) mounts its PPG like any other.

### `POST /api/v3/ppg/{id}/detach`

The panel's "Disconnect" on a PPG — the only sanctioned way to remove one: the PPG is deleted through the web's delete cascade and its TimingProgram with it. No body.

```json
{ "deletedObjectIds": ["<ppg>"], "deletedTimingProgramIds": ["<program>"] }
```

## Deleting objects — `POST /api/v3/objects/delete` (this WRITES)

The web store's `deleteObjects` (`frontend/src/store/sceneStore.ts:4615`) served to a second client: delete a set of SceneObjects with everything the web's cascade takes along, in ONE transaction. Router `backend/app/routers/v3_objects.py:55`; plan `backend/app/services/object_delete.py:89` (`plan_delete`, on top of `rf_cables/flows.py:393` `plan_delete_objects` — the one Python port of the cascade, which `/rf-cables/{id}/disconnect` and `/ppg/{id}/detach` use too); DB side `object_delete.py:122`.

```json
{ "objectIds": ["<RF_SWITCH0>", "<MIRROR4, locked>", "<an id already deleted>"], "dryRun": false }
```

`dryRun` is optional (default `false`). Response 200:

```json
{ "deletedObjectIds": ["<RF_SWITCH0>", "<RF_CABLE3>", "<RF_CABLE1>", "<CH0>", "<an id already deleted>"],
  "deletedTimingProgramIds": ["<CH0's TimingProgram>"],
  "refused": [ { "objectId": "<MIRROR4, locked>", "reason": "locked" } ] }
```

**The cascade**, exactly the web's, in the order the web issues its DELETEs (which is the order of `deletedObjectIds`):

1. the requested objects, de-duplicated, minus the `locked` ones — the web skips those silently; here they come back in `refused` (`reason` is always `"locked"` today);
2. every object whose `properties.rfCableEndpoints.A` or `.B` names a doomed object — ONE pass in scene order. A cable is **deleted**, never unlinked (a coax either joins two ports or does not exist, [rf.md](rf.md) §7);
3. every PPG plugged into a doomed object (`properties.ppgAttachment`, `ppgsAttachedTo`, evaluated once);
4. every LEGACY PPG (still wired through rf_cables) whose rf_cables are all doomed — and never one with no rf_cable at all (the `cables.length === 0` guard, `sceneStore.ts:4698`: a cable-less PPG lives by its attachment);
5. per row, what `DELETE /api/objects/{id}` removes (`routers/objects.py:250` `remove_scene_object`): the PhysicsElement, and a PPG's bound TimingProgram (`kindParams.timingProgramId`, `bound_timing_program_id`, `:234`); the FK cascades take the object's ObjectBindings, collection membership, assembly relations, device state and connection / optical / RF link rows.

**Not touched**, as in the web: fibres and pigtails linked to a doomed object keep their now-dangling `fiberEndpoints` / `pigtailEndpoints` link (a loose patch cable is a real bench state; `POST /api/v3/fibers/{id}/disconnect` unlinks one if wanted). Nothing is gated by kind: the web hides rf_cables and PPGs from the Outliner ("Managed", `capabilityProfile`) but its store — and its Delete key on a viewer selection — deletes them, so this does too. Rigid groups only move together; they do not delete together. Deleting a collection is `DELETE /api/collections/{id}` (the Outliner first deletes the objects under it, through `deleteObjects`, when asked to).

- `deletedTimingProgramIds`: the programs those rows took along, each once, only rows that existed.
- **Locked**: a cascade that reaches a `locked` object (step 2–4; a requested locked object is only skipped) is refused whole — `409 {"detail": "locked: deleting these would also delete locked object(s) RF_CABLE3 (<id>); unlock them first."}` — and nothing is deleted. `dryRun` answers the same 409.
- **Already gone**: a requested id with no row counts as deleted (the web treats a 404 as the outcome it wanted). It is listed at the end of `deletedObjectIds`; nothing cascades from it, and nothing is broadcast for it (whoever deleted it did).
- **Events**, after the one commit, per deleted row in `deletedObjectIds` order — exactly those of `DELETE /api/objects/{id}` (`objects.py:277`): `object.deleted {id, objectId}`, `physics_element.updated {objectId, deleted: true}` when it had one, `timing_program.deleted {id}` for a PPG naming a program.
- `dryRun: true` returns exactly what the real call would (409 included) and writes and broadcasts nothing — for a confirmation dialog.
- 422 when `objectIds` is missing or an id is not a UUID. An empty list is a 200 with three empty lists.

**Where it departs from the web**, both because it is one transaction: the web DELETEs a locked cascaded object and gets a 409 for that row while the rest go through (in parallel), so the request half-happens and the store's own update is skipped (only the websocket events reconcile it); here the request is refused before anything is written. And the web can only count as "already gone" an object its snapshot still holds (then it also cascades from it); the backend's scene is the database, so an id with no row cascades nothing.

**Parity**: `frontend/src/store/__tests__/deleteParity.test.ts` runs the real `deleteObjects` against a recording fake of `api/client` and writes `backend/tests/fixtures/delete/{pinned,random}.json` (63 hand-picked requests — the unit-test pins, a live-shaped bench, locks, malformed links, the TS quirks — and 255 on 120 seeded-random scenes), failing when they go stale (`UPDATE_DELETE_FIXTURES=1` regenerates). `backend/tests/test_objects_delete_parity.py` asserts the Python plan issues the same deletes in the same order; `test_objects_delete_endpoint.py` inserts every scene as real rows and replays each request whose outcome does not depend on scene order (306 of 318) through the endpoint — dry run, then for real — and checks the rows, plus dryRun / 409 / one-transaction / event tests. Cross-checked once on the live snapshot (2026-09-22: 73 single-object deletes and delete-all): identical.

## Fibre and pigtail ends — `POST /api/v3/fibers/*`, `/api/v3/pigtails/*` (these WRITE)

The ONLY implementation of the fibre-end and pigtail-end flows, for every client. The web store's `findFiberAlignmentCandidates` / `applyFiberAlignmentCandidate` / `clearFiberEndpointLink` / `resnapFibersLinkedTo` and the `…Pigtail…` four call these (2026-09-23) and `utils/fiberAlignment.ts` + `utils/pigtailAlignment.ts` are deleted; the qmem-blender add-on calls the same ones. Routers `backend/app/routers/v3_fibers.py` / `v3_pigtails.py`; flows `backend/app/optical/fibers/service.py`; what they mean physically in [fiber.md](fiber.md#the-endpoint-flows-2026-09-22-the-web-calls-them-since-2026-09-23) and [component.md](component.md). Ports are placed through the tracer's chain (binding tree + SceneObject pose). What the TypeScript answered before it was deleted is kept as frozen golden fixtures at arbitrary poses (`backend/tests/fixtures/fibers/`, replayed at 1e-9 by `tests/optical/test_fiber_parity.py`; nothing regenerates them).

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

**What the web keeps for itself**, because neither is alignment: the `beamSegments` it sends (only a client with a live trace knows which beams exist — the same contract as `/api/v3/align/*`), and the Object panel's per-end port-pose editor, which writes an arbitrary lab pose the user typed (`utils/fiberAnchorResolver.withFiberPortLabPose`; it shares the bound connector's `tipMm` with everything here). Its instrument-side "Plug in…" list is `/fibers/{cable}/candidates` once per cable per end with `beamSegments: []`, filtered to the one port — so a port offered from the cable and the same port offered from the instrument produce byte-identical geometry.

The round trip the web makes — `/candidates` with its live `beamSegments`, then a returned `port` fed straight into `/connect` and a beam candidate's own segment into `/apply` — is pinned by `test_the_web_clients_candidates_feed_straight_back_into_connect_and_apply` in `backend/tests/optical/test_fiber_endpoints.py`, including the label fields the store matches a candidate back to its segment on.
