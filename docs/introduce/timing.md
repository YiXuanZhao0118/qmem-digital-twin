[← 文件索引](README.md)

# 時間域模擬

> RF tracer（穩態）見 [optics.md](optics.md)；多物理模組見 [multiphysics.md](multiphysics.md)。

**設計核心**：時間是一等座標。一次「實驗 run」是時間演化的 trace，而非穩態快照。
- **Sequence Timeline**：一個 Sequence = 一串 Event `(t, channel, action, params)`（channel 為點分路徑如 `AOM_001.rf_amplitude`；action：set/ramp/pulse_gate/trigger/wait/barrier）。模組在 event 之間各自向前演化，於 event 邊界交換跨物理狀態。**穩態 = 空 Sequence 的特例**（無 Sequence → 既有 CW evaluator 跑，不破相容）。
- **per-module 時間網格**：optical envelope（ps–100ns 取樣）、RF phasor、量子 ρ(t) 密度矩陣、thermal T(t,x)、vacuum P(t)——因單一全域 dt 不可行。採 RWA/SVEA 近似。
- **Schema**：`PulseEnvelope`/`RFSignal`/`QuantumTrace`/`ScalarTrace` + `Sequence`/`SequenceEvent` 表；各 kind 加選用色散參數（gvdFs2、groupDelayPs、riseTimeNs…）。
- **PhysicsModule Protocol**：`steady_state(scene)` + `evolve(scene, t0, t1, controls, state_in)`。光學 primitive：`propagate_envelope`（split-step Fourier 處理 GVD/TOD，已實作於 optical_solver、textbook 驗證 <0.5%）、`angular_spectrum_propagate`、`fiber_overlap`。
- **已落實**：trace schemas + 選用色散參數 + `propagate_envelope`；CW 路徑為 no-op，無回歸。後續 Phase（量子 Lindblad、thermal ODE、timeline UI）未完。

## Scrub time / Timing programs / AD9959

- **Scrub time**（`ScrubTimeBar.tsx`）：場景狀態是時間 t 的函數。
- **TimingProgram**：per-SceneObject 1:1，扁平 `TimingBlock` list（`[t_start_ns, t_end_ns)` + `waveform_kind`(const/linear_ramp/arbitrary/gate_on/gate_off) + params JSONB）。端點 `/api/timing-programs`、model `models/timing.py`。`evaluate_intervals_at(t)` 求當下有效狀態。
- **Programmable Pulse Generator（PPG）**：承載 timing program、輸出 TTL，驅動下游裝置。
- **AD9959**（4 通道 DDS RF 源）：時序整合採 **Option A**——在 TimingBlock 的 `params.channelIndex`(0–3) 加通道標籤，零 migration；AD9959 專屬波形 `dds_single_tone`/`dds_sweep`/`dds_profile`。player 把每通道有效 block 解析成 `DdsChannel`，靜態 `kindParams.channels[i]` 為 fallback。（此為設計提案，是否完全落地需對照程式碼確認。）
- **RF 鏈**：AD9959 通道 → rf_amplifier → rf_switch → AOM（`utils/rfPropagation.ts`、端點 `/api/rf-chains/nodes`），透過 AOM 的 dynamicSource 耦合到光學。
