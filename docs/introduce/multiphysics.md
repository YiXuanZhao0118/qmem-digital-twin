[← 文件索引](README.md)

# 多物理場模組系統

> 時間域演化見 [timing.md](timing.md)；光學模組細節見 [optics.md](optics.md)。

UI 可切換的**模組**（前端 `modules/<name>/`，`modules/_registry.ts` 註冊、`ModuleSwitcher.tsx` 切換，各模組 workspace 內的 Run 按鈕跑求解）。

**Lab tab 兼作 Scene 選單（2026-08-14）**：`status: "available"` 的 tab 會多一個 caret，點擊展開 `.module-tab-menu`（沿用 `.window-menu` 樣式，`ModuleSwitcher.tsx:70` 起），內含原本 `SceneToolbar` "Scene" group 的動作——Initial Setup / PHY Editor；SceneToolbar 只剩 View + Status group。**2026-08-14 後續**：Add text annotation 已從此選單搬回 SceneToolbar 的 View group，做成與 Display overlays 同款的 `.icon-button`（`lucide-react` `Type`，`size=17`），位置在 Display overlays 眼睛鈕**左邊**（`SceneToolbar.tsx:168` 起）。Initial Setup 的開關狀態移到 store（`sceneStore.initialSetupOpen` + `setInitialSetupOpen`），因為觸發點在 ModuleSwitcher 而面板仍由 `SceneToolbar` 繪製。invariant：該面板必須 portal 到 `<body>`（`position: fixed`，`top` 由量測 `.top-bar` 下緣後 inline 指定）——`.top-bar-toolbar` 是 `overflow: hidden`，留在 toolbar 內的絕對定位彈窗會被裁掉（`DisplayPopover` 也是為此才 portal）。

**現行（2026-06-10 之後）只剩 Lab 一個 top-level tab**：

| 模組 | 內容 | 後端求解器 | 函式庫 |
|---|---|---|---|
| **Lab**（唯一 tab） | 主 3D 光學實驗室（預設） | `optics_seq` → v3 anchor tracer | — |
| Magnetics（**Lab 內的 overlay panel**，非獨立 tab） | DC 線圈 / 磁場 | `magnetics_dc` | magpylib v5 Biot-Savart（Helmholtz 已驗證） |

> ⚠️ **已移除的模組（2026-06-10，完整刪除）**：**Optics**（`optics_cavity` 光腔 + `optics_crystal` 非線性晶體）、**Electronics**（`spice` 電路/SPICE）、**EM**（`em_fem` 電磁/天線）三個 tab 整組移除——前端 `modules/{optics_cavity,electronics,em}/` 資料夾刪除、`_registry.ts`／`App.tsx` 對應 import 與分支刪除、後端 solvers（`optics_cavity`/`optics_crystal`/`spice`/`em_fem`）與 routers（`/api/optics-cavity`、`/api/optics-crystal`、`/api/circuits`）刪除、`SimulationModule` enum 只剩 `optics_seq`／`optics_fdtd`／`magnetics_dc`、`circuits` 表與 `rf_chain_nodes.linked_circuit_id` 由 **migration 0109** drop（並清除 `simulation_runs` 殘留列）。**保留**：`em_problems`／`meshes`／`touchstone` 表與 routes、`SshWorkstationRunner` 基建（目前無模組使用）。

**設計原則**：不重做殼，擴充既有 SceneObject 樹 + per-module sidecar 表。

**SolverRunner 抽象**（`solvers/runner.py` Protocol：submit/cancel/status）：`InProcessRunner`（光學，ms 級）、`ContainerRunner`（ngspice/MEEP 子程序）、`SshWorkstationRunner`（palace 跑在實驗室工作站，經 SSH）。`simulation_runs.runner_kind` 記錄分派方式。

**sidecar 表（additive）**：`simulation_runs`(0036)、~~`circuits`(0037)~~（0109 drop）、`em_problems`+`meshes`(0038)、`coils`+`magnetics_problems`(0039)。

**EM 工作站（Phase C，已隨 EM tab 於 2026-06-10 移除；以下為歷史記錄）**：13700K+128GB+RTX4070Ti、Windows+WSL2+Docker Desktop；palace 用 `awslabs/palace` image；流程 SSH→SCP mesh+config.json→`docker run palace`→SCP 回 `port-S.csv`→`palace_io.parse_palace_sparams`。env `WORKSTATION_HOST`/`WORKSTATION_KEY_PATH`/`WORKSTATION_PALACE_IMAGE` 與 `SshWorkstationRunner` 仍在 code 中但已無模組使用。
