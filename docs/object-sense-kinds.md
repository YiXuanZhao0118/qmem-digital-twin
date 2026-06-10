# Object Sense — 所有 kinds 與其運行方式（整合參考）

> 本檔盤點 **29 個 physics kinds** 在 **Object Sense**（主 3D 視埠 `DigitalTwinViewer` 的渲染 + 後端 v3 anchor trace 畫光束）裡「怎麼被畫出來」與「怎麼作用在光束上」。
> 由多 agent 掃描全程式碼產生、再經獨立 critic 逐項對照原始碼校驗（confidence: high）。最後整理：2026-06-10。
> 權威來源：`backend/data/kinds.json`（kind 參數）、`backend/app/optical/anchor_ops/`（trace op）、`frontend/src/three/loadAsset/`（渲染）。

---

## 0. Object Sense 管線（一次看懂）

**渲染 dispatch**（`DigitalTwinViewer.tsx` → `three/loadAsset/index.ts`）：每個 SceneObject 先由 `shouldRenderViaBindings()` 決定走 **binding-tree**（複合元件，如 isolator）或 **legacy 單一資產** `loadAssetObject`。`loadAssetObject` dispatch 順序：
`optical_table` → `kindId==="fiber"`（spline）→ `rf_cable/sma_cable`（spline）→ `procedural://isolator_body` → `procedural://glan_polarizer_prism` → **`primitive://` 或無資產**（依 `component.kindId` 查 `pluginForComponentType().renderer`，無則 100×100×80 灰盒）→ **副檔名**（`.stl/.glb/.gltf/.obj`）。STL 特例 builder：BB1E03、WPHSM05、PBS252、AD9959、isolator。顏色 `colorForComponent`：裝置狀態著色 → `properties.colorHex` → `switch(kindId)` 色表 → 預設 slate `#64748b`。

**Trace 管線**（`backend/app/optical/anchor_tracer.py` `trace_ray_anchor_scene`）：BFS。每條 ray 找 `nearest_anchor_hit`（只認 **PRIMARY_ANCHOR_IDS** = `intercept_in`/`intercept_out`/`intercept_face`/`interaction_center`/`optical_center`）→ `get_anchor_op(kind)` 查表分派（**無 `switch(kind)`**；查無 op → 當 sink）→ ray lab→body、補自由空間 q 傳播 → `op(BeamRay, ctx)` 回傳 out rays → body→lab、push 回 queue。**Sink 回 `[]`**（光束終止）；**分支 op 回 ≥2 條**（PBS、AOM 階）。`solver.solve_anchor_scene`：先 seeded emit pass，再 TA ASE pass。

**參數合併**（later wins）：`asset.default_params` ← `dynamic_sources`(properties) ← `param_overrides[binding]` ← **`rf_drive`（後端 `rf_resolve.hydrate_aom_rf_drive` 解析）** ← request `dynamic_overrides`。

**輸出回視埠**：`labSegments[]` → `three/v3TraceAdapter.ts` → `window.__rayTraceDebug` → `renderRayTraces()` 用 `THREE.Line` 依波長著色畫出。

**Anchor-op 註冊**（`anchor_ops/__init__.py` import 時 `register_anchor_op`）；`laser_source`/`tapered_amplifier(ASE)` 是 solver 的 **emitter**，不在 BFS 分派表。

---

## 1. 主表（29 kinds）

| kind | 類別 | trace 角色 | primary anchor | anchor op | 對光束的作用（摘要） | 狀態 |
|---|---|---|---|---|---|---|
| **laser_source** | emitter | emit | intercept_out | `emit_laser_source.py` | 每個 intercept_out 發 1 條 ray；波長/功率/偏振/腰寬由 dynamic→default 決定，Jones 參考 anchor axisY | full |
| **tapered_amplifier** | emitter | passthrough + ASE | intercept_in/out | `misc_ops.tapered_amplifier_anchor_op` + `emit_ta_ase_rays` | 種子放大四因素（TE 偏振×模態重疊×增益飽和×driver）；無種子時雙向發 ASE | ⚠ partial |
| **mirror** | passive | passthrough | intercept_face | `mirror.py:mirror_anchor_op` | 反射（flip 傳播）、Jones r_s=+1/r_p=−1 翻手徵、×reflectivity 0.99；**平面鏡，無聚焦** | full |
| **dichroic_mirror** | passive | passthrough | intercept_face | （同 mirror op）| **與 mirror 完全相同**；×0.95，**無波長分光**（cutoff/passband 失效） | ⚠ partial |
| **lens_biconvex** | passive | passthrough | intercept_in | `lens.py:lens_anchor_op` | 球面薄透鏡 ABCD 雙軸：θ′=θ−offset/f、q′=q/(1−q/f)，f=focalLengthMm 100 | full |
| **lens_plano_convex** | passive | passthrough | intercept_in | （同 lens op）| **與 biconvex 數學相同**（不分平凸非對稱） | full |
| **lens_cylindrical** | passive | passthrough | intercept_in | `lens.py:lens_cylindrical_op` | **只在 axisY 聚焦**，axisZ 穿透 → 產生像散；只更新 qx | full |
| **waveplate** | passive | passthrough | intercept_in | `waveplate.py:waveplate_anchor_op` | 快慢軸 Jones retardance（預設 180° HWP）；快軸=anchor axisY+per-object fastAxisDeg | full |
| **polarizer** | passive | passthrough | intercept_in | `polarizer.py:polarizer_anchor_op` | 衰減 jones[1]（阻擋軸）by 消光比，×Malus 功率；**不讀 transmissionAxis 角** | ⚠ partial |
| **glan_polarizer** | passive | passthrough | intercept_in | （同 polarizer op）| 同 polarizer（消光比 55dB）；**無 TIR 側向排斥光、無入射角曲線** | ⚠ partial |
| **faraday_rotator** | passive | passthrough | optical_center | `misc_ops.faraday_anchor_op` | 固定角 45° 非互易 Jones 旋轉（回程不抵銷）；多半在 isolator binding tree 內 | full |
| **beam_splitter** | passive | **branch** | intercept_face | `pbs.py:pbs_anchor_op` | 依入射 Jones 分 2 條：p 穿透 + s 反射；**忽略 polarizing 旗標**（50/50 非偏振 BS 被誤當 PBS） | ⚠ partial |
| **aom** | active | **branch** | interaction_center | `aom.py:aom_anchor_op` | Bragg：依 RF freq/power 分多個繞射階，每階 freq_offset+=m·f_RF；無 RF→0 階直穿。**Hybrid：RF sink** | full |
| **eom** | active | passthrough | intercept_in | `misc_ops.eom_anchor_op` | 由 driveVoltageV 算 δ=π·V/Vπ 的 Jones 相位；**只相位、無 sideband、不接 RF graph** | ⚠ partial |
| **nonlinear_crystal** | active | passthrough | intercept_in | `misc_ops.nonlinear_crystal_op` | **純 slab 穿透 stub**，無 SHG/轉換 | 🔴 stub |
| **saturable_absorber** | active | passthrough | intercept_in | `misc_ops.saturable_absorber_op` | 強度相依透過率 T；**參數 key 全錯位 → 永遠用 op 預設** | 🔴 stub |
| **detector** | sink | sink | intercept_in | `misc_ops._terminal_sink_op` | 回 `[]` 吸收，無 responsivity/讀數 | sink-only |
| **camera** | sink | sink | intercept_in | `_terminal_sink_op` | 同上，無成像模型 | sink-only |
| **spectrometer** | sink | sink | intercept_in | `_terminal_sink_op` | 同上，**不讀 wavelengthNm** | sink-only |
| **wavemeter** | sink | sink | intercept_in | `_terminal_sink_op` | 同上，無量測輸出 | sink-only |
| **beam_dump** | sink | sink | intercept_in | `_terminal_sink_op` | 標準終止；宣告 thermal 但無熱負載模型 | sink-only |
| **rf_source** | rf | not-ray-traced | rf_out (CH0–3) | `rf_resolve.build_rf_propagation` (seed) | RF graph 種子：每 rf_out 發 RfSignal（channels[] 或預設 80MHz/amp1.0），vpp=amp×1.0V | full |
| **rf_amplifier** | rf | not-ray-traced | rf_in/rf_out | `rf_resolve._rf_amplifier_transfer` | 線性增益 ×10^(gainDb/20) + outputPowerMaxDbm 硬 clamp（saturated 旗標） | full |
| **rf_switch** | rf | not-ray-traced | rf_in/RF1/RF2/ttl_in | `rf_resolve._rf_switch_transfer` | TTL 路由：throw 由上游 PPG TimingProgram 在 scrub 時刻取樣決定 + 插入損耗 | full |
| **rf_cable** | rf | not-ray-traced | rf_in/rf_out | `rf_resolve._read_cables`（**edge**）| **不是節點，是 graph 邊**：從 rfCableEndpoints 建無向鄰接，**無損耗複製** | ⚠ partial |
| **programmable_pulse_generator** | rf | not-ray-traced | rf_out (TTL) | `rf_resolve` TTL pre-pass | **不帶載波**：以 TimingProgram 區間在 scrub 時刻 gate rf_switch 路由 | ⚠ partial |
| **horn_antenna** | rf | not-ray-traced | aperture | **無**（未註冊） | **完全惰性**：未註冊 sink、不在 RF graph、無 renderer | 🔴 stub |
| **fiber** | passive/光 | passthrough | intercept_in/out | `fiber.py:fiber_anchor_op` | 雙埠 Marcuse 耦合（模態重疊×Fresnel×衰減），出口重設基模 q；**參數 key 錯位 + 無 PM/彎損** | ⚠ partial |
| **fiber_coupler** | passive/光 | **sink** | intercept_in | （同 fiber op）| **只有 intercept_in → 找不到另一端 → 回 `[]` 變成 sink**；couplingEfficiency 無效 | 🔴 stub |

狀態圖例：**full** 物理可用 ｜ **⚠ partial** 能跑但有重大簡化/缺漏 ｜ **🔴 stub** 形同未實作 ｜ **sink-only** 設計上就是終止。

---

## 2. Object Sense 渲染對照（怎麼被畫出來）

| kind | 渲染路徑 | 顏色/材質 |
|---|---|---|
| laser_source | primitive→`renderLaser` 260×90×80 盒 | ⚠ kindId 落預設灰（只有 legacy `laser` 是 teal） |
| tapered_amplifier | primitive→`createTaperedAmplifier`（Boosta Pro 或程序晶片）| 材質硬寫（銅鰭+陶瓷+金錐） |
| mirror | STL：`buildBB1E03MirrorObject`（粉色鍍膜+綠玻璃）否則 generic | `mirror`→`#c4b5fd` |
| dichroic_mirror | 同 mirror dispatch（無專屬 builder）| ⚠ 無色表 case→預設灰 |
| lens_* | **無特例 builder**，依副檔名載入資產或 generic 盒 | ⚠ 只有 `lens` 是藍；`lens_biconvex/...`→預設灰 |
| waveplate | STL：`buildWphsm05WaveplateObject`（黑陽極座+綠玻片）| 黑陽極氧化 |
| polarizer | 無特例→generic | ⚠ 預設灰 |
| glan_polarizer | `procedural://glan_polarizer_prism`（兩塊方解石稜鏡+氣隙）| 晶體材質 |
| faraday_rotator | 多半在 isolator binding tree 內 | （isolator 殼主導） |
| beam_splitter | STL：`buildPbs252BeamSplitterObject`（清/霜玻璃+對角虹彩）否則 generic | ⚠ generic→預設灰 |
| aom | primitive→`createAom`（AA MT80 程序模型）| `aom`→琥珀 `#f59e0b` |
| eom | ⚠ 無 renderer → **generic 灰盒** | `eom`→`#e879f9`（僅盒色） |
| nonlinear_crystal / saturable_absorber | ⚠ 無 renderer → generic 灰盒 | 預設灰 |
| detector/camera/spectrometer/wavemeter/beam_dump | ⚠ 無 renderer → generic 灰盒 | 預設灰 |
| rf_source | STL：`buildAd9959PcbObject` 或 primitive→`createDdsAd9959Pcb`（綠 PCB+4 SMA）| DDS 材質 |
| rf_amplifier | primitive→`renderRfAmplifier`（ZHL 模型/generic）| **熱著色**：>45°C 紅 |
| rf_switch | primitive→`createRfSwitch`（ZYSWA 4 連接器）| `#c8ccd0` |
| rf_cable | early branch→`createSmaShortCable`（Bezier spline）| `#c4a884` 棕 |
| programmable_pulse_generator | ⚠ 無 renderer → generic 灰盒 | 預設灰 |
| horn_antenna | ⚠ 無 renderer → generic 灰盒（承諾的 cos^n lobe 未接）| 預設灰 |
| fiber | early branch `kindId==="fiber"`→`createFiberSplineObject`（TubeGeometry+FC ferrule）| 依 fiberType：PM 藍/SM 黃/MM 橘 |
| fiber_coupler | 無特例→generic 灰盒 | 預設灰 |

---

## 3. 可「整合」的系統性議題（跨 kind 的共通病）

盤點時反覆出現、值得用「一次整合」處理的橫向問題：

**A. 參數合約漂移（最普遍、影響最大）** — 多個 op 讀的 key 與 `kinds.json` default_params 對不上，導致 panel/型錄的數值**永遠到不了 trace**，op 默默用 hardcode 預設：
- `tapered_amplifier`：ASE op 讀 `aseForwardMw/aseBackwardMw`，kinds.json 卻是 `ase.{powerMw,...}` → **未種子的 TA 實際發 0 ASE**（最嚴重）。
- `fiber`：op 讀 `coreMfdUm/attenuationDbPerKm/lengthM`，kinds.json 是 `endA/endB.modeFieldDiameterUm` + `attenuationCurve[]` → 衰減/MFD 編輯無效。
- `saturable_absorber`：op 讀 `smallSignalTransmittance/...`，kinds.json 是 `saturationIntensityWPerCm2/modulationDepth/...` → 全部失效。
- `nonlinear_crystal`：op 預設 lengthMm=1.0，型錄種 10。
- `lens_*`：op 讀 `focalLengthMm`，Object panel 寫 `focalMm` → 焦距編輯不入 trace。
→ **整合方向**：每 kind 一份 canonical key 對照 + 啟動時的 param-contract 驗證（key ⊆ op 讀取集）。

**B. 平行的 legacy 物理（`kinds/<kind>/physics.py` + `registry.py`）未在 v3 路徑** — waveplate/polarizer/faraday/glan_laser/fiber 都還有一份 `register_kind` 的舊 op，但 `anchor_tracer` 從不 import `app.optical.registry`。功能重複、易誤導。→ **這就是計畫 H4（退役死碼）。**

**C. 顏色表 / renderer 覆蓋不全** — `colorForComponent` 的 `switch(kindId)` 只涵蓋一部分，多數 kindId 落預設灰（laser_source、三種 lens、dichroic、polarizer、faraday、beam_splitter…）；多個 kind 無程序 renderer → generic 灰盒（eom、nonlinear、saturable、五個 sink、PPG、horn、fiber_coupler）。→ **整合方向**：補齊色表 + 一張 kind→視覺 registry。

**D. 宣告了卻沒實作的物理（kind 承諾 ≠ trace 行為）** — dichroic 波長分光、glan TIR 排斥、beam_splitter polarizing 旗標/分光比、polarizer 任意角、eom 振幅/sideband、nonlinear 轉換、saturable 動態、sink 量測讀數、rf_cable 損耗、horn 輻射。→ **這是 Phase E（能力擴充）backlog。**

**E. anchor 合約與 op 需求不符** — `beam_splitter` kind 模板沒有 op 需要的 `intercept_face`（靠資產自帶）；`fiber_coupler` 只有 `intercept_in` → 退化成 sink；glan 的 `intercept_out` 不在 PRIMARY 集。→ **整合方向**：對齊 kind anchor 合約與 op 實際 dispatch 的 anchor。

**F. 過時 docstring（行為對、註解錯）** — mirror 寫 `reflection_surface`（實為 intercept_face）、lens 寫 `optical_center`（實為 intercept_in）、emit 寫 `emit_point`（實為 intercept_out）、misc_ops 寫「backward ASE 未實作」（實已雙向）、fiber 寫 `tip_a/tip_b`。→ **docstring sweep。**

**G. horn_antenna 完全惰性** — 既未註冊為 sink（`get_anchor_op` 回 None）、也不在 RF graph、也無 renderer。RF 鏈若終止於 horn 等於懸空。→ 需決定：接成真正的 RF load，或標記為純佔位。

---

## 附：核心檔案

- Trace：`backend/app/optical/anchor_tracer.py`、`solver.py`、`anchor_ops/{mirror,lens,waveplate,polarizer,pbs,aom,fiber,misc_ops,emit_laser_source}.py`、`aom_physics.py`、`rf_resolve.py`
- 渲染：`frontend/src/three/loadAsset/index.ts`、`loadAsset/stl_builders/*`、`loadAsset/materials.ts`、`kinds/_renderer_bindings.ts`、各 `kinds/<kind>/renderer.ts`
- 參數：`backend/data/kinds.json`（physics_plugins[].default_params）
