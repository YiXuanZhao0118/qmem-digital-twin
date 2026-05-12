# Multi-physics Platform — Progress Tracker

> Phase 進度追蹤。Plan 是 [MULTIPHYSICS_PLAN.md](MULTIPHYSICS_PLAN.md);這份是「實際做了什麼、剩什麼、卡在哪」。每完成一個 sub-task 就在這裡打勾並寫 commit hash。

---

## Status Legend

- ✅ Done(commit hash)
- 🚧 In progress(誰 + ETA)
- 📋 Planned(順序排好,還沒開工)
- 🔒 Blocked(等什麼)
- ⏭ Deferred(本 phase 不做)

---

## Phase A — Optics Shell + Module Switcher

**Target:** module switcher UI 切得起來,現有光學功能不變,從新 `simulation_runs` 機制觸發 ray trace。

**Estimate:** 2–3 週(全職)
**Started:** 2026-05-12
**Done:** —

### Sub-tasks

| # | Task | Status | Commit | Notes |
|---|---|---|---|---|
| A.0 | 建 `MULTIPHYSICS_PROGRESS.md` | ✅ | 0119646 | 開工 |
| A.1 | Backend: `simulation_runs` schema + alembic 0036 + Pydantic + CRUD router | ✅ | (this commit) | ALTER TABLE 加 7 cols;status enum 擴 +'queued'/'cancelled';Literals `SimulationModule` / `SolverRunnerKind` ;router POST + GET filter;e2e 通過 (POST→queued→completed in 62ms) |
| A.2 | Backend: `SolverRunner` Protocol + `InProcessRunner` 實作 | ✅ | (this commit) | `backend/app/solvers/runner.py` Protocol + InProcessRunner via `asyncio.create_task`(strong-ref `self._tasks` 防 GC);MODULE_DISPATCH + MODULE_DEFAULT_RUNNER + RUNNERS dispatch tables |
| A.3 | Backend: 把現有 `optical_solver.py` 包進 `solvers/optics_seq.py`,註冊到 runner | ✅ | (this commit) | adapter `solvers/optics_seq.py`;`hydrate_laser_kind_params` 從 routers/simulations.py 抽出共用;run() mutate sim_run + persist beam_segments + WS broadcast `simulation_run.status_changed` + `scene.reload`;legacy POST /api/simulations/optical/run 改 import 共用 helper,行為不變 |
| A.4 | Frontend: module registry + `ModuleSwitcher.tsx` (top bar) | ✅ | (this commit) | `modules/_registry.ts` lists Optics(A) / Electronics(B) / EM(C);`components/workspace/ModuleSwitcher.tsx` segmented control;sceneStore 加 `currentModule` + `setCurrentModule`;types/digitalTwin.ts 擴 `SimulationRunStatus` 加 'queued'+'cancelled',新 `SimulationModule` / `SolverRunnerKind` / `SimulationRunCreatePayload` |
| A.5 | Frontend: `OpticsWorkspace.tsx` 包現有 viewer/panels;Electronics/EM placeholder | ✅ | (this commit) | App.tsx 條件渲染:Optics → 現有 viewer + panels(不動);其他 module → `modules/ModulePlaceholder.tsx` 顯示 phase tag + description + 'Coming soon' card。PHY editor mode 仍 take-over,跟 module 正交。Browser verify: ModuleSwitcher 三個 tab 渲染 + Electronics click 顯示 placeholder + 回 Optics 重出 viewer (canvasHasViewer:true, no console errors) |
| A.6 | Frontend: `SolverConsole.tsx`(progress / log / error) | ✅ | (this commit) | FloatingPanel @ panel id `solver-console`(右下,visible by default);Run button POST /api/simulation-runs;active run 顯示 status badge + progress bar;recent runs list (last 6);WS `simulation_run.status_changed` 透過 sceneStore.applyEvent 即時 patch list。新 sceneStore state `recentSimulationRuns` + actions `loadRecentSimulationRuns` / `dispatchSimulationRun`。新 api helpers `fetchSimulationRunsApi` / `fetchSimulationRunApi` / `createSimulationRunApi`。Browser preview verified: panel 渲染、initial GET 拿到 4 個 historical runs、Run button enabled (POST e2e 卡 8010 zombie socket — backend 已獨立 verified on 8011, fix 需 reboot Windows 清 stale binding) |
| A.7 | End-to-end smoke test:切 Optics → 觸發 ray trace → 看到結果 + console log | 📋 | — | playwright-cli 寫一個 e2e |

### Phase A 完成判準

- 啟動新 stack,瀏覽器看到 top bar 有三個 module(Optics 可選,Electronics/EM 灰掉)
- 切到 Optics → 看到原本完整 viewer + panels
- Run Solver → 後端寫 `simulation_runs` row → solver console 即時看到 progress
- 現有所有光學功能(ray trace、AOM、collection、placement)無 regression
- pytest 通過,vitest 通過
- 切到 Electronics/EM 看到 "Coming in Phase B/C" placeholder

---

## Phase B — Electronics MVP(ngspice)

📋 等 Phase A done 才開工。

詳細 sub-task 等 Phase A 收尾再展開。

---

## Phase C — EM MVP(palace)

📋 等 Phase B done 才開工。

**前置條件**:
- 🔒 Lab workstation 確認可用(✅ 13700K + 128GB + RTX 4070 Ti)
- 🔒 Workstation 上裝好 palace + Gmsh + MPI
- 🔒 SSH key 設好(目前 dev 機器 `~/.ssh/` 沒 private key)
- 🔒 Workstation 跟 dev 機器網路互通(`~/.ssh/config` 有 `QM` host on 172.30.10.204,確認可達)

---

## Phase D — Optics FDTD(MEEP)

⏭ Phase C 之後才考慮。

---

## Phase E — Electronics Schematic Editor

⏭ Phase B 完成後 polish 階段。

---

## Phase F — Cross-module Dependency + Polishing

⏭ 三個 module 都穩了才做。

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-12 | 架構方向:Workbench-style + 共用 SceneObject + wrap 開源 solver | User 確認 |
| 2026-05-12 | Phase 順序 A→B→C(Electronics 先於 EM) | User 確認;Electronics 工程量小先驗證流程 |
| 2026-05-12 | EM solver = palace(FEM,接近 HFSS) | User 確認;openEMS FDTD 對複雜幾何收斂差 |
| 2026-05-12 | Solver runner:Phase A/B 用 backend container,Phase C 用 lab workstation SSH(兩個 implementation 都做) | User 確認 |
| 2026-05-12 | Cross-module dependency 放 Phase F | User 確認;先單 module 結果可信再串 |
| 2026-05-12 | 不支援 Ansys license / batch | User 確認;全 open source |
| 2026-05-12 | Repo 從 OneDrive 移到 `C:\repos\qmem-digital-twin\` | 避免 .git 同步 corrupt |
| 2026-05-12 | `.claude/` `.codex/` `.agents/` 加進 .gitignore | user-local runtime,workstation 不需要 |

---

## Open Questions / TODO

- [ ] Workstation 上 git clone 一份(Phase C 開工前)
- [ ] SSH key 設定(dev 機器 → workstation,Phase C 用)
- [ ] OneDrive 舊 repo 何時刪(建議:Phase A 第一個 milestone 完成 + 一週)
- [ ] `simulation_runs.scene_snapshot_id` 怎麼實作 immutable snapshot — 是 DB clone 一份,還是 JSON dump 存 blob?(Phase A.1 做時決定)
- [ ] 是否要在 Phase A 就引入 Celery / RQ 等 job queue?還是先用 FastAPI BackgroundTasks?(InProcessRunner 是 in-process async,不需要 queue;後 phase 看需求)
