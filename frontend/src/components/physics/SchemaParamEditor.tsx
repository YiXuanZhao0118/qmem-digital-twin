/**
 * Generic schema-driven param editor — renders ANY kind's params from its
 * typed `physics.paramSchema` (number → input, enum → dropdown, boolean →
 * checkbox, record → nested, list → repeated blocks). ONE component replaces
 * per-asset bespoke editors (the device-registry plan's "❌ per-type editor
 * branch" rule).
 *
 * Used by the PHY Editor (asset defaults + tunable toggles) and — Phase 2 —
 * the Object panel (per-instance values → dynamicSources). Pure controlled
 * component: `value` in, `onChange(nextValue)` out, immutable updates.
 */
import type { CSSProperties } from "react";
import { RotateCcw } from "lucide-react";

import {
  defaultForSpec,
  type ParamSchema,
  type ParamSpec,
} from "../../kinds/paramSchema";
import { cleanNumber } from "../../utils/numberFormat";

const LABEL: CSSProperties = { fontSize: 11, color: "#6b7280" };
const INPUT: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "#fff",
  color: "#1f2937",
  border: "1px solid #d8ded8",
  padding: "3px 5px",
  fontSize: 11,
};

export function SchemaParamEditor({
  schema,
  value,
  onChange,
  tunableParams,
  onToggleTunable,
  cardinalityByRole,
}: {
  schema: ParamSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** When provided, a tunable checkbox renders next to each top-level key. */
  tunableParams?: string[];
  onToggleTunable?: (key: string, on: boolean) => void;
  /** List length per anchor role (rf_out → channel count). */
  cardinalityByRole?: Record<string, number>;
}) {
  const tunableSet = new Set(tunableParams ?? []);
  const setKey = (key: string, v: unknown) => onChange({ ...value, [key]: v });

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {Object.entries(schema).map(([key, spec]) => (
        <div key={key} style={{ display: "grid", gap: 3 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: "#374151", fontWeight: 600 }}>
              {spec.label ?? key}
            </span>
            {onToggleTunable && (
              <label style={{ display: "flex", alignItems: "center", gap: 3, ...LABEL }}>
                <input
                  type="checkbox"
                  checked={tunableSet.has(key)}
                  onChange={(e) => onToggleTunable(key, e.target.checked)}
                />
                tunable
              </label>
            )}
          </div>
          <SpecField
            spec={spec}
            value={value[key]}
            onChange={(v) => setKey(key, v)}
            cardinalityByRole={cardinalityByRole}
          />
        </div>
      ))}
    </div>
  );
}

/** Recursive control renderer for one ParamSpec. Exported so the per-instance
 *  editor (InstanceDynamicSourcesEditor) reuses the exact same widgets. */
export function SpecField({
  spec,
  value,
  onChange,
  cardinalityByRole,
}: {
  spec: ParamSpec;
  value: unknown;
  onChange: (v: unknown) => void;
  cardinalityByRole?: Record<string, number>;
}) {
  if (spec.type === "number") {
    const num = typeof value === "number" ? value : (spec.min ?? 0);
    return (
      <input
        type="number"
        value={cleanNumber(num)}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        style={INPUT}
      />
    );
  }

  if (spec.type === "enum") {
    const cur = value ?? spec.options[0]?.value;
    return (
      <select
        value={String(cur)}
        onChange={(e) => {
          const opt = spec.options.find((o) => String(o.value) === e.target.value);
          if (opt) onChange(opt.value);
        }}
        style={INPUT}
      >
        {spec.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label ?? String(o.value)}
          </option>
        ))}
      </select>
    );
  }

  if (spec.type === "boolean") {
    return (
      <input
        type="checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }

  if (spec.type === "record") {
    const rec = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    return (
      <div style={{ display: "grid", gap: 6, paddingLeft: 8, borderLeft: "2px solid #eef2ee" }}>
        {Object.entries(spec.fields).map(([fk, fs]) => (
          <div key={fk} style={{ display: "grid", gap: 2 }}>
            <span style={LABEL}>{fs.label ?? fk}</span>
            <SpecField
              spec={fs}
              value={rec[fk]}
              onChange={(v) => onChange({ ...rec, [fk]: v })}
              cardinalityByRole={cardinalityByRole}
            />
          </div>
        ))}
      </div>
    );
  }

  // list
  const arr = Array.isArray(value) ? (value as unknown[]) : [];
  const fromRole = spec.cardinalityFromRole
    ? cardinalityByRole?.[spec.cardinalityFromRole]
    : undefined;
  const count = fromRole ?? arr.length;
  const items = Array.from({ length: count }, (_, i) =>
    i < arr.length ? arr[i] : defaultForSpec(spec.item),
  );
  const writeItem = (i: number, v: unknown) => {
    const next = items.slice();
    next[i] = v;
    onChange(next);
  };
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {items.map((item, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} style={{ display: "grid", gap: 4, padding: 6, border: "1px solid #e5e7eb", borderRadius: 4 }}>
          <div style={{ fontSize: 11, color: "#374151", fontWeight: 600 }}>
            {spec.itemLabel ? spec.itemLabel(i) : `#${i}`}
          </div>
          <SpecField
            spec={spec.item}
            value={item}
            onChange={(v) => writeItem(i, v)}
            cardinalityByRole={cardinalityByRole}
          />
        </div>
      ))}
    </div>
  );
}

/** Small reset-to-default button (shared with per-instance editors, Phase 2). */
export function SchemaResetButton({ onReset }: { onReset: () => void }) {
  return (
    <button
      type="button"
      className="icon-button"
      title="Reset to asset default"
      onClick={onReset}
      style={{ display: "inline-flex", alignItems: "center", padding: 2 }}
    >
      <RotateCcw size={12} />
    </button>
  );
}
