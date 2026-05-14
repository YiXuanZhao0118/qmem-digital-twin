import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Power, Radio } from "lucide-react";
import { useSceneStore } from "../store/sceneStore";
import type {
  ComponentItem,
  DdsChannel,
  DdsChannelMode,
  DdsModulationLevels,
  DdsProfile,
  DdsSerialPortMode,
  DdsSweepConfig,
  DdsSweepTarget,
  DdsSyncRole,
  RfSourceParams,
} from "../types/digitalTwin";

/** Per-AD9959-instance controls in the Object Panel.
 *
 *  V1 scope: single_tone + sweep modes; collapsible per-channel blocks;
 *  chip-level PLL controls + read-only derived SYS_CLK. FM/PM/AM
 *  profile-pin modulation and TimingProgram integration land in v2.
 *
 *  Reads + writes `PhysicsElement.kindParams` for the selected object's
 *  rf_source element via `upsertOpticalElement`. When no SceneObject is
 *  selected (catalog-only view), inputs render disabled with a hint. */

const DEFAULT_SWEEP_FREQ: DdsSweepConfig = {
  target: "frequency",
  start: 70.0,
  end: 90.0,
  // 1 MHz/μs = 1e12 Hz/s. Most DDS sweeps run µs–ms; expose as MHz/µs
  // in the UI and convert here (×1e12) and on display (÷1e12).
  rampUpRate: 1e12,
  rampDownRate: 1e12,
  noDwellLow: false,
  noDwellHigh: false,
};

function makeDefaultChannel(channelIndex: number): DdsChannel {
  return {
    channelIndex,
    anchorName: `CH${channelIndex}`,
    mode: "single_tone",
    channelEnabled: true,
    frequencyMhz: 80.0,
    phaseDeg: 0.0,
    amplitudeScale: 1.0,
    sweep: null,
    modulationLevels: 2,
    profiles: null,
  };
}

/** Resize a profiles[] array to match `levels`. Existing rows are
 *  preserved; new rows are seeded with the channel's current freq/phase/
 *  amp so a user switching from single_tone → fm gets sensible starting
 *  values for profile[0]. */
function resizeProfiles(
  current: DdsProfile[] | null | undefined,
  levels: DdsModulationLevels,
  seed: { frequencyMhz: number; phaseDeg: number; amplitudeScale: number },
): DdsProfile[] {
  const next: DdsProfile[] = [];
  for (let i = 0; i < levels; i++) {
    const prev = current?.[i];
    next.push(
      prev ?? {
        frequencyMhz: i === 0 ? seed.frequencyMhz : seed.frequencyMhz + 1.0 * i,
        phaseDeg: i === 0 ? seed.phaseDeg : 0.0,
        amplitudeScale: seed.amplitudeScale,
      },
    );
  }
  return next;
}

function resolveChannels(stored: DdsChannel[] | null | undefined): DdsChannel[] {
  const byIndex = new Map<number, DdsChannel>();
  for (const c of stored ?? []) byIndex.set(c.channelIndex, c);
  const out: DdsChannel[] = [];
  for (let i = 0; i < 4; i++) {
    const prev = byIndex.get(i);
    // Merge defaults UNDER prev so older DB rows missing newer fields
    // (modulationLevels / profiles / channelEnabled) get sensible
    // values without write-back. New writes from the UI carry the
    // full shape forward.
    out.push(prev ? { ...makeDefaultChannel(i), ...prev } : makeDefaultChannel(i));
  }
  return out;
}

export function Ad9959ObjectControls({ component }: { component: ComponentItem }) {
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);
  // Look up the per-OBJECT PhysicsElement for the currently selected scene
  // object whose componentId matches this component. Same pattern as
  // FiberSlowAxisEditor — per-object kindParams, not per-template.
  const physicsElement = useSceneStore((state) => {
    const obj =
      (state.selectedObjectId &&
        state.scene.objects.find((o) => o.id === state.selectedObjectId)) ||
      state.scene.objects.find((o) => o.componentId === component.id);
    if (!obj) return null;
    return state.scene.physicsElements.find((e) => e.objectId === obj.id) ?? null;
  });

  const params = (physicsElement?.kindParams ?? {}) as Partial<RfSourceParams>;
  const channels = useMemo(() => resolveChannels(params.channels), [params.channels]);
  const pllMultiplier = params.pllMultiplier ?? 25;
  const pllBypass = params.pllBypass ?? false;
  const refClockMhz = params.referenceClockMhz ?? 20.0;
  const sysClockMhz = pllBypass ? refClockMhz : refClockMhz * pllMultiplier;
  const syncRole: DdsSyncRole = params.syncRole ?? "standalone";
  const serialPortMode: DdsSerialPortMode = params.serialPortMode ?? "4wire";

  const writeParams = async (patch: Partial<RfSourceParams>) => {
    if (!physicsElement) return;
    const next = { ...params, ...patch };
    await upsertOpticalElement({
      objectId: physicsElement.objectId,
      elementKind: physicsElement.elementKind,
      wavelengthRangeNm: physicsElement.wavelengthRangeNm,
      inputPorts: physicsElement.inputPorts,
      outputPorts: physicsElement.outputPorts,
      kindParams: next as Record<string, unknown>,
    });
  };

  const updateChannel = (idx: number, patch: Partial<DdsChannel>) => {
    const next = channels.map((c, i) => (i === idx ? { ...c, ...patch } : c));
    void writeParams({ channels: next });
  };

  const hasInstance = physicsElement != null;

  return (
    <section className="edit-section">
      <h3>
        <Radio size={17} />
        AD9959 controls
      </h3>
      {!hasInstance && (
        <p style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
          Place this AD9959 in the scene to edit per-instance parameters.
          Showing catalog defaults.
        </p>
      )}

      {/* Chip clock --------------------------------------------------- */}
      <div className="ad9959-subsection">
        <div className="ad9959-subsection-title">Chip clock</div>
        <label className="ad9959-row">
          <span>REF_CLK (MHz)</span>
          <input
            type="number"
            step={0.1}
            min={0}
            disabled={!hasInstance}
            value={refClockMhz}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v) || v < 0) return;
              void writeParams({ referenceClockMhz: v });
            }}
          />
        </label>
        <label className="ad9959-row">
          <span>PLL multiplier</span>
          <input
            type="number"
            step={1}
            min={1}
            max={80}
            disabled={!hasInstance || pllBypass}
            value={pllMultiplier}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (!Number.isFinite(v) || v < 1) return;
              void writeParams({ pllMultiplier: v });
            }}
          />
        </label>
        <label className="ad9959-row">
          <input
            type="checkbox"
            disabled={!hasInstance}
            checked={pllBypass}
            onChange={(e) => void writeParams({ pllBypass: e.target.checked })}
          />
          <span>PLL bypass (REF_CLK = SYSCLK)</span>
        </label>
        <div className="ad9959-row ad9959-derived">
          <span>SYS_CLK</span>
          <code>{sysClockMhz.toFixed(2)} MHz</code>
        </div>
      </div>

      {/* Sync & serial ------------------------------------------------- */}
      <div className="ad9959-subsection">
        <div className="ad9959-subsection-title">Sync &amp; serial</div>
        <label className="ad9959-row">
          <span>Sync role</span>
          <select
            disabled={!hasInstance}
            value={syncRole}
            onChange={(e) =>
              void writeParams({ syncRole: e.target.value as DdsSyncRole })
            }
          >
            <option value="master">master (drives SYNC_OUT)</option>
            <option value="slave">slave (consumes SYNC_IN)</option>
            <option value="standalone">standalone</option>
          </select>
        </label>
        <label className="ad9959-row">
          <span>Serial port</span>
          <select
            disabled={!hasInstance}
            value={serialPortMode}
            onChange={(e) =>
              void writeParams({ serialPortMode: e.target.value as DdsSerialPortMode })
            }
          >
            <option value="4wire">4-wire SPI (CS + SCLK + SDIO_IN + SDIO_OUT)</option>
            <option value="2wire">2-wire (CS + SCLK + SDIO bidir)</option>
            <option value="1wire">1-wire (vendor mode)</option>
          </select>
        </label>
      </div>

      {/* Channels ------------------------------------------------------ */}
      <div className="ad9959-subsection">
        <div className="ad9959-subsection-title">Channels</div>
        {channels.map((ch, idx) => (
          <ChannelBlock
            key={idx}
            channel={ch}
            disabled={!hasInstance}
            onChange={(patch) => updateChannel(idx, patch)}
          />
        ))}
      </div>
    </section>
  );
}

/* ============================================================== */
/* Per-channel collapsible block                                   */
/* ============================================================== */

function ChannelBlock({
  channel,
  disabled,
  onChange,
}: {
  channel: DdsChannel;
  disabled: boolean;
  onChange: (patch: Partial<DdsChannel>) => void;
}) {
  const [expanded, setExpanded] = useState(channel.channelIndex === 0);
  const sweep = channel.sweep;
  const isSweep = channel.mode === "sweep";
  const isMod = channel.mode === "fm" || channel.mode === "pm" || channel.mode === "am";
  // Normalise profiles to match modulationLevels at render time. Older
  // DB rows can have `profiles: []` (length mismatch) or `profiles:
  // null`; both fall through the same path so the editor always sees a
  // correctly-sized array. `null ?? fallback` works but `[] ?? fallback`
  // doesn't — use an explicit length comparison.
  const normalizedProfiles =
    channel.profiles && channel.profiles.length === channel.modulationLevels
      ? channel.profiles
      : resizeProfiles(channel.profiles, channel.modulationLevels, {
          frequencyMhz: channel.frequencyMhz,
          phaseDeg: channel.phaseDeg,
          amplitudeScale: channel.amplitudeScale,
        });

  const summary = (() => {
    if (!channel.channelEnabled) return "disabled";
    if (channel.mode === "sweep" && sweep) {
      const unit =
        sweep.target === "frequency" ? "MHz" : sweep.target === "phase" ? "°" : "";
      return `sweep ${sweep.target} ${sweep.start}→${sweep.end}${unit}`;
    }
    if (isMod) {
      const t = channel.mode === "fm" ? "freq" : channel.mode === "pm" ? "phase" : "amp";
      return `${channel.mode.toUpperCase()} ${channel.modulationLevels}-level (P0..P${Math.log2(channel.modulationLevels) - 1}) · ${t}`;
    }
    return `${channel.frequencyMhz.toFixed(2)} MHz · ${channel.phaseDeg.toFixed(0)}° · ${(channel.amplitudeScale * 100).toFixed(0)}%`;
  })();

  const setMode = (mode: DdsChannelMode) => {
    const patch: Partial<DdsChannel> = { mode };
    // Lazily allocate a default sweep on first mode switch so user gets
    // sensible starting numbers; preserve existing sweep otherwise.
    if (mode === "sweep" && !channel.sweep) {
      patch.sweep = { ...DEFAULT_SWEEP_FREQ };
    }
    // Lazily allocate profiles when entering FM/PM/AM modes so the user
    // sees the table immediately. Preserve existing profiles when
    // switching between fm ↔ pm ↔ am (same length, different fields
    // matter).
    if (mode === "fm" || mode === "pm" || mode === "am") {
      if (!channel.profiles || channel.profiles.length !== channel.modulationLevels) {
        patch.profiles = resizeProfiles(channel.profiles, channel.modulationLevels, {
          frequencyMhz: channel.frequencyMhz,
          phaseDeg: channel.phaseDeg,
          amplitudeScale: channel.amplitudeScale,
        });
      }
    }
    onChange(patch);
  };

  const updateSweep = (patch: Partial<DdsSweepConfig>) => {
    const base = channel.sweep ?? DEFAULT_SWEEP_FREQ;
    onChange({ sweep: { ...base, ...patch } });
  };

  const setModLevels = (levels: DdsModulationLevels) => {
    const profiles = resizeProfiles(channel.profiles, levels, {
      frequencyMhz: channel.frequencyMhz,
      phaseDeg: channel.phaseDeg,
      amplitudeScale: channel.amplitudeScale,
    });
    onChange({ modulationLevels: levels, profiles });
  };

  const updateProfile = (idx: number, patch: Partial<DdsProfile>) => {
    const next = normalizedProfiles.map((p, i) => (i === idx ? { ...p, ...patch } : p));
    onChange({ profiles: next });
  };

  return (
    <div className={`ad9959-channel${expanded ? " is-expanded" : ""}`}>
      <button
        type="button"
        className="ad9959-channel-header"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="ad9959-channel-name">CH{channel.channelIndex}</span>
        <span className="ad9959-channel-summary">{summary}</span>
        <label
          className="ad9959-channel-enable"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            disabled={disabled}
            checked={channel.channelEnabled}
            onChange={(e) => onChange({ channelEnabled: e.target.checked })}
          />
          <Power size={12} />
        </label>
      </button>
      {expanded && (
        <div className="ad9959-channel-body">
          <label className="ad9959-row">
            <span>Mode</span>
            <select
              disabled={disabled}
              value={channel.mode}
              onChange={(e) => setMode(e.target.value as DdsChannelMode)}
            >
              <option value="single_tone">single_tone</option>
              <option value="sweep">sweep (DRG)</option>
              <option value="fm">FM (profile-pin freq)</option>
              <option value="pm">PM (profile-pin phase)</option>
              <option value="am">AM (profile-pin amp)</option>
            </select>
          </label>

          {!isSweep && !isMod && (
            <>
              <label className="ad9959-row">
                <span>frequency (MHz)</span>
                <input
                  type="number"
                  step={0.001}
                  min={0}
                  disabled={disabled}
                  value={channel.frequencyMhz}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    onChange({ frequencyMhz: v });
                  }}
                />
              </label>
              <label className="ad9959-row">
                <span>phase (deg)</span>
                <input
                  type="number"
                  step={0.1}
                  disabled={disabled}
                  value={channel.phaseDeg}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    onChange({ phaseDeg: v });
                  }}
                />
              </label>
              <label className="ad9959-row">
                <span>amplitude (0..1)</span>
                <input
                  type="number"
                  step={0.01}
                  min={0}
                  max={1}
                  disabled={disabled}
                  value={channel.amplitudeScale}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    onChange({ amplitudeScale: Math.max(0, Math.min(1, v)) });
                  }}
                />
              </label>
            </>
          )}

          {isSweep && sweep && (
            <>
              <label className="ad9959-row">
                <span>sweep target</span>
                <select
                  disabled={disabled}
                  value={sweep.target}
                  onChange={(e) => updateSweep({ target: e.target.value as DdsSweepTarget })}
                >
                  <option value="frequency">frequency</option>
                  <option value="phase">phase</option>
                  <option value="amplitude">amplitude</option>
                </select>
              </label>
              <label className="ad9959-row">
                <span>start</span>
                <input
                  type="number"
                  step={0.01}
                  disabled={disabled}
                  value={sweep.start}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    updateSweep({ start: v });
                  }}
                />
              </label>
              <label className="ad9959-row">
                <span>end</span>
                <input
                  type="number"
                  step={0.01}
                  disabled={disabled}
                  value={sweep.end}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    updateSweep({ end: v });
                  }}
                />
              </label>
              <label className="ad9959-row">
                <span>RU rate (MHz/µs)</span>
                <input
                  type="number"
                  step={0.001}
                  min={0}
                  disabled={disabled}
                  value={sweep.rampUpRate / 1e12}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v <= 0) return;
                    updateSweep({ rampUpRate: v * 1e12 });
                  }}
                />
              </label>
              <label className="ad9959-row">
                <span>RD rate (MHz/µs)</span>
                <input
                  type="number"
                  step={0.001}
                  min={0}
                  disabled={disabled}
                  value={sweep.rampDownRate / 1e12}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v <= 0) return;
                    updateSweep({ rampDownRate: v * 1e12 });
                  }}
                />
              </label>
              <div className="ad9959-row" style={{ gap: 12 }}>
                <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={sweep.noDwellLow}
                    onChange={(e) => updateSweep({ noDwellLow: e.target.checked })}
                  />
                  no_dwell_low
                </label>
                <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={sweep.noDwellHigh}
                    onChange={(e) => updateSweep({ noDwellHigh: e.target.checked })}
                  />
                  no_dwell_high
                </label>
              </div>
              <SweepPreview sweep={sweep} />
            </>
          )}

          {isMod && (
            <>
              <label className="ad9959-row">
                <span>Modulation levels</span>
                <select
                  disabled={disabled}
                  value={channel.modulationLevels}
                  onChange={(e) =>
                    setModLevels(Number(e.target.value) as DdsModulationLevels)
                  }
                >
                  <option value={2}>2-level (P0)</option>
                  <option value={4}>4-level (P0..P1)</option>
                  <option value={8}>8-level (P0..P2)</option>
                  <option value={16}>16-level (P0..P3)</option>
                </select>
              </label>
              <ProfilesEditor
                mode={channel.mode as "fm" | "pm" | "am"}
                levels={channel.modulationLevels}
                profiles={normalizedProfiles}
                disabled={disabled}
                onUpdate={updateProfile}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================== */
/* Profiles editor (FM / PM / AM)                                  */
/* ============================================================== */

function ProfilesEditor({
  mode,
  levels,
  profiles,
  disabled,
  onUpdate,
}: {
  mode: "fm" | "pm" | "am";
  levels: DdsModulationLevels;
  profiles: DdsProfile[];
  disabled: boolean;
  onUpdate: (idx: number, patch: Partial<DdsProfile>) => void;
}) {
  const pinCount = Math.log2(levels);
  const label =
    mode === "fm" ? "freq (MHz)" : mode === "pm" ? "phase (deg)" : "amp (0..1)";
  return (
    <div className="ad9959-profiles">
      <div className="ad9959-profiles-header">
        <span>idx · P{pinCount - 1}..P0</span>
        <span>{label}</span>
      </div>
      {profiles.slice(0, levels).map((p, i) => {
        const pinBits = i.toString(2).padStart(pinCount, "0");
        const value =
          mode === "fm"
            ? p.frequencyMhz ?? 0
            : mode === "pm"
              ? p.phaseDeg ?? 0
              : p.amplitudeScale ?? 0;
        return (
          <div key={i} className="ad9959-profile-row">
            <code className="ad9959-profile-idx">
              {i}{" · "}{pinBits}
            </code>
            <input
              type="number"
              step={mode === "am" ? 0.01 : mode === "fm" ? 0.001 : 0.1}
              min={mode === "am" ? 0 : undefined}
              max={mode === "am" ? 1 : undefined}
              disabled={disabled}
              value={value}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v)) return;
                if (mode === "fm") onUpdate(i, { frequencyMhz: v });
                else if (mode === "pm") onUpdate(i, { phaseDeg: v });
                else onUpdate(i, { amplitudeScale: Math.max(0, Math.min(1, v)) });
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================== */
/* Sweep waveform preview                                          */
/* ============================================================== */

/** One-cycle visualisation of a DDS linear sweep. Shape always rises
 *  then falls (low → high → low) — start/end labels indicate which
 *  numerical extreme is the configured `start`. Segment widths reflect
 *  the relative rates: slower ramp → wider segment. Dwell plateaus are
 *  drawn only when `no_dwell_low / no_dwell_high` are off. */
function SweepPreview({ sweep }: { sweep: DdsSweepConfig }) {
  const w = 220;
  const h = 56;
  const padX = 6;
  const padY = 14; // leave room for top + bottom labels
  const innerW = w - 2 * padX;
  const innerH = h - 2 * padY;
  const yTop = padY;
  const yBottom = padY + innerH;

  const dwellLowW = sweep.noDwellLow ? 0 : Math.max(6, innerW * 0.08);
  const dwellHighW = sweep.noDwellHigh ? 0 : Math.max(6, innerW * 0.08);
  const rampTotal = Math.max(20, innerW - dwellLowW - dwellHighW);
  const invUp = 1 / Math.max(1e-12, sweep.rampUpRate);
  const invDown = 1 / Math.max(1e-12, sweep.rampDownRate);
  const invSum = invUp + invDown;
  const rampUpW = invSum > 0 ? rampTotal * (invUp / invSum) : rampTotal / 2;
  const rampDownW = rampTotal - rampUpW;

  let x = padX;
  const pts: string[] = [];
  pts.push(`${x},${yBottom}`);
  x += dwellLowW;
  pts.push(`${x},${yBottom}`);
  x += rampUpW;
  pts.push(`${x},${yTop}`);
  x += dwellHighW;
  pts.push(`${x},${yTop}`);
  x += rampDownW;
  pts.push(`${x},${yBottom}`);

  const startIsLow = sweep.start <= sweep.end;
  const lo = Math.min(sweep.start, sweep.end);
  const hi = Math.max(sweep.start, sweep.end);
  const unit = sweep.target === "frequency" ? "MHz" : sweep.target === "phase" ? "°" : "";

  return (
    <svg
      width={w}
      height={h}
      style={{
        display: "block",
        marginTop: 6,
        background: "rgba(255, 255, 255, 0.03)",
        borderRadius: 3,
      }}
    >
      <polyline points={pts.join(" ")} stroke="#7dd3fc" strokeWidth={1.5} fill="none" />
      <text
        x={padX}
        y={yBottom + 11}
        fontSize={9}
        fill="rgba(255,255,255,0.55)"
      >
        {lo.toFixed(2)}{unit} ({startIsLow ? "start" : "end"})
      </text>
      <text
        x={w - padX}
        y={yTop - 3}
        fontSize={9}
        fill="rgba(255,255,255,0.55)"
        textAnchor="end"
      >
        {hi.toFixed(2)}{unit} ({startIsLow ? "end" : "start"})
      </text>
    </svg>
  );
}
