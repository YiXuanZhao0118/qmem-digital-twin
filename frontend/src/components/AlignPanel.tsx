// Multi-select Align section — appears inside the Object floating panel
// when the user has ≥ 2 SceneObjects selected.

import { useState } from "react";

import { useSceneStore } from "../store/sceneStore";

type Axis = "x" | "y" | "z";
type Target = "median" | "min" | "max" | "active" | "cursor";

export function AlignPanel() {
  const selectedObjectIds = useSceneStore((state) => state.selectedObjectIds);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const objects = useSceneStore((state) => state.scene.objects);
  // AlignPanel is a global side-panel — it uses the LEFT panel's cursor as
  // the primary reference (single-view only has left, dual-view treats left
  // as the principal pivot for global ops).
  const cursorMm = useSceneStore((state) => state.transformCursorMm.left);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);

  const [axis, setAxis] = useState<Axis>("x");
  const [target, setTarget] = useState<Target>("median");
  const [busy, setBusy] = useState(false);

  if (selectedObjectIds.length < 2) return null;
  const selected = objects.filter((o) => selectedObjectIds.includes(o.id));
  if (selected.length < 2) return null;
  const editable = selected.filter((o) => !o.locked);

  const fieldName = (a: Axis): "xMm" | "yMm" | "zMm" => `${a}Mm` as const;

  const computeTargetValue = (): number => {
    const f = fieldName(axis);
    const values = selected.map((o) => o[f] as number);
    switch (target) {
      case "median": return values.reduce((s, v) => s + v, 0) / values.length;
      case "min": return Math.min(...values);
      case "max": return Math.max(...values);
      case "active": {
        const active = objects.find((o) => o.id === selectedObjectId);
        return active ? (active[f] as number) : values[0];
      }
      case "cursor": return cursorMm[axis];
    }
  };

  const onAlign = async () => {
    setBusy(true);
    try {
      const value = computeTargetValue();
      const f = fieldName(axis);
      await Promise.all(
        editable.map((o) => updateSceneObject(o.id, { [f]: value } as { xMm?: number; yMm?: number; zMm?: number })),
      );
    } finally {
      setBusy(false);
    }
  };

  const distribute = async () => {
    setBusy(true);
    try {
      const f = fieldName(axis);
      const sorted = [...editable].sort((a, b) => (a[f] as number) - (b[f] as number));
      const lo = sorted[0][f] as number;
      const hi = sorted[sorted.length - 1][f] as number;
      const step = (hi - lo) / Math.max(1, sorted.length - 1);
      await Promise.all(
        sorted.map((o, idx) =>
          updateSceneObject(o.id, { [f]: lo + idx * step } as { xMm?: number; yMm?: number; zMm?: number }),
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="edit-section align-panel">
      <h3>
        Align ({editable.length === selected.length ? selected.length : `${editable.length}/${selected.length}`} selected)
      </h3>
      <div className="align-row">
        <span>Axis</span>
        {(["x", "y", "z"] as const).map((a) => (
          <label key={a} className={`align-axis-radio${axis === a ? " active" : ""}`}>
            <input
              type="radio"
              name="align-axis"
              checked={axis === a}
              onChange={() => setAxis(a)}
            />
            {a.toUpperCase()}
          </label>
        ))}
      </div>
      <div className="align-row">
        <span>To</span>
        <select value={target} onChange={(e) => setTarget(e.target.value as Target)}>
          <option value="median">Median</option>
          <option value="min">Min</option>
          <option value="max">Max</option>
          <option value="active">Active</option>
          <option value="cursor">3D cursor</option>
        </select>
      </div>
      <div className="align-actions">
        <button type="button" className="primary-button" onClick={() => void onAlign()} disabled={busy || editable.length === 0}>
          Align
        </button>
        <button type="button" className="secondary-button" onClick={() => void distribute()} disabled={busy || editable.length < 3}>
          Distribute evenly
        </button>
      </div>
    </section>
  );
}
