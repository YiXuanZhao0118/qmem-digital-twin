import { useMemo } from "react";

import { useSceneStore } from "../store/sceneStore";
import type { ComponentBinding, ComponentItem } from "../types/digitalTwin";
import {
  commonTunableAxes,
  groupBindingsByLink,
} from "../utils/componentBindings";

/** Generic per-instance override editor for a composite component's
 *  binding tree.
 *
 *  Reads from:
 *    - `component.id` → scene.componentBindings: bindings for this Component
 *    - each `binding.tunableAxes`: declared user-adjustable DoFs
 *    - each `binding.properties.linkGroup`: groups bindings that should
 *      move together (one slider drives multiple bindings)
 *
 *  Writes to:
 *    - `sceneObject.properties.bindingOverrides[bindingId][axis]`: per-axis
 *      DELTA on top of the binding's calibrated baseline. The render
 *      pipeline (resolveBindingTree → _effectiveTransform) adds these
 *      deltas at draw time.
 *
 *  Works for ANY composite component (isolator, mirror_mount, future
 *  decompositions) — no component-specific code. New components opt in
 *  simply by declaring tunable axes on their bindings; no UI change. */

const AXIS_KEY_TO_FIELD: Record<string, "xMm" | "yMm" | "zMm" | "rxDeg" | "ryDeg" | "rzDeg"> = {
  x_mm: "xMm", y_mm: "yMm", z_mm: "zMm",
  rx_deg: "rxDeg", ry_deg: "ryDeg", rz_deg: "rzDeg",
  // Also accept already-camelCase (in case future bindings use the
  // pose-field naming the type's docstring suggests):
  xMm: "xMm", yMm: "yMm", zMm: "zMm",
  rxDeg: "rxDeg", ryDeg: "ryDeg", rzDeg: "rzDeg",
  localXMm: "xMm", localYMm: "yMm", localZMm: "zMm",
  localRxDeg: "rxDeg", localRyDeg: "ryDeg", localRzDeg: "rzDeg",
};

function axisLabel(axisKey: string): string {
  const field = AXIS_KEY_TO_FIELD[axisKey];
  if (!field) return axisKey;
  switch (field) {
    case "xMm": return "X (mm)";
    case "yMm": return "Y (mm)";
    case "zMm": return "Z (mm)";
    case "rxDeg": return "RX (°)";
    case "ryDeg": return "RY (°)";
    case "rzDeg": return "RZ (°)";
  }
}

function defaultRange(field: ReturnType<typeof axisToField>): { min: number; max: number; step: number } {
  if (field.endsWith("Deg")) return { min: 0, max: 360, step: 1 };
  return { min: -200, max: 200, step: 0.5 };
}

function axisToField(axisKey: string): "xMm" | "yMm" | "zMm" | "rxDeg" | "ryDeg" | "rzDeg" | null {
  return AXIS_KEY_TO_FIELD[axisKey] ?? null;
}

/** Map an axis key (tunable_axes key or pose-field name) to the
 *  matching ObjectBinding delta column on the row API payload. */
const AXIS_FIELD_TO_DELTA_KEY: Record<
  "xMm" | "yMm" | "zMm" | "rxDeg" | "ryDeg" | "rzDeg",
  "localXMmDelta" | "localYMmDelta" | "localZMmDelta" | "localRxDegDelta" | "localRyDegDelta" | "localRzDegDelta"
> = {
  xMm: "localXMmDelta",
  yMm: "localYMmDelta",
  zMm: "localZMmDelta",
  rxDeg: "localRxDegDelta",
  ryDeg: "localRyDegDelta",
  rzDeg: "localRzDegDelta",
};

export function BindingTreeAdjustControls({ component }: { component: ComponentItem }) {
  const upsertObjectBinding = useSceneStore((s) => s.upsertObjectBinding);
  const deleteObjectBinding = useSceneStore((s) => s.deleteObjectBinding);
  // Read stable references from the store, then derive the filtered
  // arrays via useMemo. Filtering inside the selector returns a new
  // array on every render, which zustand's Object.is comparison sees
  // as "changed" → causes an infinite re-render loop.
  const selectedObjectId = useSceneStore((s) => s.selectedObjectId);
  const sceneObjects = useSceneStore((s) => s.scene.objects);
  const allComponentBindings = useSceneStore((s) => s.scene.componentBindings);
  const allObjectBindings = useSceneStore((s) => s.scene.objectBindings);

  const sceneObject = useMemo(() => {
    const selected = selectedObjectId
      ? sceneObjects.find((o) => o.id === selectedObjectId)
      : undefined;
    if (selected && selected.componentId === component.id) return selected;
    return sceneObjects.find((o) => o.componentId === component.id) ?? null;
  }, [selectedObjectId, sceneObjects, component.id]);

  const componentBindings = useMemo(
    () => (allComponentBindings ?? []).filter((b) => b.componentId === component.id),
    [allComponentBindings, component.id],
  );
  const objectBindings = useMemo(
    () => (allObjectBindings ?? []).filter((b) => b.objectId === sceneObject?.id),
    [allObjectBindings, sceneObject?.id],
  );

  const groups = useMemo(() => groupBindingsByLink(componentBindings), [componentBindings]);

  // Drop any group whose bindings share no tunable axis (nothing the
  // user can adjust uniformly across the group).
  const tunableGroups = useMemo(() => {
    const out: { name: string; bindings: ComponentBinding[]; axes: string[] }[] = [];
    for (const [name, bindings] of groups) {
      const axes = commonTunableAxes(bindings)
        .filter((axisKey) => axisToField(axisKey) !== null);
      if (axes.length === 0) continue;
      out.push({ name, bindings, axes });
    }
    return out;
  }, [groups]);

  if (tunableGroups.length === 0) return null;

  const hasInstance = sceneObject != null;

  const readOverride = (bindingId: string, axisField: ReturnType<typeof axisToField>): number => {
    if (!sceneObject || !axisField) return 0;
    const row = objectBindings.find((b) => b.componentBindingId === bindingId);
    if (!row) return 0;
    const v = row[AXIS_FIELD_TO_DELTA_KEY[axisField]];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };

  const writeOverride = async (
    bindings: ComponentBinding[],
    axisField: Exclude<ReturnType<typeof axisToField>, null>,
    value: number,
  ) => {
    if (!sceneObject) return;
    const deltaKey = AXIS_FIELD_TO_DELTA_KEY[axisField];
    // One row per (objectId, componentBindingId) — UPSERT per binding.
    // Backend's unique constraint makes the POST idempotent for slider
    // drags. Writing the SAME value to every binding in the linkGroup
    // keeps them rotated together.
    await Promise.all(
      bindings.map(async (b) => {
        const existing = objectBindings.find((r) => r.componentBindingId === b.id);
        // If the user dragged back to "0 and all other axes already 0",
        // delete the row entirely so the renderer reverts to baseline.
        if (value === 0 && existing) {
          const otherAxesAllNull = (
            ["localXMmDelta", "localYMmDelta", "localZMmDelta",
             "localRxDegDelta", "localRyDegDelta", "localRzDegDelta"] as const
          )
            .filter((k) => k !== deltaKey)
            .every((k) => existing[k] == null);
          if (otherAxesAllNull && existing.asset3dIdOverride == null) {
            await deleteObjectBinding(existing.id);
            return;
          }
        }
        await upsertObjectBinding(sceneObject.id, {
          componentBindingId: b.id,
          [deltaKey]: value === 0 ? null : value,
        });
      }),
    );
  };

  return (
    <div className="physics-panel-kind-params" style={{ marginTop: 6 }}>
      <div className="physics-panel-kind-params-header">Per-instance adjustments</div>
      <div className="physics-panel-kind-params-grid">
        {tunableGroups.map(({ name, bindings, axes }) =>
          axes.map((axisKey) => {
            const axisField = axisToField(axisKey);
            if (!axisField) return null;
            const spec = bindings[0].tunableAxes[axisKey] ?? {};
            const fallback = defaultRange(axisField);
            const min = typeof spec.min === "number" ? spec.min : fallback.min;
            const max = typeof spec.max === "number" ? spec.max : fallback.max;
            const step = fallback.step;
            const value = readOverride(bindings[0].id, axisField);
            const showLabel = axes.length > 1
              ? `${name} · ${axisLabel(axisKey)}`
              : `${name}`;
            return (
              <label key={`${name}-${axisKey}`} className="physics-panel-kind-params-field">
                <span>{showLabel}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="number"
                    step={step}
                    min={min}
                    max={max}
                    disabled={!hasInstance}
                    value={value}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v)) return;
                      void writeOverride(bindings, axisField, v);
                    }}
                    style={{ width: 64 }}
                  />
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    disabled={!hasInstance}
                    value={value}
                    onChange={(e) => void writeOverride(bindings, axisField, Number(e.target.value))}
                    style={{ flex: 1 }}
                  />
                </div>
              </label>
            );
          }),
        )}
      </div>
    </div>
  );
}
