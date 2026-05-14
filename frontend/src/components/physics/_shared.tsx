/**
 * Shared helper components used by multiple physics inspectors.
 * Split out of PhysicsElementPanel.tsx (god-file) so the main file
 * stays small (~120 lines of dispatcher).
 *
 *   - wavelengthHex          (number -> color hex via three.js)
 *   - EmissionVisualRow      (color picker + visibility toggle)
 *   - AlignToBeamSection     (snap-to-beam UI for any SceneObject)
 *   - PerObjectApertureEditor (V2 per-object aperture editor)
 *
 * Consumed by PhysicsElementPanel + the inspectors that need them.
 */
import { useEffect, useMemo, useState } from "react";

import { useSceneStore } from "../../store/sceneStore";
import type {
  ComponentItem,
  ElementKind,
  PhysicsElement,
  SceneObject,
} from "../../types/digitalTwin";
import {
  findSnapToBeam,
  perpendicularBasis,
} from "../../utils/beamPlacement";
import {
  getEffectiveApertureMm,
  getPerObjectAperture,
  setPerObjectAperture,
  type V2Aperture,
} from "../../utils/v2Bindings";
import {
  type EmissionKey,
  getEmissionVisual,
  setEmissionVisualPatch,
} from "../../utils/emissionVisuals";
import { wavelengthToColor } from "../../three/opticalBeams";
// The kind-specific Controls live in sibling files; AlignToBeamSection
// dispatches into them based on element.elementKind.
import {
  MirrorAdjustControls,
  WaveplateAdjustControls,
  BeamSplitterControls,
  LensControls,
} from "./SimpleAdjustControls";
import { LaserSourceControls } from "./LaserSourceControls";
import { AomAdjustControls } from "./AomAdjustControls";
import { TaperedAmplifierAdjustControls } from "./TaperedAmplifierAdjustControls";

export function wavelengthHex(wavelengthNm: number): string {
  return `#${wavelengthToColor(wavelengthNm).getHexString()}`;
}

export function EmissionVisualRow({
  sceneObject,
  emissionKey,
  label,
  fallbackColorHex,
  showVisibilityToggle,
}: {
  sceneObject: SceneObject;
  emissionKey: EmissionKey;
  label: string;
  fallbackColorHex: string;
  showVisibilityToggle: boolean;
}) {
  const updateSceneObject = useSceneStore((s) => s.updateSceneObject);
  const visual = getEmissionVisual(sceneObject, emissionKey);
  const hasOverride = visual.colorHex !== null;
  const displayHex = visual.colorHex ?? fallbackColorHex;

  const persist = (patch: Partial<{ colorHex: string | null; visible: boolean }>) => {
    void updateSceneObject(sceneObject.id, {
      properties: setEmissionVisualPatch(sceneObject, emissionKey, patch),
    });
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
      <span style={{ fontSize: 11, minWidth: 70 }}>{label}</span>
      <input
        type="color"
        value={displayHex}
        onChange={(e) => persist({ colorHex: e.target.value })}
        style={{ width: 32, height: 22, padding: 0, border: "1px solid rgba(255,255,255,0.2)", borderRadius: 3, cursor: "pointer" }}
        title="Beam colour for this emission"
      />
      <span style={{ fontSize: 10, opacity: 0.7, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>{displayHex}</span>
      {hasOverride ? (
        <button
          type="button"
          onClick={() => persist({ colorHex: null })}
          style={{ fontSize: 10, padding: "1px 6px" }}
          title="Reset to wavelength-derived colour"
        >Reset</button>
      ) : (
        <span style={{ fontSize: 10, opacity: 0.5 }}>(λ default)</span>
      )}
      {showVisibilityToggle && (
        <label style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: "auto", fontSize: 10 }}>
          <input
            type="checkbox"
            checked={visual.visible}
            onChange={(e) => persist({ visible: e.target.checked })}
          />
          <span>Show</span>
        </label>
      )}
    </div>
  );
}

type Props = {
  component: ComponentItem;
  /** The specific scene-object instance whose optical params are being
   *  edited. Per-object optical chain (alembic 0014). When omitted, the
   *  panel renders an empty-state hint asking to select an object. */
  sceneObject?: SceneObject;
};

function findElementForObject(elements: PhysicsElement[], objectId: string): PhysicsElement | undefined {
  return elements.find((item) => item.objectId === objectId);
}


export function AlignToBeamSection({
  sceneObject,
  elementKind,
  element,
}: {
  sceneObject: SceneObject;
  elementKind: ElementKind;
  element: PhysicsElement;
}) {
  const scene = useSceneStore((state) => state.scene);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const candidate = useMemo(
    () => findSnapToBeam(sceneObject.id, scene),
    [scene, sceneObject.id],
  );

  const fromName = candidate
    ? scene.objects.find((o) => o.id === candidate.fromObjectId)?.name ?? candidate.fromObjectId.slice(0, 6)
    : null;

  const isMirror = elementKind === "mirror" || elementKind === "dichroic_mirror";
  const isEmitter = elementKind === "laser_source" || elementKind === "tapered_amplifier";
  const isWaveplate = elementKind === "waveplate";
  const isBeamSplitter = elementKind === "beam_splitter";
  const isLens = elementKind === "lens_biconvex"
    || elementKind === "lens_plano_convex"
    || elementKind === "lens_cylindrical";

  const onAlign = async () => {
    if (!candidate) return;
    setBusy(true);
    setFeedback(null);
    try {
      await updateSceneObject(sceneObject.id, {
        xMm: candidate.newBodyPos.x,
        yMm: candidate.newBodyPos.y,
        zMm: candidate.newBodyPos.z,
      });
      setFeedback(
        `${candidate.anchorId} aligned to ${fromName} axis (was ${candidate.missMm.toFixed(1)} mm off, now 0).`,
      );
    } catch (err) {
      setFeedback(`Align failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (elementKind === "tapered_amplifier") {
    return <TaperedAmplifierAdjustControls sceneObject={sceneObject} element={element} />;
  }
  if (elementKind === "aom") {
    return <AomAdjustControls sceneObject={sceneObject} element={element} />;
  }
  if (elementKind === "laser_source") {
    return <LaserSourceControls sceneObject={sceneObject} element={element} />;
  }
  if (isEmitter) {
    return (
      <div className="snap-to-beam snap-to-beam-empty">
        Emitters originate the beam — alignment is for downstream optics.
      </div>
    );
  }
  // RF kinds don't propagate as optical beams, so "Align intercept to beam"
  // (which projects onto optical beam_paths / __rayTraceDebug) is meaningless
  // for rf_source / horn_antenna / rf_cable. Skip the snap-to-beam block
  // entirely for the RF domain — rf_cable has its own "Align RF" buttons
  // in ComponentPanel that snap to rf_in/rf_out anchors instead.
  if (
    elementKind === "rf_source"
    || elementKind === "horn_antenna"
    || elementKind === "rf_cable"
  ) {
    return null;
  }

  return (
    <div className="snap-to-beam">
      {candidate ? (
        <>
          <div className="snap-to-beam-info">
            <strong>Nearest beam:</strong>{" "}
            {fromName} ({candidate.fromPort}) —{" "}
            <code>{candidate.anchorId}</code> would shift{" "}
            <strong>{candidate.missMm.toFixed(2)} mm</strong> to land on axis.
          </div>
          <button
            type="button"
            className="primary-button"
            onClick={() => void onAlign()}
            disabled={busy}
          >
            {isMirror ? "Align face center to beam" : "Align intercept to beam"}
          </button>
          {/* Mirror-specific: after aligning, expose offset (on face) +
              rotation (controls reflection direction). */}
          {isMirror && <MirrorAdjustControls sceneObject={sceneObject} />}
          {/* Waveplate-specific: rotate the plate clockwise around the beam
              axis to set the fast-axis angle (Jones-matrix theta). */}
          {isWaveplate && (
            <WaveplateAdjustControls sceneObject={sceneObject} element={element} />
          )}
          {/* Beam-splitter / PBS-specific: split ratio, polarising flag,
              extinction ratio, and overall transmission. */}
          {isBeamSplitter && (
            <BeamSplitterControls sceneObject={sceneObject} element={element} />
          )}
          {/* Lens-specific (biconvex / plano-convex / cylindrical):
              focal length, NA or cylindrical axis, transmission,
              material, GVD. */}
          {isLens && (
            <LensControls sceneObject={sceneObject} element={element} />
          )}
          {/* V2: per-object aperture override (asset apertureMm becomes a
              default seed; the editable value lives on the SceneObject). */}
          <PerObjectApertureEditor sceneObject={sceneObject} />
        </>
      ) : (
        <div className="snap-to-beam-empty">
          No beam axis within 25 mm of any intercept anchor.
        </div>
      )}
      {feedback && <div className="snap-to-beam-feedback">{feedback}</div>}
    </div>
  );
}

/** Per-object aperture editor — V2.
 *
 *  Aperture used to live on Asset3D.anchors[].apertureMm and was edited in
 *  the PHY Editor (Layer 2). Per V2 (docs/optical-schema-v2.md §3),
 *  aperture is per-physical-instance: the asset value is just a default
 *  seed, and the user overrides it on the SceneObject. We write to
 *  objects.properties.perAnchorApertures[anchorId] (a transitional
 *  flat map covering anchors that have no V2 binding yet — AOM
 *  intercept_in/out, lens intercept_in, etc.). For kinds whose existing
 *  binding already carries geometry (mirror's opticalSurface), future
 *  cleanup will fold the aperture into that binding's payload — the
 *  reader helper getEffectiveApertureMm hides the distinction.
 */
export function PerObjectApertureEditor({ sceneObject }: { sceneObject: SceneObject }) {
  const scene = useSceneStore((state) => state.scene);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);

  const component = scene.components.find((c) => c.id === sceneObject.componentId);
  const asset = component?.asset3dId
    ? scene.assets.find((a) => a.id === component.asset3dId)
    : undefined;
  // Surface every anchor whose asset seed carries an apertureMm — those
  // are the ones the consumer code reads (beam intercept tests, AOM align,
  // apertureCheck). Anchors with no apertureMm seed are out of scope here;
  // a future kind contract may extend the list.
  const anchors = (asset?.anchors ?? []).filter(
    (a) =>
      a.apertureMm != null ||
      // Always show the aperture editor for AOM intercept ports even if
      // the seed is missing — that is the canonical kind that needs an
      // explicit per-instance value.
      a.id === "intercept_in" ||
      a.id === "intercept_out",
  );
  if (!anchors.length) return null;

  const onChange = async (anchorId: string, rMm: number | null) => {
    const next: V2Aperture | null = rMm != null && rMm > 0 ? { shape: "circle", rMm } : null;
    const newProps = setPerObjectAperture(sceneObject.properties, anchorId, next);
    await updateSceneObject(sceneObject.id, { properties: newProps });
  };

  return (
    <div
      className="snap-to-beam-aperture"
      style={{
        marginTop: 8,
        padding: "6px 8px",
        borderLeft: "2px solid #facc15",
        background: "rgba(250, 204, 21, 0.08)",
        fontSize: 11,
      }}
    >
      <div style={{ color: "#facc15", fontWeight: 600, marginBottom: 4 }}>
        Aperture (per-object)
      </div>
      <div style={{ opacity: 0.7, marginBottom: 6 }}>
        Asset value is a default seed; per-object override lives on this
        SceneObject. Set 0 / blank to reuse the asset default.
      </div>
      {anchors.map((a) => {
        const eff = getEffectiveApertureMm(sceneObject, a, a.id);
        const override = getPerObjectAperture(sceneObject, a.id);
        const overrideRadius = override && override.shape === "circle" ? override.rMm : null;
        return (
          <label
            key={a.id}
            className="component-editor-coord"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 80px",
              gap: 6,
              alignItems: "center",
              marginBottom: 4,
            }}
          >
            <span>
              <code style={{ fontSize: 10 }}>{a.id}</code>
              {overrideRadius == null && (
                <span style={{ marginLeft: 6, opacity: 0.55, fontSize: 10 }}>
                  (asset default {a.apertureMm?.toFixed(2) ?? "—"} mm)
                </span>
              )}
            </span>
            <input
              type="number"
              step={0.1}
              min={0}
              placeholder={a.apertureMm?.toFixed(2) ?? ""}
              value={overrideRadius != null ? overrideRadius.toString() : ""}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw.trim() === "") {
                  void onChange(a.id, null);
                  return;
                }
                const v = Number(raw);
                if (!Number.isFinite(v)) return;
                void onChange(a.id, v);
              }}
              title={
                eff != null
                  ? `Effective aperture: ${eff.toFixed(2)} mm`
                  : "No aperture set; consumers fall back to a kind default."
              }
            />
          </label>
        );
      })}
    </div>
  );
}
