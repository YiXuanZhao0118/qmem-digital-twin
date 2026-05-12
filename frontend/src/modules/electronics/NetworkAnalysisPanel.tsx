/**
 * Network analysis panel — Phase B.7.
 *
 * Lives at the bottom of the Electronics workspace's results pane.
 * Lets the user drop / pick a Touchstone file (.s1p .. .s4p), POSTs it
 * to the backend (scikit-rf parses), and renders:
 *
 *   - a Smith chart with S11 (and S22 if present) reflection traces
 *   - a magnitude-in-dB plot of every Sij with a frequency X axis
 *
 * Stateless — re-uploading replaces the network. No persistence.
 */
import { Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import { parseTouchstoneApi } from "../../api/client";
import type { TouchstoneNetwork } from "../../types/digitalTwin";
import { SmithChart, type Trace } from "./SmithChart";

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

export function NetworkAnalysisPanel() {
  const [network, setNetwork] = useState<TouchstoneNetwork | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onPickFile = () => fileInputRef.current?.click();

  const onFile = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const result = await parseTouchstoneApi(file);
      setNetwork(result);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err instanceof Error ? err.message : String(err));
      setError(msg);
      setNetwork(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="network-analysis-panel">
      <header className="electronics-sidebar-header">
        <span className="electronics-sidebar-title">Network analysis</span>
        <button
          type="button"
          className="electronics-icon-btn"
          title="Upload Touchstone (.s2p)"
          onClick={onPickFile}
          disabled={busy}
        >
          <Upload size={14} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".s1p,.s2p,.s3p,.s4p,.snp"
          style={{ display: "none" }}
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
      </header>

      <div className="network-analysis-body">
        {!network && !busy && !error && (
          <div className="electronics-empty">
            Upload a Touchstone (.s1p .. .s4p) to view S-parameters.
          </div>
        )}
        {busy && <div className="electronics-empty">Parsing…</div>}
        {error && (
          <div className="electronics-error">
            <X size={12} style={{ marginRight: 4 }} />
            {error}
          </div>
        )}
        {network && (
          <>
            <NetworkMeta network={network} onClear={() => setNetwork(null)} />
            <SmithChart traces={makeSmithTraces(network)} />
            <MagnitudePlot network={network} />
          </>
        )}
      </div>
    </div>
  );
}

function NetworkMeta({
  network,
  onClear,
}: {
  network: TouchstoneNetwork;
  onClear: () => void;
}) {
  const fMin = network.freqHz[0] ?? 0;
  const fMax = network.freqHz[network.freqHz.length - 1] ?? 0;
  return (
    <div className="network-meta">
      <div>
        <strong>{network.filename}</strong> — {network.nPorts}-port,{" "}
        Z₀={network.z0.toFixed(0)} Ω, {network.freqHz.length} pts
        ,{" "}
        {prettyFreq(fMin)} → {prettyFreq(fMax)}
      </div>
      <button
        type="button"
        className="electronics-icon-btn"
        title="Clear network"
        onClick={onClear}
      >
        <X size={12} />
      </button>
    </div>
  );
}

function makeSmithTraces(network: TouchstoneNetwork): Trace[] {
  // Diagonal S-params (S11, S22, ...) are reflection coefficients,
  // appropriate to plot on a Smith chart. Off-diagonals (S21, S12) are
  // transmission, not on the Smith chart.
  const traces: Trace[] = [];
  for (let i = 1; i <= network.nPorts; i++) {
    const key = `s${i}${i}`;
    const pts = network.sParams[key];
    if (!pts) continue;
    traces.push({
      label: key.toUpperCase(),
      color: SMITH_COLORS[key] ?? MAG_COLORS[i - 1],
      points: pts.map((p) => [p[0], p[1]]),
    });
  }
  return traces;
}

function MagnitudePlot({ network }: { network: TouchstoneNetwork }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Sort sParam keys so the legend reads in a predictable order.
  const keys = useMemo(
    () =>
      Object.keys(network.sParams).sort((a, b) => {
        const an = parseInt(a.slice(1), 10);
        const bn = parseInt(b.slice(1), 10);
        return an - bn;
      }),
    [network.sParams],
  );

  useEffect(() => {
    if (!containerRef.current) return;
    const xValues = network.freqHz;
    const ySeries = keys.map((k) =>
      network.sParams[k].map(([re, im]) => {
        const mag = Math.hypot(re, im);
        return mag > 0 ? 20 * Math.log10(mag) : -200;
      }),
    );
    const data: uPlot.AlignedData = [xValues, ...ySeries];

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth || 320,
      height: 180,
      cursor: { drag: { x: true, y: false } },
      scales: {
        x: { time: false, distr: 3 }, // log frequency
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
  }, [network.freqHz, network.sParams, keys]);

  return (
    <div className="magnitude-plot-block">
      <div className="magnitude-plot-title">|S| magnitude</div>
      <div ref={containerRef} className="magnitude-plot-canvas" />
    </div>
  );
}

function prettyFreq(hz: number): string {
  if (hz >= 1e9) return `${(hz / 1e9).toFixed(2)} GHz`;
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(2)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(2)} kHz`;
  return `${hz} Hz`;
}
