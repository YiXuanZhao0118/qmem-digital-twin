[← 文件索引](README.md)

# 啟動與開發 Runbook

> 三層服務與連接埠見 [overview.md](overview.md)；migration 鏈見 [migrations.md](migrations.md)。

**一鍵重啟（建議）：**
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "C:\repos\qmem-digital-twin\.claude\skills\start-project\scripts\restart-stack.ps1"
```
釋放 5173/8010、啟動 Postgres、跑 `alembic upgrade head`、起 uvicorn + vite，印出驗證表。

**手動：**
```powershell
scripts/start-local-postgres.ps1                    # Postgres → 55432（qmem/qmem_password, db qmem_twin）
# 在 backend/ 下，用 DATABASE_URL env 覆寫到 55432：
alembic upgrade head
python -m uvicorn app.main:app --host 0.0.0.0 --port 8010 --reload   # ★8010
frontend/node_modules/.bin/vite.cmd                 # Vite → 5173（勿用 npx）
```

**驗證**：前端 `http://localhost:5173`（200）、後端 `/api/health`（`{"ok":true}`）、`alembic current` 報 head。

**Seed**：live DB 由 `backend/scripts/seed_v3_assets.py` + v3 catalog 種；舊 `seed.py` 已 deprecated（有 banner，不在 live DB）。

**工具**：pytest（backend）、vitest（frontend）、`tsc --noEmit`、`vite build`。

> Windows/工具陷阱：PowerShell `Set-Content` 預設 cp950 會讓含中文的 JSON mojibake → 用 `-Encoding UTF8`；uvicorn `--reload` 在 Windows 檔案監看不穩，必要時手動重啟；PS 5.1 無 `??`；Asset3D JSON 不可有 `+` 前綴數字；scipy `from_euler` "YXZ"(intrinsic) 才對應 three.js。
