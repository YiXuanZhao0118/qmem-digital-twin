/**
 * Jacket colour + visual radius editor for cable Components / SceneObjects
 * (plan §5.5). Edits the `cableAppearance` blob; "Restore default" clears a
 * key so it falls back to the kind default (fiberType colour table / RG-316).
 * Visual only — radius is decoupled from the physical fibre/core spec.
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from "react";

import {
  CABLE_JACKET_SWATCHES,
  CABLE_RADIUS_MAX_MM,
  CABLE_RADIUS_MIN_MM,
  type CableAppearance,
} from "../three/loadAsset/cableAppearance";

const LABEL: CSSProperties = { fontSize: 11, color: "#6b7280", fontWeight: 600 };
const INPUT: CSSProperties = {
  background: "#ffffff",
  color: "#1f2937",
  border: "1px solid #d8ded8",
  padding: "3px 5px",
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
};

export function CableAppearanceEditor({
  value,
  defaultColorHex,
  onChange,
}: {
  value: CableAppearance;
  /** Kind-default jacket colour shown when no override is set. */
  defaultColorHex: string;
  onChange: (next: CableAppearance) => void;
}): ReactElement {
  // Local draft so the radius slider stays smooth; commit on release (and
  // immediately for discrete colour / number / restore actions) — each
  // commit triggers a scene reload upstream.
  const [draft, setDraft] = useState<CableAppearance>(value);
  useEffect(() => setDraft(value), [JSON.stringify(value)]);

  const color = draft.jacketColorHex ?? defaultColorHex;
  const radius = draft.radiusMm ?? 1.0;
  const hasColor = draft.jacketColorHex != null;
  const hasRadius = draft.radiusMm != null;

  const commit = (p: Partial<CableAppearance>): void => {
    const next = { ...draft, ...p };
    setDraft(next);
    onChange(next);
  };
  const clear = (key: keyof CableAppearance): void => {
    const next = { ...draft };
    delete next[key];
    setDraft(next);
    onChange(next);
  };

  return (
    <div
      style={{
        marginTop: 8,
        border: "1px solid #e9ece9",
        borderRadius: 2,
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <span style={{ ...LABEL, color: "#374151" }}>Appearance (visual only)</span>

      {/* Jacket colour */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ ...LABEL, width: 48 }}>jacket</span>
        <input
          type="color"
          value={color}
          onChange={(e) => commit({ jacketColorHex: e.target.value })}
          style={{ width: 28, height: 22, padding: 0, border: "1px solid #d8ded8", background: "#fff", cursor: "pointer" }}
        />
        {CABLE_JACKET_SWATCHES.map((s) => (
          <button
            key={s.hex}
            type="button"
            title={s.label}
            onClick={() => commit({ jacketColorHex: s.hex })}
            style={{
              width: 18,
              height: 18,
              borderRadius: 3,
              background: s.hex,
              border: color.toLowerCase() === s.hex.toLowerCase() ? "2px solid #111827" : "1px solid #d8ded8",
              cursor: "pointer",
              padding: 0,
            }}
          />
        ))}
        {hasColor && (
          <button type="button" onClick={() => clear("jacketColorHex")} style={{ ...INPUT, cursor: "pointer", color: "#6b7280" }}>
            default
          </button>
        )}
      </div>

      {/* Radius */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ ...LABEL, width: 48 }}>radius</span>
        <input
          type="range"
          min={CABLE_RADIUS_MIN_MM}
          max={CABLE_RADIUS_MAX_MM}
          step={0.1}
          value={radius}
          onChange={(e) => setDraft({ ...draft, radiusMm: Number(e.target.value) })}
          onPointerUp={() => onChange(draft)}
          style={{ flex: 1 }}
        />
        <input
          type="number"
          min={CABLE_RADIUS_MIN_MM}
          max={CABLE_RADIUS_MAX_MM}
          step={0.1}
          value={radius}
          onChange={(e) => commit({ radiusMm: Number(e.target.value) })}
          style={{ ...INPUT, width: 56, textAlign: "right" }}
        />
        <span style={{ fontSize: 10, color: "#9ca3af" }}>mm</span>
        {hasRadius && (
          <button type="button" onClick={() => clear("radiusMm")} style={{ ...INPUT, cursor: "pointer", color: "#6b7280" }}>
            default
          </button>
        )}
      </div>
    </div>
  );
}
