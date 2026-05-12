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
**Done:** 2026-05-12(同日完成 — 因為 simulation_runs 表 V2 Phase 1 已建好 + 既有 panel system 可重用)

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
| A.7 | End-to-end smoke test | ✅ | (this commit) | **Two-layer:** (1) vitest unit guard `frontend/src/modules/_registry.test.ts` 守 backend SimulationModule enum vs frontend MODULES drift(top-level vs nested;5 tests pass)。(2) Playwright browser e2e `frontend/e2e/module-switcher.spec.ts`(4 tests pass / 12.0s):top bar 列 3 tabs、Optics 是 Phase A only available、Optics workspace 顯示 SolverConsole + canvas、Electronics → placeholder → 回 Optics round-trip 復原 viewer。POST e2e click 沒測(因為要等 backend reboot 清 zombie + Phase A 的 backend POST 已在 A.1+A.2+A.3 commit 透過 curl 獨立 verified)。新 npm scripts:`test:e2e` + `test:e2e:ui`。 |

### Phase A 完成判準

- 啟動新 stack,瀏覽器看到 top bar 有三個 module(Optics 可選,Electronics/EM 灰掉)
- 切到 Optics → 看到原本完整 viewer + panels
- Run Solver → 後端寫 `simulation_runs` row → solver console 即時看到 progress
- 現有所有光學功能(ray trace、AOM、collection、placement)無 regression
- pytest 通過,vitest 通過
- 切到 Electronics/EM 看到 "Coming in Phase B/C" placeholder

---

## Phase B — Electronics MVP(ngspice)

**Target:** Electronics tab 從 placeholder 變成可用,user 寫 SPICE netlist → POST `/api/simulation-runs {module:'spice'}` → ngspice 跑 → 看 V/I 波形圖。

**Estimate:** 3–4 週(全職)
**Started:** 2026-05-12
**Done:** —

### Sub-tasks

| # | Task | Status | Commit | Notes |
|---|---|---|---|---|
| B.0 | PROGRESS.md kickoff | ✅ | (this commit) | This entry |
| B.1 | Backend: `circuits` schema + alembic 0037 + Pydantic + CRUD | ✅ | (this commit) | id, scene_object_id (nullable FK with ON DELETE SET NULL), name, netlist text, schematic JSONB stub for Phase E。Pydantic CircuitBase / Create / Update / Out。Router /api/circuits 5 endpoints (GET list w/ scene_object_id filter, GET id, POST, PATCH, DELETE)。Curl CRUD verified (201 → list → PATCH → DELETE 204 → 404)。247 pytest 仍 pass。 |
| B.2 | Backend: `solvers/spice.py` adapter(subprocess wrap ngspice)| ✅ | (this commit) | `solvers/spice.py` async run():load Circuit → write netlist temp file → spawn `ngspice -b -r raw -o log netlist.cir`(60s timeout)→ parse rawfile → fill result_summary `{circuitId, circuitName, analysisName, isComplex, variables, pointCount, data, logLineCount}`。binary 跟 ASCII rawfile parser 都 implemented(complex 支援 binary)。MODULE_DISPATCH 註冊 spice。`settings.ngspice_path` 加 config(env var NGSPICE_PATH override)。新 `tests/test_spice_parser.py` 6 tests 全 pass(real / complex / 3 errors / ASCII)。Live POST + dispatch 確認 work(無 ngspice 時 status='failed' + clean error message指 user 裝)。 |
| B.3 | ngspice binary install + Windows portability fixes | ✅ | (this commit) | choco install ngspice -y (admin) → C:\ProgramData\chocolatey\bin\ngspice.exe shim。發現 3 個 Windows-only 問題並修:(1) uvicorn on Windows 預設 SelectorEventLoop 不支援 asyncio subprocess → 改用 sync `subprocess.run` 包進 `loop.run_in_executor`;(2) ngspice on Windows 寫 `Binary:\r\n` not `Binary:\n`,parser 改用 `blob.find` 同時接 4 種 EOL 變體;(3) ngspice 預設 ASCII output,AC 是 complex,parser 加 ASCII complex case (token format `re,im`)。新 2 tests (CRLF + ASCII complex);8/8 parser tests + 247 整 backend pytest 全 pass。**Live e2e RLC band-pass AC sweep:81 frequency points × 6 variables (complex);v(n2) 1.0→0.14→2.5e-5 確實 band-pass 衰減**。 |
| B.4 | Frontend: `ElectronicsWorkspace.tsx` 取代 placeholder | ✅ | (this commit) | `modules/_registry.ts` spice → 'available';新 `modules/electronics/ElectronicsWorkspace.tsx` 三欄 grid (220 / 1fr / 380):circuits sidebar + netlist textarea editor + LATEST RUN result panel。新 `Circuit` / `CircuitCreatePayload` / `CircuitUpdatePayload` types,`fetchCircuitsApi` / `createCircuitApi` / `updateCircuitApi` / `deleteCircuitApi` API helpers,sceneStore `circuits` / `selectedCircuitId` state + `loadCircuits` / `createCircuit` / `updateCircuit` / `deleteCircuit` / `setSelectedCircuit` actions。App.tsx 三 module 條件 (optics_seq / spice / placeholder)。SolverConsole 跨 optics_seq + spice mount。Phase B.4 用 textarea + raw JSON dump;monaco (B.5) + uPlot (B.6) 接續。**Live e2e:Click Electronics → workspace 渲染 → click Run → 4 秒後 LATEST RUN status='completed', AC Analysis, 81 points, complex, 6 variables, RLC band-pass screenshot 確認**。 |
| B.5 | Frontend: monaco netlist editor | ✅ | (this commit) | `npm install @monaco-editor/react monaco-editor`;新 `modules/electronics/NetlistEditor.tsx` 用 `@monaco-editor/react` wrap Monaco。註冊 custom `spice-netlist` language(Monarch tokenizer):line comments `*` / `;`、dot-directives `.AC` `.TRAN` `.control` `.end` ...、component prefixes (V/I/R/L/C/B/D/E/F/G/H/J/K/L/M/N/Q/T/X 等)、engineering-suffix numbers (`1.5m` `4.7n` `100k` `1e-9`)。Editor options:line numbers / no minimap / no word wrap / tab=4 / automaticLayout / monospace。需要 vite.config.ts `resolve.dedupe: ["react","react-dom"]` 否則 @monaco-editor/react 拿 own React instance → "Invalid hook call"。Browser verify:8 lines RLC netlist 渲染、syntax highlight 啟用、無 console errors。 |
| B.6 | Frontend: uPlot waveform viewer + dispatch run | ✅ | (this commit) | `npm install uplot@1.6.32`;新 `modules/electronics/WaveformChart.tsx` 接 `ResultData {variables, isComplex, data}` → uPlot canvas line chart。第一個 variable = X 軸(frequency / time / sweep param 自動),其他 = Y series。Complex 值 reduce 成 magnitude `sqrt(re²+im²)`。X 軸 var 名為 'frequency' 時 auto log10 scale。Per-series 顏色 + click-toggle legend。ResizeObserver 跟 container 同步。**Browser verify:RLC AC sweep 顯示 log-frequency axis 100→1M Hz,藍 v(in)=1V 平、紅 v(n2) 5 kHz LC 共振 notch、綠 v(n1) 中段 dip,5 個 legend items 可 toggle**。Raw JSON dump 保留為 collapsed `<details>` debug fallback。 |
| B.7 | (optional) scikit-rf S-parameter / Smith chart | 📋 | — | Phase B polish;先標 optional |
| B.8 | Playwright e2e for spice run round-trip | 📋 | — | RLC netlist → run → waveform 出現 |

### Phase B 完成判準

- 切 Electronics tab → 看到 netlist editor + waveform viewer(不是 placeholder)
- 寫 RLC 共振 netlist 點 Run → 30 秒內看到 V/I 波形圖
- POST `/api/simulation-runs {module:'spice'}` 不再返回 501
- circuits 表 CRUD 全 work(create / list / load / update / delete)
- pytest 通過,新 spice solver 有單元測試
- vitest 通過,新 ElectronicsWorkspace 有 component test
- Playwright e2e:寫 netlist → run → waveform appears

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
