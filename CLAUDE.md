# CLAUDE.md — qmem-digital-twin

Project-specific guidance. Merge with the global guidelines.

## Authoritative docs — read these instead of grepping source

- For **architecture / concept questions**, read [`docs/introduce/README.md`](docs/introduce/README.md) (the index) first, then the relevant per-concept file. As of 2026-06-11 every file under `docs/introduce/` has been line-verified against the code — treat them as the **authoritative, current map** of the system.
- **Trust the docs for orientation.** Do NOT re-read source just to confirm what a doc already states — *unless you are about to change that area's code* (see "Read vs verify").
- **Auto-memory** (`MEMORY.md` + topic files) holds project state/decisions/gotchas — check it before assuming. Note: it is **machine-local and keyed to the launch cwd** (`~/.claude/projects/<cwd-hash>/memory/`), so it does **NOT** live in or travel with this repo, and it differs per cwd — launch Claude from a consistent directory or the memory won't load. Keep it updated as state changes.

## Locked rows — do NOT modify (human-confirmed complete)

A Kind, Asset3D, Device or Component row can carry `locked = true` (DB column, alembic 0112; Device 0123, Component 0128). It means a human has reviewed that row, confirmed it is **complete and correct**, and frozen it. Treat a locked row as off-limits:

- **Never edit, re-tune, "fix", or delete a locked Kind / Asset3D / Device / Component** — not its `default_params`, anchors, `wavelength_range_nm`, nothing. If your task seems to require changing a locked row, **stop and ask the user to unlock it first** (or to confirm the change); don't work around the lock.
- **How to check:** the flag is `kinds.locked` / `assets_3d.locked`, surfaced as `locked` on `KindOut` / `Asset3DV3Out` (GET `/api/kinds`, `/api/v3/assets3d`). The PHY Editor shows a 🔒 on each locked list row.
- **Enforcement is real, not advisory:** every write path (`PATCH /api/kinds/{id}`, `PUT /api/v3/assets3d/{key}`, `PUT /api/assets/{id}`, and the deletes) rejects any change to a locked row with **422** unless the request *only* toggles `locked` (i.e. unlock). Guard: `backend/app/lock_guard.py`. So a tool call that edits a locked row will fail — don't retry it, surface the lock to the user.
- Unlocking is a deliberate **human** action (click the lock icon in the PHY Editor). Do not unlock a row on your own initiative to push an edit through.

## Read vs verify (balance context cost against correctness)

This is the core rule for using docs efficiently:

- **Answering a question / orienting** → rely on `docs/introduce/` + `MEMORY.md`. Avoid broad grepping or reading large swaths of source. The docs exist precisely so you don't have to.
- **Making a CODE change** → verify the *specific* code you're touching against the actual source. Docs can lag the code by minutes.
- **High-risk changes** (DB schema / Alembic migrations, the render pipeline, the optical tracer / physics ops, anything cross-cutting) → **spot-verify against source even when the docs look right.** A stale doc leading to wrong code is a real, recurring failure mode — never suppress verification entirely here.
- If the user says "trust the docs, don't re-verify," honour it for questions; for code edits still apply the high-risk rule above and say so.

## Keeping docs trustworthy (this is what makes the rule above safe)

- **Every session that changes code MUST update the affected `docs/introduce/*.md` in the same change.** Code and its doc move together so the docs never drift. If you rename a field, change a behaviour, add/remove an endpoint, retire a file, etc. — fix the doc(s) that describe it in the same commit. A code commit that silently outdates a doc is a bug.
- **Cite `file:line` + invariants** in docs so future reads jump precisely instead of searching. Prefer "X lives in `path/file.ts:NN`; invariant: Y must hold" over vague prose. When you touch a doc, add/repair these anchors.
- **Split large docs + cross-link.** If a doc grows too large or covers multiple topics, split it into per-concept files and link them — exactly as `docs/introduce/` already does: an index `README.md` + single-topic files, each starting with `[← 文件索引](README.md)` and cross-linking siblings via `[other.md](other.md)`. Keep each file one topic.
- After adding/splitting/renaming docs: update the index `README.md` link list **and** run a link check (no broken `](*.md)` targets). Update the `MEMORY.md` line + the relevant memory file if the doc set's shape changed.

## Current model (quick pointers — details in docs/introduce/)

- **Optical engine**: live = `backend/app/optical/anchor_tracer.py` (anchor-based) + `solver.py` (`solve_anchor_scene`), endpoint `/api/v3/solver`, DB→slots via `db_scene_loader.load_anchor_scene_from_db`. Dispatch via `anchor_ops/<kind>.py`. Only `PRIMARY_ANCHOR_IDS` (`intercept_in/out/face`, `interaction_center`, `optical_center`) are hit-tested. faces/transitions retired (migration 0106) → `anchors[]`. Face-based `ray_tracer.py` is legacy.
  - **Fiber coupling is a synthesized slot, not a static asset**: a connector-component fiber binds two `fiber_connector` assets (passthrough; `connect_in/out` aren't primary), so the loader synthesizes a `fiber`-kind slot (`_synth_fiber_slot`) — `intercept_in/out` pose from the fiber PhysicsElement's `kindParams.endA/endB` (what Align writes), while the optical-face offset + hit aperture come from the connector asset's `connect_in` (`_connector_tip_and_aperture`). Editing `connect_in` on the asset moves the coupling face / waist. Fiber **align** (`sceneStore.resolveEffectiveFiberNodes` + `syncFiberEndpointToKindParams`) reads/writes those same kindParams. Details in [`docs/introduce/fiber.md`](docs/introduce/fiber.md).
- **Rendering**: unified onto the ComponentBinding tree (`bindingRendererGate.ts`, `shouldRenderViaBindings` always true). Legacy single-asset `loadAssetObject` dispatch is dead code; per-instance fiber/rf_cable/isolator state forwarding through the tree is still TODO.
- **Classification (two separate axes)**: **category ← component kind** (`Component.kind_id` → plugin `assetCategory`); **domain ← asset kind** (`Asset3D.kind_id` → `kind.domains` ∈ {optical, rf, mechanical}). Decoupled — `physicsCapabilities` no longer drives either.
- **Multiphysics**: Lab is the only top-level module (Optics/Electronics/EM removed 2026-06-10, migration 0109); Magnetics is a Lab overlay.
- **Alembic head**: `0128_component_locked` (Component gets a real `locked` column + the shared `lock_guard`, replacing a `properties['locked']` JSONB flag that guarded delete only with a 409; the AI rule above now covers **Component** too). Before it, `0127_aom_acoustic_axis_anchor` (backfills the `acoustic_axis` anchor onto every `aom` asset — the direction's single source of truth since 2026-06-03, but the draining migration its two resolvers point at was never written, so the catalog's one AOM ran on the legacy param fallback; see [`docs/aom-model.md`](docs/aom-model.md)). Before it, `0126_kinds_manifest_resync` (**the `kinds` table must equal `backend/data/kinds.json`** — 0086 backfilled it once and nothing re-ran it, so 29 of the 31 plugin-backed rows had fossilised (only `dichroic_mirror` and `mirror` were clean); the invariant is now pinned by `backend/tests/test_kind_manifest_sync.py` and reportable via `backend/scripts/audit_kind_param_drift.py`. **Built-in kinds are edited in `frontend/src/kinds/<kind>/index.ts` + `npm run export:kinds` + a resync migration, NOT in the Kinds editor** — see [`docs/introduce/kinds.md`](docs/introduce/kinds.md)). Then `0123_devices` (the device registry as a DB table — devices left `frontend/src/devices/*.ts` so the PHY Editor's **DEVICE** section can create and correct them; `/api/devices`, seeded from `0123_devices_seed.json`) and `0122_asset_lods` (the LOD sidecar table — one row per (asset, level); kept off `assets_3d` because locked rows would 422, see [`docs/introduce/rendering.md`](docs/introduce/rendering.md)). Still load-bearing: `0113_param_ownership_tunable` (per-instance editing gated by `assets_3d.tunable_params`, values in `objects.dynamic_sources`; `objects.param_overrides` dropped). Stack ports: frontend 5173 / backend 8010 / Postgres 55432.
  - ⚠️ **0126 and 0127 both write `locked` rows**, which the rule above forbids. Both were done with the user's explicit authorisation and are argued for in [`docs/introduce/kinds.md`](docs/introduce/kinds.md) + [`docs/introduce/migrations.md`](docs/introduce/migrations.md). Note the general lesson: `lock_guard` is **API-layer only**, so a migration bypasses it silently — the lock cannot stop you, only the rule can.
