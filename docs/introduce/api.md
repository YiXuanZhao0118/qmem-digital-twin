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
