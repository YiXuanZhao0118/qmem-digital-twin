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
- Static: `/assets/files/...`; Swagger: `/docs`; WebSocket: `/ws/scene`
- Conventions: every persisted id is a UUIDv7; CamelModel (DB snake_case ↔ API camelCase).
