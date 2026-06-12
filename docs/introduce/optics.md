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
- **元件預覽 probe（2026-06-12）**：PHY Editor COMPONENT 預覽的 probe beam 也走**同一個 anchor 引擎**，端點 `POST /api/v3/solver/run-from-component`（`v3_solver.py`）+ loader `db_scene_loader.load_anchor_scene_from_component`。它從**單一 Component 的 bindings** 組 scene（**component frame**，identity SceneObject pose、無 ObjectBinding delta / dynamic_sources / RF / power-gating），把 caller 給的 probe ray 當 initial ray 追跡，回傳與 run-from-db 相同的 `labSegments`（含逐段 Jones）。前端因此能在元件預覽逐段畫**真實偏振**（含非互易 Faraday），取代舊的前端 face-probe 近似（見 [rendering.md](rendering.md)）。
- 前端 `optical/` 的 TypeScript 光追引擎（`ray-tracer-v3.ts` 等，**face-based**）是**平行、尚未上線**的實作，目前只被 vitest 引用、main.tsx 到不了，但有完整 parity 測試 + golden fixtures——**勿當廢案刪**。

## 雷射源發射與高斯傳播（emit_laser_source.py）

emitter 不等入射光，主動種出初始 `BeamRay`（`emit_anchor_source_rays`）。beam propagation 由 **複數 q 參數**（per-axis `qx`/`qy`，支援像散）+ **embedded-Gaussian** 法控制。`laser_source` defaultParams（**只有 Asset `tunable_params` 標記的 key** 可被 `SceneObject.dynamic_sources` per-instance 覆寫，預設 tunable = `nominalPowerMw` + `centerWavelengthNm`，其餘由 Asset 決定——見 [data-model.md](data-model.md)）：

- `centerWavelengthNm`（λ）、`nominalPowerMw`（P，emit op 讀 dynamic 時 `nominalPowerMw` 優先於 legacy `powerMw`/`laserPowerMw` alias，逐實例調功率才生效）、`polarization`（Jones，在 anchor axisY/axisZ 基底）。
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

- **通光孔徑裁切**：光斑比 `anchor.aperture_mm`（半徑）寬時邊緣被擋。能量穿透率用高斯封閉解 **`T_ap = 1 − exp(−2a²/w²)`**，`w = √(wx·wy)`、`a = anchor.aperture_mm`。**對準（2026-06-11）**：chief ray 不一定正中孔徑——op 把 `hit.offset_y/z` 的徑向偏心 `r_c=√(off_y²+off_z²)` 餵進 `gaussian_circular_aperture_fraction(w,a,r_c)`，偏心束用**最近孔徑邊緣的刀口（knife-edge）模型**：`T = ½(1+erf(√2·(a−r_c)/w))`（邊緣帶符號距離 `s=a−r_c`；`r_c=0` 退回 on-axis 封閉解）。tracer 端建 `aperture_truncation` descriptor 時用**同一個** `r_c`（多帶 `decenterMm` 欄位），確保 scope 顯示的 `combinedFraction` = op 實際扣的功率。
- **鍍膜穿透率**：`default_params.transmittance`（缺省 1.0），AR/Fresnel 損耗。
- `power_out = P_in · T_ap · transmittance`。**唯一真值來源** `optical/aperture.py`（`gaussian_circular_aperture_fraction` + `gaussian_width_mm`），前端 `profileUtils.ts` 同公式；tracer 與 op 都呼叫它，永不分歧。
- **向後相容**：無 aperture（`apertureMm=0`）或無 transmittance 的舊透鏡資產 → 因子 1.0，功率不變；一般細光束（w≪a）→ `T_ap≈1`。

**顯示**：tracer 在「進入透鏡」那段 `LabSegment.aperture_truncation`（`anchor_tracer.py`，僅 `LENS_KINDS` + `aperture_mm>0`）記 `{apertureMm, wEffMm, transmittedFraction, transmittance, combinedFraction}` → `solver.to_dict` 的 `apertureTruncation` → `v3TraceAdapter` → BeamScopePanel 顯示「Aperture: X% through」。**注意**：descriptor 在「進入」段（功率為截斷前）；實際功率下降反映在透鏡**下游**段的 `power_mw`（自動經 `nominalPowerMwAtSource` 流到 scope 的 `P` 讀數）。

- **這是能量半**：同一個截斷產生的**繞射環（Airy）圖樣**屬波動場，q-引擎不畫（見上「限制」）；繞射 *pattern* 由獨立的 **POP 場通道**處理（見下），3D 場景光束仍為高斯錐。偏振/RF/AOM/fiber 一律留在 q 通道。
- **A230TM-B**（Thorlabs 非球面，`kind=lens_plano_convex`）：`default_params.focalLengthMm=4.51`（op 讀此 key，**非** Object 面板的 `focalMm`）、`clearApertureMm=4.95`、`transmittance=0.995`；intercept anchor 的 `apertureMm=2.475`（=clearAperture/2，半徑）。

## 斜入射像散（beam 與透鏡不對準，2026-06-11）

beam 軸與透鏡光軸（anchor `axisX`）不平行時，薄透鏡是**像散**的。`_tilt_astig_focals`（`lens.py`）把焦距依入射角 α 拆成 tangential `f·cosα`（入射面內）與 sagittal `f/cosα`（垂直），再依入射面方位角 φ=atan2(θ_z,θ_y) 把聚焦功率張量 `diag(1/f_t,1/f_s)` 投影回 (axisY, axisZ)，取**對角項** → `f_y` 套 `qx`（axisY 平面）、`f_z` 套 `qy`（axisZ 平面）+ 對應的幾何 kick。

- α 由 `beam_state_from_anchor_hit` 的斜率求出（`tanα=√(θ_y²+θ_z²)`）；正向入射（α=0）→ `f_y=f_z=f`，完全退回對稱薄透鏡（既有行為不變）。橢圓光斑經 beamMode per-axis qx/qy 自動流到 beam-scope + 3D 錐管，**無需新增管線**。
- **限制**：(1) 投影的**非對角交叉項**（φ≈45° 的斜向像散）被丟棄——q-tracer 的 qx/qy 各自獨立、無法表示旋轉的像散軸；(2) cosα 設下限 `_COS_INCIDENCE_FLOOR=0.5`（≈60°），near-grazing 不會讓 `f·cosα→0` 塌縮（同 `beam_ray._NONPARAXIAL_S_FLOOR` 慣例）；(3) **僅薄透鏡分支**——厚透鏡 ABCD 與 cylindrical 不套（需逐面傾斜，未做）；(4) coma 等離軸像差屬非近軸幾何，q-tracer 不模（同上「限制」）。

## 偏心截斷（beam 沒打在孔徑中心）

chief ray 不一定正中孔徑：op 與 tracer descriptor 都把 `hit.offset_y/z` 的徑向偏心 `r_c` 餵進 `gaussian_circular_aperture_fraction(w,a,r_c)`（見上「通光孔徑裁切」），偏心束用**刀口模型** `T=½(1+erf(√2·(a−r_c)/w))`，descriptor 多帶 `decenterMm` 供顯示。**為何不是 `exp(−2(r_c/w)²)`**：舊式把鏡片當成「偏心 r_c 處的針孔」、用該點高斯強度當穿透率，會把「偏心但仍整顆落在大孔徑內」的光束（如 `r_c=8.76 < a=12.7`、`w≈1`）錯誤歸零（`≈e⁻¹⁶²`）；真實 2D 積分 ≈1.0。刀口模型改看**光束邊緣離孔徑邊緣多遠**（`a−r_c`）：完整在內（`a−r_c≫w`）→≈1、束心正在孔緣（`r_c=a`）→½、束心出孔數個 w → 0。**限制**：偏心高斯過圓孔無封閉解，此為與前端 `profileUtils.ts` 一致的近似（僅近邊裁切，`w≳a` 時遠邊 vignette 未模）；大偏心（`r_c>a+3w`）直接歸零。

## 厚透鏡模型（短焦 / 非球面，2026-06-11）

薄透鏡把前後主平面 H/H' 併成一點;A230TM-B 這種 **T/f≈0.6**(中心厚 2.75、EFL 4.51)的短焦鏡,H–H' 間距~mm,是焦距一大部分 → 薄透鏡會把焦點放錯~mm。`lens_anchor_op` 因此**依參數分派**(`_is_thick`,`lens.py`):asset `default_params` 有 `radiusFrontMm`+`refractiveIndex`+`centerThicknessMm` → 走**全 air→air 厚透鏡 ABCD**;否則退回薄透鏡 `focalLengthMm`(向後相容,不開新 kind)。

- **為何單 anchor 不用雙面**:tracer 在 anchor 間用**空氣**傳 q(`q+=t_lab`),真的兩面+中間玻璃會被當空氣傳 → 錯。單 anchor 套**整顆 air→air ABCD**(折射率只活在矩陣係數裡,q 套用邊界是空氣)避開這問題。
- **ABCD**(`_thick_lens_abcd`):`P1=(n−1)/R1`、`P2=(1−n)/R2`(平面 R=∞→P=0)、`τ=d/n`;`M=[[1−P1τ, τ],[−(P1+P2−P1P2τ), 1−P2τ]]`、`EFL=−1/C`。符號慣例對齊退役的 `thorlabs_la1509_b.json` `matrix5x5`(golden 測試 R=51.5/∞、n=1.5168、d=3.6)。`q'=(Aq+B)/(Cq+D)` 套 qx/qy;`apply_abcd_state`(`anchor_tracer.py`)套幾何 (y,θ)。
- **幾何**:anchor `intercept_in` 放**前頂點**;op 把出光 ray origin 移到**後頂點**(anchor + d·axisX,signed) → 焦點落在 `後頂點 + BFL`(物理正確),而非薄透鏡的 `anchor + f`。玻璃內 d 段不畫(cosmetic)。
- **非球面**:近軸只看**頂點曲率半徑**;conic/非球面係數只影響像差(q-tracer 不模)。
- **A230TM-B 參數來源 = datasheet 等效擬合**:半徑未公開、由 EFL 推 R1 無法重現 WD(非簡單平凸)。改用 **EFL=4.51 + BFL=WD=2.53**(n、d 已知)解出等效 (R1,R2):`P1=(1−BFL/EFL)/τ` → `R1=(n−1)/P1`,再由 `1/EFL` 解 P2 → R2。**EFL/BFL 與 n 無關**(擬合吸收 n),故 n 只決定等效半徑、不影響焦點。A230TM-B asset 存 `radiusFrontMm=2.3244`、`radiusBackMm=10.308`、`refractiveIndex=1.59`、`centerThicknessMm=2.75`。
- **anchor 位置校準**:焦點正確的前提是 anchor 落在**物理前頂點**;若 GLB 原點使 anchor 不在前頂點,焦點會整體平移 → 視覺驗證後調 anchor z。
- **POP 不受影響**:`/api/v3/pop` 只算焦面 Airy 圖樣(用 EFL 定首零/尺度),不放 z,所以厚透鏡不破壞 POP。

## POP 場通道：透鏡焦平面繞射（Stage 2，2026-06-11）

**標量 2D 複數場引擎**，與 q-tracer **平行並存、不取代**。把被有限通光孔徑截斷的光束 → 焦平面 **Airy 繞射環**（q 通道畫不出的東西）。

- **引擎** `optical/pop_field.py`：`PopField`（N×N complex numpy 場 + pitch + λ）。運算子 `seed_gaussian`/`seed_plane_wave`、`apply_circular_aperture`（硬截斷→種繞射）、`apply_thin_lens`（`exp(−i k r²/2f)`）、`propagate_asm`（**角譜法**自由空間傳播，近/遠場皆精確、evanescent 歸零）、`focal_plane`（透鏡 = 前焦面到後焦面的精確傅立葉變換，輸出 pitch=`λf/(N·pitch_in)`，均勻圓孔→Airy 首零 `1.22λf/D`）、`radial_profile`、`downsample_intensity`（**中心裁切**到 k·out_n 再 block-average → 軸心留在輸出中央；角落裁切會把 Airy peak 移位，這是實作過的 bug）。
- **橋接** `optical/pop_pass.py`：`lens_focal_airy_pattern(w_at_lens_mm, aperture_mm, f_mm, wavelength_nm)`。幾何（透鏡處光束半徑 w、孔徑半徑 a、焦距 f）**由 q 通道供給、不在此重算**（前端 `gaussianWidthMm(q)` 已知 w）。流程：在透鏡處種 w 寬高斯 → 孔徑硬截斷 → `focal_plane(f)` → 裁到 ±6 Airy 零點 → 降採樣。回傳 `{size, halfExtentUm, pitchUm, firstNullUm, clipFraction, intensity[peak-normalized], diffractionLimited}`。v1 限制：入射平相位（忽略入射波前曲率，環主要由截斷產生）、單透鏡焦平面視圖。
- **端點** `POST /api/v3/pop`（`routers/pop.py`，**on-demand 專用**，絕不進 `/api/v3/solver` live trace）：body `{wAtLensUm, apertureMm, focalLengthMm, wavelengthNm, gridN?, outN?}` → 上述 payload。前端在 beam-scope 探測截斷透鏡下游時呼叫。
- **物理驗證**（`tests/optical/test_pop_field.py` + `test_pop_pass.py`）：圓孔焦面 = Airy（首零在 `1.22λf/D` 8% 內 + 確認有環）、自由空間高斯 `w(zR)=w0√2`（6% 內）、高斯過孔徑能量比 = Stage 1 `1−exp(−2a²/w²)`（3% 內）。Live A230TM-B 端點徑向切面確認中央亮斑→暗環→次環。
- **Stage 3 — DONE 2026-06-11**：`BeamScopePanel` 找出該透鏡的 `apertureTruncation`(含 `focalLengthMm`)→ 呼叫 `POST /api/v3/pop` → 雙線性取樣回傳的強度網格餵進現有 `Heatmap`（取代解析 `sampleIntensity`），標題標「diffraction (POP) · focal plane」。幾何（透鏡處光束半徑 w、孔徑、焦距、λ）全來自 q 通道的 segment descriptor。
  - **只在焦面附近顯示（2026-06-11 修）**：POP 是**焦平面** Airy,只在焦點附近有意義。`truncLens` 取焦面(`lensZ+EFL`)離 probe 最近的透鏡,且**僅當 `|probe.z − focalZ| ≤ EFL`** 才回傳 → 否則 `popPattern=null`、退回**隨 z 變化的解析 profile**(否則遠下游探測會一直顯示同一張定位焦面圖,與 probe z 無關 → 使用者回報的 bug)。POP 焦面視圖也**不套**解析 profile 的 90° 旋轉/世界軸標籤(見 [rendering.md](rendering.md))。
- **尚未做**：偵測器影像面、astigmatic POP 場（v1 種圓形 `w_eff`，焦面 Airy 由圓孔主導本就近圓）、入射波前曲率、**任意下游平面**（option B：會聚透鏡的環只在焦點 ±景深~3µm 內存在,離焦處是平滑光斑;且 mm 尺度近場 + 孔徑/焦斑~3000× 比例是硬取樣問題 → 暫不做）。

## 偏振分光器 PBS / Glan（beam_splitter，2026-06-11）

Op 在 `anchor_ops/pbs.py`（`register_anchor_op` 同時註冊 `pbs` 與 `beam_splitter`），單一 anchor `intercept_face`（axisX = coating/cut normal、axisY = s 參考、axisZ = p 參考）。每次命中**回兩條 branch**：

- **透射（p，extraordinary）**：方向 = `ray.direction`（直穿,不靠 axisX,所以 Glan 那種 cut normal 偏 ~38° 也不會打歪);slab `B = L/n_e`。
- **反射（s，ordinary）**：方向 = 對 axisX 鏡射 `d − 2(d·axisX)axisX`;slab `B = L/n_o`。

**slab 折射率分 branch**：透射 e-ray 用 `refractiveIndex_e`、反射 o-ray 用 `refractiveIndex_o`;一般 PBS cube 只設 isotropic `refractiveIndex` → 兩 branch fallback 同值（`_pick_index`，鍵序 `refractiveIndex` 先於 `refractiveIndex_e/o`）。length 取 `cubeSizeMm` 或 `lengthMm`。

**有限消光（漏光）**：`att = 10^(−ER_dB/10)` 為被拒偏振漏進該埠的功率比，**能量守恆**（每偏振兩出口比例和為 1）：透射埠 = `(1−att_s)·E_p + att_p·E_s`、反射埠 = `(1−att_p)·E_s + att_s·E_p`。`extinctionRatioPpDb`=透射 P 埠（s 漏）、`extinctionRatioSpDb`=反射 S 埠（p 漏);**值為合法 dB**（100000:1 → 50dB）。缺參數 ⇒ att=0 = 理想完美分光（一般 cube 不受影響）。

**分光基於偏振器自身方位（plane-of-incidence frame，2026-06-12）**：分光**不是**在世界-up 的 beam-local s/p 框做，而是先把入射 Jones 旋進**偏振器自己的入射面框**：`s_glan = dir × axisX`（⊥入射面 = 反射 o-ray 的 s 偏振）、`p_glan = dir × s_glan`（透射 e-ray）。`_glan_frame_phi` 算 beam-local-s 到 `s_glan` 的有號角 φ、`rotate_jones` 把 jones 轉進去分光、兩條輸出再轉回 beam-local（`pbs.py`）。**為何**：isolator 的出口 Glan 相對入口 Glan **繞光軸轉 ~45°**——舊版兩顆都用同一個 beam-local 框分光 → 出口 Glan 會**透射**它該**反射**的（被 Faraday 轉過的）分量。水平擺的單顆 PBS：`dir×axisX ≈ beam-local s` → φ≈0 不變（向後相容）；近正入射（beam ∥ axisX，degenerate 入射面）→ 退回 raw beam-local。測試 `test_pbs_axis_referenced.py`（轉過的 Glan 沿自身 s 軸的偏振必全反射）。**反射 branch 仍維持入射 beam-local 框**（換方向後的 re-base 是既有近似，未動）。連結：[passive ops 偏振框](#) 見 memory `polarization_frame_convention`（PBS 現已 orientation-referenced，但 faraday/seeded-TA 仍待補）。

isolator 內的 Glan-Laser 稜鏡 asset **掛 `beam_splitter` kind 走此雙 branch op**，不是 `glan_polarizer`（後者單透射、且其 op 會把透射方向沿 cut normal 打歪 → 對 Glan 幾何是壞的，見 kinds.md / 程式註解）。參數全集見 [kinds.md](kinds.md)（beam_splitter 的 defaultParams 即此 op 實讀的全集，無 optionalParams）。

**除錯：「透射光偏振是垂直/不純」≠ frame bug（2026-06-12 診斷）**。isolator 正向光本來就**穿過兩顆 Glan**（隔離只在回程 glan1 反射擋光），所以 Object Sense / Optical Link 看到 glan2「透射」是對的。若透射光顯示成**垂直、且看似不純**，根因通常是**入射偏振落在 glan1 的拒斥(o-ray)軸**：glan1 把主功率全反射出側面，往前只剩 `extinctionRatioPpDb` 定義的那條漏光 `E_s·√att_p`（`pbs.py:162`，`att_p=10^(−Pp/10)`，Pp=50dB→1e-5），是**純 s（垂直）**但功率≈0；面板正規化後仍畫一條滿線 + 偏振標籤，易誤判成「順利透射」。把 `Pp→∞` 只會讓垂直入射的透射→**零**（不是變水平）。修法在上游：把雷射 `polarization`（或 glan1 繞光軸）對齊 glan1 透射(p)軸。詳見 memory `isolator_glan_input_pol_gotcha`。

## Faraday rotator（非互易偏振旋轉，2026-06-12）

Live op = `anchor_ops/misc_ops.py` 的 `faraday_anchor_op`（單 anchor `optical_center`）。**`kinds/faraday_rotator/physics.py` 是退役的 face-based legacy，live 不跑到**（但其 registry 測試 `test_faraday_rotator.py` 仍綠）。op 做兩件事：slab 直穿（`B=L/n`，q 前進、不聚焦、功率不變）＋ Jones 旋轉 `rotationDeg`（預設 45°）。

- **非互易性靠 anchor axisX 定號（`misc_ops.py:53`）**：旋轉固定在 lab B-field 軸（= rod 光軸 anchor `axisX`），**不是** beam-local 框。`beam_local_sp` 反向時保留 ŝ、翻 p̂，所以「方向無關的固定矩陣」在回程會被讀成 `R(−θ)` 而**抵銷**去程 → 退化成互易旋光體、isolator 失效（2026-06-12 前的 bug，使用者實測「來回相互抵銷」）。修法：`fwd = sign(direction·axisX)`，去/回程在 lab 同手性 → 往返累積 **2θ**（45°+45°=90°，配交叉偏振器擋反射）。
- **旋轉手性 2026-06-12 反轉（依需求）**：`θ ← −rotationDeg·fwd`（原為 `+rotationDeg·fwd`），forward 改成繞 axisX 轉 −rotationDeg、去/回程都是 `R(−θ)`、往返 **−2θ**。**非互易性不變，只反轉旋向**；op 層契約測試的號已同步更新。
- **矩陣**（`rotate_jones(+θ)` 慣例）：`E_s' = cosθ·E_s + sinθ·E_p`、`E_p' = −sinθ·E_s + cosθ·E_p`。
- **op 層 vs 整鏈**：單 op 呼叫只看到 `±θ`（forward/reverse 號相反）；完整 2θ 非互易要靠 tracer 在反射處 re-base jones 才浮現。op 層契約測試見 `tests/optical/test_faraday_anchor_nonreciprocal.py`。

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
