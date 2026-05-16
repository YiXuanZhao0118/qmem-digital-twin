/**
 * Section-based scrub-time bar — mirrors the Pulse & Timing multi-
 * channel timeline so the row of equal-width section columns the user
 * draws there is the same row they scrub against here. Cursor click
 * sets ``scrubTimeNs`` in the scene store; every gate-aware consumer
 * (rf_switch routing in ``buildRfPropagation``, AOM RF drive, beam
 * gating) re-evaluates at that time.
 *
 * Collapsed state: a thin "Scrub time" pill that activates the bar.
 * Active state: a wide strip showing all section boundaries (alternating
 * background bands) with a vertical cursor at the current time.
 */
import { Clock, Play, Square } from "lucide-react";
import { useMemo, useRef } from "react";

import { useSceneStore } from "../../store/sceneStore";

const ROW_H_PX = 28;
const READOUT_W_PX = 110;
const STOP_W_PX = 56;

function formatTimeNs(tNs: number): string {
  if (tNs >= 1_000_000) return `${(tNs / 1_000_000).toFixed(3)} ms`;
  if (tNs >= 1_000) return `${(tNs / 1_000).toFixed(3)} µs`;
  return `${tNs.toFixed(0)} ns`;
}

export function ScrubTimeBar() {
  const scrubTimeNs = useSceneStore((s) => s.scrubTimeNs);
  const setScrubTimeNs = useSceneStore((s) => s.setScrubTimeNs);
  const programs = useSceneStore((s) => s.scene.timingPrograms);
  const userTotalNs = useSceneStore((s) => s.userTimelineTotalNs);
  const svgRef = useRef<SVGSVGElement>(null);

  // Resolve total + section boundaries identically to PulseTimingPanel
  // so the two views always agree on which "column" a time falls into.
  const totalNs = useMemo(() => {
    let maxEnd = 0;
    for (const p of programs ?? []) {
      for (const iv of p.intervals ?? []) {
        if (iv.spinCoreEndNs > maxEnd) maxEnd = iv.spinCoreEndNs;
      }
    }
    return Math.max(userTotalNs ?? 0, maxEnd, 1_000);
  }, [programs, userTotalNs]);

  const sectionBoundaries = useMemo(() => {
    const edges = new Set<number>([0, totalNs]);
    for (const p of programs ?? []) {
      for (const iv of p.intervals ?? []) {
        if (iv.spinCoreStartNs > 0 && iv.spinCoreStartNs < totalNs) {
          edges.add(iv.spinCoreStartNs);
        }
        if (iv.spinCoreEndNs > 0 && iv.spinCoreEndNs < totalNs) {
          edges.add(iv.spinCoreEndNs);
        }
      }
    }
    return Array.from(edges).sort((a, b) => a - b);
  }, [programs, totalNs]);

  const active = scrubTimeNs !== null;

  if (!active) {
    return (
      <button
        type="button"
        className="scrub-time-pill"
        onClick={() => setScrubTimeNs(0)}
        title="Start scrub-time playback (samples device gates at time t)"
      >
        <Play size={11} /> Scrub time
      </button>
    );
  }

  const t = scrubTimeNs ?? 0;
  const sectionCount = Math.max(1, sectionBoundaries.length - 1);
  const SECTION_W_PX = sectionCount <= 8 ? Math.max(60, Math.floor(720 / sectionCount)) : 80;
  const TIMELINE_W_PX = SECTION_W_PX * sectionCount;

  /** Pixel X (in SVG coords) → real time ns. Linear within the clicked
   *  section so sub-section resolution is still possible. */
  const xToNs = (x: number): number => {
    const relPx = x;
    const idx = Math.min(sectionCount - 1, Math.max(0, Math.floor(relPx / SECTION_W_PX)));
    const within = (relPx - idx * SECTION_W_PX) / SECTION_W_PX;
    const startNs = sectionBoundaries[idx];
    const endNs = sectionBoundaries[idx + 1];
    return startNs + Math.max(0, Math.min(1, within)) * (endNs - startNs);
  };
  const nsToX = (ns: number): number => {
    if (ns <= sectionBoundaries[0]) return 0;
    if (ns >= sectionBoundaries[sectionCount]) return TIMELINE_W_PX;
    for (let i = 0; i < sectionCount; i += 1) {
      const a = sectionBoundaries[i];
      const b = sectionBoundaries[i + 1];
      if (ns < b) {
        const frac = (ns - a) / (b - a);
        return i * SECTION_W_PX + frac * SECTION_W_PX;
      }
    }
    return TIMELINE_W_PX;
  };

  const cursorX = nsToX(t);

  return (
    <div
      className="scrub-time-bar"
      style={{ display: "flex", alignItems: "center", gap: 6 }}
    >
      <Clock size={12} className="scrub-time-icon" />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflowX: "auto",
          background: "#f5f5f8",
          border: "1px solid #cfd2d8",
          borderRadius: 3,
        }}
      >
        <svg
          ref={svgRef}
          width={TIMELINE_W_PX}
          height={ROW_H_PX}
          style={{ display: "block", cursor: "pointer" }}
          onClick={(e) => {
            if (!svgRef.current) return;
            const rect = svgRef.current.getBoundingClientRect();
            const px = e.clientX - rect.left;
            setScrubTimeNs(xToNs(px));
          }}
        >
          {/* Section background bands + per-section duration label */}
          {sectionBoundaries.slice(0, -1).map((startNs, idx) => {
            const endNs = sectionBoundaries[idx + 1];
            const x = idx * SECTION_W_PX;
            return (
              <g key={`section-${idx}-${startNs}`}>
                <rect
                  x={x}
                  y={0}
                  width={SECTION_W_PX}
                  height={ROW_H_PX}
                  fill={idx % 2 === 0 ? "#fafafc" : "#eef0f4"}
                />
                <text
                  x={x + SECTION_W_PX / 2}
                  y={ROW_H_PX / 2 + 4}
                  fontSize={10}
                  fill="#3a3a44"
                  textAnchor="middle"
                  style={{ pointerEvents: "none" }}
                >
                  {formatTimeNs(endNs - startNs)}
                </text>
              </g>
            );
          })}
          {/* Boundary dashed lines + tiny time labels */}
          {sectionBoundaries.map((boundaryNs, idx) => {
            const x = idx * SECTION_W_PX;
            return (
              <g key={`boundary-${idx}-${boundaryNs}`}>
                <line
                  x1={x}
                  y1={0}
                  x2={x}
                  y2={ROW_H_PX}
                  stroke="#a0a0ac"
                  strokeDasharray="2 4"
                />
                <text
                  x={x + 2}
                  y={9}
                  fontSize={8}
                  fill="#5a5a64"
                  style={{ pointerEvents: "none" }}
                >
                  {formatTimeNs(boundaryNs)}
                </text>
              </g>
            );
          })}
          {/* Cursor at current scrub time */}
          <line
            x1={cursorX}
            y1={0}
            x2={cursorX}
            y2={ROW_H_PX}
            stroke="#ff3b3b"
            strokeWidth={2}
            style={{ pointerEvents: "none" }}
          />
          <polygon
            points={`${cursorX - 5},0 ${cursorX + 5},0 ${cursorX},6`}
            fill="#ff3b3b"
            style={{ pointerEvents: "none" }}
          />
        </svg>
      </div>
      <span
        className="scrub-time-readout"
        title={`${t} ns of ${totalNs} ns`}
        style={{ minWidth: READOUT_W_PX, textAlign: "right", fontSize: 11, color: "#3a3a44" }}
      >
        {formatTimeNs(t)} / {formatTimeNs(totalNs)}
      </span>
      <button
        type="button"
        className="scrub-time-stop"
        onClick={() => setScrubTimeNs(null)}
        title="Stop scrub — return to static gate visibility"
        style={{ minWidth: STOP_W_PX }}
      >
        <Square size={10} /> Stop
      </button>
    </div>
  );
}
