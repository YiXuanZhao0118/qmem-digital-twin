[← Doc index](README.md)

# Main API endpoints

> How to start the stack: [runbook.md](runbook.md). Wiring / ports: [overview.md](overview.md).

- `GET /api/health` → `{"ok": true}`; `GET /api/scene` — scene snapshot
- `POST /api/v3/solver/run-from-db` — run the optical trace over the persisted scene (produces beam segments: dir, pol, hit face)
- `POST /api/v3/pop` — **on-demand** physical-optics diffraction: given the beam radius at the lens plus aperture and focal length, returns the focal-plane Airy intensity grid (diffraction rings). Never part of the live trace. See the POP field channel in [optics.md](optics.md)
- `GET /api/v3/catalog/...`, `/api/v3/assets3d`, `/api/v3/components`
- `GET/POST/PATCH/DELETE /api/kinds` — the Kind registry; `GET /api/kinds/op-sets` lists every op-set name a Kind row may reference (exactly what `POST /api/kinds` validates against, so the KIND editor's dropdown can offer code-side op sets that have no Kind row yet); `GET /api/kinds/roles` — every physics kind's port contract from the manifest (see below)
- `GET/POST/PATCH/DELETE /api/devices` — the device registry (alembic 0123; previously TypeScript files under `frontend/src/devices/`). `GET /api/devices/behavioral-kinds` lists the kinds a device may pin itself to — the manifest's ElementKinds and passive plugin ids **plus every existing `kinds` row** (`isolator`, `mechanical`, `unclassified`, user kinds); `POST` / `PATCH` validate `behavioralKind` against exactly that set (400 otherwise, `routers/devices.py:39`). `slug` is create-only, a `locked` row rejects edits with 422, and DELETE is refused with 409 while an Asset3D still references the slug
- `/api/timing-programs` (`POST` and `PUT` both reject an unordered / overlapping `intervals` list with 422, see [timing.md](timing.md)), `/api/rf-chains/nodes`, `/api/coils`, `/api/magnetics-problems`, `/api/simulation-runs`, `/api/touchstone/parse`, `/api/app-settings/{key}`
- `POST /api/v3/rf/propagation` — the RF readout at one scrub time (compute-only, see below)
- `POST /api/v3/align/mirror-coupling`, `/api/v3/align/isolator`, `/api/v3/align/aom-bragg` — proposed poses from the align solvers (compute-only, see below)
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
