[← 文件索引](README.md)

# 系統概觀

> 相關：[資料模型](data-model.md)、[座標系與 Anchor](anchors.md)、[啟動 Runbook](runbook.md)

## 這是什麼

**QMsimulation**（別名 qmem-digital-twin）是一套**量子記憶體 / 冷原子光學實驗室的數位分身（digital twin / 數位孿生）**。它把一張真實的量子光學桌（laser → tapered amplifier → 波片 → PBS → AOM → 量子記憶體 cell，加上 RF 電子與時序控制）建模成一個可互動、物理精確的 3D 數位分身，支援光束追跡、偏振模擬與多物理場模擬。

使用者可以在瀏覽器裡擺放/對準光學元件、連接光路與 RF 鏈、沿時間排程脈衝，並即時看到光束如何傳播與被各元件作用。長期目標是做成類 Ansys Workbench 的「多物理整合平台」（光學 + 電子 + 電磁 + 磁學 + 時序），但全用開源求解器、供實驗室內部使用。

---

## 系統架構（三層服務）

| 層 | 技術 | 連接埠 | 角色 |
|---|---|---|---|
| 前端 Frontend | React 18 + TypeScript + Vite 6 + three.js 0.170 + zustand + axios | **5173** | 3D 視埠、編輯 UI、各模組工作區 |
| 後端 Backend | FastAPI + SQLAlchemy 2.x async + Pydantic v2 + numpy/scipy | **8010** | REST API + WebSocket、光學/多物理求解器、持久化 |
| 資料庫 Database | PostgreSQL 16（本機隔離實例，位於 `.local-postgres/`） | **55432** | 場景 / 資產 / 元件 / 模擬結果持久化 |

**連接方式：**
- 前端寫死連後端 `http://localhost:8010`（`frontend/src/api/client.ts`，可用 `VITE_API_BASE_URL` 覆寫），**直接打、不透過 Vite proxy**。
- WebSocket：`ws://localhost:8010/ws/scene`（伺服器→客戶端推 `component.*`/`object.*`/`simulation_run.*` 等事件，客戶端只送 `ping`）。
- 後端 CORS 白名單 `localhost:5173`、`localhost:3000`（`backend/app/config.py`）。
- DB 連線字串：`postgresql+asyncpg://qmem:qmem_password@localhost:55432/qmem_twin`。
- 資產檔：前端 `resolveAssetUrl()` 組出 `http://localhost:8010/assets/files/...`，後端靜態服務 `assets/`。

> ⚠️ **常見過時資訊更正：**
> - 後端 port 是 **8010**（部分舊文件/根 README 寫 8000，那是 docker 模式預設，本機開發用 8010）。
> - `docker-compose.yml` 內 Postgres 寫 **5432**；本專案實際用本機 **55432** + `scripts/start-local-postgres.ps1`，且環境未安裝 Docker。5432 vs 55432 是最常見的混淆點。

---

## 目錄結構

```
qmem-digital-twin/
├── frontend/src/
│   ├── components/   # React UI：DigitalTwinViewer（主場景，~6000 行）、各 panel、editor
│   │   └── physics/  # 各 kind 的 *AdjustControls（Laser/Aom/TaperedAmplifier/Simple）
│   ├── three/        # three.js 場景、loadAsset、rayTrace、v3TraceAdapter、beam、placement/
│   ├── kinds/        # 每 kind 的 plugin 渲染器 + 註冊表（_plugins.ts、_renderer_bindings.ts）
│   ├── optical/      # TS 光學：jones、frames、pose、fiber/、WIP v3 光追島（見 optics.md）
│   ├── store/        # zustand：sceneStore、kindsStore、(v3)catalogStore
│   ├── utils/        # (v2)bindings、anchorAccess、componentBindings、rfPropagation
│   └── modules/      # Lab 工作區（唯一 tab）+ Magnetics overlay；Optics/Electronics/EM tab 已於 2026-06-10 完整移除（資料夾刪除）
├── backend/
│   ├── app/
│   │   ├── main.py       # FastAPI 進入點，~40 routers 註冊於 /api/<resource>
│   │   ├── routers/      # 每資源 REST router
│   │   ├── models/       # SQLAlchemy ORM（scene、hardware、timing…）
│   │   ├── optical/      # ★權威光學引擎：anchor_tracer（live, anchor-based）+ solver（solve_anchor_scene）+ anchor_ops/<kind>；rf_resolve（RF 圖傳播）；ray_tracer/solver_v3 face-based 為 legacy（0106 後退役）；db_scene_loader、jones、abcd
│   │   ├── solvers/      # 多物理：optics_seq、magnetics_dc、runner（Optics/Electronics/EM solvers 已於 2026-06-10 移除）
│   │   ├── services/     # touchstone…（onshape_client / instrument_polling 為死碼）
│   │   └── schemas*.py   # Pydantic（CamelModel：DB snake_case ↔ API camelCase）
│   ├── alembic/versions/ # migration 0001..0109（線性鏈，head 0109）
│   └── data/             # kinds.json（★kind 物理參數權威來源）、thorlabs_cad_manifest.json
├── assets/
│   ├── catalog/          # 元件/資產/kinds JSON 定義（seed 來源；DB 才是 runtime 真值）
│   └── files/            # stl、glb、cad_sources（CAD 二進位不進 DB）
└── docs/                 # 本說明檔群 + aom_align_*.{png,py}（AOM 對準圖表腳本）
```
