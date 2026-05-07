/**
 * QM — timeline editor floating panel.
 *
 * Hardware-aware per-component sequence editor. The panel binds to the
 * currently-selected Component (or the Component of the selected Object) and
 * shows a different control palette depending on what the hardware can do:
 *
 *   - laser_source / tapered_amplifier  → full timeline (any waveform_kind)
 *   - aom / eom WITH rf_driver_component_id  → full timeline incl. arbitrary
 *   - aom / eom WITHOUT rf driver  → on/off gates only
 *   - other components  → "no timing for this component" message
 *
 * 10 ns is the minimum block resolution (snapped both client- and server-side).
 */
import {
  CircleDot,
  Clock,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useSceneStore } from "../store/sceneStore";
import type {
  ComponentItem,
  SpinCoreStartMode,
  TimingBlock,
  TimingProgram,
  WaveformKind,
} from "../types/digitalTwin";
import { getComponentName } from "../utils/components";
import { FloatingPanel } from "./workspace/FloatingPanel";

const TIMING_RESOLUTION_NS = 10;

type CapabilityMode = "full" | "rf_arbitrary" | "gate_only" | "none";

function capabilityFor(
  component: ComponentItem | undefined,
  scene: {
    opticalElements: { objectId: string; elementKind: string; kindParams: Record<string, unknown> }[];
    objects: { id: string; componentId: string }[];
  },
): { mode: CapabilityMode; reason: string } {
  if (!component) return { mode: "none", reason: "Select a component to edit its timing." };
  // Per-object optical chain (alembic 0014): find any OE whose object
  // belongs to this component. First match wins.
  const objIds = new Set(scene.objects.filter((o) => o.componentId === component.id).map((o) => o.id));
  const element = scene.opticalElements.find((oe) => objIds.has(oe.objectId));
  const kind = element?.elementKind ?? component.componentType;
  if (kind === "laser_source" || kind === "tapered_amplifier") {
    return { mode: "full", reason: "Emitter — full waveform control." };
  }
  if (kind === "aom" || kind === "eom") {
    const rfId = (element?.kindParams ?? {})["rfDriverComponentId"] as string | null | undefined;
    if (rfId) return { mode: "rf_arbitrary", reason: "RF driver attached — arbitrary waveform available." };
    return { mode: "gate_only", reason: "No RF driver attached — on/off gating only." };
  }
  return { mode: "none", reason: `${kind} is a passive element; timing is not applicable.` };
}

function snap10ns(value: number): number {
  return Math.round(value / TIMING_RESOLUTION_NS) * TIMING_RESOLUTION_NS;
}

function fmtNs(value: number): string {
  if (value === 0) return "0";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(3)} ms`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(3)} µs`;
  return `${value.toFixed(0)} ns`;
}

type DraftBlock = Omit<TimingBlock, "id" | "programObjectId" | "createdAt" | "updatedAt">;

function emptyBlock(at: number = 0): DraftBlock {
  return {
    label: "",
    tStartNs: at,
    tEndNs: at + 1000,
    waveformKind: "const",
    params: { value: 1.0 },
    sortOrder: 0,
  };
}

function gateBlock(at: number = 0, on: boolean = true): DraftBlock {
  return {
    label: on ? "ON" : "OFF",
    tStartNs: at,
    tEndNs: at + 1000,
    waveformKind: on ? "gate_on" : "gate_off",
    params: {},
    sortOrder: 0,
  };
}

export function TimingEditorPanel() {
  const scene = useSceneStore((state) => state.scene);
  const selectedComponentId = useSceneStore((state) => state.selectedComponentId);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const upsertTimingProgram = useSceneStore((state) => state.upsertTimingProgram);
  const deleteTimingProgram = useSceneStore((state) => state.deleteTimingProgram);
  const runOpticalTransient = useSceneStore((state) => state.runOpticalTransient);
  const lastTransientRun = useSceneStore((state) => state.lastTransientRun);

  // Resolve which Object this panel is editing. Timing programs are
  // per-OBJECT now (alembic 0015); fall back to "first scene object of
  // selected component" when only a component template is selected.
  const selectedObject = scene.objects.find((o) => o.id === selectedObjectId);
  const fallbackObject = selectedObject
    ? null
    : selectedComponentId
      ? scene.objects.find((o) => o.componentId === selectedComponentId)
      : null;
  const editingObject = selectedObject ?? fallbackObject ?? null;
  const objectId = editingObject?.id ?? null;
  const componentId = editingObject?.componentId ?? selectedComponentId ?? null;
  const component = componentId ? scene.components.find((c) => c.id === componentId) : undefined;

  const capability = useMemo(
    () => capabilityFor(component, { opticalElements: scene.opticalElements, objects: scene.objects }),
    [component, scene.opticalElements, scene.objects],
  );

  const existingProgram: TimingProgram | undefined = useMemo(
    () =>
      objectId
        ? (scene.timingPrograms ?? []).find((p) => p.objectId === objectId)
        : undefined,
    [objectId, scene.timingPrograms],
  );

  // Local draft state — synced from existingProgram.
  const [name, setName] = useState("program");
  const [spinCoreStart, setSpinCoreStart] = useState<SpinCoreStartMode>("WAIT");
  const [durationNs, setDurationNs] = useState(0);
  const [blocks, setBlocks] = useState<DraftBlock[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (existingProgram) {
      setName(existingProgram.name);
      setSpinCoreStart(existingProgram.spinCoreStart);
      setDurationNs(existingProgram.durationNs);
      setBlocks(
        existingProgram.blocks.map((b) => ({
          label: b.label ?? "",
          tStartNs: b.tStartNs,
          tEndNs: b.tEndNs,
          waveformKind: b.waveformKind,
          params: b.params ?? {},
          sortOrder: b.sortOrder,
        })),
      );
    } else {
      setName("program");
      setSpinCoreStart("WAIT");
      setDurationNs(0);
      setBlocks([]);
    }
    setDirty(false);
    setError(null);
  }, [existingProgram?.objectId, existingProgram?.updatedAt]);

  const allowedKinds: WaveformKind[] = useMemo(() => {
    if (capability.mode === "gate_only") return ["gate_on", "gate_off"];
    if (capability.mode === "rf_arbitrary")
      return ["const", "linear_ramp", "arbitrary", "gate_on", "gate_off"];
    if (capability.mode === "full") return ["const", "linear_ramp", "gate_on", "gate_off"];
    return [];
  }, [capability.mode]);

  const sortedBlocks = useMemo(
    () =>
      blocks
        .map((block, origIndex) => ({ block, origIndex }))
        .sort((a, b) => a.block.tStartNs - b.block.tStartNs),
    [blocks],
  );

  // ─── Ruler drag-to-resize ────────────────────────────────────────────────
  // Refs for the timeline ruler and the in-flight drag op. The drag mutates
  // `blocks` directly via setBlocks each pointermove (so the bar follows the
  // cursor live); on pointerup we leave the dirty flag so Save persists.
  const rulerRef = useRef<HTMLDivElement | null>(null);
  type DragZone = "start" | "end" | "move";
  const dragStateRef = useRef<
    | {
        blockIndex: number;
        zone: DragZone;
        startClientX: number;
        startTStart: number;
        startTEnd: number;
      }
    | null
  >(null);

  const beginBarDrag = (
    event: React.PointerEvent,
    origIndex: number,
    zone: DragZone,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const block = blocks[origIndex];
    if (!block) return;
    dragStateRef.current = {
      blockIndex: origIndex,
      zone,
      startClientX: event.clientX,
      startTStart: block.tStartNs,
      startTEnd: block.tEndNs,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    document.body.classList.add("is-timing-bar-drag");
  };

  const onBarPointerMove = (event: React.PointerEvent) => {
    const drag = dragStateRef.current;
    if (!drag) return;
    const ruler = rulerRef.current;
    if (!ruler) return;
    const rect = ruler.getBoundingClientRect();
    if (rect.width <= 0) return;
    const totalSpan = Math.max(totalDuration, 1);
    const dx = event.clientX - drag.startClientX;
    const dtNs = snap10ns((dx / rect.width) * totalSpan);
    if (drag.zone === "start") {
      const next = Math.max(
        0,
        Math.min(drag.startTEnd - TIMING_RESOLUTION_NS, drag.startTStart + dtNs),
      );
      setBlocks((current) =>
        current.map((b, i) =>
          i === drag.blockIndex ? { ...b, tStartNs: snap10ns(next) } : b,
        ),
      );
      setDirty(true);
    } else if (drag.zone === "end") {
      const next = Math.max(drag.startTStart + TIMING_RESOLUTION_NS, drag.startTEnd + dtNs);
      setBlocks((current) =>
        current.map((b, i) =>
          i === drag.blockIndex ? { ...b, tEndNs: snap10ns(next) } : b,
        ),
      );
      setDirty(true);
    } else {
      // "move" — translate the whole block, keeping its duration.
      const dur = drag.startTEnd - drag.startTStart;
      const newStart = Math.max(0, drag.startTStart + dtNs);
      setBlocks((current) =>
        current.map((b, i) =>
          i === drag.blockIndex
            ? { ...b, tStartNs: snap10ns(newStart), tEndNs: snap10ns(newStart + dur) }
            : b,
        ),
      );
      setDirty(true);
    }
  };

  const endBarDrag = (event: React.PointerEvent) => {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    document.body.classList.remove("is-timing-bar-drag");
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  };

  const updateBlock = (index: number, patch: Partial<DraftBlock>) => {
    setBlocks((current) => {
      const next = [...current];
      next[index] = { ...next[index], ...patch };
      return next;
    });
    setDirty(true);
  };

  const addBlock = () => {
    const lastEnd = blocks.reduce((max, b) => Math.max(max, b.tEndNs), 0);
    const at = snap10ns(lastEnd);
    setBlocks((current) => [
      ...current,
      capability.mode === "gate_only" ? gateBlock(at, true) : emptyBlock(at),
    ]);
    setDirty(true);
  };

  const removeBlock = (index: number) => {
    setBlocks((current) => current.filter((_, i) => i !== index));
    setDirty(true);
  };

  const onSave = async () => {
    if (!objectId) return;
    setSaving(true);
    setError(null);
    try {
      // Snap times client-side too (matches server).
      const cleanedBlocks = sortedBlocks.map(({ block: b }, i) => ({
        ...b,
        label: b.label || null,
        tStartNs: snap10ns(b.tStartNs),
        tEndNs: snap10ns(b.tEndNs),
        sortOrder: i,
      }));
      // Validate end > start
      for (const b of cleanedBlocks) {
        if (b.tEndNs <= b.tStartNs) {
          throw new Error(`Block "${b.label || "(unnamed)"}" has end ≤ start`);
        }
      }
      await upsertTimingProgram(objectId, {
        name,
        spinCoreStart,
        durationNs: snap10ns(durationNs),
        blocks: cleanedBlocks,
      });
      setDirty(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmDeleteTimer = useRef<number | null>(null);

  useEffect(() => {
    setConfirmingDelete(false);
    if (confirmDeleteTimer.current) {
      window.clearTimeout(confirmDeleteTimer.current);
      confirmDeleteTimer.current = null;
    }
  }, [existingProgram?.objectId]);

  useEffect(
    () => () => {
      if (confirmDeleteTimer.current) window.clearTimeout(confirmDeleteTimer.current);
    },
    [],
  );

  const onDelete = async () => {
    if (!objectId || !existingProgram) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      if (confirmDeleteTimer.current) window.clearTimeout(confirmDeleteTimer.current);
      confirmDeleteTimer.current = window.setTimeout(() => {
        setConfirmingDelete(false);
        confirmDeleteTimer.current = null;
      }, 3000);
      return;
    }
    setConfirmingDelete(false);
    if (confirmDeleteTimer.current) {
      window.clearTimeout(confirmDeleteTimer.current);
      confirmDeleteTimer.current = null;
    }
    setSaving(true);
    try {
      await deleteTimingProgram(objectId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const totalDuration = useMemo(
    () => blocks.reduce((max, b) => Math.max(max, b.tEndNs), 0),
    [blocks],
  );

  // ─── Run transient ───────────────────────────────────────────────────────
  const [running, setRunning] = useState(false);

  const onRunTransient = async () => {
    if (totalDuration <= 0) {
      setError("Add at least one block before running transient.");
      return;
    }
    setRunning(true);
    setError(null);
    try {
      // ~200 samples across the program span (capped 10ns min, 10000ns max).
      const dt = Math.max(10, Math.min(10000, Math.round(totalDuration / 200 / 10) * 10));
      await runOpticalTransient({
        tStartNs: 0,
        tEndNs: totalDuration,
        dtNs: dt || 100,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  // Pull this object's trace out of the last run, if any.
  const trace = useMemo(() => {
    if (!lastTransientRun || !objectId) return null;
    return lastTransientRun.objectTraces.find((t) => t.objectId === objectId) ?? null;
  }, [lastTransientRun, objectId]);

  return (
    <FloatingPanel
      id="timing-editor"
      title="QM — timeline editor"
      icon={<Clock size={14} />}
      badge={blocks.length > 0 ? blocks.length : undefined}
    >
      {!component ? (
        <p className="empty-state">Select a component to edit its timing.</p>
      ) : capability.mode === "none" ? (
        <div className="timing-empty">
          <p className="timing-target">{getComponentName(component)}</p>
          <p className="timing-reason">{capability.reason}</p>
        </div>
      ) : (
        <>
          <div className="timing-header-bar">
            <div>
              <p className="timing-target">{getComponentName(component)}</p>
              <p className="timing-reason">{capability.reason}</p>
              <p className="timing-resolution">
                Sections are computed from the timing layout. Edit each block directly with
                start, end, and duration. Minimum resolution is {TIMING_RESOLUTION_NS} ns.
              </p>
            </div>
            <div className="timing-controls">
              <label className="timing-pill-label">
                <span>SpinCore start</span>
                <select
                  value={spinCoreStart}
                  onChange={(e) => {
                    setSpinCoreStart(e.target.value as SpinCoreStartMode);
                    setDirty(true);
                  }}
                >
                  <option value="WAIT">WAIT</option>
                  <option value="CONTINUE">CONTINUE</option>
                </select>
              </label>
            </div>
          </div>

          {/* Visual ruler — drag bar middle to move, drag edges to resize */}
          <div className="timing-ruler" ref={rulerRef}>
            {sortedBlocks.map(({ block: b, origIndex }) => {
              const totalSpan = Math.max(totalDuration, 1);
              const left = (b.tStartNs / totalSpan) * 100;
              const width = ((b.tEndNs - b.tStartNs) / totalSpan) * 100;
              const blockClass =
                b.waveformKind === "gate_on" || b.waveformKind === "const"
                  ? "timing-block-bar on"
                  : b.waveformKind === "gate_off"
                    ? "timing-block-bar off"
                    : "timing-block-bar ramp";
              return (
                <div
                  key={`bar-${origIndex}`}
                  className={blockClass}
                  style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
                  title={`${b.label || "(unnamed)"} · ${fmtNs(b.tStartNs)} → ${fmtNs(b.tEndNs)} (drag to move, edges to resize)`}
                  onPointerDown={(e) => beginBarDrag(e, origIndex, "move")}
                  onPointerMove={onBarPointerMove}
                  onPointerUp={endBarDrag}
                  onPointerCancel={endBarDrag}
                >
                  <span
                    className="timing-block-edge timing-block-edge-left"
                    aria-label="Resize block start"
                    onPointerDown={(e) => beginBarDrag(e, origIndex, "start")}
                    onPointerMove={onBarPointerMove}
                    onPointerUp={endBarDrag}
                    onPointerCancel={endBarDrag}
                  />
                  <span className="timing-block-label">{b.label || "·"}</span>
                  <span
                    className="timing-block-edge timing-block-edge-right"
                    aria-label="Resize block end"
                    onPointerDown={(e) => beginBarDrag(e, origIndex, "end")}
                    onPointerMove={onBarPointerMove}
                    onPointerUp={endBarDrag}
                    onPointerCancel={endBarDrag}
                  />
                </div>
              );
            })}
            {totalDuration === 0 && <span className="timing-ruler-empty">No blocks yet</span>}
            {trace && trace.points.length > 1 && totalDuration > 0 && (
              <svg
                className="timing-trace-overlay"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden
              >
                <polyline
                  points={trace.points
                    .map((p) => {
                      const x = (p.tNs / totalDuration) * 100;
                      // Trace value is in [0, 1] for normalized programs; clamp
                      // anything outside so the overlay stays in the ruler box.
                      const y = 100 - Math.max(0, Math.min(1, p.value)) * 90 - 5;
                      return `${x},${y}`;
                    })
                    .join(" ")}
                />
              </svg>
            )}
          </div>

          {/* Block table */}
          <div className="timing-block-list">
            <div className="timing-block-header-row">
              <span>Label</span>
              <span>Start (ns)</span>
              <span>End (ns)</span>
              <span>Duration</span>
              <span>Waveform</span>
              <span>Value</span>
              <span aria-label="actions" />
            </div>
            {sortedBlocks.map(({ block, origIndex }) => (
              <div className="timing-block-row" key={`row-${origIndex}`}>
                <input
                  className="timing-input timing-input-label"
                  type="text"
                  value={block.label ?? ""}
                  placeholder="(label)"
                  onChange={(e) => updateBlock(origIndex, { label: e.target.value })}
                />
                <input
                  className="timing-input"
                  type="number"
                  step={TIMING_RESOLUTION_NS}
                  min={0}
                  value={block.tStartNs}
                  onChange={(e) => updateBlock(origIndex, { tStartNs: snap10ns(Number(e.target.value)) })}
                />
                <input
                  className="timing-input"
                  type="number"
                  step={TIMING_RESOLUTION_NS}
                  min={0}
                  value={block.tEndNs}
                  onChange={(e) => updateBlock(origIndex, { tEndNs: snap10ns(Number(e.target.value)) })}
                />
                <span className="timing-duration">{fmtNs(block.tEndNs - block.tStartNs)}</span>
                <select
                  className="timing-input timing-input-kind"
                  value={block.waveformKind}
                  onChange={(e) => updateBlock(origIndex, { waveformKind: e.target.value as WaveformKind })}
                >
                  {allowedKinds.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <BlockValueInput
                  block={block}
                  onChange={(params) => updateBlock(origIndex, { params })}
                />
                <button
                  type="button"
                  className="icon-button danger"
                  title="Remove block"
                  onClick={() => removeBlock(origIndex)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {sortedBlocks.length === 0 && (
              <p className="empty-state" style={{ padding: "10px 0" }}>
                No blocks yet — click "Add block".
              </p>
            )}
          </div>

          <div className="timing-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={addBlock}
              disabled={allowedKinds.length === 0}
            >
              <Plus size={14} />
              Add block
            </button>
            <label className="timing-name-field">
              <span>Name</span>
              <input
                className="timing-input"
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setDirty(true);
                }}
              />
            </label>
            <label className="timing-name-field">
              <span>Total (ns)</span>
              <input
                className="timing-input"
                type="number"
                step={TIMING_RESOLUTION_NS}
                value={durationNs}
                onChange={(e) => {
                  setDurationNs(snap10ns(Number(e.target.value)));
                  setDirty(true);
                }}
              />
            </label>
            <span style={{ flex: 1 }} />
            {existingProgram && (
              <button
                type="button"
                className={`danger-button${confirmingDelete ? " confirming" : ""}`}
                title={
                  confirmingDelete
                    ? "Click again to confirm deletion"
                    : "Delete this timing program (two-step)"
                }
                onClick={onDelete}
                disabled={saving}
              >
                <Trash2 size={14} />
                {confirmingDelete ? "Click again to confirm" : "Delete program"}
              </button>
            )}
            <button
              type="button"
              className="primary-button"
              onClick={onSave}
              disabled={saving || !dirty}
            >
              {saving ? "Saving…" : existingProgram ? "Save changes" : "Create program"}
            </button>
            <button
              type="button"
              className="secondary-button"
              title="Walk the time grid and overlay the actual evaluated trace"
              onClick={onRunTransient}
              disabled={running || totalDuration <= 0 || dirty}
            >
              <Zap size={14} />
              {running ? "Running…" : dirty ? "Save first" : "Run transient"}
            </button>
          </div>
          {error && (
            <p className="form-error" style={{ marginTop: 6 }}>
              {error}
            </p>
          )}
        </>
      )}
    </FloatingPanel>
  );
}

function BlockValueInput({
  block,
  onChange,
}: {
  block: DraftBlock;
  onChange: (params: Record<string, unknown>) => void;
}) {
  if (block.waveformKind === "const") {
    return (
      <input
        className="timing-input"
        type="number"
        step="0.01"
        value={(block.params.value as number | undefined) ?? 0}
        onChange={(e) => onChange({ ...block.params, value: Number(e.target.value) })}
      />
    );
  }
  if (block.waveformKind === "linear_ramp") {
    return (
      <span className="timing-ramp-fields">
        <input
          className="timing-input timing-ramp-input"
          type="number"
          step="0.01"
          placeholder="start"
          value={(block.params.start as number | undefined) ?? 0}
          onChange={(e) => onChange({ ...block.params, start: Number(e.target.value) })}
        />
        <input
          className="timing-input timing-ramp-input"
          type="number"
          step="0.01"
          placeholder="end"
          value={(block.params.end as number | undefined) ?? 0}
          onChange={(e) => onChange({ ...block.params, end: Number(e.target.value) })}
        />
      </span>
    );
  }
  if (block.waveformKind === "arbitrary") {
    const samples = (block.params.samples as number[] | undefined) ?? [];
    return (
      <span className="timing-arbitrary-summary" title={`${samples.length} samples`}>
        <Zap size={12} /> {samples.length || 0}
      </span>
    );
  }
  if (block.waveformKind === "gate_on" || block.waveformKind === "gate_off") {
    return (
      <span className="timing-gate-pill">
        <CircleDot size={12} />
        {block.waveformKind === "gate_on" ? "ON" : "OFF"}
      </span>
    );
  }
  return <span>—</span>;
}
