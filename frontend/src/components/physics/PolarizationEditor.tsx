import React, { useEffect, useState } from "react";

import {
  type Jones,
  POLARIZATION_PRESETS,
  detectPreset,
  ellipseFromJones,
  jonesFromEllipse,
} from "../../optical/polarizationJones";

/** Polarization editor shared by the laser-source and tapered-amplifier
 *  control panels. Presents the stored complex Jones (ex = E∥axisY,
 *  ey = E∥axisZ) through three layers, finest-grained last:
 *    1. Named presets (H / V / ±45 / R-LCP).
 *    2. Continuous ellipse: orientation θ (° from axisY) + ellipticity χ
 *       (0 = linear, ±45 = circular). This is the missing knob — presets
 *       only reach 6 discrete states.
 *    3. Raw (exRe, exIm, eyRe, eyIm) for full manual control.
 *  All three write the same complex Jones, so circular / elliptical states
 *  survive. Renders the inner controls only; the parent supplies the section
 *  wrapper + title. */
export function PolarizationEditor({
  value,
  onChange,
}: {
  value: Jones;
  onChange: (next: Jones) => void;
}) {
  const preset = detectPreset(value);
  const { thetaDeg, chiDeg } = ellipseFromJones(value);

  const grid2: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 6,
  };

  return (
    <>
      <label className="component-editor-coord" style={{ marginBottom: 6 }}>
        <span style={{ fontSize: 11 }}>Preset</span>
        <select
          value={preset}
          onChange={(e) => {
            const p = POLARIZATION_PRESETS[e.target.value];
            if (p) onChange(p);
          }}
        >
          <option value="H">H — linear ∥ axisY</option>
          <option value="V">V — linear ∥ axisZ</option>
          <option value="+45">+45°</option>
          <option value="-45">−45°</option>
          <option value="RCP">RCP</option>
          <option value="LCP">LCP</option>
          <option value="custom">custom</option>
        </select>
      </label>

      {/* Continuous ellipse knobs — the intuitive spatial control. */}
      <div style={grid2}>
        <PolNumber
          label="Orientation θ"
          suffix="° from axisY"
          value={thetaDeg}
          step={5}
          onCommit={(t) => onChange(jonesFromEllipse(t, chiDeg))}
        />
        <PolNumber
          label="Ellipticity χ"
          suffix="° (±45=circular)"
          value={chiDeg}
          step={5}
          onCommit={(c) => onChange(jonesFromEllipse(thetaDeg, Math.max(-45, Math.min(45, c))))}
        />
      </div>

      {/* Raw complex Jones — full manual control. */}
      <div style={{ ...grid2, marginTop: 6 }}>
        <PolNumber label="Eₓ_re" value={value.exRe ?? 0} step={0.05} onCommit={(v) => onChange({ ...value, exRe: v })} />
        <PolNumber label="Eₓ_im" value={value.exIm ?? 0} step={0.05} onCommit={(v) => onChange({ ...value, exIm: v })} />
        <PolNumber label="Eᵧ_re" value={value.eyRe ?? 0} step={0.05} onCommit={(v) => onChange({ ...value, eyRe: v })} />
        <PolNumber label="Eᵧ_im" value={value.eyIm ?? 0} step={0.05} onCommit={(v) => onChange({ ...value, eyIm: v })} />
      </div>

      <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
        ex = E∥axisY, ey = E∥axisZ (complex). θ rotates the polarization in the
        axisY–axisZ plane; χ sets ellipticity. Jones is normalised at solver
        time — total power stays in Power (mW).
      </div>
    </>
  );
}

/** Numeric cell that commits on blur / Enter (uncontrolled draft). Mirrors
 *  the NumberCell used elsewhere in the panels; kept local so the editor is
 *  drop-in without prop-threading the parent's helper. */
function PolNumber({
  label,
  value,
  step = 0.1,
  suffix,
  onCommit,
}: {
  label: string;
  value: number;
  step?: number;
  suffix?: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(value.toString());
  useEffect(() => setDraft(value.toString()), [value]);
  const commit = (raw: string) => {
    const v = Number(raw);
    if (Number.isFinite(v)) onCommit(v);
  };
  return (
    <label className="component-editor-coord">
      <span style={{ fontSize: 11 }}>{label}{suffix ? ` (${suffix})` : ""}</span>
      <input
        type="number"
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit((e.target as HTMLInputElement).value);
          }
        }}
      />
    </label>
  );
}
