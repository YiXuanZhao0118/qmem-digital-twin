[← 文件索引](README.md)

# Kind 分類與每 kind 契約

> 相關：[optics.md](optics.md)（求解器如何分派 PhysicsOp）、[asset.md](asset.md)（defaultParams 存放處）、[object-sense-kinds.md](../object-sense-kinds.md)。

## Kind 分類（live `kinds.json` `element_kinds`：29）

- **Emitter**：`laser_source`、`tapered_amplifier`。
- **Passive 光學**：`mirror`、`dichroic_mirror`、`lens_biconvex`/`lens_plano_convex`/`lens_cylindrical`、`waveplate`、`polarizer`、`glan_polarizer`、`beam_splitter`(含 PBS)、`fiber`/`fiber_coupler`、`isolator`(複合)、`faraday_rotator`、`aom`、`eom`、`nonlinear_crystal`、`saturable_absorber`。
- **Sink**：`detector`、`camera`、`spectrometer`、`wavemeter`、`beam_dump`。
- **RF kinds**：`rf_source`(AD9959 DDS)、`rf_amplifier`、`rf_cable`、`rf_switch`、`programmable_pulse_generator`(TTL)、`horn_antenna`(sink)。
- 另有 24 個純機械 `passive_plugins`（mount/post/chassis/optical_table…），無物理。

> 注意：`backend/data/kinds.json` 是 kind 物理參數的權威來源；v3 設計文件曾把三種 lens 簡化成單一 `lens`、把 Glan 併入 polarizer，但實際 live `element_kinds` 為 29。`test_kinds_manifest` 與實際數可能有差異（已知）。

## Domain 與 Category（兩條獨立的軸）

兩者都「只是分類」，但分屬不同層、來源不同 kind，**互不覆蓋**：

| 軸 | 屬於 | 來源 | 用途 |
|---|---|---|---|
| **Domain**（物理行為） | **Asset3D** 層 | `Asset3D.kind_id` → `kind.domains` | 跑什麼物理、PHY Editor domain rail、kind 篩選 |
| **Category**（目錄分類） | **Component** 層 | `Component.kind_id` → plugin `assetCategory` | 在零件庫的哪個區段 |

- **Domain**：正規值只有 `optical` / `rf` / `mechanical`（DB `kinds.domains`，CHECK `<@ {optical,rf,mechanical}` + cardinality≥1，`models/hardware.py`）。**kind-authoritative**；asset 的 `properties.domains` 只能**收窄**（與 kind.domains 取交集）。另有 `primary_domain`（單一主 domain）、`default_physics`（會跑哪些求解，可含 thermal 等）、`port_domains`（per-port，給 AOM 這類 hybrid）。
- **Category**：kind plugin 的 `assetCategory`（粗區：Optical / Electronics & RF / Mounts & Mechanics / Workspace / Annotations / Uncategorized）+ `catalogGroup`（細組：Emitters / Passive / Active·Nonlinear / Sinks / RF…）。零件庫面板 `categoryForComponent`（`AssetLibraryPanel.tsx`）由 **component 的 kind** 決定；**2026-06-10 起與 domain 解耦**——不再讓 `physicsCapabilities` 蓋過 category。

→ 一句話：**Category 由 component 的 kind 決定、Domain 由 asset 的 kind 決定**，兩者本就不同步（見 [component.md](component.md)、[asset.md](asset.md)），也互不覆蓋。

## 每 kind 契約

每 kind 契約：前端註冊渲染器（`kinds/<kind>/`）+ 後端物理（**live：`optical/anchor_ops/<kind>.py` 的 anchor op**；face-based `optical/kinds/<kind>/physics.py` 已退役）+ `kinds.json` 參數。代表性 defaultParams：laser 780.241nm/50mW；AOM v=4200 m/s、n=2.26、baseEfficiency 0.85；glan_polarizer wedge 38.5°、ER 55dB；TA gain 30dB、sat 500mW。
