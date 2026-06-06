/**
 * Generic per-instance coefficient editor (per binding slot).
 *
 * The v3 anchor tracer merges params as `{**asset.default_params, **dynamic}`
 * per slot. The slot `dynamic` is built in db_scene_loader.load_anchor_scene_
 * from_db, which merges `SceneObject.param_overrides[binding_id]` on top of the
 * asset defaults. So any top-level key written to
 * `SceneObject.paramOverrides[bindingKey]` overrides that one slot's asset
 * default at trace time, with no per-kind backend code. This component surfaces
 * exactly that: it lists the slot asset's top-level scalar coefficients and
 * writes per-field overrides into paramOverrides[bindingKey].
 *
 * Nested params (laser spectrum / spatialMode / polarization, fiber endA/endB)
 * are intentionally skipped — the shallow merge can't override a nested leaf
 * cleanly, so those stay with their dedicated *AdjustControls panels.
 */
import { useMemo } from "react";
import { RotateCcw } from "lucide-react";

import { useSceneStore } from "../../store/sceneStore";
import type { Asset3D, ElementKind, SceneObject } from "../../types/digitalTwin";
import { cleanNumber } from "../../utils/numberFormat";
import { pluginForKind } from "../../kinds/_plugins";

type EditableValue = number | boolean | string | number[];

/** Top-level value the generic editor can override via a shallow dynamicSources
 *  merge: a scalar, or a short numeric tuple (e.g. wavelengthRangeNm). Nested
 *  objects / null are left to the dedicated controls. */
function isEditableValue(v: unknown): v is EditableValue {
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return true;
  if (Array.isArray(v) && v.length > 0 && v.length <= 3 && v.every((x) => typeof x === "number")) {
    return true;
  }
  return false;
}

function fmtDefault(v: unknown): string {
  if (Array.isArray(v)) return `[${v.join(", ")}]`;
  return String(v);
}

/** Shared field derivation: the kind's top-level overridable params, ordered
 *  with operating-state knobs first (tuned during an experiment), spec-sheet
 *  keys after. `baseline` is the asset/registry default bag. */
function useCoefficientFields(elementKind: ElementKind, baseline: Record<string, unknown>) {
  const plugin = pluginForKind(elementKind);
  const intrinsicKeys = useMemo(
    () => new Set<string>((plugin?.physics.intrinsicParamKeys ?? []) as string[]),
    [plugin],
  );
  const fields = useMemo(() => {
    const keys = Object.keys(baseline).filter((k) => isEditableValue(baseline[k]));
    const stateKeys = (plugin?.physics.stateParamKeys ?? []) as string[];
    const stateFirst = stateKeys.filter((k) => keys.includes(k));
    const rest = keys.filter((k) => !stateFirst.includes(k));
    return [...stateFirst, ...rest];
  }, [baseline, plugin]);
  return { fields, intrinsicKeys };
}

/** Presentational grid of CoefficientField cells. Read/write of the override
 *  store is the caller's concern (object-level dynamicSources vs per-binding
 *  paramOverrides) — this only renders the fields against a baseline + the
 *  current override bag. */
function CoefficientGrid({
  fields,
  intrinsicKeys,
  baseline,
  overrides,
  onChange,
  onReset,
}: {
  fields: string[];
  intrinsicKeys: Set<string>;
  baseline: Record<string, unknown>;
  overrides: Record<string, unknown>;
  onChange: (key: string, value: EditableValue) => void;
  onReset: (key: string) => void;
}) {
  return (
    <div className="physics-panel-kind-params-grid">
      {fields.map((key) => (
        <CoefficientField
          key={key}
          name={key}
          base={baseline[key]}
          value={key in overrides ? overrides[key] : baseline[key]}
          overridden={key in overrides}
          isSpec={intrinsicKeys.has(key)}
          onChange={(v) => onChange(key, v)}
          onReset={() => onReset(key)}
        />
      ))}
    </div>
  );
}

/** Per-binding coefficient editor for ONE optical asset slot of a component —
 *  a single optic's root asset OR one sub-asset of a composite (e.g. the
 *  isolator's front / back Glan prisms). Reads/writes
 *  `SceneObject.paramOverrides[bindingKey]` (alembic 0082); the backend anchor
 *  loader merges that bag into the matching binding slot's dynamic_sources so
 *  each asset's coefficients reach the trace independently
 *  (db_scene_loader.load_anchor_scene_from_db). `bindingKey` MUST match the
 *  slot's binding_id = ComponentBinding.role || id.
 *
 *  This is the single home for per-instance optical coefficients. It replaced
 *  the old dynamicSources-column editor, which never reached the anchor trace:
 *  the loader's _extract_dynamic only knows a fixed whitelist + the laser beam,
 *  so generic column edits silently no-op'd (the documented lens-focal gap).
 *  paramOverrides is the per-instance coefficient home per the data-ownership
 *  model; dynamicSources stays reserved for laser/AOM runtime values. */
export function BindingCoefficientOverrides({
  sceneObject,
  asset,
  bindingKey,
  elementKind,
}: {
  sceneObject: SceneObject;
  asset: Asset3D;
  bindingKey: string;
  elementKind: ElementKind;
}) {
  const updateSceneObject = useSceneStore((s) => s.updateSceneObject);
  const plugin = pluginForKind(elementKind);

  const baseline = useMemo(() => {
    const pluginDefaults = (plugin?.physics.defaultParams ?? {}) as Record<string, unknown>;
    return { ...pluginDefaults, ...((asset.defaultParams ?? {}) as Record<string, unknown>) };
  }, [plugin, asset]);

  const { fields, intrinsicKeys } = useCoefficientFields(elementKind, baseline);

  const allOverrides = (sceneObject.paramOverrides ?? {}) as Record<string, Record<string, unknown>>;
  const overrides = (allOverrides[bindingKey] ?? {}) as Record<string, unknown>;

  const writeOverride = (key: string, value: EditableValue) => {
    void updateSceneObject(sceneObject.id, {
      paramOverrides: {
        ...allOverrides,
        [bindingKey]: { ...overrides, [key]: value },
      },
    });
  };

  const resetOverride = (key: string) => {
    if (!(key in overrides)) return;
    const next = { ...overrides };
    delete next[key];
    const nextAll = { ...allOverrides };
    if (Object.keys(next).length) nextAll[bindingKey] = next;
    else delete nextAll[bindingKey];
    void updateSceneObject(sceneObject.id, {
      paramOverrides: Object.keys(nextAll).length ? nextAll : null,
    });
  };

  if (fields.length === 0) {
    return (
      <p className="mirror-adjust-hint">No editable coefficients for this element.</p>
    );
  }

  return (
    <CoefficientGrid
      fields={fields}
      intrinsicKeys={intrinsicKeys}
      baseline={baseline}
      overrides={overrides}
      onChange={writeOverride}
      onReset={resetOverride}
    />
  );
}

function ResetButton({ onReset }: { onReset: () => void }) {
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

function CoefficientField({
  name,
  base,
  value,
  overridden,
  isSpec,
  onChange,
  onReset,
}: {
  name: string;
  base: unknown;
  value: unknown;
  overridden: boolean;
  isSpec: boolean;
  onChange: (v: EditableValue) => void;
  onReset: () => void;
}) {
  const label = (
    <span title={overridden ? `asset default: ${fmtDefault(base)}` : undefined}>
      {name}
      {isSpec ? " (spec)" : ""}
      {overridden ? " •" : ""}
    </span>
  );

  // Numeric tuple (e.g. wavelengthRangeNm, coatingNormalBodyLocal).
  if (Array.isArray(base)) {
    const arr = (Array.isArray(value) ? value : base) as number[];
    return (
      <label className="physics-panel-kind-params-field">
        {label}
        <div className="physics-panel-kind-params-tuple">
          {arr.map((n, i) => (
            <input
              // eslint-disable-next-line react/no-array-index-key
              key={i}
              type="number"
              value={cleanNumber(n)}
              onChange={(e) => {
                const num = Number(e.target.value);
                if (!Number.isFinite(num)) return;
                const next = [...arr];
                next[i] = num;
                onChange(next);
              }}
            />
          ))}
          {overridden ? <ResetButton onReset={onReset} /> : null}
        </div>
      </label>
    );
  }

  if (typeof base === "boolean") {
    return (
      <label
        className="physics-panel-kind-params-field"
        style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
        {overridden ? <ResetButton onReset={onReset} /> : null}
      </label>
    );
  }

  if (typeof base === "string") {
    return (
      <label className="physics-panel-kind-params-field">
        {label}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="text"
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
            style={{ flex: 1 }}
          />
          {overridden ? <ResetButton onReset={onReset} /> : null}
        </div>
      </label>
    );
  }

  // Default: scalar number.
  return (
    <label className="physics-panel-kind-params-field">
      {label}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="number"
          value={cleanNumber(Number(value ?? 0))}
          onChange={(e) => {
            const num = Number(e.target.value);
            if (Number.isFinite(num)) onChange(num);
          }}
          style={{ flex: 1 }}
        />
        {overridden ? <ResetButton onReset={onReset} /> : null}
      </div>
    </label>
  );
}
