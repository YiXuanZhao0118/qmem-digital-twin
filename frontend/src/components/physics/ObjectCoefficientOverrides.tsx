/**
 * Generic per-instance coefficient editor.
 *
 * The v3 tracer merges params as `{**asset.default_params, **dynamic_sources}`
 * (backend/app/optical/anchor_tracer.py:469) — a SHALLOW merge applied to every
 * kind. So any top-level key written to `SceneObject.dynamicSources` overrides
 * that one instance's asset default at trace time, with no per-kind backend
 * code. This component surfaces exactly that: it lists the kind's top-level
 * scalar coefficients (baseline from the object's Asset3D.defaultParams, or the
 * kind registry as fallback) and writes per-field overrides into dynamicSources.
 *
 * Nested params (laser spectrum / spatialMode / polarization, fiber endA/endB)
 * are intentionally skipped — the shallow merge can't override a nested leaf
 * cleanly, so those stay with their dedicated *AdjustControls panels.
 */
import { useMemo } from "react";
import { RotateCcw } from "lucide-react";

import { useSceneStore } from "../../store/sceneStore";
import type { ComponentItem, ElementKind, SceneObject } from "../../types/digitalTwin";
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

export function ObjectCoefficientOverrides({
  component,
  sceneObject,
  elementKind,
}: {
  component: ComponentItem;
  sceneObject: SceneObject;
  elementKind: ElementKind;
}) {
  const updateSceneObject = useSceneStore((s) => s.updateSceneObject);
  const assets = useSceneStore((s) => s.scene.assets);

  const plugin = pluginForKind(elementKind);

  // Baseline = registry defaults overlaid by the object's actual Asset3D row
  // (the asset is what the solver reads, so its defaults win the display).
  const baseline = useMemo(() => {
    const pluginDefaults = (plugin?.physics.defaultParams ?? {}) as Record<string, unknown>;
    const asset = component.asset3dId
      ? assets.find((a) => a.id === component.asset3dId)
      : undefined;
    return { ...pluginDefaults, ...((asset?.defaultParams ?? {}) as Record<string, unknown>) };
  }, [plugin, component.asset3dId, assets]);

  const intrinsicKeys = useMemo(
    () => new Set<string>((plugin?.physics.intrinsicParamKeys ?? []) as string[]),
    [plugin],
  );

  // Editable fields: top-level overridable params, ordered with operating-state
  // knobs first (the ones tuned during an experiment), spec-sheet keys after.
  const fields = useMemo(() => {
    const keys = Object.keys(baseline).filter((k) => isEditableValue(baseline[k]));
    const stateKeys = (plugin?.physics.stateParamKeys ?? []) as string[];
    const stateFirst = stateKeys.filter((k) => keys.includes(k));
    const rest = keys.filter((k) => !stateFirst.includes(k));
    return [...stateFirst, ...rest];
  }, [baseline, plugin]);

  const overrides = (sceneObject.dynamicSources ?? {}) as Record<string, unknown>;

  const writeOverride = (key: string, value: EditableValue) => {
    void updateSceneObject(sceneObject.id, {
      dynamicSources: { ...overrides, [key]: value },
    });
  };

  const resetOverride = (key: string) => {
    if (!(key in overrides)) return;
    const next = { ...overrides };
    delete next[key];
    void updateSceneObject(sceneObject.id, {
      dynamicSources: Object.keys(next).length ? next : null,
    });
  };

  if (fields.length === 0) return null;

  return (
    <div className="physics-panel-kind-params" style={{ marginTop: 6 }}>
      <div className="physics-panel-kind-params-header">Per-instance coefficients</div>
      <div className="physics-panel-kind-params-grid">
        {fields.map((key) => (
          <CoefficientField
            key={key}
            name={key}
            base={baseline[key]}
            value={key in overrides ? overrides[key] : baseline[key]}
            overridden={key in overrides}
            isSpec={intrinsicKeys.has(key)}
            onChange={(v) => writeOverride(key, v)}
            onReset={() => resetOverride(key)}
          />
        ))}
      </div>
      <p className="mirror-adjust-hint">
        Overrides write to this object's <code>dynamicSources</code> — they apply
        only to this instance and revert to the asset default on reset.
      </p>
    </div>
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
              value={n}
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
          value={Number(value ?? 0)}
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
