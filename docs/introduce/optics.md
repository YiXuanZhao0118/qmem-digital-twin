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
