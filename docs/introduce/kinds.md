[← 文件索引](README.md)

# Kind 分類與每 kind 契約

> 相關：[optics.md](optics.md)（求解器如何分派 PhysicsOp）、[asset.md](asset.md)（defaultParams 存放處）、[object-sense-kinds.md](../object-sense-kinds.md)。

## Kind 分類（live `kinds.json`：28 kinds）

- **Emitter**：`laser_source`、`tapered_amplifier`。
- **Passive 光學**：`mirror`、`dichroic_mirror`、`lens_biconvex`/`lens_plano_convex`/`lens_cylindrical`、`waveplate`、`polarizer`、`glan_polarizer`、`beam_splitter`(含 PBS)、`fiber`/`fiber_coupler`、`isolator`(複合)、`faraday_rotator`、`aom`、`eom`、`nonlinear_crystal`、`saturable_absorber`。
- **Sink**：`detector`、`camera`、`spectrometer`、`wavemeter`、`beam_dump`。
- **RF kinds**：`rf_source`(AD9959 DDS)、`rf_amplifier`、`rf_cable`、`rf_switch`、`programmable_pulse_generator`(TTL)、`horn_antenna`(sink)。
- 另有 24 個純機械 `passive_plugins`（mount/post/chassis/optical_table…），無物理。

> 注意：`backend/data/kinds.json` 是 kind 物理參數的權威來源；v3 設計文件曾把三種 lens 簡化成單一 `lens`、把 Glan 併入 polarizer，但實際 live 是上述 28 種。`test_kinds_manifest` 期待 30、實際 28，是已知差異。

## 每 kind 契約

每 kind 契約：前端註冊渲染器（`kinds/<kind>/`）+ 後端物理（`optical/kinds/<kind>/physics.py` 的 PhysicsOp）+ `kinds.json` 參數。代表性 defaultParams：laser 780.241nm/50mW；AOM v=4200 m/s、n=2.26、baseEfficiency 0.85；glan_polarizer wedge 38.5°、ER 55dB；TA gain 30dB、sat 500mW。
