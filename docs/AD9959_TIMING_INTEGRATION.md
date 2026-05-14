# AD9959 ↔ TimingProgram integration — design (draft, 2026-05-13)

Per-AD9959 `RfSourceParams.channels[]` currently holds **static** runtime
values (one freq/phase/amp per channel, one optional DRG sweep). This
document proposes how those values become **time-varying** by reusing
the existing `TimingProgram` / `TimingBlock` plumbing.

## Status quo

- `TimingProgram` is per-`SceneObject` (1:1) with a flat list of
  `TimingBlock` rows. Each block carries `[t_start_ns, t_end_ns)` +
  `waveform_kind` (`const | linear_ramp | arbitrary | gate_on | gate_off`)
  + `params` JSONB.
- Existing single-channel `rf_source` consumers already read
  `params.frequencyMhz / .powerDbm / .phaseDeg` from `arbitrary`
  waveform samples (see `schemas.py:1393`).
- An AD9959 SceneObject would currently get one TimingProgram with
  blocks that describe **the whole chip**, not individual channels —
  there is no slot for "this block applies to CH2 only".

## Design problem

Two facts collide:

1. **Hardware reality**: an AD9959 has 4 channels that step
   independently. CH0 can be doing a 1-ms frequency sweep while CH1
   holds a static tone and CH2 cycles through profile-pin presets.
2. **TimingProgram model**: per-`SceneObject` 1:1 + flat `blocks[]`.
   No native concept of "this block touches a subset of channels".

## Two paths

### (Option A) Channel tag inside `TimingBlock.params`

- Keep `TimingProgram` 1:1 with the AD9959 SceneObject.
- Each block tags itself with `params.channelIndex` (0..3) plus the
  channel-mode payload (e.g. `{channelIndex: 2, mode: "sweep", target:
  "frequency", start: 70, end: 90, rampUpRate: 1e12, rampDownRate: 1e12}`).
- Blocks for different channels can overlap freely in time — the
  player groups them by `channelIndex` at runtime.
- **Pros**: zero schema migration; reuses every existing UI piece
  (timeline editor, scrub readout, block validation). Smallest blast
  radius.
- **Cons**: existing block validators (`schemas.py:1894`) assume
  single-stream semantics; would need to teach the validator that
  overlapping blocks with different `channelIndex` are OK. Block
  semantics become "per-channel slice" instead of "device timeline",
  which changes mental model for non-AD9959 consumers.

### (Option B) Per-channel sub-programs

- Add an indirection: AD9959 SceneObject's `TimingProgram` becomes a
  **container**; the actual block lists live on 4 child structures,
  one per channel.
- Two storage shapes possible:
  1. **JSON-only**: `TimingProgram.properties.channels = [{blocks: [...]},
     ...]`. No DB schema changes; per-channel blocks are not first-class
     rows.
  2. **First-class**: add `TimingBlock.channel_index: int | null`
     column (alembic migration) + `(program_object_id, channel_index)`
     compound index. Existing single-stream devices use `null`.
- **Pros**: per-channel concept is explicit; UI can render 4 lanes;
  validators stay per-stream.
- **Cons**: real migration cost; existing scrub / Phase RF.3 readers
  need updating; richer than needed for the 90% case.

## Recommendation: Option A first, Option B later if needed

The `channelIndex` tag is a 1-line params field with zero schema cost.
The validator change is a 5-line update inside `_check_block`
(`schemas.py:1894`). If/when the UI grows past "show one timeline"
into "4 lanes with cross-channel sync events", revisit Option B.

## Concrete v3 scope (built on Option A)

1. **Backend**
   - `TimingBlockBase._check_block` (`schemas.py:1894`): when the
     owning SceneObject's element kind is `rf_source` and the
     component has `componentType === "dds_ad9959_pcb"`, require
     `params.channelIndex ∈ {0,1,2,3}`. For other kinds the field is
     forbidden (back-compat).
   - New waveform_kind values gated to AD9959 channels:
     `dds_single_tone` (params: `frequencyMhz / phaseDeg /
     amplitudeScale`), `dds_sweep` (params mirror `DdsSweepConfig`),
     `dds_profile` (params: `mode ∈ {fm,pm,am}, modulationLevels,
     profiles[]`).
   - Player / Phase RF.3 reader: at each scrub-time `t`, for each
     channel `i`, find the active block with `params.channelIndex ===
     i` (latest `t_start ≤ t`); reduce its params to the same shape
     as `DdsChannel` and emit. Static `kindParams.channels[i]` is the
     fallback when no block is active.

2. **Frontend — TimingEditorPanel**
   - For AD9959 SceneObjects, render **4 lanes** (CH0..CH3) instead
     of one. Lane filter = `block.params.channelIndex === i`.
   - "+ Add block" picker exposes `dds_single_tone / dds_sweep /
     dds_profile` only inside an AD9959 lane.
   - Drag/resize/snap behaviour is per-lane (already per-block).
   - Cross-lane preview line for the scrub time (vertical guide).

3. **Frontend — Ad9959ObjectControls**
   - Read-only mode indicator on each channel: "static" (no block at
     scrub time) / "timed: <block label>" (block active at scrub
     time).
   - When a block is active, the per-channel fields in
     `Ad9959ObjectControls` become read-only — the source of truth
     is the timing block. Editing requires opening
     TimingEditorPanel.

4. **Scrub readout**
   - `ScrubTimeRfReadout` extends to show 4 rows (one per channel)
     when fronting an AD9959.

## Open questions

- **REF_CLK / SYS_CLK timing**: should chip-level params (PLL
  multiplier, REF_CLK source) also be time-varying? AD9959 hardware
  supports reprogramming the PLL at runtime but it triggers a
  500-µs-ish settling tail. Default: treat chip-level as **static
  only** (kindParams); flag this in the timing block validator.
- **SYNC across chips**: a daisy-chain sync between 5 AD9959 chips
  means timing blocks must be CHIP-aligned, not just per-channel.
  How does the chassis's `syncTopology` constraint surface in the
  timing editor? Possibly a "sync mode" property on TimingProgram
  itself (`independent` vs `chassis_sync_master_of: <object_id>`).
- **Profile-pin source pins**: in FM/PM/AM, the `modulation_levels`
  field tells us how many profile pins are active, but **the pins
  themselves come from external timing** (PulseBlaster or scripted
  GPIO). Linking AD9959.kindParams.modulation_levels to a
  PulseBlaster channel routing is out of scope for this doc — track
  separately as **AD9959 ↔ PulseBlaster wiring**.
- **Long arbitrary waveforms**: the AD9959 chip has no large buffer.
  Long `arbitrary` waveforms would require streaming SPI updates at
  high rate, which is host-MCU-bound. The TimingProgram model should
  reject `dds_arbitrary` with > N samples (TBD bound from MCU spec).

## Non-goals (this doc)

- Wiring up AD9959 to PulseBlaster trigger pins (separate effort).
- Hardware execution / driver code (this design only describes the
  digital twin layer).
- Backwards migration for existing non-AD9959 `rf_source` timing
  programs (single-channel synths stay valid without `channelIndex`).
