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
import { Clock, Code2, Download, Plus, Save, Trash2, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { compileTimingProgramsApi } from "../api/client";
import { useSceneStore } from "../store/sceneStore";
import type {
  TimingInterval,
  TimingProgram,
  TimingProgramCompile,
  TimingProgramKind,
} from "../types/digitalTwin";
import { FloatingPanel } from "./workspace/FloatingPanel";

const N_CHANNELS = 24;
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

function programMaxEnd(p: TimingProgram): number {
  let max = 0;
  for (const iv of p.intervals ?? []) {
    if (iv.spinCoreEndNs > max) max = iv.spinCoreEndNs;
  }
  return max;
}

export function PulseTimingPanel() {
  const programs = useSceneStore((s) => s.scene.timingPrograms) ?? [];
  const createProgram = useSceneStore((s) => s.createTimingProgram);
  const updateProgram = useSceneStore((s) => s.updateTimingProgram);
  const deleteProgram = useSceneStore((s) => s.deleteTimingProgram);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compiled, setCompiled] = useState<TimingProgramCompile | null>(null);
  const [compiling, setCompiling] = useState(false);

  const sortedPrograms = useMemo(() => {
    return [...programs].sort((a, b) => {
      const ach = a.channelIndex ?? Number.MAX_SAFE_INTEGER;
      const bch = b.channelIndex ?? Number.MAX_SAFE_INTEGER;
      if (ach !== bch) return ach - bch;
      return (a.name ?? "").localeCompare(b.name ?? "");
    });
  }, [programs]);

  const selected = selectedId
    ? programs.find((p) => p.id === selectedId) ?? null
    : null;

  const onCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const program = await createProgram({
        name: `Program ${programs.length + 1}`,
        kind: "TTL",
        intervals: [],
      });
      setSelectedId(program.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm("Delete this TimingProgram? This cannot be undone.")) return;
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

        {/* Catalog --------------------------------------------------- */}
        <section className="pt-catalog">
          <header className="pt-catalog-header">
            <span className="pt-catalog-title">TimingPrograms</span>
            <div className="pt-catalog-actions">
              <button
                type="button"
                className="electronics-btn primary"
                onClick={onCreate}
                disabled={busy}
              >
                <Plus size={12} /> New
              </button>
              <button
                type="button"
                className="electronics-btn"
                onClick={onCompile}
                disabled={compiling}
                title="Compile all channel-bound programs into a SpinCore opcode stream"
              >
                <Code2 size={12} /> {compiling ? "Compiling…" : "Compile"}
              </button>
            </div>
          </header>
          <table className="pt-table">
            <thead>
              <tr>
                <th>Ch</th>
                <th>Name</th>
                <th>Kind</th>
                <th>Intervals</th>
                <th>Inv</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sortedPrograms.length === 0 && (
                <tr className="pt-empty-row">
                  <td colSpan={6}>No programs yet. Click + New to create one.</td>
                </tr>
              )}
              {sortedPrograms.map((p) => (
                <tr
                  key={p.id}
                  className={p.id === selectedId ? "pt-row-selected" : ""}
                  onClick={() => setSelectedId(p.id)}
                >
                  <td className="pt-ch">{p.channelIndex ?? "—"}</td>
                  <td>{p.name || "(unnamed)"}</td>
                  <td>{p.kind}</td>
                  <td>{(p.intervals ?? []).length}</td>
                  <td>{p.invert ? "✓" : ""}</td>
                  <td className="pt-row-actions">
                    <button
                      type="button"
                      className="electronics-btn icon"
                      title="Delete program"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDelete(p.id);
                      }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Editor --------------------------------------------------- */}
        {selected && (
          <ProgramEditor
            key={selected.id}
            program={selected}
            onPatch={patchSelected}
            allPrograms={programs}
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

function ProgramEditor({
  program,
  onPatch,
  allPrograms,
}: {
  program: TimingProgram;
  onPatch: (patch: Partial<TimingProgram>) => Promise<void>;
  allPrograms: TimingProgram[];
}) {
  const [name, setName] = useState(program.name ?? "");
  const [pendingChannel, setPendingChannel] = useState<string>(
    program.channelIndex === null ? "" : String(program.channelIndex),
  );
  useEffect(() => {
    setName(program.name ?? "");
    setPendingChannel(
      program.channelIndex === null ? "" : String(program.channelIndex),
    );
  }, [program.id, program.name, program.channelIndex]);

  const channelInUse = useMemo(() => {
    const map = new Set<number>();
    for (const p of allPrograms) {
      if (p.id !== program.id && p.channelIndex !== null) map.add(p.channelIndex);
    }
    return map;
  }, [allPrograms, program.id]);

  const commitName = async () => {
    if (name === (program.name ?? "")) return;
    await onPatch({ name: name || null });
  };

  const commitChannel = async () => {
    const next =
      pendingChannel.trim() === "" ? null : Number(pendingChannel);
    if (next === program.channelIndex) return;
    if (next !== null && (Number.isNaN(next) || next < 0 || next >= N_CHANNELS)) {
      setPendingChannel(
        program.channelIndex === null ? "" : String(program.channelIndex),
      );
      return;
    }
    await onPatch({ channelIndex: next });
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

  const maxEnd = Math.max(programMaxEnd(program), 1000);

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
          />
        </label>
        <label>
          Kind
          <select
            value={program.kind}
            onChange={(e) => void onPatch({ kind: e.target.value as TimingProgramKind })}
          >
            <option value="TTL">TTL gate</option>
            <option value="Trigger">Trigger</option>
          </select>
        </label>
        <label>
          PB channel
          <select
            value={pendingChannel}
            onChange={(e) => setPendingChannel(e.target.value)}
            onBlur={commitChannel}
          >
            <option value="">— unbound —</option>
            {Array.from({ length: N_CHANNELS }, (_, i) => (
              <option
                key={i}
                value={String(i)}
                disabled={channelInUse.has(i)}
              >
                {`ch${i}${channelInUse.has(i) ? " (taken)" : ""}`}
              </option>
            ))}
          </select>
        </label>
        <label className="pt-editor-invert">
          <input
            type="checkbox"
            checked={program.invert}
            onChange={(e) => void onPatch({ invert: e.target.checked })}
          />
          Invert (active-low)
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

      <IntervalsTimeline
        intervals={program.intervals ?? []}
        maxEnd={maxEnd}
        onDelete={deleteInterval}
      />

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

function IntervalsTimeline({
  intervals,
  maxEnd,
  onDelete,
}: {
  intervals: TimingInterval[];
  maxEnd: number;
  onDelete: (index: number) => void;
}) {
  const width = 600;
  const height = 36;
  const padding = 6;
  const usable = width - padding * 2;
  const scale = (ns: number) => padding + (ns / maxEnd) * usable;

  return (
    <svg className="pt-timeline" width={width} height={height}>
      <rect
        x={padding}
        y={padding}
        width={usable}
        height={height - padding * 2}
        className="pt-timeline-track"
      />
      {intervals.map((iv, i) => {
        const x = scale(iv.spinCoreStartNs);
        const w = Math.max(2, scale(iv.spinCoreEndNs) - x);
        return (
          <g key={i} className="pt-timeline-interval">
            <rect
              x={x}
              y={padding}
              width={w}
              height={height - padding * 2}
            />
            <title>{`#${i}: ${fmtNs(iv.spinCoreStartNs)} → ${fmtNs(iv.spinCoreEndNs)} (${fmtNs(iv.spinCoreEndNs - iv.spinCoreStartNs)})`}</title>
            <rect
              x={x}
              y={padding}
              width={w}
              height={height - padding * 2}
              fill="transparent"
              onDoubleClick={() => onDelete(i)}
            />
          </g>
        );
      })}
    </svg>
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
