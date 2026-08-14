[← 文件索引](README.md)

# 時間域模擬

> RF tracer（穩態）見 [optics.md](optics.md)；多物理模組見 [multiphysics.md](multiphysics.md)。

**設計核心**：時間是一等座標。一次「實驗 run」是時間演化的 trace，而非穩態快照。
- **Sequence Timeline**：一個 Sequence = 一串 Event `(t, channel, action, params)`（channel 為點分路徑如 `AOM_001.rf_amplitude`；action：set/ramp/pulse_gate/trigger/wait/barrier）。模組在 event 之間各自向前演化，於 event 邊界交換跨物理狀態。**穩態 = 空 Sequence 的特例**（無 Sequence → 既有 CW evaluator 跑，不破相容）。
- **per-module 時間網格**：optical envelope（ps–100ns 取樣）、RF phasor、量子 ρ(t) 密度矩陣、thermal T(t,x)、vacuum P(t)——因單一全域 dt 不可行。採 RWA/SVEA 近似。
- **Schema**：`PulseEnvelope`/`RFSignal`/`QuantumTrace`/`ScalarTrace` + `Sequence`/`SequenceEvent` 表；各 kind 加選用色散參數（gvdFs2、groupDelayPs、riseTimeNs…）。
- **PhysicsModule Protocol**：`steady_state(scene)` + `evolve(scene, t0, t1, controls, state_in)`。光學 primitive 設計：`propagate_envelope`（split-step Fourier 處理 GVD/TOD）、`angular_spectrum_propagate`、`fiber_overlap`。`propagate_envelope` 曾實作於 `optical_solver`（textbook 驗證 <0.5%），但**該檔已隨 legacy 退役刪除、色散時域數學一併移除（可從 git 復原）**。
- **現況**：trace schemas + 選用色散參數仍在；CW 路徑為 no-op，無回歸。`propagate_envelope` 等時域 primitive **待重新接上**（見 [known-issues.md](known-issues.md)）。後續 Phase（量子 Lindblad、thermal ODE、timeline UI）未完。

## Scrub time / Timing programs / AD9959

- **Scrub time**（`ScrubTimeBar.tsx`）：場景狀態是時間 t 的函數。
- **TimingProgram**：per-SceneObject 1:1，扁平 `TimingBlock` list（`[t_start_ns, t_end_ns)` + `waveform_kind`(const/linear_ramp/arbitrary/gate_on/gate_off) + params JSONB）。端點 `/api/timing-programs`、model `models/timing.py`。`evaluate_intervals_at(t)` 求當下有效狀態。
- **Programmable Pulse Generator（PPG）**：承載 timing program、輸出 TTL，驅動下游裝置。
  - **生命週期只在 RF Link**：PPG 由 RF Link 面板右鍵空的 `ttl_in`/`trigger_in` 建立，也只能從那裡移除。其他入口都已封死 —— `capabilityProfile.programmable_pulse_generator`（`kinds/_capabilityProfile.ts:97`）關掉 `outlinerVisible` + `showRemoveObjectButton` + gizmo，全 app 只有 4 個 `deleteObject` 呼叫點且都受此閘門保護。**串聯刪除**在 `sceneStore.deleteObjects`（`sceneStore.ts:3234`）：刪掉主儀器 → 指向它的 cable 一併進 doomed set → PPG 的 cable 全沒了就跟著刪 → 後端再串掉 TimingProgram。
  - **命名同步（2026-08-13 修）**：channel 身分的唯一真值是 **PPG 的 `SceneObject.name`**；`TimingProgram.name` 是編譯輸出用的鏡像。鏡像寫在 **store**（`sceneStore.mirrorPpgNameToTimingProgram`，由 `updateSceneObject` 呼叫），不在面板 —— 先前只有 Pulse & Timing 面板自己鏡像，從 RF Link 節點雙擊改名只寫 `SceneObject.name`，`TimingProgram.name` 就此走鐘。孤兒 program（無 PPG）仍由面板直接寫 `TimingProgram.name`。
  - **rest level 是「區塊之外」的位準，不是只在 idle 生效（2026-08-14 修）**：Pulse & Timing 每列左側的 `H`/`L` 藥丸寫的是 PPG `kindParams.restState`，語意 = **`level = inInterval XOR (restState === "HIGH")`** —— rest=HIGH 時使用者畫的 block 變成 LOW 脈衝（負邏輯），沒畫 block 的 channel 則整條線恆 HIGH。先前 active scrub 只吃正邏輯（intervals 斷言 HIGH，`restState` 僅用於 scrub 停的 idle snapshot），所以「rest=HIGH 但沒畫任何 block」的 channel 一按下 Scrub time 就變 LOW，下游 switch 直接斷路。實作在 FE `rfPropagation.ts:528` / BE `rf_resolve.py:421` 的 gate pre-pass（先算每顆 PPG 的位準，TTL pre-pass 只查表）；契約寫在 `types/digitalTwin.ts` `ProgrammablePulseGeneratorParams.restState` 與 `schemas.py` `rest_state`。插著的 PPG 一律擁有那條線 —— **沒綁 TimingProgram 也用 rest 位準**（先前會 fall through 到 switch 的手動 `ttlState`）。RF Link 面板的 TTL 線也照這個位準著色（`ppgGateHighObjectIds`，見 [rf.md](rf.md) §4/§7）。
  - **直接插在埠上，沒有 cable（2026-08-14 起）**：連接關係存在 PPG 自己的 `SceneObject.properties.ppgAttachment = {targetObjectId, targetAnchorId, targetAnchorName}`（契約見 [`utils/ppgAttachment.ts`](../../frontend/src/utils/ppgAttachment.ts)）。它同時是 **3D 姿態的依據**（`computePpgMountedThreePose` 把 PPG 的 `rf_out` 對到目標埠、方向反平行）與 **RF 圖的邊**（FE/BE BFS + RF Link 面板都當零長度邊吃）。舊模型會建一條隱形的 rf_cable，衍生出「看不見卻可被選/可被刪/可被永久隱藏」的一連串 bug，已淘汰；舊場景仍有 cable 的走 legacy fallback。詳見 [rf.md](rf.md) §7。
- **AD9959**（4 通道 DDS RF 源）：時序整合採 **Option A**——在 TimingBlock 的 `params.channelIndex`(0–3) 加通道標籤，零 migration；AD9959 專屬波形 `dds_single_tone`/`dds_sweep`/`dds_profile`。player 把每通道有效 block 解析成 `DdsChannel`，靜態 `kindParams.channels[i]` 為 fallback。（此為設計提案，是否完全落地需對照程式碼確認。）
- **RF 鏈**：AD9959 通道 → rf_amplifier → rf_switch → AOM（`utils/rfPropagation.ts`、端點 `/api/rf-chains/nodes`），透過 AOM 的 dynamicSource 耦合到光學。
