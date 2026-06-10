[← 文件索引](README.md)

# 主要 API 端點

> 啟動方式見 [runbook.md](runbook.md)；連接設定見 [overview.md](overview.md)。

- `GET /api/health` → `{"ok": true}`；`GET /api/scene` — 場景快照
- `POST /api/v3/solver/run-from-db` — 對持久化場景跑光學 trace（產生光束段：dir、pol、命中面）
- `GET /api/v3/catalog/...`、`/api/v3/assets3d`、`/api/v3/components`
- `/api/timing-programs`、`/api/rf-chains/nodes`、`/api/coils`、`/api/magnetics-problems`、`/api/simulation-runs`、`/api/touchstone/parse`、`/api/app-settings/{key}`
- 靜態：`/assets/files/...`；Swagger：`/docs`；WebSocket：`/ws/scene`
- 慣例：所有持久 id 為 UUIDv7；CamelModel（DB snake_case ↔ API camelCase）。
