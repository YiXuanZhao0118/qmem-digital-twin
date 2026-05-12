/**
 * Waveform chart for SPICE rawfile output (Phase B.6).
 *
 * Renders the resultSummary from a completed spice SimulationRun as an
 * interactive uPlot line chart:
 *
 *   - First variable in resultSummary.variables is the X axis
 *     (ngspice rawfile convention: frequency for AC, time for TRAN,
 *     sweep parameter for DC).
 *   - Remaining variables become Y series (one line each, color-cycled).
 *   - Complex values (AC analysis) are reduced to magnitude
 *     |c| = sqrt(re^2 + im^2) before plotting.
 *   - X axis switches to log10 when the X-variable name is "frequency"
 *     (AC sweeps span decades and need log spacing).
 *   - Each series has a toggle in the legend; the chart re-renders when
 *     a series is shown/hidden.
 *
 * Uses uplot directly (no react wrapper) — the chart is created on
 * mount, destroyed on unmount, and re-created when the run id or visible
 * series change. uplot is fast enough for the 81-point AC sweep we ship
 * in Phase B; bigger transients (10k+ points) will still render in
 * <100 ms because uplot is canvas-based.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

const SERIES_COLORS = [
  "#2563eb", // blue
  "#dc2626", // red
  "#16a34a", // green
  "#ea580c", // orange
  "#7c3aed", // violet
  "#0891b2", // cyan
  "#ca8a04", // amber
  "#db2777", // pink
];

type ResultData = {
  analysisName?: string;
  isComplex?: boolean;
  variables?: string[];
  pointCount?: number;
  data?: Record<string, unknown>;
};

type Props = {
  /** Run-id key — re-creates chart when it changes. */
  runId: string;
  result: ResultData;
};

export function WaveformChart({ runId, result }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);

  const variables = result.variables ?? [];
  const xVarName = variables[0];
  const yVarNames = useMemo(() => variables.slice(1), [variables]);
  const isLogX = xVarName?.toLowerCase() === "frequency";

  // Visible series — start with all on.
  const [visibleSet, setVisibleSet] = useState<Set<string>>(
    () => new Set(yVarNames),
  );

  // Reset visibility when the run changes (different vars).
  useEffect(() => {
    setVisibleSet(new Set(yVarNames));
  }, [runId, yVarNames]);

  // Build the data arrays from the rawfile dict.
  const plotData = useMemo<uPlot.AlignedData | null>(() => {
    if (!xVarName || !result.data) return null;
    const xRaw = result.data[xVarName];
    if (!Array.isArray(xRaw) || xRaw.length === 0) return null;

    const xValues = (xRaw as unknown[]).map((v) => coerceReal(v));
    const series: number[][] = [xValues];
    for (const name of yVarNames) {
      const raw = result.data[name];
      if (!Array.isArray(raw)) {
        series.push(new Array(xValues.length).fill(NaN));
        continue;
      }
      series.push((raw as unknown[]).map((v) => coerceMagnitude(v)));
    }
    return series as uPlot.AlignedData;
  }, [runId, xVarName, yVarNames, result.data]);

  // (Re-)create the chart whenever data, visibility, or container size changes.
  useEffect(() => {
    if (!containerRef.current || !plotData) return;
    const container = containerRef.current;

    const opts: uPlot.Options = {
      width: container.clientWidth || 600,
      height: container.clientHeight || 280,
      cursor: { drag: { x: true, y: false } },
      scales: {
        x: { time: false, distr: isLogX ? 3 : 1 },
        y: { auto: true },
      },
      axes: [
        {
          label: xVarName ?? "",
          stroke: "#475569",
          grid: { stroke: "rgba(15,23,42,0.06)" },
        },
        {
          label: result.isComplex ? "magnitude" : "value",
          stroke: "#475569",
          grid: { stroke: "rgba(15,23,42,0.06)" },
        },
      ],
      series: [
        {}, // X axis
        ...yVarNames.map((name, i) => ({
          label: name,
          stroke: SERIES_COLORS[i % SERIES_COLORS.length],
          width: 1.5,
          show: visibleSet.has(name),
        })),
      ],
      legend: { show: false }, // we render our own toggles below
    };

    const plot = new uPlot(opts, plotData, container);
    plotRef.current = plot;

    // Resize on container size change.
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth || 600;
      const h = container.clientHeight || 280;
      plot.setSize({ width: w, height: h });
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [plotData, isLogX, xVarName, yVarNames, result.isComplex, visibleSet, runId]);

  if (!plotData || yVarNames.length === 0) {
    return (
      <div className="waveform-empty">
        No plottable variables (need at least one Y series).
      </div>
    );
  }

  const toggle = (name: string) => {
    setVisibleSet((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="waveform-chart-block">
      <div ref={containerRef} className="waveform-chart-canvas" />
      <ul className="waveform-legend">
        {yVarNames.map((name, i) => {
          const visible = visibleSet.has(name);
          const color = SERIES_COLORS[i % SERIES_COLORS.length];
          return (
            <li
              key={name}
              className={`waveform-legend-item${visible ? "" : " off"}`}
              onClick={() => toggle(name)}
              title={`Toggle ${name}`}
            >
              <span className="waveform-legend-swatch" style={{ background: color }} />
              <span className="waveform-legend-name">{name}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Coerce a possibly-complex rawfile value to its real part (X-axis). */
function coerceReal(v: unknown): number {
  if (typeof v === "number") return v;
  if (Array.isArray(v) && v.length >= 1 && typeof v[0] === "number") return v[0];
  return NaN;
}

/** Coerce a possibly-complex rawfile value to its magnitude (Y-axis). */
function coerceMagnitude(v: unknown): number {
  if (typeof v === "number") return v;
  if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
    return Math.hypot(v[0], v[1]);
  }
  return NaN;
}
