import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useSceneStore } from "../store/sceneStore";
import type { ComponentBinding, ComponentItem } from "../types/digitalTwin";
import { cleanNumber } from "../utils/numberFormat";
import {
  commonTunableAxes,
  groupBindingsByLink,
  hiddenBindingIds,
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
 *    - `sceneObject.properties.hiddenBindings[]`: parts THIS instance
 *      isn't wearing (the Parts list). Render-only — see
 *      `hiddenBindingIds`.
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

/** Floor on how often a slider drag is allowed to hit the API. One
 *  write re-runs the viewer's whole placement pass, so 60 fps of them
 *  is what made the knob stutter on a busy scene. */
const COMMIT_MIN_MS = 120;

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

function defaultRange(field: NonNullable<ReturnType<typeof axisToField>>): { min: number; max: number; step: number } {
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
  const updateSceneObject = useSceneStore((s) => s.updateSceneObject);
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

  // The component's own binding rows in tree order, indented by depth —
  // the same tree the PHY editor's COMPONENT tab shows, listed here so an
  // instance can drop a part it isn't wearing. Sub-component bindings are
  // NOT spliced in: those rows belong to another Component and hiding one
  // would mean hiding it everywhere it is used.
  const partRows = useMemo(() => {
    const byParent = new Map<string, ComponentBinding[]>();
    for (const b of componentBindings) {
      const key = b.parentBindingId ?? "";
      const list = byParent.get(key);
      if (list) list.push(b);
      else byParent.set(key, [b]);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.sortOrder - b.sortOrder);
    const out: { binding: ComponentBinding; label: string; depth: number }[] = [];
    const walk = (parentKey: string, depth: number) => {
      for (const b of byParent.get(parentKey) ?? []) {
        const roleLabel = (b.properties as { role_label?: unknown } | null)?.role_label;
        out.push({
          binding: b,
          label: (typeof roleLabel === "string" && roleLabel) || b.role || b.id,
          depth,
        });
        walk(b.id, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }, [componentBindings]);

  const hidden = useMemo(() => hiddenBindingIds(sceneObject), [sceneObject]);

  const setBindingHidden = async (bindingId: string, next: boolean) => {
    if (!sceneObject) return;
    const ids = new Set(hidden);
    if (next) ids.add(bindingId);
    else ids.delete(bindingId);
    const props = { ...((sceneObject.properties ?? {}) as Record<string, unknown>) };
    if (ids.size > 0) props.hiddenBindings = [...ids];
    else delete props.hiddenBindings;
    await updateSceneObject(sceneObject.id, { properties: props });
  };

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

  // ---- Write pacing for the knobs -----------------------------------
  // A drag used to POST every intermediate value and await the
  // round-trip before the store — and with it the 3D scene — moved, so
  // the knob could never render ahead of the network: one write per
  // binding per pixel dragged, each one re-running the viewer's
  // placement pass over the whole scene.
  //
  // The knob now renders from `drafts` (local, instant) while the
  // writes are paced: only the LATEST value per knob is kept, one
  // commit is in flight at a time, and they are no closer together than
  // COMMIT_MIN_MS. Letting go flushes immediately, so what is persisted
  // is always the value the user stopped on.
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const pendingRef = useRef(new Map<string, () => Promise<void>>());
  const drainRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommitRef = useRef(0);

  const drain = useCallback(() => {
    if (drainRef.current) return drainRef.current;
    const run = (async () => {
      while (pendingRef.current.size > 0) {
        const entry = pendingRef.current.entries().next().value as
          | [string, () => Promise<void>]
          | undefined;
        if (!entry) break;
        pendingRef.current.delete(entry[0]);
        await entry[1]();
        lastCommitRef.current = Date.now();
      }
    })().finally(() => {
      drainRef.current = null;
    });
    drainRef.current = run;
    return run;
  }, []);

  const schedule = useCallback(
    (key: string, job: () => Promise<void>) => {
      // Same knob queued twice before it drained → the newer value wins.
      pendingRef.current.set(key, job);
      if (timerRef.current) return;
      const wait = Math.max(0, COMMIT_MIN_MS - (Date.now() - lastCommitRef.current));
      if (wait === 0) {
        void drain();
        return;
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void drain();
      }, wait);
    },
    [drain],
  );

  /** Send whatever is still queued, then hand the knob back to the store
   *  value. Called when the user stops moving it (pointer-up / blur). */
  const flush = useCallback(
    async (key: string) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      await drain();
      setDrafts((d) => {
        if (!(key in d)) return d;
        const next = { ...d };
        delete next[key];
        return next;
      });
    },
    [drain],
  );

  // Panel closed mid-drag: cancel the timer, but still run the queue so
  // the last value isn't dropped on the floor.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      void drain();
    },
    [drain],
  );

  // A single-root component has exactly one part, and hiding it is what
  // the object's own "Visible" checkbox already does — only offer the
  // list once there is something to pick apart.
  const showParts = partRows.length > 1;

  if (tunableGroups.length === 0 && !showParts) return null;

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

  const setKnob = (
    key: string,
    bindings: ComponentBinding[],
    axisField: Exclude<ReturnType<typeof axisToField>, null>,
    value: number,
  ) => {
    setDrafts((d) => ({ ...d, [key]: value }));
    schedule(key, () => writeOverride(bindings, axisField, value));
  };

  // Per-instance rendering hint: "See through" toggle. Lives on
  // sceneObject.properties.translucentHousing (boolean, default false).
  // The renderer's default is OPAQUE (real metal isolator look);
  // checking this lets the user inspect the internal prisms by
  // dropping the housing to 0.35 opacity. Isolator-only for now —
  // gated on componentType so the toggle only shows where the
  // renderer honours it. Generic enough that adding new hints later
  // is one more checkbox in this block.
  const translucentHousing = Boolean(
    (sceneObject?.properties as { translucentHousing?: unknown } | undefined)?.translucentHousing,
  );
  const setTranslucentHousing = async (next: boolean) => {
    if (!sceneObject) return;
    const existing = (sceneObject.properties ?? {}) as Record<string, unknown>;
    const props = { ...existing };
    if (next) props.translucentHousing = true;
    else delete props.translucentHousing;
    // Clean up the legacy `opaqueHousing` key so we're not carrying
    // two flags with overlapping semantics on the same object.
    delete props.opaqueHousing;
    await updateSceneObject(sceneObject.id, { properties: props });
  };
  // Isolators carry kindId "none", so detect the composite by its binding
  // tree (a front + back polariser role) — same gate as ComponentPanel's
  // "Align to beam". The renderer honours `translucentHousing` for these.
  const isolatorRoles = componentBindings.map((b) =>
    String((b.properties as { role_label?: unknown } | null)?.role_label || b.role || "").toLowerCase(),
  );
  const showTranslucentToggle =
    isolatorRoles.some((r) => r.includes("front")) && isolatorRoles.some((r) => r.includes("back"));

  return (
    <div className="physics-panel-kind-params" style={{ marginTop: 6 }}>
      <div className="physics-panel-kind-params-header">Per-instance adjustments</div>
      {showTranslucentToggle && (
        <label
          className="physics-panel-kind-params-field"
          style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 4 }}
          title="Render the housing translucent (opacity 0.35) so the internal prisms are visible through it. Default is opaque metal."
        >
          <input
            type="checkbox"
            disabled={!hasInstance}
            checked={translucentHousing}
            onChange={(e) => void setTranslucentHousing(e.target.checked)}
          />
          <span>See through</span>
        </label>
      )}
      {showParts && (
        <>
          <div className="physics-panel-kind-params-header" style={{ marginTop: 2 }}>
            Parts
          </div>
          <div style={{ paddingBottom: 4 }}>
            {partRows.map(({ binding, label, depth }) => (
              <label
                key={binding.id}
                className="physics-panel-kind-params-field"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  paddingLeft: 12 * depth,
                }}
                title={
                  hidden.has(binding.id)
                    ? `${label} is hidden on this instance. The part and its pose (including any RZ adjustment) are kept — untick to bring it back.`
                    : `Untick to hide ${label} on this instance only. Nothing is deleted.`
                }
              >
                <input
                  type="checkbox"
                  disabled={!hasInstance}
                  checked={!hidden.has(binding.id)}
                  onChange={(e) => void setBindingHidden(binding.id, !e.target.checked)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </>
      )}
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
            // Draft (mid-drag) wins over the stored value; `??` so a
            // dragged-to-zero draft still shows as 0.
            const knobKey = `${sceneObject?.id ?? ""}|${bindings[0].id}|${axisField}`;
            const value = drafts[knobKey] ?? readOverride(bindings[0].id, axisField);
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
                    value={cleanNumber(value)}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v)) return;
                      setKnob(knobKey, bindings, axisField, v);
                    }}
                    onBlur={() => void flush(knobKey)}
                    style={{ width: 64 }}
                  />
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    disabled={!hasInstance}
                    value={cleanNumber(value)}
                    onChange={(e) => setKnob(knobKey, bindings, axisField, Number(e.target.value))}
                    onPointerUp={() => void flush(knobKey)}
                    onKeyUp={() => void flush(knobKey)}
                    onBlur={() => void flush(knobKey)}
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
