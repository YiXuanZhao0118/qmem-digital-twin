[← 文件索引](README.md)

# 光學物理模型

> Kind 清單見 [kinds.md](kinds.md)；座標 / anchor 法向見 [anchors.md](anchors.md)；AOM 對準幾何另見 [aom-model.md](../aom-model.md) + `../aom_align_*.png`。

## 偏振

以 **Jones calculus** 追蹤（`optical/jones.ts`）。各 kind 套自己的 Jones：waveplate retardance、polarizer 投影、PBS 分光（face 慣例 `face_1..6` = ±X/±Y/±Z，`H_transmit_V_reflect`）。

## 求解器：anchor-centric ray tracer（現行）

- **Kind Registry**（alembic 0086）：DB `kinds` 表存 metadata（name、domain、`op_set_name`、default_params、needs_aperture、wavelength_range_nm）；**code 端 REGISTRY 存 op callable**，由 `op_set_name` 連結。新 kind 可在 UI 用既有 op 建立。
- **Live：anchor tracer**（`anchor_tracer.py`，Phase 9.2）：單一迴圈，**沒有 `switch(kind)`**——靠每 kind 的 **anchor op** 查表分派（`anchor_ops/<kind>.py`，以 `register_anchor_op(kind, op)` 註冊）。op ≈ `(rayIn, in_anchor, out_anchor, params, dynamic?) => BeamRay[]`，回傳陣列以支援分支（AOM 階數、PBS 穿透+反射、ghost）。`BeamRay` 帶 chief ray + 獨立 qx/qy（像散）+ Jones s/p。命中用 ray-plane（過 `anchor.position`、垂直 `axisX`）+ aperture 裁切（見 [anchors.md](anchors.md)）。
- **Legacy（已退役）**：舊的 **face-based** dispatch（`ray_tracer.py` 的 `PhysicsOp(rayIn, faceIn, faceOut)`）在 **0106 drop faces/transitions** 後被 anchor-based 取代。
- **AOM Bragg**：`theta_B = asin(λ·f_rf / (2·v_acoustic))`、`theta_deflect(order) = order·2·theta_B`（外角慣例）。

## 求解器現況（重要）

- **後端 anchor 求解器**（`anchor_tracer.py` + `solver.py` 的 `solve_anchor_scene`，端點 `/api/v3/solver`、DB 載入 `db_scene_loader.load_anchor_scene_from_db`）是**唯一權威光學引擎**。實驗室看到的光束 = 後端 anchor trace。
- 舊的 legacy chain solver（`optical_solver.py` + `rf_propagation.py` + `optics_seq` 的 solve_chain）已於 Phase 1（migration ~0094 期）**刪除**；Lab「Run」按鈕現在也走此引擎。RF 的圖傳播現由 `rf_resolve.py` 負責（見 [cable.md](cable.md)）。
- 前端 `optical/` 的 TypeScript 光追引擎（`ray-tracer-v3.ts` 等，**face-based**）是**平行、尚未上線**的實作，目前只被 vitest 引用、main.tsx 到不了，但有完整 parity 測試 + golden fixtures——**勿當廢案刪**。

## 雷射源發射與高斯傳播（emit_laser_source.py）

emitter 不等入射光，主動種出初始 `BeamRay`（`emit_anchor_source_rays`）。beam propagation 由 **複數 q 參數**（per-axis `qx`/`qy`，支援像散）+ **embedded-Gaussian** 法控制。`laser_source` defaultParams（可被 `SceneObject.dynamic_sources` per-instance 覆寫）：

- `centerWavelengthNm`（λ）、`nominalPowerMw`（P）、`polarization`（Jones，在 anchor axisY/axisZ 基底）。
- `spatialModeX/Y.waistUm`（束腰 w₀）、`.mSquared`（M²）、`.waistZOffsetMm`（束腰沿 +axisX 的位置偏移）。
- `transverseModeType`(`"HG"`/`"LG"`) + `mode_index_1`/`mode_index_2`（HG=m/n；LG=p/l）。

**理論（embedded-Gaussian，`emit_laser_source._q_at_waist_mm`）**：
- 種光 `q₀ = -z_offset + i·z_R`，**`z_R = π·w₀²/(M²·λ)`** —— q 帶的是「embedded 基模」，其發散已被 M² 放大（遠場半角 `θ = M²λ/(πw₀)`），自動沿每個 ABCD op 正確傳播（lens `1/q'=1/q−1/f`、自由空間 `q+z`）。
- **真實橫向寬度 = (q 推導的 embedded 寬度) × `BeamRay.width_mult`**，其中 `width_mult = √(M²) × 模態因子`（LG：兩軸 `√(2p+|l|+1)`；HG：x=`√(2m+1)`、y=`√(2n+1)`）。`width_mult_x/y` 隨 ray 沿 `.replaced()` 傳播，經 `LabSegment.width_mult_*_at_start` → solver `to_dict` 的 `widthMultAtStart` → 前端 `v3TraceAdapter` **各軸獨立**還原寬度（X←qx、Y←qy；2026-06-11 起 `beamMode.x/.y` + `waistAtStart/EndUm{,Y}` 皆 per-axis，先前 y 誤用 qx → 永遠圓）；TA mode-match（`misc_ops._mode_match_eta`）也乘此倍率。**像散渲染**：2D beam-scope profile + 3D optical-link **橢圓錐管**都吃這對 per-axis 寬度（見 [rendering.md](rendering.md)）。
- **限制**：高階模態在此幾何錐管裡**只放大等效寬度，不畫 donut/lobe 形狀**（真正環形需 2D 複振幅波動場，本引擎不含）。`waistZOffsetMm` 透過 `Re(q)` 自然流到前端，無需前端改動。

**非近軸發散修正（高 NA / 次波長束腰）**：q-ABCD 是近軸（`z_R=πw₀²/(M²λ)`），當 `w₀→λ`（光纖端面、緊聚焦）發散會失準。做法：**q 維持近軸**（chief ray + 透鏡聚焦不變），只在**寬度 readout** 套修正——
- `s = M²λ/(πw₀)`（近軸發散參數 = sinθ，rigorous）；**繞射硬下限 `s≤1` ⇔ `w₀≥M²λ/π`（NA=1）**，`s>1` 為倏逝、clamp 並標 past-limit。
- 遠場用 `z_R_eff = z_R·√(1−s²)`（遠場斜率→`tan(arcsin s)`）；低 NA（s≪1）→ `z_R_eff≈z_R` 完全回到近軸。
- helper：`beam_ray.nonparaxial_fundamental_waist_mm`（後端）/ `v3TraceAdapter.nonparaxialFundamentalWaistUm`（前端，同公式）。**M² 需在 readout 取得**，故 `m2x/m2y` 與 `width_mult` 一起沿 ray→`LabSegment`→`to_dict`(`m2AtStart`)→前端傳遞；`mode_factor=width_mult/√M²`。套用點：optical-link 錐管寬度、TA mode-match（`misc_ops._mode_match_eta`）。
- **fiber mode-match** 之後接同一個 helper（同樣的高 NA 問題、同樣的解）。

## 透鏡與通光孔徑能量截斷（POP Stage 1，2026-06-11）

透鏡 op `anchor_ops/lens.py`（`lens`/`lens_biconvex`/`lens_plano_convex`/`lens_cylindrical`）除了 `1/q'=1/q−1/f` 的 ABCD，現在還對 `power_mw` 套兩個衰減因子（`_lens_power_factor`，`lens.py:44`）：

- **通光孔徑裁切**：chief ray 在 `optical_center` 必過光軸，故光斑比 `anchor.aperture_mm`（半徑）寬時邊緣被擋。能量穿透率用 on-axis 高斯封閉解 **`T_ap = 1 − exp(−2a²/w²)`**，`w = √(wx·wy)`、`a = anchor.aperture_mm`。
- **鍍膜穿透率**：`default_params.transmittance`（缺省 1.0），AR/Fresnel 損耗。
- `power_out = P_in · T_ap · transmittance`。**唯一真值來源** `optical/aperture.py`（`gaussian_circular_aperture_fraction` + `gaussian_width_mm`），前端 `profileUtils.ts` 同公式；tracer 與 op 都呼叫它，永不分歧。
- **向後相容**：無 aperture（`apertureMm=0`）或無 transmittance 的舊透鏡資產 → 因子 1.0，功率不變；一般細光束（w≪a）→ `T_ap≈1`。

**顯示**：tracer 在「進入透鏡」那段 `LabSegment.aperture_truncation`（`anchor_tracer.py`，僅 `LENS_KINDS` + `aperture_mm>0`）記 `{apertureMm, wEffMm, transmittedFraction, transmittance, combinedFraction}` → `solver.to_dict` 的 `apertureTruncation` → `v3TraceAdapter` → BeamScopePanel 顯示「Aperture: X% through」。**注意**：descriptor 在「進入」段（功率為截斷前）；實際功率下降反映在透鏡**下游**段的 `power_mw`（自動經 `nominalPowerMwAtSource` 流到 scope 的 `P` 讀數）。

- **這是能量半**：同一個截斷產生的**繞射環（Airy）圖樣**屬波動場，q-引擎不畫（見上「限制」）；繞射 *pattern* 由獨立的 **POP 場通道**處理（見下），3D 場景光束仍為高斯錐。偏振/RF/AOM/fiber 一律留在 q 通道。
- **A230TM-B**（Thorlabs 非球面，`kind=lens_plano_convex`）：`default_params.focalLengthMm=4.51`（op 讀此 key，**非** Object 面板的 `focalMm`）、`clearApertureMm=4.95`、`transmittance=0.995`；intercept anchor 的 `apertureMm=2.475`（=clearAperture/2，半徑）。

## POP 場通道：透鏡焦平面繞射（Stage 2，2026-06-11）

**標量 2D 複數場引擎**，與 q-tracer **平行並存、不取代**。把被有限通光孔徑截斷的光束 → 焦平面 **Airy 繞射環**（q 通道畫不出的東西）。

- **引擎** `optical/pop_field.py`：`PopField`（N×N complex numpy 場 + pitch + λ）。運算子 `seed_gaussian`/`seed_plane_wave`、`apply_circular_aperture`（硬截斷→種繞射）、`apply_thin_lens`（`exp(−i k r²/2f)`）、`propagate_asm`（**角譜法**自由空間傳播，近/遠場皆精確、evanescent 歸零）、`focal_plane`（透鏡 = 前焦面到後焦面的精確傅立葉變換，輸出 pitch=`λf/(N·pitch_in)`，均勻圓孔→Airy 首零 `1.22λf/D`）、`radial_profile`、`downsample_intensity`（**中心裁切**到 k·out_n 再 block-average → 軸心留在輸出中央；角落裁切會把 Airy peak 移位，這是實作過的 bug）。
- **橋接** `optical/pop_pass.py`：`lens_focal_airy_pattern(w_at_lens_mm, aperture_mm, f_mm, wavelength_nm)`。幾何（透鏡處光束半徑 w、孔徑半徑 a、焦距 f）**由 q 通道供給、不在此重算**（前端 `gaussianWidthMm(q)` 已知 w）。流程：在透鏡處種 w 寬高斯 → 孔徑硬截斷 → `focal_plane(f)` → 裁到 ±6 Airy 零點 → 降採樣。回傳 `{size, halfExtentUm, pitchUm, firstNullUm, clipFraction, intensity[peak-normalized], diffractionLimited}`。v1 限制：入射平相位（忽略入射波前曲率，環主要由截斷產生）、單透鏡焦平面視圖。
- **端點** `POST /api/v3/pop`（`routers/pop.py`，**on-demand 專用**，絕不進 `/api/v3/solver` live trace）：body `{wAtLensUm, apertureMm, focalLengthMm, wavelengthNm, gridN?, outN?}` → 上述 payload。前端在 beam-scope 探測截斷透鏡下游時呼叫。
- **物理驗證**（`tests/optical/test_pop_field.py` + `test_pop_pass.py`）：圓孔焦面 = Airy（首零在 `1.22λf/D` 8% 內 + 確認有環）、自由空間高斯 `w(zR)=w0√2`（6% 內）、高斯過孔徑能量比 = Stage 1 `1−exp(−2a²/w²)`（3% 內）。Live A230TM-B 端點徑向切面確認中央亮斑→暗環→次環。
- **Stage 3 — DONE 2026-06-11**：`BeamScopePanel` 在探測截斷透鏡下游時,找出該透鏡的 `apertureTruncation`(含 `focalLengthMm`)→ 呼叫 `POST /api/v3/pop` → 雙線性取樣回傳的強度網格餵進現有 `Heatmap`（取代解析 `sampleIntensity`），標題標「diffraction (POP) · focal plane」。幾何（透鏡處光束半徑 w、孔徑、焦距、λ）全來自 q 通道的 segment descriptor。
- **尚未做**：偵測器影像面、astigmatic POP 場（v1 種圓形 `w_eff`，焦面 Airy 由圓孔主導本就近圓）、入射波前曲率、**任意下游平面**（option B：會聚透鏡的環只在焦點 ±景深~3µm 內存在,離焦處是平滑光斑;且 mm 尺度近場 + 孔徑/焦斑~3000× 比例是硬取樣問題 → 暫不做）。

## RF tracer

RF **不是** ray tracer——沒有波前/Jones/q。它在 port 鄰接圖上做 **graph BFS**，攜帶 `RfSignalState{frequencyMhz, vpp, cumulativeGainDb, saturated, …}`。常數 `AD9959_VPP_FULL_SCALE=1.0V`、`RF_LOAD_Z=50Ω`、`P=Vpp²/(8Z)`。AOM 是**hybrid**——同時是 ray tracer 的光學元件與 RF tracer 的 RF sink；RF 經 BFS 灌到 `signalAtPort[(aom,"rf_in")]`，AOM RF 設定值優先序：**dynamicSources（手動）> RF tracer > defaultParams.centerFreqMhz**。RF 鏈的時序面（AD9959 通道、PPG）見 [timing.md](timing.md)。

## Tapered Amplifier（設計鎖定 2026-05-31，四因素模型 2026-06-01）

半導體增益晶片，種子放大。鎖定：forward A→B only；ASE 僅在無種子時發射（option 6b）。Op 在 `anchor_ops/misc_ops.py`（`tapered_amplifier_anchor_op`），代表資產 `toptica_boosta_pro`（face A 種子 −z / B 輸出 +z）。

**Gain 軸 = anchor `axisY`**（取代舊的 `gainAxisDegBodyLocal` 角度參數）：兩個面 `intercept_in` / `intercept_out` 都標 `needsFastAxis`，axisY 在 PHY Editor 可編輯。放大量由四個物理因素決定，耦合功率 `P_coupled = P_in · frac_TE · η_mode`：

1. **偏振（TE 選擇定則）**：`_jones_in_axis_basis()` 把入射 Jones 轉到 anchor (axisY, axisZ) 基底，`frac_TE = |E_axisY|²/|E|²`。只有 TE（∥axisY）被放大，TM 幾乎零增益；輸出沿 axisY 線偏振 + 有限消光（`polarizationExtinctionDb`）。
2. **Seed 光強度（增益飽和）**：`P_out = P_sat·ln(1 + (P_coupled/P_sat)·(G0−1))`，`G0=10^(smallSignalGainDb/10)`，clamp 到 `outputPowerMaxMw`。弱種子→線性、提取差、ASE 高;強種子→飽和、最大輸出。
3. **Mode matching（重疊積分）**：`_mode_match_eta()` 從 seed q 參數算端面光腰 `w²=λ|q|²/(π·Im q)`，與波導模 `inputSpatialModeX/Y.waistUm` + hit 橫向偏移做可分離二維高斯重疊。輸出橫模重塑為 `outputSpatialModeX/Y`。
4. **Current Driver Quality**：`driverQualityFactor∈[0,1]` 穩態提取效率懲罰（預設 1.0）。**動態效應不在範圍內**：α-parameter AM→PM 雜訊、自聚焦/filamentation、M² 崩潰屬時域/M²-aware 現象（BeamRay 無 M² 欄位、trace 為穩態）→ 歸時域模組（見 [timing.md](timing.md)）。

新參數：`polarizationExtinctionDb`、`driverQualityFactor`（FE interface + kind defaultParams；op 對舊資產 graceful default）。已知 bug：op 讀 `smallSignalGainDb` 但舊資產存 `gainLinear`，待統一。
