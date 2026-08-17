[← Doc index](README.md)

# Main API endpoints

> How to start the stack: [runbook.md](runbook.md). Wiring / ports: [overview.md](overview.md).

- `GET /api/health` → `{"ok": true}`; `GET /api/scene` — scene snapshot
- `POST /api/v3/solver/run-from-db` — run the optical trace over the persisted scene (produces beam segments: dir, pol, hit face)
- `POST /api/v3/pop` — **on-demand** physical-optics diffraction: given the beam radius at the lens plus aperture and focal length, returns the focal-plane Airy intensity grid (diffraction rings). Never part of the live trace. See the POP field channel in [optics.md](optics.md)
- `GET /api/v3/catalog/...`, `/api/v3/assets3d`, `/api/v3/components`
- `/api/timing-programs`, `/api/rf-chains/nodes`, `/api/coils`, `/api/magnetics-problems`, `/api/simulation-runs`, `/api/touchstone/parse`, `/api/app-settings/{key}`
- Static: `/assets/files/...`; Swagger: `/docs`; WebSocket: `/ws/scene`
- Conventions: every persisted id is a UUIDv7; CamelModel (DB snake_case ↔ API camelCase).
