/**
 * Per-instance editor for an optical asset's TUNABLE params.
 *
 * The asset author marks which default_params keys are tunable
 * (Asset3D.tunableParams, alembic 0113). This grid surfaces exactly those
 * leaves and writes per-instance values into SceneObject.dynamicSources — the
 * object-scoped runtime channel the v3 anchor loader merges over the asset
 * default_params at trace time (`{**default_params, **dynamic_sources}`). An
 * asset with no tunable params renders nothing (the panel hides the section).
 *
 * Replaces the retired per-binding BindingCoefficientOverrides /
 * param_overrides: intrinsic optical coefficients are no longer per-instance
 * editable — only the asset-blessed tunable knobs (laser power / wavelength …).
 *
 * Nested tunable params (e.g. a spatialMode object) flatten to dotted-path
 * leaves and each scalar edits independently; the COMPLETE top-level object is
 * rebuilt on write so the backend's shallow merge keeps sibling leaves.
 */
import { useMemo } from "react";
import { RotateCcw } from "lucide-react";

import { useSceneStore } from "../../store/sceneStore";
import { pluginForKind } from "../../kinds/_plugins";
import type { Asset3D, SceneObject } from "../../types/digitalTwin";
import { cleanNumber } from "../../utils/numberFormat";
import {
  type EditableValue,
  type Leaf,
  flattenLeaves,
  getAtPath,
  setAtPath,
} from "../../utils/paramLeaves";
import { SpecField } from "./SchemaParamEditor";
import type { ParamSchema } from "../../kinds/paramSchema";

function fmtDefault(v: unknown): string {
  if (Array.isArray(v)) return `[${v.join(", ")}]`;
  return String(v);
}

export function InstanceDynamicSourcesEditor({
  sceneObject,
  asset,
}: {
  sceneObject: SceneObject;
  asset: Asset3D;
}) {
  const updateSceneObject = useSceneStore((s) => s.updateSceneObject);

  const tunable = asset.tunableParams ?? [];
  const baseline = (asset.defaultParams ?? {}) as Record<string, unknown>;

  // Typed-schema path: when the asset's kind declares physics.paramSchema, the
  // generic schema-driven editor (number → input, enum → dropdown, list →
  // per-channel blocks) renders the tunable params — the same widgets the PHY
  // Editor uses. Kinds without a schema fall through to the legacy flattenLeaves
  // editor below (zero regression). Mirrors the Asset3DEditor convergence.
  const schema = pluginForKind(asset.kindId ?? "")?.physics.paramSchema;
  if (schema) {
    return (
      <SchemaInstanceFields
        schema={schema}
        asset={asset}
        sceneObject={sceneObject}
        onWrite={(dyn) => void updateSceneObject(sceneObject.id, { dynamicSources: dyn })}
      />
    );
  }

  // Every editable leaf under a tunable top-level key (nested included), in the
  // tunableParams order so the laser's power/wavelength keep a stable layout.
  const leaves = useMemo(() => {
    if (tunable.length === 0) return [] as Leaf[];
    const all: Leaf[] = [];
    flattenLeaves(baseline, [], all);
    const order = new Map(tunable.map((k, i) => [k, i]));
    return all
      .filter((l) => order.has(l.path[0]))
      .map((leaf, i) => ({ leaf, i }))
      .sort((a, b) => {
        const d = (order.get(a.leaf.path[0]) ?? 0) - (order.get(b.leaf.path[0]) ?? 0);
        return d !== 0 ? d : a.i - b.i;
      })
      .map((x) => x.leaf);
  }, [baseline, tunable]);

  const overrides = (sceneObject.dynamicSources ?? {}) as Record<string, unknown>;

  // Write one leaf: rebuild the COMPLETE top-level object (override-or-baseline
  // ⊕ this leaf) so the backend's shallow per-object merge keeps sibling leaves.
  const writeOverride = (path: string[], value: EditableValue) => {
    const topKey = path[0];
    const baseTop = topKey in overrides ? overrides[topKey] : baseline[topKey];
    const fullTop = path.length === 1 ? value : setAtPath(baseTop, path.slice(1), value);
    void updateSceneObject(sceneObject.id, {
      dynamicSources: { ...overrides, [topKey]: fullTop },
    });
  };

  const resetOverride = (topKey: string) => {
    if (!(topKey in overrides)) return;
    const next = { ...overrides };
    delete next[topKey];
    void updateSceneObject(sceneObject.id, {
      dynamicSources: Object.keys(next).length ? next : null,
    });
  };

  if (leaves.length === 0) return null;

  return (
    <div className="physics-panel-kind-params-grid">
      {leaves.map((leaf) => {
        const topKey = leaf.path[0];
        const overridden = topKey in overrides;
        const value = overridden ? getAtPath(overrides[topKey], leaf.path.slice(1)) : leaf.base;
        return (
          <CoefficientField
            key={leaf.path.join(".")}
            name={leaf.path.join(".")}
            base={leaf.base}
            value={value}
            overridden={overridden}
            onChange={(v) => writeOverride(leaf.path, v)}
            onReset={() => resetOverride(topKey)}
          />
        );
      })}
    </div>
  );
}

/** Schema-driven per-instance editor: one block per tunable top-level key,
 *  value = dynamicSources override ?? asset default, write the WHOLE key to
 *  dynamicSources (backend shallow-merges per object), reset clears it. List
 *  cardinality (channel count) comes from the asset's anchors. */
function SchemaInstanceFields({
  schema,
  asset,
  sceneObject,
  onWrite,
}: {
  schema: ParamSchema;
  asset: Asset3D;
  sceneObject: SceneObject;
  onWrite: (dynamicSources: Record<string, unknown> | null) => void;
}) {
  const tunable = asset.tunableParams ?? [];
  const baseline = (asset.defaultParams ?? {}) as Record<string, unknown>;
  const overrides = (sceneObject.dynamicSources ?? {}) as Record<string, unknown>;
  const cardinalityByRole: Record<string, number> = {};
  for (const a of asset.anchors ?? []) {
    const id = (a as { id?: string }).id;
    if (id) cardinalityByRole[id] = (cardinalityByRole[id] ?? 0) + 1;
  }
  const keys = tunable.filter((k) => k in schema);
  if (keys.length === 0) return null;

  const writeKey = (key: string, v: unknown) => onWrite({ ...overrides, [key]: v });
  const resetKey = (key: string) => {
    if (!(key in overrides)) return;
    const next = { ...overrides };
    delete next[key];
    onWrite(Object.keys(next).length ? next : null);
  };

  return (
    <div className="physics-panel-kind-params-grid">
      {keys.map((key) => {
        const spec = schema[key];
        const overridden = key in overrides;
        const value = overridden ? overrides[key] : baseline[key];
        return (
          <div key={key} style={{ display: "grid", gap: 3 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "#374151", fontWeight: 600 }}>
                {spec.label ?? key}
                {overridden ? " •" : ""}
              </span>
              {overridden ? <ResetButton onReset={() => resetKey(key)} /> : null}
            </div>
            <SpecField
              spec={spec}
              value={value}
              onChange={(v) => writeKey(key, v)}
              cardinalityByRole={cardinalityByRole}
            />
          </div>
        );
      })}
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
  onChange,
  onReset,
}: {
  name: string;
  base: unknown;
  value: unknown;
  overridden: boolean;
  onChange: (v: EditableValue) => void;
  onReset: () => void;
}) {
  const label = (
    <span title={overridden ? `asset default: ${fmtDefault(base)}` : undefined}>
      {name}
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
