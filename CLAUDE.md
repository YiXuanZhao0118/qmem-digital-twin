# CLAUDE.md — qmem-digital-twin

Project-specific guidance. Merge with the global guidelines.

## Authoritative docs — read these instead of grepping source

- For **architecture / concept questions**, read [`docs/introduce/README.md`](docs/introduce/README.md) (the index) first, then the relevant per-concept file. As of 2026-06-11 every file under `docs/introduce/` has been line-verified against the code — treat them as the **authoritative, current map** of the system.
- **Trust the docs for orientation.** Do NOT re-read source just to confirm what a doc already states — *unless you are about to change that area's code* (see "Read vs verify").
- **Auto-memory** (`MEMORY.md` + topic files) holds project state/decisions/gotchas — check it before assuming. Note: it is **machine-local and keyed to the launch cwd** (`~/.claude/projects/<cwd-hash>/memory/`), so it does **NOT** live in or travel with this repo, and it differs per cwd — launch Claude from a consistent directory or the memory won't load. Keep it updated as state changes.

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

- **Optical engine**: live = `backend/app/optical/anchor_tracer.py` (anchor-based) + `solver.py` (`solve_anchor_scene`), endpoint `/api/v3/solver`. Dispatch via `anchor_ops/<kind>.py`. faces/transitions retired (migration 0106) → `anchors[]`. Face-based `ray_tracer.py` is legacy.
- **Rendering**: unified onto the ComponentBinding tree (`bindingRendererGate.ts`, `shouldRenderViaBindings` always true). Legacy single-asset `loadAssetObject` dispatch is dead code; per-instance fiber/rf_cable/isolator state forwarding through the tree is still TODO.
- **Classification (two separate axes)**: **category ← component kind** (`Component.kind_id` → plugin `assetCategory`); **domain ← asset kind** (`Asset3D.kind_id` → `kind.domains` ∈ {optical, rf, mechanical}). Decoupled — `physicsCapabilities` no longer drives either.
- **Multiphysics**: Lab is the only top-level module (Optics/Electronics/EM removed 2026-06-10, migration 0109); Magnetics is a Lab overlay.
- **Alembic head**: `0109_drop_circuits_em_runs`. Stack ports: frontend 5173 / backend 8010 / Postgres 55432.
