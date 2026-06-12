/**
 * Per-kind "Adjust" controls — split out of PhysicsElementPanel.tsx
 * (god-file).
 *
 * Only the Mirror control survives here: it nudges the SceneObject POSE
 * (transverse shift on the face + rotation), which reaches the trace. The
 * former Waveplate / BeamSplitter / Lens dedicated editors were retired —
 * they wrote PhysicsElement.kindParams, which the v3 anchor tracer does NOT
 * read (it merges asset.default_params ⊕ dynamic_sources), so their edits
 * never reached the beam. Those kinds' intrinsic coefficients are now
 * asset-only; only asset-blessed tunable params are per-instance editable
 * (InstanceDynamicSourcesEditor → dynamicSources).
 */
import { useMemo } from "react";

import { useSceneStore } from "../../store/sceneStore";
import type { SceneObject } from "../../types/digitalTwin";
import {
  findSnapToBeam,
  perpendicularBasis,
} from "../../utils/beamPlacement";

export function MirrorAdjustControls({ sceneObject }: { sceneObject: SceneObject }) {
  const scene = useSceneStore((state) => state.scene);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  // Cache the perpendicular basis from the nearest beam axis at render time.
  // Each input change translates the mirror by u*Δ or v*Δ.
  const candidate = useMemo(
    () => findSnapToBeam(sceneObject.id, scene),
    [scene, sceneObject.id],
  );
  const axisDir = candidate?.axisDirection ?? null;

  const onTransverse = (basis: "u" | "v", deltaMm: number) => {
    if (!axisDir || !Number.isFinite(deltaMm)) return;
    const { u, v } = perpendicularBasis(axisDir);
    const dir = basis === "u" ? u : v;
    void updateSceneObject(sceneObject.id, {
      xMm: sceneObject.xMm + dir.x * deltaMm,
      yMm: sceneObject.yMm + dir.y * deltaMm,
      zMm: sceneObject.zMm + dir.z * deltaMm,
    });
  };

  const onRotate = (axis: "rxDeg" | "ryDeg" | "rzDeg", value: number) => {
    if (!Number.isFinite(value)) return;
    void updateSceneObject(sceneObject.id, { [axis]: value });
  };

  return (
    <div className="mirror-adjust">
      <div className="mirror-adjust-row">
        <label className="mirror-adjust-field">
          <span>Beam Δ on face — U (mm)</span>
          <input
            type="number"
            step={0.1}
            defaultValue="0"
            onBlur={(e) => onTransverse("u", Number(e.target.value))}
          />
        </label>
        <label className="mirror-adjust-field">
          <span>V (mm)</span>
          <input
            type="number"
            step={0.1}
            defaultValue="0"
            onBlur={(e) => onTransverse("v", Number(e.target.value))}
          />
        </label>
      </div>
      <div className="mirror-adjust-row">
        {(["rxDeg", "ryDeg", "rzDeg"] as const).map((key) => (
          <label key={key} className="mirror-adjust-field">
            <span>{key.replace("Deg", "").toUpperCase()} (°)</span>
            <input
              type="number"
              step={0.5}
              value={sceneObject[key]}
              onChange={(e) => onRotate(key, Number(e.target.value))}
            />
          </label>
        ))}
      </div>
      <p className="mirror-adjust-hint">
        Δ inputs apply on blur (translate mirror perpendicular to beam — beam
        lands off-center on the face). Rotation updates live.
      </p>
    </div>
  );
}
