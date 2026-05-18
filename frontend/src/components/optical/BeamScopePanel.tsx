// Beam-scope panel: shows the beam state at a probe point along the optical
// path. The probe is set by clicking on a beam segment in the 3D viewer; the
// click handler computes the cumulative path length z (mm from emission) and
// stores it in `useSceneStore.scopeProbe`. This panel reads that probe and
// renders four small SVG plots: spectrum, beam profile, wavefront phase, and
// pulse-temporal envelope.

import { useEffect, useMemo, useRef, useState } from "react";

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

/** Per-axis Gaussian beam parameters. The X and Y axes propagate
 *  independently with their own waist, M², and waist-z-offset (the axial
 *  position where the waist is, relative to the source). This is needed
 *  for astigmatic beams (e.g., a TA output is typically 500 µm × 50 µm). */
type AxisMode = {
  waist0Um: number;
  mSquared: number;
  waistZOffsetMm: number;
  wavelengthNm: number;
};

function rayleighRangeMmAxis(mode: AxisMode): number {
  // z_R = π · w₀² / (M² · λ) — keep all in µm then convert to mm at the end.
  const zRUm = (Math.PI * mode.waist0Um * mode.waist0Um) / (mode.mSquared * mode.wavelengthNm * 1e-3);
  return zRUm / 1000;
}

/** w(z) for one axis. dz is measured from the per-axis waist position
 *  (which may be offset from the source by `waistZOffsetMm`), so an
 *  astigmatic beam can have its X waist at the source but its Y waist
 *  1 mm downstream. */
function waistAtZUmAxis(zMm: number, mode: AxisMode): number {
  const zR = rayleighRangeMmAxis(mode);
  if (zR === 0) return mode.waist0Um;
  const dz = zMm - mode.waistZOffsetMm;
  return mode.waist0Um * Math.sqrt(1 + (dz / zR) ** 2);
}

function radiusOfCurvatureMmAxis(zMm: number, mode: AxisMode): number {
  const zR = rayleighRangeMmAxis(mode);
  const dz = zMm - mode.waistZOffsetMm;
  if (Math.abs(dz) < 1e-9) return Infinity;
  return dz * (1 + (zR / dz) ** 2);
}

function gouyPhaseRadAxis(zMm: number, mode: AxisMode): number {
  const zR = rayleighRangeMmAxis(mode);
  if (zR === 0) return 0;
  return Math.atan((zMm - mode.waistZOffsetMm) / zR);
}

/** Hermite polynomial H_n(ξ) by the standard recursion
 *  H_{n+1}(ξ) = 2ξ H_n(ξ) − 2n H_{n−1}(ξ).  Returns 0 for negative n. */
function hermiteH(n: number, xi: number): number {
  if (n < 0 || !Number.isInteger(n)) return 0;
  let h0 = 1;
  let h1 = 2 * xi;
  if (n === 0) return h0;
  if (n === 1) return h1;
  for (let k = 1; k < n; k++) {
    const next = 2 * xi * h1 - 2 * k * h0;
    h0 = h1;
    h1 = next;
  }
  return h1;
}

/** Associated Laguerre polynomial L_p^α(x) by recursion
 *  (p+1) L_{p+1}^α(x) = (2p + 1 + α − x) L_p^α(x) − (p + α) L_{p−1}^α(x).
 *  L_0^α = 1; L_1^α = 1 + α − x. p must be a non-negative integer; α can
 *  be any non-negative real (we only call with α = |ℓ|, integer ≥ 0).
 *  Returns 0 for invalid p. */
function laguerreAssociated(p: number, alpha: number, x: number): number {
  if (p < 0 || !Number.isInteger(p)) return 0;
  let lkm1 = 1; // L_0^α
  if (p === 0) return lkm1;
  let lk = 1 + alpha - x; // L_1^α
  if (p === 1) return lk;
  for (let k = 1; k < p; k++) {
    const lkp1 = ((2 * k + 1 + alpha - x) * lk - (k + alpha) * lkm1) / (k + 1);
    lkm1 = lk;
    lk = lkp1;
  }
  return lk;
}

/** Factorial for non-negative integers; tolerates double inputs by
 *  rounding. Returns NaN on negatives so callers fall back. */
function factorial(n: number): number {
  if (n < 0) return NaN;
  const k = Math.round(n);
  let acc = 1;
  for (let i = 2; i <= k; i++) acc *= i;
  return acc;
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

/** Inner UI of the beam scope: snapshot computation + summary line +
 *  spectrum / profile / phase / pulse plots. Used both by the legacy
 *  floating BeamScopePanel and embedded inline inside the optical-link
 *  viewer panel. Returns a Fragment (no FloatingPanel chrome). */
type RawSegment = Record<string, unknown> & {
  startThree?: { x: number; y: number; z: number };
  endThree?: { x: number; y: number; z: number };
  waistAtStartUm?: number;
  waistAtEndUm?: number;
  sourceObjectId?: string;
  hitObjectId?: string;
  wavelengthNm?: number;
};

export function BeamScopeContents() {
  const probe = useSceneStore((state) => state.scopeProbe);
  const physicsElements = useSceneStore((state) => state.scene.physicsElements);
  const sceneObjects = useSceneStore((state) => state.scene.objects);

  // Find every segment whose centreline passes within its own Gaussian
  // waist of the probe point. When two beams are combined by a PBS or
  // dichroic, both pass this test at the same probe and the user gets
  // tabs to inspect each beam separately. Sorted closest-first so the
  // default tab is the beam the user most likely clicked on. Recomputed
  // on each store mutation so live changes to the ray trace (e.g., the
  // user rotates a waveplate upstream) reorder/filter tabs as needed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const overlappingSegments = useMemo<RawSegment[]>(() => {
    if (!probe) return [];
    const allSegs = ((window as unknown as { __rayTraceDebug?: RawSegment[] }).__rayTraceDebug) ?? [];
    const px = probe.pointThree.x, py = probe.pointThree.y, pz = probe.pointThree.z;
    type Match = { seg: RawSegment; distThree: number };
    const matches: Match[] = [];
    for (const seg of allSegs) {
      const a = seg.startThree;
      const b = seg.endThree;
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const len2 = dx * dx + dy * dy + dz * dz;
      if (len2 < 1e-18) continue;
      let t = ((px - a.x) * dx + (py - a.y) * dy + (pz - a.z) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = a.x + dx * t, cy = a.y + dy * t, cz = a.z + dz * t;
      const distThree = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2);
      // Convert this segment's waist at the probe's t into Three units
      // (1 Three unit = 100 mm via MM_PER_THREE_UNIT). A segment counts
      // as "passing through" the probe when the probe is within the
      // beam's geometric Gaussian radius — physically meaningful, and
      // for PBS-coincident beams (distance ≈ 0) it always matches.
      const wStartUm = typeof seg.waistAtStartUm === "number" ? seg.waistAtStartUm : 100;
      const wEndUm = typeof seg.waistAtEndUm === "number" ? seg.waistAtEndUm : 100;
      const waistAtProbeUm = wStartUm + (wEndUm - wStartUm) * t;
      const waistThreshThree = waistAtProbeUm / 100_000; // µm → mm (÷1000) → Three (÷100)
      if (distThree <= waistThreshThree) matches.push({ seg, distThree });
    }
    matches.sort((a, b) => a.distThree - b.distThree);
    return matches.map((m) => m.seg);
  }, [probe, physicsElements]);

  const [activeBeamIndex, setActiveBeamIndex] = useState(0);
  // A fresh probe always defaults to the closest beam.
  useEffect(() => { setActiveBeamIndex(0); }, [probe]);
  const safeBeamIndex = Math.min(activeBeamIndex, Math.max(0, overlappingSegments.length - 1));

  const snapshot = useMemo(() => {
    if (!probe) return null;
    // Multi-beam: each tab maps to one segment. The segment's source-
    // object id determines which emitter's kindParams to use — this is
    // critical when two different lasers are combined by a PBS, since
    // each beam has its own waist / wavelength / mode.
    const bestSeg = overlappingSegments[safeBeamIndex];
    if (!bestSeg) return null;
    const laserEl = physicsElements.find((el) => el.objectId === bestSeg.sourceObjectId);
    if (!laserEl) return null;
    const params = (laserEl.kindParams ?? {}) as {
      centerWavelengthNm?: number;
      spatialModeX?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number };
      spatialModeY?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number };
      transverseMode?: {
        kind?: "TEM00" | "TEM_mn" | "LG_pl" | "multimode";
        indicesM?: number;
        indicesN?: number;
        indicesP?: number;
        indicesL?: number;
      };
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
    const wavelengthNm = params.centerWavelengthNm ?? 780;
    const modeX: AxisMode = {
      waist0Um: params.spatialModeX?.waistUm ?? 100,
      mSquared: params.spatialModeX?.mSquared ?? 1,
      waistZOffsetMm: params.spatialModeX?.waistZOffsetMm ?? 0,
      wavelengthNm,
    };
    const modeY: AxisMode = {
      waist0Um: params.spatialModeY?.waistUm ?? 100,
      mSquared: params.spatialModeY?.mSquared ?? 1,
      waistZOffsetMm: params.spatialModeY?.waistZOffsetMm ?? 0,
      wavelengthNm,
    };
    const zMm = probe.zMm;
    const wxUm = waistAtZUmAxis(zMm, modeX);
    const wyUm = waistAtZUmAxis(zMm, modeY);
    const rxMm = radiusOfCurvatureMmAxis(zMm, modeX);
    const ryMm = radiusOfCurvatureMmAxis(zMm, modeY);
    const gouyX = gouyPhaseRadAxis(zMm, modeX);
    const gouyY = gouyPhaseRadAxis(zMm, modeY);
    const tm = params.transverseMode ?? { kind: "TEM00" };
    // For TEM_mn use the configured (m, n); TEM00 forces m=n=0;
    // LG_pl uses (p, ℓ) directly via the Laguerre-Gauss intensity
    // formula; multimode falls back to TEM00 rendering (incoherent
    // superposition is out of scope here, but stored kindParams still
    // round-trip via the API).
    const hgM = tm.kind === "TEM_mn" ? Math.max(0, Math.round(tm.indicesM ?? 0)) : 0;
    const hgN = tm.kind === "TEM_mn" ? Math.max(0, Math.round(tm.indicesN ?? 0)) : 0;
    const lgP = tm.kind === "LG_pl" ? Math.max(0, Math.round(tm.indicesP ?? 0)) : 0;
    const lgL = tm.kind === "LG_pl" ? Math.round(tm.indicesL ?? 0) : 0;
    const modeLabel: string =
      tm.kind === "TEM_mn"
        ? `HG ${hgM},${hgN}`
        : tm.kind === "LG_pl"
        ? `LG p=${lgP}, ℓ=${lgL}`
        : tm.kind === "multimode"
        ? "multimode (rendered as TEM₀₀)"
        : "TEM₀₀";
    // probe.powerFactor / probe.polarization are the values AT CLICK TIME —
    // stale once the user rotates the upstream HWP. The overlappingSegments
    // useMemo already picked the live ray-trace segment for this tab (sorted
    // by distance), so we just consume it. Keeping the same liveFactor / livePol
    // fallback pattern preserves the pre-multi-beam behaviour for segments
    // missing those fields.
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
    const fiberCoupling = (bestSeg as {
      fiberCoupling?: {
        etaMode: number;
        etaFresnel: number;
        etaAttenuation: number;
        etaTotal: number;
        arcLengthM: number;
        mfdEntryUm: number;
        mfdExitUm: number;
      };
    } | null)?.fiberCoupling;
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
      modeX,
      modeY,
      zMm,
      wxUm,
      wyUm,
      rxMm,
      ryMm,
      gouyX,
      gouyY,
      hgM,
      hgN,
      lgP,
      lgL,
      modeLabel,
      tmKind: tm.kind ?? "TEM00",
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
      fiberCoupling,
    };
  }, [probe, physicsElements, overlappingSegments, safeBeamIndex]);

  if (!probe || !snapshot) {
    return (
      <p className="empty-state">Click on a beam segment to probe.</p>
    );
  }

  const {
    params,
    modeX,
    modeY,
    zMm,
    wxUm,
    wyUm,
    rxMm,
    ryMm,
    gouyX,
    gouyY,
    hgM,
    hgN,
    lgP,
    lgL,
    modeLabel,
    tmKind,
    powerMw,
    displayWavelengthNm,
    opticalCenterThz,
    upstreamFactor,
    livePol,
    segmentLabel,
    branch,
    taSeedCoupling,
    aomSideband,
    fiberCoupling,
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

  // ─ Beam profile — dispatches by transverse-mode family ────────────────
  // HG (TEM_mn / TEM00): astigmatic |E_{m,n}|² ∝ H_m²(√2·x/w_x) · H_n²(√2·y/w_y)
  //                                                  · exp(−2x²/w_x² − 2y²/w_y²)
  // LG (LG_pl): cylindrically symmetric — assumes a circular Gaussian, so
  //   uses the geometric mean √(w_x · w_y) as the effective waist (LG
  //   modes aren't well-defined on astigmatic beams). Intensity is
  //     |E_{p,ℓ}|² ∝ (2r²/w₀²)^|ℓ| · [L_p^|ℓ|(2r²/w₀²)]² · exp(−2r²/w₀²)
  //   times the field-amplitude normalisation √(2 p! / (π (p+|ℓ|)!)).
  // Multimode / unknown families fall back to TEM₀₀ (circular Gaussian).
  const wxM = wxUm * 1e-6;
  const wyM = wyUm * 1e-6;
  const I0 = (2 * powerMw * 1e-3) / (Math.PI * wxM * wyM); // W/m² peak for TEM₀₀

  // LG uses circular waist; warn label if astigmatism is significant.
  const wEffUm = Math.sqrt(wxUm * wyUm);
  const lgL_abs = Math.abs(lgL);
  // Field-amplitude normalisation for LG (squared because we want |E|²).
  const lgNormSq = lgP >= 0 && Number.isFinite(factorial(lgP)) && Number.isFinite(factorial(lgP + lgL_abs))
    ? (2 * factorial(lgP)) / (Math.PI * factorial(lgP + lgL_abs))
    : 1;

  // Half-extent: HG fringes from sidelobes; LG rings from p; |ℓ|>0 grows
  // the radius of peak intensity to ≈ w · √(|ℓ|+2p)/√2.
  const hgFringeMult = 1 + 0.7 * Math.max(hgM, hgN);
  const lgRingMult = 1 + 0.6 * (lgP + lgL_abs);
  const profileHalfUm =
    tmKind === "LG_pl"
      ? wEffUm * 2.5 * lgRingMult
      : Math.max(wxUm, wyUm) * 2.5 * hgFringeMult;

  const sampleIntensity = (xUm: number, yUm: number) => {
    if (tmKind === "LG_pl") {
      const rUm2 = xUm * xUm + yUm * yUm;
      const u = (2 * rUm2) / (wEffUm * wEffUm); // dimensionless 2r²/w²
      const env = Math.exp(-u);
      const Lp = laguerreAssociated(lgP, lgL_abs, u);
      const radial = Math.pow(u, lgL_abs);
      // Multiply by I₀ for absolute scale; lgNormSq · radial · L² · env
      // is the un-normalised cylindrical intensity profile.
      return I0 * lgNormSq * radial * Lp * Lp * env;
    }
    // HG branch (TEM_mn or TEM00 fallback).
    const xiX = (Math.SQRT2 * xUm) / wxUm;
    const xiY = (Math.SQRT2 * yUm) / wyUm;
    const env = Math.exp(
      -2 * (xUm * xUm) / (wxUm * wxUm) - 2 * (yUm * yUm) / (wyUm * wyUm),
    );
    if (hgM === 0 && hgN === 0) {
      return I0 * env;
    }
    const Hm = hermiteH(hgM, xiX);
    const Hn = hermiteH(hgN, xiY);
    return I0 * Hm * Hm * Hn * Hn * env;
  };

  // ─ Wavefront phase φ(x, y) — mode-aware ────────────────────────────────
  // HG: φ = k·(x²/2R_x + y²/2R_y) − (m + n + 1)·½·(ψ_x + ψ_y)
  // LG: φ = k·r²/(2R) + ℓ·atan2(y,x) − (2p + |ℓ| + 1)·ψ
  //   (the e^{iℓφ} helical phase factor comes from the azimuthal angle).
  // Half-extent matches the beam profile so the user sees both plots
  // over the same window.
  const phaseHalfUm = profileHalfUm * 0.8;
  const gouyAvg = 0.5 * (gouyX + gouyY);
  const gouyHg = (hgM + hgN + 1) * gouyAvg;
  const gouyLg = (2 * lgP + lgL_abs + 1) * gouyAvg;
  const rEffMm = 0.5 * ((isFinite(rxMm) ? rxMm : Infinity) + (isFinite(ryMm) ? ryMm : Infinity));
  const samplePhase = (xUm: number, yUm: number) => {
    if (tmKind === "LG_pl") {
      const rM2 = (xUm * 1e-6) * (xUm * 1e-6) + (yUm * 1e-6) * (yUm * 1e-6);
      const rM = rEffMm * 1e-3;
      let phi = -gouyLg + lgL * Math.atan2(yUm, xUm);
      if (isFinite(rM) && rM !== 0) phi += (k * rM2) / (2 * rM);
      return phi;
    }
    const xM2 = (xUm * 1e-6) * (xUm * 1e-6);
    const yM2 = (yUm * 1e-6) * (yUm * 1e-6);
    const rxM = rxMm * 1e-3;
    const ryM = ryMm * 1e-3;
    let phi = -gouyHg;
    if (isFinite(rxM) && rxM !== 0) phi += (k * xM2) / (2 * rxM);
    if (isFinite(ryM) && ryM !== 0) phi += (k * yM2) / (2 * ryM);
    return phi;
  };

  // ─ Pulse temporal (CW = constant, pulsed = envelope) ────────────────────
  const isCw = true;
  const pulseSpanPs = 100;
  const pulsePoints: PlotPoint[] = [];
  for (let i = 0; i < N; i++) {
    const t = -pulseSpanPs / 2 + (i / (N - 1)) * pulseSpanPs;
    pulsePoints.push({ x: t, y: isCw ? 1.0 : Math.exp(-(t * t) / 50) });
  }

  const showTabs = overlappingSegments.length > 1;

  return (
    <>
      {showTabs && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: "4px 6px 6px",
            borderBottom: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          <div style={{ fontSize: 11, color: "#facc15" }}>
            {`${overlappingSegments.length} beams overlapping at probe`}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {overlappingSegments.map((seg, i) => {
              const src = sceneObjects.find((o) => o.id === seg.sourceObjectId);
              const hit = seg.hitObjectId
                ? sceneObjects.find((o) => o.id === seg.hitObjectId)
                : null;
              const wl =
                typeof seg.wavelengthNm === "number"
                  ? `${seg.wavelengthNm.toFixed(0)}nm`
                  : "?";
              const label = `${src?.name ?? "(emitter)"} → ${hit?.name ?? "(open)"}  ·  ${wl}`;
              const active = i === safeBeamIndex;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActiveBeamIndex(i)}
                  style={{
                    fontSize: 10,
                    padding: "2px 8px",
                    borderRadius: 3,
                    border: "1px solid",
                    borderColor: active ? "#facc15" : "rgba(255,255,255,0.12)",
                    background: active ? "rgba(250,204,21,0.15)" : "transparent",
                    color: active ? "#facc15" : "#9ca3af",
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="beam-scope-segment-header" style={{
        fontSize: 11,
        color: "#9ca3af",
        padding: "4px 6px",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        marginBottom: 4,
      }}>
        {`${segmentLabel}  ·  z = ${zMm.toFixed(1)} mm  ·  ${branch}  ·  ${modeLabel}`}
      </div>
      <div className="beam-scope-summary">
        <div>
          <strong>w(z)</strong>: {wxUm.toFixed(1)} × {wyUm.toFixed(1)} µm
          <span className="beam-scope-power-frac"> (x × y)</span>
        </div>
        <div>
          <strong>R(z)</strong>:{" "}
          {isFinite(rxMm) ? rxMm.toFixed(1) : "∞"} ×{" "}
          {isFinite(ryMm) ? ryMm.toFixed(1) : "∞"} mm
          <span className="beam-scope-power-frac"> (R_x × R_y)</span>
        </div>
        <div>
          <strong>ψ<sub>Gouy</sub></strong>:{" "}
          {(() => {
            const psi = 0.5 * (gouyX + gouyY);
            const factor =
              tmKind === "LG_pl"
                ? 2 * lgP + Math.abs(lgL) + 1
                : hgM + hgN + 1;
            return (factor * psi * (180 / Math.PI)).toFixed(2);
          })()}°
          {(hgM > 0 || hgN > 0 || tmKind === "LG_pl") && (
            <span className="beam-scope-power-frac">
              {" "}
              ({tmKind === "LG_pl" ? "(2p+|ℓ|+1)" : "(m+n+1)"} factor applied)
            </span>
          )}
        </div>
        <div>
          <strong>z<sub>R</sub></strong>: {rayleighRangeMmAxis(modeX).toFixed(1)} ×{" "}
          {rayleighRangeMmAxis(modeY).toFixed(1)} mm
        </div>
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
        {fiberCoupling && (
          <>
            <div>
              <strong>Fiber η</strong>: {(fiberCoupling.etaTotal * 100).toFixed(2)}%
              {" "}<span style={{ opacity: 0.7 }}>
                = mode {(fiberCoupling.etaMode * 100).toFixed(1)}%
                {" × "}Fresnel {(fiberCoupling.etaFresnel * 100).toFixed(1)}%
                {" × "}atten {(fiberCoupling.etaAttenuation * 100).toFixed(1)}%
              </span>
            </div>
            <div style={{ opacity: 0.7 }}>
              <strong>Fiber</strong>: L {fiberCoupling.arcLengthM.toFixed(3)} m
              {" · "}MFD entry {fiberCoupling.mfdEntryUm.toFixed(2)} µm
              {" / "}exit {fiberCoupling.mfdExitUm.toFixed(2)} µm
            </div>
          </>
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
          /* HG (m,n>0) and LG modes have peaks that shift off-axis or
             exceed I₀ (TEM₀₀'s peak), so let the heatmap auto-range. */
          vmax={tmKind === "LG_pl" || hgM > 0 || hgN > 0 ? undefined : I0}
          colour={thermalColour}
          title={
            tmKind === "LG_pl"
              ? `Beam profile  ${modeLabel}  ·  w_eff ${wEffUm.toFixed(1)} µm`
              : `Beam profile  ${modeLabel}  ·  w_x ${wxUm.toFixed(1)}, w_y ${wyUm.toFixed(1)} µm`
          }
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
    </>
  );
}

/** Floating-panel chrome around BeamScopeContents — kept for code
 *  compatibility but no longer rendered in App.tsx (the contents now
 *  live inside the optical-link viewer panel). */
export function BeamScopePanel() {
  const { togglePanelVisible, focusPanel } = useWorkspace();
  useEffect(() => {
    const onOpen = () => {
      togglePanelVisible("beam-scope", true);
      focusPanel("beam-scope");
    };
    window.addEventListener("qmem.openBeamScope", onOpen);
    return () => window.removeEventListener("qmem.openBeamScope", onOpen);
  }, [togglePanelVisible, focusPanel]);
  return (
    <FloatingPanel id="beam-scope" title="Beam scope">
      <BeamScopeContents />
    </FloatingPanel>
  );
}
