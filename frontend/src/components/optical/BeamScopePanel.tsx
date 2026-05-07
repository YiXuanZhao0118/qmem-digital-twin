// Beam-scope panel: shows the beam state at a probe point along the optical
// path. The probe is set by clicking on a beam segment in the 3D viewer; the
// click handler computes the cumulative path length z (mm from emission) and
// stores it in `useSceneStore.scopeProbe`. This panel reads that probe and
// renders four small SVG plots: spectrum, beam profile, wavefront phase, and
// pulse-temporal envelope.

import { useEffect, useMemo, useRef } from "react";

import { useSceneStore } from "../../store/sceneStore";
import { FloatingPanel } from "../workspace/FloatingPanel";
import { useWorkspace } from "../workspace/WorkspaceProvider";

// ───────────────────────────────────────────────────────────────────────────
// 2D canvas heatmap — used for Beam profile (linear intensity colourmap)
// and Wavefront phase (cyclic colourmap).
// ───────────────────────────────────────────────────────────────────────────

type ColourMap = (value: number) => [number, number, number];

/** Linear "thermal" colourmap: 0 → black, 1 → white, with red→yellow ramp. */
const thermalColour: ColourMap = (v) => {
  const t = Math.max(0, Math.min(1, v));
  const r = Math.round(255 * Math.min(1, t * 2));
  const g = Math.round(255 * Math.max(0, t * 2 - 0.5) * 1.2);
  const b = Math.round(255 * Math.max(0, t * 2 - 1.4));
  return [r, Math.min(255, g), Math.min(255, b)];
};

/** HSL-cyclic colourmap for phase: input is in [0, 1] = angle / 2π. */
const cyclicColour: ColourMap = (v) => {
  const t = ((v % 1) + 1) % 1;
  // Convert hue (0..1) → RGB via HSL with sat=0.85, light=0.55
  const h = t;
  const s = 0.85;
  const l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 1 / 6) [r, g, b] = [c, x, 0];
  else if (h < 2 / 6) [r, g, b] = [x, c, 0];
  else if (h < 3 / 6) [r, g, b] = [0, c, x];
  else if (h < 4 / 6) [r, g, b] = [0, x, c];
  else if (h < 5 / 6) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
};

type HeatmapProps = {
  size: number; // pixels (width = height)
  halfExtentUm: number; // physical half-width of the visible region
  /** value = sample(xUm, yUm). Returns the scalar (intensity or phase). */
  sample: (xUm: number, yUm: number) => number;
  vmin?: number;
  vmax?: number;
  colour: ColourMap;
  title: string;
  axisLabel: string;
  valueLabelMin?: string;
  valueLabelMax?: string;
};

function Heatmap({
  size,
  halfExtentUm,
  sample,
  vmin,
  vmax,
  colour,
  title,
  axisLabel,
  valueLabelMin,
  valueLabelMax,
}: HeatmapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(size, size);

    // First pass: compute values + auto-range if needed.
    const values = new Float32Array(size * size);
    let minV = Infinity;
    let maxV = -Infinity;
    for (let py = 0; py < size; py++) {
      // Image y=0 is top; physical y axis runs from +halfExtent at top to
      // −halfExtent at bottom (display upright).
      const y = halfExtentUm * (1 - (2 * py) / (size - 1));
      for (let px = 0; px < size; px++) {
        const x = halfExtentUm * ((2 * px) / (size - 1) - 1);
        const v = sample(x, y);
        values[py * size + px] = v;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
    const lo = vmin !== undefined ? vmin : minV;
    const hi = vmax !== undefined ? vmax : maxV;
    const range = hi - lo > 0 ? hi - lo : 1;

    for (let i = 0; i < size * size; i++) {
      const v = values[i];
      const t = (v - lo) / range;
      const [r, g, b] = colour(t);
      img.data[i * 4 + 0] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [size, halfExtentUm, sample, vmin, vmax, colour]);

  return (
    <div className="beam-scope-plot">
      <div className="beam-scope-plot-title">{title}</div>
      <div className="beam-scope-heatmap-frame">
        <canvas ref={canvasRef} width={size} height={size} className="beam-scope-heatmap-canvas" />
        <div className="beam-scope-heatmap-axis-x">
          <span>−{halfExtentUm.toFixed(0)}</span>
          <span>{axisLabel}</span>
          <span>+{halfExtentUm.toFixed(0)}</span>
        </div>
        <div className="beam-scope-heatmap-axis-y">
          <span>+{halfExtentUm.toFixed(0)}</span>
          <span>−{halfExtentUm.toFixed(0)}</span>
        </div>
      </div>
      {(valueLabelMin || valueLabelMax) && (
        <div className="beam-scope-heatmap-legend">
          <span>{valueLabelMin}</span>
          <span>{valueLabelMax}</span>
        </div>
      )}
    </div>
  );
}

const PLOT_W = 240;
const PLOT_H = 150;
const PADDING = { top: 12, right: 12, bottom: 28, left: 38 };

type PlotPoint = { x: number; y: number };

function plotAxes(maxX: number, maxY: number): { xs: number[]; ys: number[] } {
  const xs: number[] = [0, maxX * 0.25, maxX * 0.5, maxX * 0.75, maxX];
  const ys: number[] = [0, maxY * 0.5, maxY];
  return { xs, ys };
}

function svgPoly(points: PlotPoint[], xMax: number, yMax: number, fill: string): string {
  const w = PLOT_W - PADDING.left - PADDING.right;
  const h = PLOT_H - PADDING.top - PADDING.bottom;
  const xs = (x: number) => PADDING.left + (x / xMax) * w;
  const ys = (y: number) => PADDING.top + h - (y / yMax) * h;
  if (points.length === 0) return "";
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${xs(p.x).toFixed(1)},${ys(p.y).toFixed(1)}`)
    .join(" ");
  return `${path} L${xs(points[points.length - 1].x).toFixed(1)},${ys(0).toFixed(1)} L${xs(points[0].x).toFixed(1)},${ys(0).toFixed(1)} Z`;
}

function svgLine(points: PlotPoint[], xMax: number, yMin: number, yMax: number): string {
  const w = PLOT_W - PADDING.left - PADDING.right;
  const h = PLOT_H - PADDING.top - PADDING.bottom;
  const xs = (x: number) => PADDING.left + (x / xMax) * w;
  const ys = (y: number) => PADDING.top + h - ((y - yMin) / (yMax - yMin)) * h;
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${xs(p.x).toFixed(1)},${ys(p.y).toFixed(1)}`)
    .join(" ");
}

function PlotFrame({
  title,
  xLabel,
  yLabel,
  xMax,
  xOffset = 0,
  yMin = 0,
  yMax,
  children,
}: {
  title: string;
  xLabel: string;
  yLabel: string;
  xMax: number;
  /** Added to tick labels — useful for absolute axes like wavelength (nm). */
  xOffset?: number;
  yMin?: number;
  yMax: number;
  children: React.ReactNode;
}) {
  const w = PLOT_W - PADDING.left - PADDING.right;
  const h = PLOT_H - PADDING.top - PADDING.bottom;
  const ax = plotAxes(xMax, yMax);
  return (
    <div className="beam-scope-plot">
      <div className="beam-scope-plot-title">{title}</div>
      <svg width={PLOT_W} height={PLOT_H}>
        {/* axes */}
        <line x1={PADDING.left} y1={PADDING.top} x2={PADDING.left} y2={PADDING.top + h} stroke="#888" />
        <line x1={PADDING.left} y1={PADDING.top + h} x2={PADDING.left + w} y2={PADDING.top + h} stroke="#888" />
        {/* x ticks */}
        {ax.xs.map((x) => (
          <g key={`x${x}`}>
            <line
              x1={PADDING.left + (x / xMax) * w}
              y1={PADDING.top + h}
              x2={PADDING.left + (x / xMax) * w}
              y2={PADDING.top + h + 3}
              stroke="#888"
            />
            <text
              x={PADDING.left + (x / xMax) * w}
              y={PADDING.top + h + 14}
              fontSize="9"
              fill="#666"
              textAnchor="middle"
            >
              {(x + xOffset).toPrecision(xOffset !== 0 ? 5 : 2)}
            </text>
          </g>
        ))}
        {/* y ticks */}
        {ax.ys.map((y) => (
          <g key={`y${y}`}>
            <line
              x1={PADDING.left - 3}
              y1={PADDING.top + h - ((y - yMin) / (yMax - yMin)) * h}
              x2={PADDING.left}
              y2={PADDING.top + h - ((y - yMin) / (yMax - yMin)) * h}
              stroke="#888"
            />
            <text
              x={PADDING.left - 5}
              y={PADDING.top + h - ((y - yMin) / (yMax - yMin)) * h + 3}
              fontSize="9"
              fill="#666"
              textAnchor="end"
            >
              {y.toPrecision(2)}
            </text>
          </g>
        ))}
        {children}
      </svg>
      <div className="beam-scope-plot-axes">
        <span>{xLabel}</span>
        <span>{yLabel}</span>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Beam state computation (frontend-only — derived from laser params + z)
// ───────────────────────────────────────────────────────────────────────────

type SpatialMode = { waist0Um: number; mSquared: number; wavelengthNm: number };

function rayleighRangeMm(mode: SpatialMode): number {
  // z_R = π · w₀² / (M² · λ) — keep all in µm then convert to mm at the end.
  const zRUm = (Math.PI * mode.waist0Um * mode.waist0Um) / (mode.mSquared * mode.wavelengthNm * 1e-3);
  return zRUm / 1000;
}

function waistAtZUm(zMm: number, mode: SpatialMode): number {
  const zR = rayleighRangeMm(mode);
  if (zR === 0) return mode.waist0Um;
  return mode.waist0Um * Math.sqrt(1 + (zMm / zR) ** 2);
}

function radiusOfCurvatureMm(zMm: number, mode: SpatialMode): number {
  const zR = rayleighRangeMm(mode);
  if (zMm === 0) return Infinity;
  return zMm * (1 + (zR / zMm) ** 2);
}

function gouyPhaseRad(zMm: number, mode: SpatialMode): number {
  const zR = rayleighRangeMm(mode);
  if (zR === 0) return 0;
  return Math.atan(zMm / zR);
}

/** Render the polarisation state of the clicked segment as
 *    - an SVG ellipse showing the E-field tip locus (axis-orientation +
 *      ellipticity), and
 *    - a one-line summary (linear @ N°, RHC, LHC, elliptical, …).
 *  Reads the Jones vector from the trace segment that was passed into the
 *  probe — already accounts for upstream waveplate / polarizer / PBS so
 *  passing a HWP visibly rotates the ellipse here. */
function PolarizationDisplay({ jones }: { jones: [number, number, number, number] }) {
  const [exRe, exIm, eyRe, eyIm] = jones;
  const intensity = exRe * exRe + exIm * exIm + eyRe * eyRe + eyIm * eyIm;
  if (intensity < 1e-9) {
    return (
      <div className="beam-scope-pol">
        <strong>Pol</strong>: (no light)
      </div>
    );
  }
  // Stokes parameters from the Jones vector. S0 = total intensity;
  // S1 = |Ex|² − |Ey|²; S2 = 2·Re(Ex·Ey*); S3 = 2·Im(Ex·Ey*) where * is
  // complex conjugate. Then azimuth ψ = ½·atan2(S2, S1) and ellipticity
  // χ = ½·asin(S3 / S0). Linear when |S3| ≈ 0; circular when |S3| ≈ S0.
  const S0 = intensity;
  const S1 = exRe * exRe + exIm * exIm - eyRe * eyRe - eyIm * eyIm;
  const exConjEy_Re = exRe * eyRe + exIm * eyIm;
  const exConjEy_Im = exRe * eyIm - exIm * eyRe;
  const S2 = 2 * exConjEy_Re;
  const S3 = 2 * exConjEy_Im;
  const psiRad = 0.5 * Math.atan2(S2, S1);
  const chiRad = 0.5 * Math.asin(Math.max(-1, Math.min(1, S3 / S0)));
  const psiDeg = (psiRad * 180) / Math.PI;
  const chiDeg = (chiRad * 180) / Math.PI;

  // Semi-axes of the ellipse from S0/χ. a = √S0·cos(χ), b = √S0·sin(χ).
  const a = Math.sqrt(S0) * Math.cos(chiRad);
  const b = Math.sqrt(S0) * Math.sin(chiRad);

  let label: string;
  if (Math.abs(chiDeg) < 1.5) {
    label = `linear @ ${psiDeg.toFixed(1)}°`;
  } else if (Math.abs(Math.abs(chiDeg) - 45) < 1.5) {
    label = chiDeg > 0 ? "right-hand circular" : "left-hand circular";
  } else {
    label = `elliptical (χ=${chiDeg.toFixed(1)}°, ψ=${psiDeg.toFixed(1)}°)`;
  }

  // Render an ellipse in a 60×60 SVG. Scale so |a|=24 fits.
  const scale = 24;
  const ax = scale * Math.abs(a);
  const ay = scale * Math.abs(b);
  return (
    <div className="beam-scope-pol">
      <strong>Pol</strong>: {label}
      <svg width={62} height={62} viewBox="-31 -31 62 62" className="beam-scope-pol-svg">
        <line x1={-28} y1={0} x2={28} y2={0} stroke="#475569" strokeDasharray="2 2" strokeWidth={0.6} />
        <line x1={0} y1={-28} x2={0} y2={28} stroke="#475569" strokeDasharray="2 2" strokeWidth={0.6} />
        <ellipse
          cx={0}
          cy={0}
          rx={Math.max(ax, 1)}
          ry={Math.max(ay, 1)}
          transform={`rotate(${(-psiDeg).toFixed(2)})`}
          fill="none"
          stroke="#facc15"
          strokeWidth={1.6}
        />
      </svg>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────

export function BeamScopePanel() {
  const probe = useSceneStore((state) => state.scopeProbe);
  const opticalElements = useSceneStore((state) => state.scene.opticalElements);
  const { togglePanelVisible, focusPanel } = useWorkspace();

  useEffect(() => {
    const onOpen = () => {
      togglePanelVisible("beam-scope", true);
      focusPanel("beam-scope");
    };
    window.addEventListener("qmem.openBeamScope", onOpen);
    return () => window.removeEventListener("qmem.openBeamScope", onOpen);
  }, [togglePanelVisible, focusPanel]);

  const snapshot = useMemo(() => {
    if (!probe) return null;
    // probe.sourceComponentId is legacy — map to the first scene object of
    // that component, then look up the OE by object_id (alembic 0014).
    const sourceObj = (useSceneStore.getState().scene.objects).find((o) => o.componentId === probe.sourceComponentId);
    const laserEl = sourceObj
      ? opticalElements.find((el) => el.objectId === sourceObj.id)
      : undefined;
    if (!laserEl) return null;
    const params = (laserEl.kindParams ?? {}) as {
      centerWavelengthNm?: number;
      spatialModeX?: { waistUm?: number; mSquared?: number };
      spatialModeY?: { waistUm?: number; mSquared?: number };
      nominalPowerMw?: number;
      spectrum?: {
        centerThz?: number;
        components?: Array<{
          kind?: string;
          lineshape?: "gaussian" | "lorentzian" | "delta";
          fwhmMhz?: number;
          amplitude?: number;
          centerOffsetMhz?: number;
        }>;
      };
    };
    const wxUm = params.spatialModeX?.waistUm ?? 100;
    const wyUm = params.spatialModeY?.waistUm ?? 100;
    const mxSq = params.spatialModeX?.mSquared ?? 1;
    const mySq = params.spatialModeY?.mSquared ?? 1;
    const wavelengthNm = params.centerWavelengthNm ?? 780;
    const mode: SpatialMode = {
      waist0Um: 0.5 * (wxUm + wyUm),
      mSquared: 0.5 * (mxSq + mySq),
      wavelengthNm,
    };
    const zMm = probe.zMm;
    const wUm = waistAtZUm(zMm, mode);
    const rMm = radiusOfCurvatureMm(zMm, mode);
    const gouy = gouyPhaseRad(zMm, mode);
    // probe.powerFactor / probe.polarization are the values AT CLICK TIME —
    // stale once the user rotates the upstream HWP. Re-derive both from the
    // current ray-trace by finding the segment whose start point is closest
    // to the clicked world point. This makes the scope live-update whenever
    // any upstream optic's kindParams change (the renderer republishes
    // `__rayTraceDebug` on every scene re-render, and we depend on
    // `opticalElements` so React re-runs this useMemo).
    const segs = ((window as unknown as { __rayTraceDebug?: Array<Record<string, unknown>> }).__rayTraceDebug) ?? [];
    const px = probe.pointThree.x, py = probe.pointThree.y, pz = probe.pointThree.z;
    let bestSeg: Record<string, unknown> | null = null;
    let bestDist = Infinity;
    for (const seg of segs) {
      const start = seg.startThree as { x: number; y: number; z: number } | undefined;
      const end = seg.endThree as { x: number; y: number; z: number } | undefined;
      if (!start || !end) continue;
      // Distance from probe point to the segment line (clamped between
      // endpoints) — small for the segment the user actually clicked on.
      const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
      const len2 = dx * dx + dy * dy + dz * dz;
      if (len2 < 1e-18) continue;
      let t = ((px - start.x) * dx + (py - start.y) * dy + (pz - start.z) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = start.x + dx * t, cy = start.y + dy * t, cz = start.z + dz * t;
      const d2 = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
      if (d2 < bestDist) { bestDist = d2; bestSeg = seg; }
    }
    const liveFactor = typeof bestSeg?.powerFactorAtStart === "number"
      ? (bestSeg.powerFactorAtStart as number)
      : (typeof probe.powerFactor === "number" ? probe.powerFactor : 1.0);
    const livePol = Array.isArray(bestSeg?.polarizationAtStart) && (bestSeg!.polarizationAtStart as number[]).length === 4
      ? (bestSeg!.polarizationAtStart as [number, number, number, number])
      : (probe.polarization ?? [1, 0, 0, 0]);
    const aomSideband = (bestSeg as {
      aomSideband?: {
        order?: -1 | 0 | 1;
        frequencyOffsetMhz?: number;
        angleMrad?: number;
        relativeIntensity?: number;
        centerFrequencyThz?: number;
        centerWavelengthNm?: number;
      };
    } | null)?.aomSideband;
    // "src → hit" label so the user knows which segment they're reading.
    const sceneObjs = (useSceneStore.getState().scene.objects);
    const srcId = bestSeg?.sourceObjectId as string | undefined;
    const hitId = bestSeg?.hitObjectId as string | undefined;
    const srcName = srcId ? sceneObjs.find((o) => o.id === srcId)?.name ?? "(emitter)" : "(emitter)";
    const hitName = hitId ? sceneObjs.find((o) => o.id === hitId)?.name ?? "(open)" : "(open)";
    const segmentLabel = `${srcName} → ${hitName}`;
    const branch = (bestSeg?.branch as string | undefined) ?? "main";
    const upstreamFactor = liveFactor;
    // Prefer the segment-level absolute reference (nominalPowerMwAtSource).
    // For laser emitters this matches kindParams.nominalPowerMw, but for a
    // tapered amplifier it differs per emission direction (forward vs.
    // backward) — using the kindParams value alone would mis-report
    // backward power. Falls back to the legacy lookup when the segment was
    // built before the field existed.
    const bestSegNominal = (bestSeg as { nominalPowerMwAtSource?: unknown } | null)?.nominalPowerMwAtSource;
    const segNominal = typeof bestSegNominal === "number"
      ? bestSegNominal
      : (params.nominalPowerMw ?? 1.0);
    const powerMw = segNominal * upstreamFactor;
    const taSeedCoupling = (bestSeg as {
      taSeedCoupling?: {
        rawSeedPowerMw: number;
        effectiveSeedPowerMw: number;
        modeOverlap: number;
        polarizationOverlap: number;
        distanceToInputMm: number;
      };
    } | null)?.taSeedCoupling;
    const C_M_PER_S = 299_792_458;
    const opticalCenterThz =
      typeof aomSideband?.centerFrequencyThz === "number"
        ? aomSideband.centerFrequencyThz
        : C_M_PER_S / (wavelengthNm * 1e-9) / 1e12;
    const displayWavelengthNm =
      typeof aomSideband?.centerWavelengthNm === "number"
        ? aomSideband.centerWavelengthNm
        : wavelengthNm;
    return {
      laserEl,
      params,
      mode,
      zMm,
      wUm,
      rMm,
      gouy,
      powerMw,
      wavelengthNm,
      displayWavelengthNm,
      opticalCenterThz,
      upstreamFactor,
      livePol,
      segmentLabel,
      branch,
      taSeedCoupling,
      aomSideband,
    };
  }, [probe, opticalElements]);

  if (!probe || !snapshot) {
    return (
      <FloatingPanel id="beam-scope" title="Beam scope">
        <p className="empty-state">Click on a beam segment (not on an optical element) to probe.</p>
      </FloatingPanel>
    );
  }

  const {
    params,
    mode,
    zMm,
    wUm,
    rMm,
    gouy,
    powerMw,
    displayWavelengthNm,
    opticalCenterThz,
    upstreamFactor,
    livePol,
    segmentLabel,
    branch,
    taSeedCoupling,
    aomSideband,
  } = snapshot;
  const k = (2 * Math.PI) / (displayWavelengthNm * 1e-9); // wavenumber, 1/m

  // ─ Spectrum (wavelength axis, ±10 · linewidth) ──────────────────────────
  // Strategy: convert each component's FWHM (in MHz) to its FWHM in nm via
  // Δλ ≈ λ²/c · Δν (small-bandwidth approx). The plot's half-span is
  // 10 · max(FWHM_nm) so the user sees the line shape clearly with margin.
  const C_M_PER_S = 299_792_458;
  const components = params.spectrum?.components ?? [
    { kind: "main", lineshape: "gaussian", fwhmMhz: 1.0, amplitude: 1.0, centerOffsetMhz: 0 },
  ];
  const fwhmsNm = components.map((c) => {
    const fwhmMhz = c.fwhmMhz ?? 1;
    const fwhmHz = fwhmMhz * 1e6;
    const lambdaM = displayWavelengthNm * 1e-9;
    return (lambdaM * lambdaM / C_M_PER_S) * fwhmHz * 1e9; // → nm
  });
  const maxFwhmNm = Math.max(1e-9, ...fwhmsNm);
  const spectrumSpanNm = 20 * maxFwhmNm; // ±10 widths total
  const spectrumPoints: PlotPoint[] = [];
  const N = 200;
  for (let i = 0; i < N; i++) {
    const lambdaPlotNm =
      displayWavelengthNm - spectrumSpanNm / 2 + (i / (N - 1)) * spectrumSpanNm;
    let amp = 0;
    components.forEach((c, idx) => {
      const offMhz = c.centerOffsetMhz ?? 0;
      // Convert this component's centre-offset MHz → nm offset
      const offHz = offMhz * 1e6;
      const offNm =
        ((displayWavelengthNm * 1e-9) ** 2 / C_M_PER_S) * offHz * 1e9;
      const cLambdaNm = displayWavelengthNm + offNm;
      const fwhmNm = fwhmsNm[idx];
      const a = c.amplitude ?? 1;
      const dNm = lambdaPlotNm - cLambdaNm;
      if (c.lineshape === "gaussian") {
        const sigma = fwhmNm / 2.355;
        amp += a * Math.exp(-(dNm * dNm) / (2 * sigma * sigma));
      } else if (c.lineshape === "lorentzian") {
        const gamma = fwhmNm / 2;
        amp += (a * gamma * gamma) / (dNm * dNm + gamma * gamma);
      } else {
        // delta — visualise as a very narrow gaussian (1/N width)
        const sigma = spectrumSpanNm / (4 * N);
        amp += a * Math.exp(-(dNm * dNm) / (2 * sigma * sigma));
      }
    });
    spectrumPoints.push({ x: lambdaPlotNm, y: amp });
  }
  const specMaxY = Math.max(...spectrumPoints.map((p) => p.y), 1e-9);
  const lambdaLow = displayWavelengthNm - spectrumSpanNm / 2;

  // ─ Beam profile (2D Gaussian intensity I(x, y)) ─────────────────────────
  // I(x, y) = I₀ · exp(−2(x² + y²)/w²)
  const wM = wUm * 1e-6;
  const I0 = (2 * powerMw * 1e-3) / (Math.PI * wM * wM); // W/m²
  const profileHalfUm = wUm * 2.5; // ±2.5 · w fits the spot with margin
  const sampleIntensity = (xUm: number, yUm: number) => {
    const r2 = (xUm * xUm + yUm * yUm) * 1e-12; // m²
    return I0 * Math.exp(-2 * r2 / (wM * wM));
  };

  // ─ Wavefront phase φ(x, y) = k·(x² + y²)/(2R) − ψ_Gouy (2D image) ──────
  const phaseHalfUm = wUm * 2;
  const samplePhase = (xUm: number, yUm: number) => {
    const rM2 = (xUm * xUm + yUm * yUm) * 1e-12;
    const rzM = rMm * 1e-3;
    return isFinite(rzM) && rzM !== 0 ? (k * rM2) / (2 * rzM) - gouy : -gouy;
  };

  // ─ Pulse temporal (CW = constant, pulsed = envelope) ────────────────────
  const isCw = true;
  const pulseSpanPs = 100;
  const pulsePoints: PlotPoint[] = [];
  for (let i = 0; i < N; i++) {
    const t = -pulseSpanPs / 2 + (i / (N - 1)) * pulseSpanPs;
    pulsePoints.push({ x: t, y: isCw ? 1.0 : Math.exp(-(t * t) / 50) });
  }

  return (
    <FloatingPanel id="beam-scope" title={`${segmentLabel}  ·  z = ${zMm.toFixed(1)} mm  ·  ${branch}`}>
      <div className="beam-scope-summary">
        <div><strong>w(z)</strong>: {wUm.toFixed(1)} µm</div>
        <div><strong>R(z)</strong>: {isFinite(rMm) ? rMm.toFixed(1) + " mm" : "∞"}</div>
        <div><strong>ψ<sub>Gouy</sub></strong>: {(gouy * (180 / Math.PI)).toFixed(2)}°</div>
        <div><strong>z<sub>R</sub></strong>: {rayleighRangeMm(mode).toFixed(1)} mm</div>
        <div>
          <strong>P</strong>: {powerMw.toFixed(2)} mW
          {upstreamFactor < 0.999 && (
            <span className="beam-scope-power-frac">
              {" "}({(upstreamFactor * 100).toFixed(1)}% of source)
            </span>
          )}
        </div>
        <PolarizationDisplay jones={livePol} />
        {taSeedCoupling && (
          <>
            <div>
              <strong>TA seed</strong>: {taSeedCoupling.effectiveSeedPowerMw.toFixed(2)} mW
              <span className="beam-scope-power-frac">
                {" "}({taSeedCoupling.rawSeedPowerMw.toFixed(2)} mW raw)
              </span>
            </div>
            <div>
              <strong>TA eta</strong>: mode {(taSeedCoupling.modeOverlap * 100).toFixed(1)}%, pol {(taSeedCoupling.polarizationOverlap * 100).toFixed(1)}%
            </div>
          </>
        )}
        <div><strong>lambda</strong>: {displayWavelengthNm.toFixed(6)} nm</div>
        <div><strong>nu</strong>: {opticalCenterThz.toFixed(6)} THz</div>
        {aomSideband && (
          <div>
            <strong>AOM</strong>: {aomSideband.order && aomSideband.order > 0 ? "+" : ""}{aomSideband.order ?? 0}
            {" "}/ df {((aomSideband.frequencyOffsetMhz ?? 0) >= 0 ? "+" : "")}{(aomSideband.frequencyOffsetMhz ?? 0).toFixed(1)} MHz
          </div>
        )}
      </div>

      <div className="beam-scope-grid">
        <PlotFrame
          title={`Spectrum  (lambda ${displayWavelengthNm.toFixed(6)} nm, FWHM ${maxFwhmNm.toExponential(2)} nm)`}
          xLabel="λ (nm)"
          yLabel="amp"
          xMax={spectrumSpanNm}
          xOffset={lambdaLow}
          yMax={specMaxY}
        >
          <path d={svgPoly(
            spectrumPoints.map((p) => ({ x: p.x - lambdaLow, y: p.y })),
            spectrumSpanNm,
            specMaxY,
            "rgba(220, 20, 60, 0.3)",
          )} fill="rgba(220, 20, 60, 0.3)" stroke="#dc143c" />
        </PlotFrame>

        <Heatmap
          size={140}
          halfExtentUm={profileHalfUm}
          sample={sampleIntensity}
          vmin={0}
          vmax={I0}
          colour={thermalColour}
          title={`Beam profile  I(x,y)  ·  peak ${I0.toExponential(2)} W/m²`}
          axisLabel="x, y (µm)"
        />

        <Heatmap
          size={140}
          halfExtentUm={phaseHalfUm}
          sample={samplePhase}
          colour={cyclicColour}
          title="Wavefront phase  φ(x,y)  ·  cyclic colour"
          axisLabel="x, y (µm)"
          valueLabelMin="−π"
          valueLabelMax="+π"
        />

        <PlotFrame title={isCw ? "Pulse |E(t)|² · CW" : "Pulse |E(t)|²"} xLabel="t (ps)" yLabel="‖E‖²"
                   xMax={pulseSpanPs / 2} yMax={1.05}>
          <path d={svgPoly(
            pulsePoints.map((p) => ({ x: Math.abs(p.x), y: p.y })),
            pulseSpanPs / 2,
            1.05,
            "rgba(34, 139, 34, 0.3)",
          )} fill="rgba(34, 139, 34, 0.3)" stroke="#228b22" />
        </PlotFrame>
      </div>
    </FloatingPanel>
  );
}
