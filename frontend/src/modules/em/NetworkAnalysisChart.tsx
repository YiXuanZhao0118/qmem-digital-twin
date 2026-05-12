/**
 * Shared S-parameter chart bundle: Smith chart (diagonal Sii) +
 * magnitude-in-dB uPlot (all Sij). Drives both:
 *   - Phase B.7 NetworkAnalysisPanel (Touchstone upload viewer)
 *   - Phase C.7 EmWorkspace results pane (palace output)
 *
 * Decoupled from any data source — caller passes freqHz + nPorts +
 * sParams in the standard {sNM: [[re, im], ...]} format.
 */
import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import { SmithChart, type Trace } from "../electronics/SmithChart";

const SMITH_COLORS: Record<string, string> = {
  s11: "#dc2626",
  s22: "#2563eb",
  s33: "#16a34a",
  s44: "#ea580c",
};

const MAG_COLORS = [
  "#dc2626",
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#7c3aed",
  "#0891b2",
  "#ca8a04",
  "#db2777",
];

type Props = {
  freqHz: number[];
  nPorts: number;
  sParams: Record<string, [number, number][]>;
};

export function NetworkAnalysisChart({ freqHz, nPorts, sParams }: Props) {
  const smithTraces = useMemo<Trace[]>(() => {
    const traces: Trace[] = [];
    for (let i = 1; i <= nPorts; i++) {
      const key = `s${i}${i}`;
      const pts = sParams[key];
      if (!pts) continue;
      traces.push({
        label: key.toUpperCase(),
        color: SMITH_COLORS[key] ?? MAG_COLORS[i - 1],
        points: pts.map((p) => [p[0], p[1]]),
      });
    }
    return traces;
  }, [nPorts, sParams]);

  return (
    <>
      <SmithChart traces={smithTraces} />
      <MagnitudePlot freqHz={freqHz} sParams={sParams} />
    </>
  );
}

function MagnitudePlot({
  freqHz,
  sParams,
}: {
  freqHz: number[];
  sParams: Record<string, [number, number][]>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const keys = useMemo(
    () =>
      Object.keys(sParams).sort((a, b) => {
        const an = parseInt(a.slice(1), 10);
        const bn = parseInt(b.slice(1), 10);
        return an - bn;
      }),
    [sParams],
  );

  useEffect(() => {
    if (!containerRef.current) return;
    const ySeries = keys.map((k) =>
      sParams[k].map(([re, im]) => {
        const mag = Math.hypot(re, im);
        return mag > 0 ? 20 * Math.log10(mag) : -200;
      }),
    );
    const data: uPlot.AlignedData = [freqHz, ...ySeries];

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth || 320,
      height: 180,
      cursor: { drag: { x: true, y: false } },
      scales: {
        x: { time: false, distr: 3 },
        y: { auto: true },
      },
      axes: [
        { label: "frequency (Hz)", stroke: "#475569", grid: { stroke: "rgba(15,23,42,0.06)" } },
        { label: "|S| (dB)", stroke: "#475569", grid: { stroke: "rgba(15,23,42,0.06)" } },
      ],
      series: [
        {},
        ...keys.map((k, i) => ({
          label: k.toUpperCase(),
          stroke: MAG_COLORS[i % MAG_COLORS.length],
          width: 1.4,
        })),
      ],
      legend: { show: true },
    };

    const plot = new uPlot(opts, data, containerRef.current);
    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      plot.setSize({ width: containerRef.current.clientWidth, height: 180 });
    });
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      plot.destroy();
    };
  }, [freqHz, sParams, keys]);

  return (
    <div className="magnitude-plot-block">
      <div className="magnitude-plot-title">|S| magnitude</div>
      <div ref={containerRef} className="magnitude-plot-canvas" />
    </div>
  );
}
