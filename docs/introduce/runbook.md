[← Doc index](README.md)

# Startup & development runbook

> The three service tiers and their ports are in [overview.md](overview.md); the migration chain is in [migrations.md](migrations.md).

**One-shot restart (recommended):**
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "C:\repos\qmem-digital-twin\.claude\skills\start-project\scripts\restart-stack.ps1"
```
Frees 5173/8010, starts Postgres, runs `alembic upgrade head`, brings up uvicorn + vite, and prints a verification table.

**Manual:**
```powershell
scripts/start-local-postgres.ps1                    # Postgres → 55432 (qmem/qmem_password, db qmem_twin)
# From backend/, with DATABASE_URL overridden to 55432:
alembic upgrade head
python -m uvicorn app.main:app --host 0.0.0.0 --port 8010 --reload   # ★8010
frontend/node_modules/.bin/vite.cmd                 # Vite → 5173 (do NOT use npx)
```

**Verify**: frontend `http://localhost:5173` (200), backend `/api/health` (`{"ok":true}`), `alembic current` reports head.

**Seed**: the live DB is seeded by `backend/scripts/seed_v3_assets.py` + the v3 catalog; the old `seed.py` is deprecated (it carries a banner and is not in the live DB).

**Tooling**: pytest (backend), vitest (frontend), `tsc --noEmit`, `vite build`.

> Windows / tooling traps: PowerShell `Set-Content` defaults to cp950, which mojibakes JSON containing Chinese → pass `-Encoding UTF8`; uvicorn `--reload` file watching is unreliable on Windows, so restart by hand when needed; PS 5.1 has no `??`; Asset3D JSON must not contain `+`-prefixed numbers; only scipy `from_euler` "YXZ" (intrinsic) matches three.js.
