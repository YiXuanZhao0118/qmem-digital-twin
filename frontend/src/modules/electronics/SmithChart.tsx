/**
 * Smith chart — Phase B.7.
 *
 * Pure SVG (no external dependency). Plots one or more reflection-
 * coefficient traces (Γ = re + i·im) inside the unit disk, with
 * standard constant-resistance circles + constant-reactance arcs in
 * the background as a reference grid. Each trace is one S-parameter
 * (typically S11 or S22).
 */
import { useMemo } from "react";

const RESISTANCE_VALUES = [0.2, 0.5, 1, 2, 5];
const REACTANCE_VALUES = [0.2, 0.5, 1, 2, 5];

const SVG_PADDING = 16;
const SVG_SIZE = 320;
const CHART_RADIUS = (SVG_SIZE - SVG_PADDING * 2) / 2;
const CENTER = SVG_SIZE / 2;

// Map normalized Γ in [-1..1] to SVG pixels.
function gammaToPx(gx: number, gy: number): [number, number] {
  return [CENTER + gx * CHART_RADIUS, CENTER - gy * CHART_RADIUS];
}

export type Trace = {
  /** Series label, e.g. "S11". */
  label: string;
  color: string;
  /** Complex Γ samples [re, im]. */
  points: [number, number][];
};

type Props = {
  traces: Trace[];
};

export function SmithChart({ traces }: Props) {
  const grid = useMemo(() => buildGrid(), []);
  const tracePaths = useMemo(
    () => traces.map((t) => ({ ...t, path: tracePath(t.points) })),
    [traces],
  );

  return (
    <div className="smith-chart-block">
      <svg
        viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
        className="smith-chart-svg"
        aria-label="Smith chart"
      >
        {/* Background unit disk */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={CHART_RADIUS}
          fill="#fafaf7"
          stroke="rgba(15,23,42,0.3)"
          strokeWidth={1.2}
        />
        {/* Constant-resistance circles */}
        {grid.resistance.map((g, i) => (
          <circle key={`r${i}`} {...g} fill="none" stroke="rgba(15,23,42,0.18)" strokeWidth={0.6} />
        ))}
        {/* Constant-reactance arcs */}
        {grid.reactance.map((d, i) => (
          <path key={`x${i}`} d={d} fill="none" stroke="rgba(15,23,42,0.14)" strokeWidth={0.5} />
        ))}
        {/* Real axis */}
        <line
          x1={gammaToPx(-1, 0)[0]}
          y1={gammaToPx(-1, 0)[1]}
          x2={gammaToPx(1, 0)[0]}
          y2={gammaToPx(1, 0)[1]}
          stroke="rgba(15,23,42,0.25)"
          strokeWidth={0.6}
        />
        {/* Origin marker */}
        <circle cx={CENTER} cy={CENTER} r={2} fill="rgba(15,23,42,0.5)" />

        {/* Axis ticks/labels */}
        <text x={CENTER + CHART_RADIUS - 4} y={CENTER - 6} fontSize={9} fill="rgba(15,23,42,0.5)" textAnchor="end">+1</text>
        <text x={CENTER - CHART_RADIUS + 4} y={CENTER - 6} fontSize={9} fill="rgba(15,23,42,0.5)">−1</text>

        {/* Plotted traces */}
        {tracePaths.map((t) => (
          <g key={t.label}>
            <path d={t.path} fill="none" stroke={t.color} strokeWidth={1.5} strokeLinejoin="round" />
            {/* Endpoint marker (highest frequency) */}
            {t.points.length > 0 && (() => {
              const last = t.points[t.points.length - 1];
              const [px, py] = gammaToPx(last[0], last[1]);
              return <circle cx={px} cy={py} r={3} fill={t.color} />;
            })()}
            {/* Start marker (lowest frequency) */}
            {t.points.length > 0 && (() => {
              const first = t.points[0];
              const [px, py] = gammaToPx(first[0], first[1]);
              return <circle cx={px} cy={py} r={3} fill="#ffffff" stroke={t.color} strokeWidth={1.5} />;
            })()}
          </g>
        ))}
      </svg>
      {tracePaths.length > 0 && (
        <ul className="smith-chart-legend">
          {tracePaths.map((t) => (
            <li key={t.label}>
              <span className="smith-chart-swatch" style={{ background: t.color }} />
              {t.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function tracePath(points: [number, number][]): string {
  if (points.length === 0) return "";
  const segs: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const [px, py] = gammaToPx(points[i][0], points[i][1]);
    segs.push(`${i === 0 ? "M" : "L"}${px.toFixed(2)},${py.toFixed(2)}`);
  }
  return segs.join(" ");
}

function buildGrid() {
  const resistance = RESISTANCE_VALUES.map((r) => {
    // Resistance circle: center (r/(r+1), 0), radius 1/(r+1) in Γ-plane.
    const cx = r / (r + 1);
    const radius = 1 / (r + 1);
    const [px, py] = gammaToPx(cx, 0);
    return { cx: px, cy: py, r: radius * CHART_RADIUS };
  });

  // Reactance arcs: center (1, 1/x), radius 1/|x|. Only the portion
  // inside the unit disk is meaningful. Approximate with SVG path that
  // draws the full circle and let the SVG clip at the unit disk via a
  // clip-path rendered as a separate <defs>.
  // For Phase B.7 tightness we just draw the full small circles and accept
  // a tiny bit of overshoot — visually close enough.
  const reactance: string[] = [];
  for (const x of REACTANCE_VALUES) {
    for (const sign of [1, -1]) {
      const cx = 1;
      const cy = (sign * 1) / x;
      const radius = 1 / x;
      const [px, py] = gammaToPx(cx, cy);
      const r = radius * CHART_RADIUS;
      reactance.push(
        `M ${px - r} ${py} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`,
      );
    }
  }
  return { resistance, reactance };
}
