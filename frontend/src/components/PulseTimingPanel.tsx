/**
 * Pulse & Timing — merged TimingProgram catalog + timeline editor.
 *
 * Replaces the pre-0046 split between TimingEditorPanel (per-component
 * QM timeline) and PulseBlasterPanel (24-row channel grid). TimingPrograms
 * are now top-level catalog rows with their own ``id``, ``kind`` (TTL /
 * Trigger), optional ``channelIndex`` binding to a PB hardware line, and a
 * list of HIGH ``intervals``.
 *
 * Two stacked sections:
 *   1. Catalog list — every program in the DB, sortable, +Add to create.
 *   2. Timeline editor — for the selected program: pick kind / channel /
 *      invert + scroll an SVG timeline of HIGH intervals (drag-add,
 *      click-delete).
 *
 * Plus a Compile to spinapi action that calls /api/timing-programs/compile
 * and lets the user copy / download the resulting Python source.
 */
import { Clock, Code2, Download, Plus, Trash2, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { compileTimingProgramsApi } from "../api/client";
import { useSceneStore } from "../store/sceneStore";
import type {
  ProgrammablePulseGeneratorParams,
  TimingInterval,
  TimingProgram,
  TimingProgramCompile,
} from "../types/digitalTwin";
import { FloatingPanel } from "./workspace/FloatingPanel";

const TIMING_RESOLUTION_NS = 10;

function snap10ns(value: number): number {
  return Math.round(value / TIMING_RESOLUTION_NS) * TIMING_RESOLUTION_NS;
}

function fmtNs(value: number): string {
  if (value === 0) return "0";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(3)} ms`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(3)} µs`;
  return `${value.toFixed(0)} ns`;
}

export function PulseTimingPanel() {
  const programs = useSceneStore((s) => s.scene.timingPrograms) ?? [];
  const physicsElements = useSceneStore((s) => s.scene.physicsElements);
  const objects = useSceneStore((s) => s.scene.objects);
  const updateProgram = useSceneStore((s) => s.updateTimingProgram);
  const deleteProgram = useSceneStore((s) => s.deleteTimingProgram);
  const updateSceneObject = useSceneStore((s) => s.updateSceneObject);

  /** Resolve the PPG SceneObject (if any) that owns a given TimingProgram.
   *  Used to read & write the user-facing channel name from a single
   *  source of truth — the PPG's SceneObject.name. Returns null for
   *  orphan programs (no bound PPG). */
  const ppgObjectForProgram = useMemo(() => {
    const objById = new Map(objects.map((o) => [o.id, o]));
    const out = new Map<string, { objectId: string; name: string }>();
    for (const pe of physicsElements) {
      if (pe.elementKind !== "programmable_pulse_generator") continue;
      const programId = (pe.kindParams as { timingProgramId?: string } | undefined)
        ?.timingProgramId;
      if (typeof programId !== "string" || !programId) continue;
      const obj = objById.get(pe.objectId);
      if (!obj) continue;
      out.set(programId, { objectId: pe.objectId, name: obj.name });
    }
    return out;
  }, [objects, physicsElements]);

  /** Effective display name for a program — prefers the bound PPG
   *  SceneObject.name (the spec's single source of truth) and falls
   *  back to TimingProgram.name for orphan programs. */
  const effectiveNameOf = (program: TimingProgram): string =>
    ppgObjectForProgram.get(program.id)?.name ?? program.name ?? "";

  const upsertOpticalElement = useSceneStore((s) => s.upsertOpticalElement);

  /** PhysicsElement (and its kind_params) for the PPG bound to a given
   *  program. Used to read & write the PPG's `restState`. Returns null
   *  for orphan programs (no PPG cabled to a ttl_in / trigger_in port). */
  const ppgPhysicsForProgram = useMemo(() => {
    const out = new Map<string, { objectId: string; params: ProgrammablePulseGeneratorParams }>();
    for (const pe of physicsElements) {
      if (pe.elementKind !== "programmable_pulse_generator") continue;
      const params = pe.kindParams as ProgrammablePulseGeneratorParams;
      if (typeof params.timingProgramId !== "string" || !params.timingProgramId) continue;
      out.set(params.timingProgramId, { objectId: pe.objectId, params });
    }
    return out;
  }, [physicsElements]);

  /** Resolve the rest level the channel sits at OUTSIDE any interval.
   *  Falls back to "LOW" for orphan programs so the rest-pill toggle
   *  stays hidden / inert without a PPG to write to. */
  const restStateOf = (program: TimingProgram): "HIGH" | "LOW" => {
    const ppg = ppgPhysicsForProgram.get(program.id);
    return ppg?.params.restState === "HIGH" ? "HIGH" : "LOW";
  };

  /** Commit a new rest state to the bound PPG's kind_params. The XOR
   *  in `rfPropagation.ppgChannelIsHighAt` picks the change up live —
   *  no extra invalidation needed. */
  const toggleRestState = (program: TimingProgram, next: "HIGH" | "LOW"): void => {
    const ppg = ppgPhysicsForProgram.get(program.id);
    if (!ppg) return;
    setError(null);
    void upsertOpticalElement({
      objectId: ppg.objectId,
      elementKind: "programmable_pulse_generator",
      kindParams: { ...ppg.params, restState: next },
    }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  /** Edit handler — writes to the bound PPG SceneObject.name when one
   *  exists (cascading through the WS broadcast so RF Link panel
   *  updates too); also mirrors the new name to TimingProgram.name so
   *  the compile output keeps a recognisable label and orphan programs
   *  remain editable. */
  const renameChannel = async (program: TimingProgram, nextName: string): Promise<void> => {
    setError(null);
    try {
      const bound = ppgObjectForProgram.get(program.id);
      const trimmed = nextName.trim();
      const value = trimmed.length > 0 ? trimmed : null;
      if (bound && bound.name !== (value ?? "")) {
        await updateSceneObject(bound.objectId, { name: value ?? "" });
      }
      if ((program.name ?? null) !== value) {
        await updateProgram(program.id, { name: value });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compiled, setCompiled] = useState<TimingProgramCompile | null>(null);
  const [compiling, setCompiling] = useState(false);
  // Total timeline duration (ns). Stored in scene store so the
  // scrub-time bar shares the same right edge. Null = auto-fit to max
  // interval end across all programs. The MultiChannelTimeline always
  // honours max(userTotal, maxIntervalEnd, 1 µs floor) so a user-set
  // total can only EXTEND the axis beyond the data — never shrink
  // below it.
  const userTotalNs = useSceneStore((s) => s.userTimelineTotalNs);
  const setUserTotalNs = useSceneStore((s) => s.setUserTimelineTotalNs);

  /** Resolved total timeline duration. Never shrinks below the highest
   *  interval end (so user-set HIGH segments never get clipped) and
   *  enforces a 1 µs floor so an empty scene still has a usable axis. */
  const totalDurationNs = useMemo(() => {
    let maxEnd = 0;
    for (const p of programs) {
      for (const iv of p.intervals ?? []) {
        if (iv.spinCoreEndNs > maxEnd) maxEnd = iv.spinCoreEndNs;
      }
    }
    return Math.max(userTotalNs ?? 0, maxEnd, 1_000);
  }, [programs, userTotalNs]);

  const sortedPrograms = useMemo(() => {
    // Channel ordering: alembic 0051 dropped TimingProgram.channel_index;
    // channels are now positional. Sort by createdAt so older programs
    // get the lower CH numbers; fall back to id for ties.
    return [...programs].sort((a, b) => {
      const at = a.createdAt ?? "";
      const bt = b.createdAt ?? "";
      if (at !== bt) return at.localeCompare(bt);
      return a.id.localeCompare(b.id);
    });
  }, [programs]);

  const selected = selectedId
    ? programs.find((p) => p.id === selectedId) ?? null
    : null;

  const onDelete = async (id: string) => {
    if (!window.confirm("Delete this orphan TimingProgram? This cannot be undone.")) return;
    setBusy(true);
    setError(null);
    try {
      await deleteProgram(id);
      if (selectedId === id) setSelectedId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const patchSelected = async (patch: Partial<TimingProgram>) => {
    if (!selected) return;
    setError(null);
    try {
      await updateProgram(selected.id, patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onCompile = async () => {
    setCompiling(true);
    setError(null);
    try {
      const result = await compileTimingProgramsApi();
      setCompiled(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompiling(false);
    }
  };

  const onDownloadPython = () => {
    if (!compiled) return;
    const blob = new Blob([compiled.pythonSource], { type: "text/x-python" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pulse_blaster_program.py";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <FloatingPanel id="pulse-timing" title="Pulse & Timing" icon={<Clock size={14} />}>
      <div className="pulse-timing">
        {error && <div className="electronics-error">{error}</div>}

        {/* Total duration input ------------------------------------- */}
        <TotalDurationInput
          totalDurationNs={totalDurationNs}
          onCommit={(ns) => setUserTotalNs(ns)}
        />

        {/* Multi-channel timeline ------------------------------------ */}
        <MultiChannelTimeline
          programs={sortedPrograms}
          selectedProgramId={selectedId}
          onSelect={setSelectedId}
          nameOf={effectiveNameOf}
          restStateOf={restStateOf}
          onToggleRestState={toggleRestState}
          totalDurationNs={totalDurationNs}
          onPatch={(programId, patch) => {
            setError(null);
            void updateProgram(programId, patch).catch((err) => {
              setError(err instanceof Error ? err.message : String(err));
            });
          }}
        />

        {/* Catalog --------------------------------------------------- */}
        {/* Editor --------------------------------------------------- */}
        {selected && (
          <ProgramEditor
            key={selected.id}
            program={selected}
            effectiveName={effectiveNameOf(selected)}
            boundToPpg={ppgObjectForProgram.has(selected.id)}
            onRename={(name) => void renameChannel(selected, name)}
            onPatch={patchSelected}
          />
        )}

        {/* Compile output -------------------------------------------- */}
        {compiled && (
          <section className="pt-compile-result">
            <header className="pt-compile-meta">
              <span>
                <strong>{compiled.instructions.length}</strong> instructions ·{" "}
                <strong>{compiled.boundProgramCount}</strong> bound programs ·{" "}
                <strong>{compiled.totalDurationNs.toFixed(0)}</strong> ns total
              </span>
              <button
                type="button"
                className="electronics-btn"
                onClick={onDownloadPython}
              >
                <Download size={12} /> .py
              </button>
            </header>
            <details className="pt-compile-source">
              <summary>spinapi Python source</summary>
              <pre>{compiled.pythonSource}</pre>
            </details>
          </section>
        )}
      </div>
    </FloatingPanel>
  );
}

// ---------------------------------------------------------------------------
// Total duration input — sets the right edge of the timeline. Auto-fits
// to max(end) so a user-set value can only EXTEND the axis (never clip
// existing HIGH intervals). Accepts free-form "100 ns" / "1.5 us" /
// "2 ms" / "0.5 s" input; falls back to the auto-fit value on parse fail.
// ---------------------------------------------------------------------------

function parseDurationToNs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^\s*([0-9]*\.?[0-9]+)\s*(ns|us|µs|ms|s)?\s*$/i);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  const unit = (match[2] ?? "ns").toLowerCase().replace("µs", "us");
  const mul =
    unit === "ns" ? 1
    : unit === "us" ? 1_000
    : unit === "ms" ? 1_000_000
    : 1_000_000_000;
  return num * mul;
}

function TotalDurationInput({
  totalDurationNs,
  onCommit,
}: {
  totalDurationNs: number;
  onCommit: (ns: number | null) => void;
}) {
  const [draft, setDraft] = useState(() => fmtNs(totalDurationNs));
  useEffect(() => {
    setDraft(fmtNs(totalDurationNs));
  }, [totalDurationNs]);

  const commit = () => {
    const parsed = parseDurationToNs(draft);
    if (parsed == null) {
      setDraft(fmtNs(totalDurationNs));
      return;
    }
    onCommit(parsed);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 8px",
        fontSize: 10,
        color: "#3a3a44",
        background: "#e8e8ee",
        border: "1px solid #cfd2d8",
        borderRadius: 4,
      }}
    >
      <span style={{ color: "#5a5a64", fontWeight: 600 }}>Total</span>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(fmtNs(totalDurationNs));
        }}
        style={{
          width: 80,
          background: "#fafafc",
          color: "#1c1c22",
          border: "1px solid #a0a0ac",
          borderRadius: 2,
          padding: "2px 5px",
          fontSize: 11,
        }}
        title="Total timeline duration. Accepts ns / us / ms / s."
      />
      <span style={{ color: "#6a6a76" }}>
        floor is max HIGH end (timeline never clips existing intervals)
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-channel timeline — every TimingProgram stacked as one row, HIGH
// intervals shown as coloured blocks against an implicit LOW background.
// Click an empty cell to spawn a new HIGH interval (default 100 ns wide
// at the click point, snapped to TIMING_RESOLUTION_NS, refused if it
// would overlap an existing interval on that row). Click an interval
// block to delete it (with confirm). Clicking anywhere on a row also
// selects that program so the existing per-program editor below stays
// in sync.
// ---------------------------------------------------------------------------

const TIMELINE_LEFT_COL_PX = 124;
const REST_PILL_W_PX = 22;
const REST_PILL_X_PX = 96;
const TIMELINE_ROW_H_PX = 26;
const TIMELINE_HEADER_H_PX = 22;
const TIMELINE_TIME_PAD_PX = 8;
const TIMELINE_DEFAULT_NEW_INTERVAL_NS = 100;
const CHANNEL_COLORS = [
  "#60a5fa", "#34d399", "#f472b6", "#fbbf24", "#a78bfa", "#22d3ee",
  "#f87171", "#fb923c", "#4ade80", "#c084fc", "#facc15", "#38bdf8",
];

function programColor(_p: TimingProgram, idx: number): string {
  // Positional colour cycle — alembic 0051 removed channel_index so we
  // use the row's position in the sorted list as the colour seed.
  return CHANNEL_COLORS[((idx % CHANNEL_COLORS.length) + CHANNEL_COLORS.length) % CHANNEL_COLORS.length];
}

function MultiChannelTimeline({
  programs,
  selectedProgramId,
  onSelect,
  onPatch,
  nameOf,
  restStateOf,
  onToggleRestState,
  totalDurationNs,
}: {
  programs: TimingProgram[];
  selectedProgramId: string | null;
  onSelect: (id: string) => void;
  onPatch: (programId: string, patch: Partial<TimingProgram>) => void;
  /** Resolve the user-facing channel name for a program — defaults to
   *  ``program.name`` but the parent panel overrides this with the
   *  bound PPG SceneObject.name (single source of truth). */
  nameOf: (program: TimingProgram) => string;
  /** Per-program resting/default level (the level the channel sits at
   *  OUTSIDE any HIGH interval and at scrub-stop). Resolved from the
   *  bound PPG's `kindParams.restState`; orphan programs always read
   *  as "LOW". */
  restStateOf: (program: TimingProgram) => "HIGH" | "LOW";
  /** Flip the bound PPG's rest_state. Orphan programs (no PPG) are
   *  no-op — the panel hides / disables the pill for those rows. */
  onToggleRestState: (program: TimingProgram, next: "HIGH" | "LOW") => void;
  /** Right edge of the timeline (ns). Always >= the largest interval
   *  end so HIGH blocks never get clipped. */
  totalDurationNs: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);

  // Section boundaries — every interval start/end across every program
  // becomes a vertical divider, with 0 and totalDurationNs always
  // present as the outer endpoints. The resulting variable-time-width
  // sections are then rendered as EQUAL-WIDTH visual columns so even a
  // 10 ns section is clearly clickable next to a 1 ms one (matches the
  // SpinCore reference panel's behaviour).
  const sectionBoundaries = useMemo(() => {
    const edges = new Set<number>([0, totalDurationNs]);
    for (const p of programs) {
      for (const iv of p.intervals ?? []) {
        if (iv.spinCoreStartNs > 0 && iv.spinCoreStartNs < totalDurationNs) {
          edges.add(iv.spinCoreStartNs);
        }
        if (iv.spinCoreEndNs > 0 && iv.spinCoreEndNs < totalDurationNs) {
          edges.add(iv.spinCoreEndNs);
        }
      }
    }
    return Array.from(edges).sort((a, b) => a - b);
  }, [programs, totalDurationNs]);

  if (programs.length === 0) {
    return (
      <section
        className="pt-multichannel"
        style={{ padding: "8px 4px", fontSize: 11, color: "#9a9aa6" }}
      >
        No channels yet. Right-click a ttl_in / trigger_in port in the RF Link panel
        to spawn one (new channels default to 0–1 µs LOW).
      </section>
    );
  }

  const sectionCount = Math.max(1, sectionBoundaries.length - 1);
  // Equal-width columns. Cap total area at ~ 720 px to keep the panel
  // narrow at low section counts; grow indefinitely when many edges
  // exist (the outer wrapper scrolls horizontally).
  const SECTION_W_PX = sectionCount <= 8 ? Math.max(60, Math.floor(720 / sectionCount)) : 80;
  const TIMELINE_AREA_W_PX = SECTION_W_PX * sectionCount;
  const totalW = TIMELINE_LEFT_COL_PX + TIMELINE_AREA_W_PX + TIMELINE_TIME_PAD_PX;
  const totalH = TIMELINE_HEADER_H_PX + programs.length * TIMELINE_ROW_H_PX;

  const sectionXLeft = (idx: number): number =>
    TIMELINE_LEFT_COL_PX + idx * SECTION_W_PX;

  /** Find which section's [startNs, endNs) contains ``ns``. Used by
   *  click-to-add to map cursor X back to a real time value. */
  const sectionIdxAtNs = (ns: number): number => {
    if (ns <= sectionBoundaries[0]) return 0;
    for (let i = 0; i < sectionCount; i += 1) {
      if (sectionBoundaries[i + 1] > ns) return i;
    }
    return sectionCount - 1;
  };

  /** Pixel X → real ns. Linear within the clicked section. */
  const xToNs = (x: number): number => {
    if (sectionCount === 0) return 0;
    const relPx = x - TIMELINE_LEFT_COL_PX;
    const idx = Math.min(
      sectionCount - 1,
      Math.max(0, Math.floor(relPx / SECTION_W_PX)),
    );
    const within = (relPx - idx * SECTION_W_PX) / SECTION_W_PX;
    const startNs = sectionBoundaries[idx];
    const endNs = sectionBoundaries[idx + 1];
    return startNs + Math.max(0, Math.min(1, within)) * (endNs - startNs);
  };

  /** Find the boundary index whose ns value === target (or the
   *  nearest boundary <= target). Used to align HIGH blocks to
   *  section gridlines. */
  const boundaryIdxNearest = (ns: number): number => {
    if (ns <= sectionBoundaries[0]) return 0;
    if (ns >= sectionBoundaries[sectionBoundaries.length - 1]) {
      return sectionBoundaries.length - 1;
    }
    let lo = 0;
    let hi = sectionBoundaries.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sectionBoundaries[mid] === ns) return mid;
      if (sectionBoundaries[mid] < ns) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const snapNs = (ns: number) =>
    Math.round(ns / TIMING_RESOLUTION_NS) * TIMING_RESOLUTION_NS;

  const overlapsAny = (
    intervals: TimingInterval[],
    startNs: number,
    endNs: number,
  ): boolean =>
    intervals.some(
      (iv) => startNs < iv.spinCoreEndNs && endNs > iv.spinCoreStartNs,
    );

  return (
    <section className="pt-multichannel" style={{ paddingBottom: 8 }}>
      <header
        style={{
          padding: "4px 8px",
          fontSize: 10,
          color: "#5a5a64",
        }}
      >
        Click empty row → add HIGH · click block → delete · {sectionCount} section
        {sectionCount === 1 ? "" : "s"} · total {fmtNs(totalDurationNs)}
      </header>
      <div style={{ width: "100%", overflowX: "auto" }}>
        <svg
          ref={svgRef}
          width={totalW}
          height={totalH}
          style={{ display: "block", background: "#f5f5f8" }}
        >
          {/* Section background bands + per-section duration label */}
          {sectionBoundaries.slice(0, -1).map((startNs, idx) => {
            const endNs = sectionBoundaries[idx + 1];
            const x = sectionXLeft(idx);
            return (
              <g key={`section-${idx}-${startNs}`}>
                <rect
                  x={x}
                  y={0}
                  width={SECTION_W_PX}
                  height={totalH}
                  fill={idx % 2 === 0 ? "#fafafc" : "#eef0f4"}
                />
                <text
                  x={x + SECTION_W_PX / 2}
                  y={14}
                  fontSize={9}
                  fill="#3a3a44"
                  textAnchor="middle"
                  style={{ pointerEvents: "none" }}
                >
                  {fmtNs(endNs - startNs)}
                </text>
              </g>
            );
          })}
          {/* Vertical dashed gridlines at every section boundary */}
          {sectionBoundaries.map((boundaryNs, idx) => {
            const x = sectionXLeft(idx);
            return (
              <g key={`boundary-${idx}-${boundaryNs}`}>
                <line
                  x1={x}
                  y1={0}
                  x2={x}
                  y2={totalH}
                  stroke="#a0a0ac"
                  strokeDasharray="2 4"
                />
                <text
                  x={x + 2}
                  y={TIMELINE_HEADER_H_PX - 2}
                  fontSize={8}
                  fill="#5a5a64"
                  style={{ pointerEvents: "none" }}
                >
                  {fmtNs(boundaryNs)}
                </text>
              </g>
            );
          })}
          {/* Left label column — slightly darker than the timeline body
              so the CH / PPG side-panel still reads as a distinct strip. */}
          <rect x={0} y={0} width={TIMELINE_LEFT_COL_PX} height={totalH} fill="#e0e2e8" />
          <line x1={TIMELINE_LEFT_COL_PX} y1={0} x2={TIMELINE_LEFT_COL_PX} y2={totalH} stroke="#9a9aa6" />

          {/* Per-program rows --------------------------------------- */}
          {programs.map((p, rowIdx) => {
            const rowY = TIMELINE_HEADER_H_PX + rowIdx * TIMELINE_ROW_H_PX;
            const isSelected = p.id === selectedProgramId;
            const color = programColor(p, rowIdx);
            const intervals = p.intervals ?? [];

            return (
              <g key={p.id}>
                <rect
                  x={TIMELINE_LEFT_COL_PX}
                  y={rowY}
                  width={TIMELINE_AREA_W_PX + TIMELINE_TIME_PAD_PX}
                  height={TIMELINE_ROW_H_PX}
                  fill={isSelected ? "rgba(96,147,255,0.15)" : "transparent"}
                  stroke="#cfd2d8"
                  strokeWidth={0.5}
                  style={{ cursor: "crosshair" }}
                  onClick={(e) => {
                    onSelect(p.id);
                    if (!svgRef.current) return;
                    const rect = svgRef.current.getBoundingClientRect();
                    const px = e.clientX - rect.left;
                    const centerNs = xToNs(px);
                    const halfW = TIMELINE_DEFAULT_NEW_INTERVAL_NS / 2;
                    const start = snapNs(Math.max(0, centerNs - halfW));
                    const end = snapNs(Math.min(totalDurationNs, start + TIMELINE_DEFAULT_NEW_INTERVAL_NS));
                    if (end <= start) return;
                    if (overlapsAny(intervals, start, end)) return;
                    const nextIntervals: TimingInterval[] = [
                      ...intervals,
                      { spinCoreStartNs: start, spinCoreEndNs: end },
                    ].sort((a, b) => a.spinCoreStartNs - b.spinCoreStartNs);
                    onPatch(p.id, { intervals: nextIntervals });
                  }}
                />
                <text
                  x={6}
                  y={rowY + TIMELINE_ROW_H_PX / 2 + 4}
                  fontSize={10}
                  fontWeight={600}
                  fill={isSelected ? "#0a0a10" : "#1c1c22"}
                  style={{ pointerEvents: "none" }}
                >
                  CH{rowIdx}
                </text>
                <text
                  x={32}
                  y={rowY + TIMELINE_ROW_H_PX / 2 + 4}
                  fontSize={9}
                  fill="#5a5a64"
                  style={{ pointerEvents: "none" }}
                >
                  {(nameOf(p) || "(unnamed)").slice(0, 10)}
                </text>
                {(() => {
                  // Rest-state pill: click to flip the bound PPG's
                  // rest level between HIGH and LOW. The XOR in
                  // rfPropagation picks the change up live, so the
                  // 3D viewer beam gating + RF Link cable activity
                  // both retrack within the next render frame.
                  const rest = restStateOf(p);
                  const isHigh = rest === "HIGH";
                  return (
                    <g
                      style={{ cursor: "pointer" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleRestState(p, isHigh ? "LOW" : "HIGH");
                      }}
                    >
                      <rect
                        x={REST_PILL_X_PX}
                        y={rowY + 4}
                        width={REST_PILL_W_PX}
                        height={TIMELINE_ROW_H_PX - 8}
                        rx={3}
                        fill={isHigh ? color : "#cfd2d8"}
                        stroke={isHigh ? "#0a0a10" : "#5a5a64"}
                        strokeWidth={0.5}
                      />
                      <text
                        x={REST_PILL_X_PX + REST_PILL_W_PX / 2}
                        y={rowY + TIMELINE_ROW_H_PX / 2 + 3}
                        fontSize={9}
                        fontWeight={700}
                        textAnchor="middle"
                        fill={isHigh ? "#0a0a10" : "#3a3a44"}
                        style={{ pointerEvents: "none" }}
                      >
                        {isHigh ? "H" : "L"}
                      </text>
                      <title>
                        Rest level (the channel's idle / scrub-stop state).
                        Click to flip between LOW and HIGH.
                      </title>
                    </g>
                  );
                })()}
                {intervals.map((iv, ivIdx) => {
                  // HIGH block spans whole sections (every interval edge
                  // is already a section boundary by construction).
                  const startIdx = sectionIdxAtNs(Math.max(0, iv.spinCoreStartNs));
                  const endIdx = boundaryIdxNearest(Math.min(totalDurationNs, iv.spinCoreEndNs));
                  if (endIdx <= startIdx) return null;
                  const x = sectionXLeft(startIdx);
                  const w = Math.max(2, sectionXLeft(endIdx) - x);
                  return (
                    <rect
                      key={`${p.id}-iv-${ivIdx}-${iv.spinCoreStartNs}`}
                      x={x}
                      y={rowY + 4}
                      width={w}
                      height={TIMELINE_ROW_H_PX - 8}
                      fill={color}
                      stroke={isSelected ? "#0a0a10" : "#5a5a64"}
                      strokeWidth={1}
                      rx={2}
                      style={{ cursor: "pointer" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(p.id);
                        const label = `${fmtNs(iv.spinCoreStartNs)} → ${fmtNs(iv.spinCoreEndNs)}`;
                        if (!window.confirm(`Delete HIGH interval ${label}?`)) return;
                        const next = intervals.filter((_, i) => i !== ivIdx);
                        onPatch(p.id, { intervals: next });
                      }}
                    >
                      <title>
                        {`HIGH ${fmtNs(iv.spinCoreStartNs)} → ${fmtNs(iv.spinCoreEndNs)} (${fmtNs(
                          iv.spinCoreEndNs - iv.spinCoreStartNs,
                        )})`}
                      </title>
                    </rect>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function ProgramEditor({
  program,
  effectiveName,
  boundToPpg,
  onRename,
  onPatch,
}: {
  program: TimingProgram;
  /** PPG SceneObject.name when bound, else program.name. Single source
   *  of truth for the user-facing channel label. */
  effectiveName: string;
  /** True when this program is bound to a PPG. The Name input writes
   *  to the PPG's SceneObject in that case (RF Link panel reflects it
   *  via the WS scene broadcast); orphan programs fall back to
   *  TimingProgram.name. */
  boundToPpg: boolean;
  onRename: (nextName: string) => void;
  onPatch: (patch: Partial<TimingProgram>) => Promise<void>;
}) {
  const [name, setName] = useState(effectiveName);
  useEffect(() => {
    setName(effectiveName);
  }, [program.id, effectiveName]);

  const commitName = () => {
    if (name === effectiveName) return;
    onRename(name);
  };

  const addInterval = async () => {
    const intervals = [...(program.intervals ?? [])];
    const lastEnd = intervals.length
      ? intervals[intervals.length - 1].spinCoreEndNs
      : 0;
    const next: TimingInterval = {
      spinCoreStartNs: snap10ns(lastEnd + 100),
      spinCoreEndNs: snap10ns(lastEnd + 1100),
    };
    intervals.push(next);
    await onPatch({ intervals });
  };

  const deleteInterval = async (index: number) => {
    const intervals = (program.intervals ?? []).filter((_, i) => i !== index);
    await onPatch({ intervals });
  };

  const editInterval = async (
    index: number,
    patch: Partial<TimingInterval>,
  ) => {
    const intervals = (program.intervals ?? []).map((iv, i) => {
      if (i !== index) return iv;
      return {
        spinCoreStartNs: snap10ns(patch.spinCoreStartNs ?? iv.spinCoreStartNs),
        spinCoreEndNs: snap10ns(patch.spinCoreEndNs ?? iv.spinCoreEndNs),
      };
    });
    await onPatch({ intervals });
  };

  return (
    <section className="pt-editor">
      <header className="pt-editor-header">
        <span className="pt-editor-title">
          <Zap size={12} /> Edit
        </span>
      </header>
      <div className="pt-editor-grid">
        <label>
          Name
          <input
            type="text"
            value={name}
            placeholder="(unnamed)"
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setName(effectiveName);
            }}
            title={
              boundToPpg
                ? "Channel name — synced with the PPG SceneObject and shown in the RF Link panel."
                : "Orphan program — name is local to this row (no PPG bound)."
            }
          />
        </label>
      </div>

      <header className="pt-intervals-header">
        <span>Intervals (HIGH durations)</span>
        <button
          type="button"
          className="electronics-btn primary"
          onClick={addInterval}
        >
          <Plus size={12} /> Interval
        </button>
      </header>

      <table className="pt-intervals-table">
        <thead>
          <tr>
            <th>#</th>
            <th>start</th>
            <th>end</th>
            <th>duration</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(program.intervals ?? []).map((iv, i) => (
            <tr key={`${iv.spinCoreStartNs}-${i}`}>
              <td>{i}</td>
              <td>
                <NumberInput
                  value={iv.spinCoreStartNs}
                  onCommit={(v) => void editInterval(i, { spinCoreStartNs: v })}
                />
              </td>
              <td>
                <NumberInput
                  value={iv.spinCoreEndNs}
                  onCommit={(v) => void editInterval(i, { spinCoreEndNs: v })}
                />
              </td>
              <td>{fmtNs(iv.spinCoreEndNs - iv.spinCoreStartNs)}</td>
              <td>
                <button
                  type="button"
                  className="electronics-btn icon"
                  onClick={() => void deleteInterval(i)}
                  title="Delete this interval"
                >
                  <Trash2 size={11} />
                </button>
              </td>
            </tr>
          ))}
          {(program.intervals ?? []).length === 0 && (
            <tr className="pt-empty-row">
              <td colSpan={5}>
                No intervals — the output stays LOW. Click + Interval to add a HIGH window.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function NumberInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const lastCommittedRef = useRef(value);
  useEffect(() => {
    if (value !== lastCommittedRef.current) {
      setDraft(String(value));
      lastCommittedRef.current = value;
    }
  }, [value]);
  return (
    <input
      type="number"
      step={TIMING_RESOLUTION_NS}
      min={0}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const v = Number(draft);
        if (!Number.isFinite(v)) {
          setDraft(String(value));
          return;
        }
        if (v !== value) {
          lastCommittedRef.current = v;
          onCommit(v);
        }
      }}
    />
  );
}
