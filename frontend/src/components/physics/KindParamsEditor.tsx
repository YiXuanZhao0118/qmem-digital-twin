/**
 * KindParamsEditor — generic per-object kindParams editor for the
 * Objects panel (R4, 2026-05-17).
 *
 * Renders every primitive kindParam of an optical PhysicsElement as
 * an editable input EXCEPT fast/slow-axis fields, which are owned by
 * the PHY Editor → Components view per R3.
 *
 * Renders inside `<section class="physics-panel physics-panel-optical">`
 * — see PhysicsElementPanel.tsx. Mounted only for optical kinds.
 */
import { useState } from "react";

import { useSceneStore } from "../../store/sceneStore";
import type { PhysicsElement, SceneObject } from "../../types/digitalTwin";

/** Field names owned by the PHY Editor (R3). Hidden in the objects panel.
 *  Match by exact key — every kindParam blob uses these literal names. */
const AXIS_FIELDS = new Set<string>([
  "fastAxisDegBeamLocal",
  "slowAxisDegInBodyFrame",
  "transmissionAxisDegBeamLocal",
  "coatingNormalBodyLocal",
  "acousticAxisBodyLocal",
  "rfPropagationDirectionBodyLocal",
  "braggTiltAxisDegLab",
  "braggTiltAxisAngleDeg", // pre-Phase-5 alias
  "polarAxisBodyLocal",
]);

/** Keys we don't render at all (internal references, derived state). */
const HIDDEN_FIELDS = new Set<string>([
  "fiberBodyObjectId",
  "endAObjectId",
  "endBObjectId",
  "rfDriverComponentId",
  "timingProgramId",
  "randomJonesSeed",
]);

function isAxisField(key: string): boolean {
  if (AXIS_FIELDS.has(key)) return true;
  // Heuristic catch-all for new axis-style names.
  return /Axis(Deg|BodyLocal|Local)$/.test(key);
}

function isPrimitiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isTwoNumberTuple(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    isPrimitiveNumber(v[0]) &&
    isPrimitiveNumber(v[1])
  );
}

function humanLabel(key: string): string {
  // camelCase → "Camel Case"; collapse double spaces; lower first letter
  // is fine — readable enough without a translation table.
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

export function KindParamsEditor({
  element,
  sceneObject,
}: {
  element: PhysicsElement;
  sceneObject: SceneObject;
}) {
  const upsertOpticalElement = useSceneStore((s) => s.upsertOpticalElement);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  const kindParams = (element.kindParams ?? {}) as Record<string, unknown>;

  const commit = async (patch: Record<string, unknown>) => {
    setError("");
    setBusy(true);
    try {
      await upsertOpticalElement({
        objectId: sceneObject.id,
        elementKind: element.elementKind,
        kindParams: { ...kindParams, ...patch },
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Stable display order: numbers first (most commonly edited), then
  // tuples, then strings, then booleans. Within each, alphabetical.
  const entries = Object.entries(kindParams)
    .filter(([k]) => !HIDDEN_FIELDS.has(k))
    .filter(([k]) => !isAxisField(k))
    .sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="physics-panel-kind-params">
      <div className="physics-panel-kind-params-header">
        Kind parameters
        {busy && <span className="physics-panel-kind-params-busy"> · saving…</span>}
      </div>
      {error && <div className="physics-error">{error}</div>}
      <div className="physics-panel-kind-params-grid">
        {entries.map(([key, value]) => {
          if (isPrimitiveNumber(value)) {
            return (
              <label key={key} className="physics-panel-kind-params-field">
                <span>{humanLabel(key)}</span>
                <input
                  type="number"
                  defaultValue={value}
                  step="any"
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v === value) return;
                    void commit({ [key]: v });
                  }}
                />
              </label>
            );
          }
          if (isTwoNumberTuple(value)) {
            return (
              <fieldset
                key={key}
                className="physics-panel-kind-params-field physics-panel-kind-params-tuple"
              >
                <legend>{humanLabel(key)}</legend>
                <input
                  type="number"
                  defaultValue={value[0]}
                  step="any"
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v === value[0]) return;
                    void commit({ [key]: [v, value[1]] });
                  }}
                />
                <span> – </span>
                <input
                  type="number"
                  defaultValue={value[1]}
                  step="any"
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v === value[1]) return;
                    void commit({ [key]: [value[0], v] });
                  }}
                />
              </fieldset>
            );
          }
          if (typeof value === "boolean") {
            return (
              <label key={key} className="physics-panel-kind-params-field physics-panel-kind-params-bool">
                <input
                  type="checkbox"
                  defaultChecked={value}
                  onChange={(e) => {
                    const v = e.target.checked;
                    if (v === value) return;
                    void commit({ [key]: v });
                  }}
                />
                <span>{humanLabel(key)}</span>
              </label>
            );
          }
          if (typeof value === "string") {
            return (
              <label key={key} className="physics-panel-kind-params-field">
                <span>{humanLabel(key)}</span>
                <input
                  type="text"
                  defaultValue={value}
                  onBlur={(e) => {
                    const v = e.target.value;
                    if (v === value) return;
                    void commit({ [key]: v });
                  }}
                />
              </label>
            );
          }
          // Objects / arrays of structures: too rich for a generic editor.
          // Surface a hint so users know they exist but skip render.
          return (
            <div key={key} className="physics-panel-kind-params-field physics-panel-kind-params-readonly">
              <span>{humanLabel(key)}</span>
              <code>(structured — edit in PHY Editor)</code>
            </div>
          );
        })}
      </div>
    </div>
  );
}
