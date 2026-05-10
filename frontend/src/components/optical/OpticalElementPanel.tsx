import { Sparkles, Trash2 } from "lucide-react";
import * as THREE from "three";
import { Component, useEffect, useMemo, useState, type ReactNode } from "react";

import { useSceneStore } from "../../store/sceneStore";
import type { ComponentItem, ElementKind, OpticalElement, SceneObject } from "../../types/digitalTwin";
import {
  DEFAULT_KIND_PARAMS,
  KIND_GROUPS,
  KIND_LABELS,
  componentTypeToOpticalKind,
} from "../../utils/opticalDefaults";
import {
  findSnapToBeam,
  perpendicularBasis,
} from "../../utils/beamPlacement";
import {
  DEFAULT_STAGE1_MODE,
  DEFAULT_STAGE2_SIGN,
  aomBodyFrameBodyLocal,
  aomTraversalSignFromEntryPort,
  braggAngleRad,
  diffractionEfficiency,
  effectiveAomOrderForTraversal,
  expectedInputDotD2,
  phaseModulationDepth,
  resolveTraversalSign,
  rfPowerForPeakEfficiencyW,
  sidebandIntensitiesOnBragg,
  type Stage1RotationMode,
  type Stage2SignConvention,
} from "../../optical/kinds/aom/physics";
import {
  bodyLocalDirToThree,
  labDirToThree,
  rotateLabDir,
  threeToLabPointMm,
} from "../../optical/frames";

type Props = {
  component: ComponentItem;
  /** The specific scene-object instance whose optical params are being
   *  edited. Per-object optical chain (alembic 0014). When omitted, the
   *  panel renders an empty-state hint asking to select an object. */
  sceneObject?: SceneObject;
};

function findElementForObject(elements: OpticalElement[], objectId: string): OpticalElement | undefined {
  return elements.find((item) => item.objectId === objectId);
}

export function OpticalElementPanel({ component, sceneObject }: Props) {
  const opticalElements = useSceneStore((state) => state.scene.opticalElements);
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);
  const deleteOpticalElement = useSceneStore((state) => state.deleteOpticalElement);
  const autoRegisterOptical = useSceneStore((state) => state.autoRegisterOptical);

  const existing = sceneObject
    ? findElementForObject(opticalElements, sceneObject.id)
    : undefined;
  const mappedKind = componentTypeToOpticalKind(component.componentType);

  const [kind, setKind] = useState<ElementKind>((existing?.elementKind as ElementKind) ?? "laser_source");
  const [paramsText, setParamsText] = useState<string>(() =>
    JSON.stringify(existing?.kindParams ?? DEFAULT_KIND_PARAMS[kind], null, 2),
  );
  const [waveLow, setWaveLow] = useState<number>(existing?.wavelengthRangeNm?.[0] ?? 400);
  const [waveHigh, setWaveHigh] = useState<number>(existing?.wavelengthRangeNm?.[1] ?? 1100);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  // Re-sync when the underlying element changes (e.g., websocket update)
  useEffect(() => {
    if (existing) {
      setKind(existing.elementKind as ElementKind);
      setParamsText(JSON.stringify(existing.kindParams, null, 2));
      setWaveLow(existing.wavelengthRangeNm?.[0] ?? 400);
      setWaveHigh(existing.wavelengthRangeNm?.[1] ?? 1100);
    }
  }, [existing?.objectId, existing?.updatedAt]);

  const ports = (existing?.inputPorts ?? []).concat(existing?.outputPorts ?? []);

  const onLoadDefaults = () => {
    setParamsText(JSON.stringify(DEFAULT_KIND_PARAMS[kind], null, 2));
    setError("");
  };

  const onKindChange = (next: ElementKind) => {
    setKind(next);
    setParamsText(JSON.stringify(DEFAULT_KIND_PARAMS[next], null, 2));
    setError("");
  };

  const onSave = async () => {
    setError("");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(paramsText);
    } catch (e) {
      setError(`JSON parse error: ${(e as Error).message}`);
      return;
    }
    if (waveLow <= 0 || waveHigh <= waveLow) {
      setError("Invalid wavelength range (need 0 < low < high).");
      return;
    }
    if (!sceneObject) {
      setError("Select a scene object instance to attach optical params to.");
      return;
    }
    setBusy(true);
    try {
      await upsertOpticalElement({
        objectId: sceneObject.id,
        elementKind: kind,
        wavelengthRangeNm: [waveLow, waveHigh],
        kindParams: parsed,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onAutoRegister = async () => {
    if (!mappedKind || existing) return;
    setError("");
    setBusy(true);
    try {
      const created = await autoRegisterOptical(component.id);
      if (!created) {
        setError("This component type has no optical mapping.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!existing) return;
    if (!window.confirm("Delete this optical element record?")) return;
    setBusy(true);
    try {
      await deleteOpticalElement(component.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="optical-panel">
      <header className="optical-panel-header">
        <h3>Optical Element</h3>
      </header>

      {!existing && mappedKind && (
        <div className="optical-auto-register">
          <div className="optical-auto-register-text">
            <strong>Not yet registered.</strong>
            <span>
              Component type <code>{component.componentType}</code> maps to{" "}
              <code>{KIND_LABELS[mappedKind]}</code>. One click to add the
              solver-visible row with sensible defaults — you can fine-tune the
              params below afterwards.
            </span>
          </div>
          <button
            type="button"
            className="primary-button optical-auto-register-btn"
            onClick={onAutoRegister}
            disabled={busy}
          >
            <Sparkles size={14} />
            Auto-register as {KIND_LABELS[mappedKind]}
          </button>
        </div>
      )}

      <div className="optical-form">
        <label className="optical-row">
          <span>Element kind</span>
          <select value={kind} onChange={(e) => onKindChange(e.target.value as ElementKind)}>
            {KIND_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.kinds.map((k) => (
                  <option key={k} value={k}>{KIND_LABELS[k]}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <div className="optical-row optical-wavelength">
          <span>Wavelength range (nm)</span>
          <div className="number-pair">
            <input
              type="number"
              step="any"
              value={waveLow}
              onChange={(e) => setWaveLow(Number(e.target.value))}
            />
            <span>—</span>
            <input
              type="number"
              step="any"
              value={waveHigh}
              onChange={(e) => setWaveHigh(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="optical-row">
          <div className="optical-row-header">
            <span>Kind params (JSON)</span>
            <button type="button" className="link-btn" onClick={onLoadDefaults}>
              Load default
            </button>
          </div>
          <textarea
            value={paramsText}
            onChange={(e) => setParamsText(e.target.value)}
            spellCheck={false}
            rows={Math.min(20, paramsText.split("\n").length + 1)}
            className="optical-params-editor"
          />
        </div>

        {error ? <div className="optical-error">{error}</div> : null}

        <div className="optical-actions">
          <button type="button" className="primary" onClick={onSave} disabled={busy}>
            {existing ? "Update" : "Create"}
          </button>
          {existing ? (
            <button type="button" className="danger" onClick={onDelete} disabled={busy}>
              <Trash2 size={14} /> Delete
            </button>
          ) : null}
        </div>
      </div>

      {existing && sceneObject && (
        <AdjustErrorBoundary key={sceneObject.id}>
          <AlignToBeamSection sceneObject={sceneObject} elementKind={existing.elementKind as ElementKind} element={existing} />
        </AdjustErrorBoundary>
      )}
    </section>
  );
}

/** Catches transient render errors from kind-specific adjust panels —
 *  most commonly fires during HMR module swaps when a stale reference
 *  briefly throws before the next frame recovers. Resets when the
 *  selected object id changes (key prop) so re-selecting always gives a
 *  clean retry. */
class AdjustErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.warn("Adjust panel transient error:", error.message);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="snap-to-beam-feedback" style={{ marginTop: 6 }}>
          Adjust panel hit a transient error ({this.state.error.message}).
          Re-select the object to retry.
        </div>
      );
    }
    return this.props.children;
  }
}

/** Align section — replaces the old Ports table + Links list + Snap-to-beam
 *  button with a single per-kind alignment UI:
 *
 *  - mirror / dichroic_mirror  →  align face center to beam, then user
 *                                  can dial in beam offset (x,y) on the
 *                                  face + mirror angle (rx,ry,rz) so the
 *                                  reflection points exactly where wanted.
 *  - other optical kinds       →  one-click alignment of intercept_in
 *                                  (and intercept_out for TA / line-shape)
 *                                  to the nearest beam center.
 *  - emitters (laser/TA)       →  not aligned (they originate the beam).
 */
function AlignToBeamSection({
  sceneObject,
  elementKind,
  element,
}: {
  sceneObject: SceneObject;
  elementKind: ElementKind;
  element: OpticalElement;
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
  if (isEmitter) {
    return (
      <div className="snap-to-beam snap-to-beam-empty">
        Emitters originate the beam — alignment is for downstream optics.
      </div>
    );
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

/** Mirror-only secondary controls: live position offset of the BEAM on the
 *  reflection face (translates mirror along axis-perpendicular u/v) and
 *  mirror rotation (rx/ry/rz — controls where the reflected beam goes). */
function MirrorAdjustControls({ sceneObject }: { sceneObject: SceneObject }) {
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

/** Waveplate-specific control: a single "Fast axis angle" input that rotates
 *  the waveplate clockwise around the beam axis. Two effects every change:
 *    1. The SceneObject's Euler is composed with a rotation_around_beam_axis
 *       quaternion by Δ degrees, so the mesh visually spins around the beam.
 *       Snap-to-beam first (so local +X aligns with the beam) — otherwise the
 *       rotation tilts the body out of axis.
 *    2. `kindParams.fastAxisDeg` is set to the absolute angle, so the Jones
 *       matrix downstream sees the new fast-axis orientation. A λ/2 plate at
 *       angle θ rotates linear polarisation by 2θ.
 *  Convention: positive angle = clockwise when looking ALONG the beam (i.e.
 *  rotation about the +beam axis with right-hand rule = +Δ). */
function WaveplateAdjustControls({
  sceneObject,
  element,
}: {
  sceneObject: SceneObject;
  element: OpticalElement;
}) {
  const scene = useSceneStore((state) => state.scene);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);

  const candidate = useMemo(
    () => findSnapToBeam(sceneObject.id, scene),
    [scene, sceneObject.id],
  );
  const params = (element.kindParams ?? {}) as {
    fastAxisDegBeamLocal?: number;
    fastAxisDeg?: number;  // Phase 5 legacy alias
    retardanceLambda?: number;
  };
  const fastAxisDeg = typeof params.fastAxisDegBeamLocal === "number"
    ? params.fastAxisDegBeamLocal
    : typeof params.fastAxisDeg === "number" ? params.fastAxisDeg : 0;
  const retardance = params.retardanceLambda ?? 0.5;

  // Local draft so the user can type without the input losing focus on every
  // keystroke; commit on blur or Enter.
  const [draft, setDraft] = useState<string>(fastAxisDeg.toFixed(1));
  useEffect(() => {
    setDraft(fastAxisDeg.toFixed(1));
  }, [fastAxisDeg]);

  const commit = async (raw: string) => {
    const next = Number(raw);
    if (!Number.isFinite(next)) return;
    const delta = next - fastAxisDeg;
    if (Math.abs(delta) < 1e-6) return;

    const updates: Partial<SceneObject> = {};
    if (candidate?.axisDirection) {
      // Compose new orientation = R_axis(Δ) ∘ current. Use the same Euler
      // convention as transformUtils.applyObjectTransform: the renderer sets
      // three's Euler (rxDeg, rzDeg, -ryDeg) with order "YXZ".
      const dir = candidate.axisDirection;
      const beamAxisThree = labDirToThree(dir).normalize();
      const deltaQuat = new THREE.Quaternion().setFromAxisAngle(
        beamAxisThree,
        THREE.MathUtils.degToRad(delta),
      );
      const currentEuler = new THREE.Euler(
        THREE.MathUtils.degToRad(sceneObject.rxDeg),
        THREE.MathUtils.degToRad(sceneObject.rzDeg),
        THREE.MathUtils.degToRad(-sceneObject.ryDeg),
        "YXZ",
      );
      const currentQuat = new THREE.Quaternion().setFromEuler(currentEuler);
      const newQuat = deltaQuat.multiply(currentQuat);
      const newEuler = new THREE.Euler().setFromQuaternion(newQuat, "YXZ");
      updates.rxDeg = THREE.MathUtils.radToDeg(newEuler.x);
      updates.rzDeg = THREE.MathUtils.radToDeg(newEuler.y);
      updates.ryDeg = -THREE.MathUtils.radToDeg(newEuler.z);
    }
    // Always update kindParams.fastAxisDeg even if no beam axis is found —
    // the Jones matrix simulation still picks up the new angle.
    await Promise.all([
      Object.keys(updates).length > 0
        ? updateSceneObject(sceneObject.id, updates)
        : Promise.resolve(),
      upsertOpticalElement({
        objectId: sceneObject.id,
        elementKind: element.elementKind,
        // Phase 5: write the new field name; drop the legacy alias so
        // the row converges to the canonical shape on next save.
        kindParams: (() => {
          const { fastAxisDeg: _legacy, ...rest } = params;
          return { ...rest, fastAxisDegBeamLocal: next };
        })(),
        inputPorts: element.inputPorts,
        outputPorts: element.outputPorts,
      }),
    ]);
  };

  return (
    <div className="mirror-adjust">
      <label className="mirror-adjust-field">
        <span>Fast axis (° clockwise around beam)</span>
        <input
          type="number"
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => void commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit((e.target as HTMLInputElement).value);
            }
          }}
        />
      </label>
      <p className="mirror-adjust-hint">
        λ/{retardance === 0.5 ? "2" : retardance === 0.25 ? "4" : `(${retardance})`} plate.
        {retardance === 0.5
          ? " Linear polarisation rotates by 2× this angle."
          : retardance === 0.25
          ? " Linear ↔ circular conversion at ±45°."
          : ""}
        {!candidate
          ? " ⚠ Snap-align to beam first so the rotation stays around the optical axis."
          : ""}
      </p>
    </div>
  );
}

/** AOM-specific controls. Two user requests:
 *
 *   (1) "Align laser to AOM aperture" — analogous to the TA align: scan
 *       the live ray-trace for a beam whose closest-approach hits the
 *       AOM body, pick the AOM face (left or right) that is on the
 *       INCOMING side of that ray, then translate the AOM so the chosen
 *       face centre sits exactly on the ray's infinite line. Rotation
 *       is preserved — the user is responsible for first orienting the
 *       AOM along the desired beam axis.
 *
 *   (2) "Choose which diffraction order is the primary output" — radio
 *       picker (−1 / 0 / +1). Persists to kindParams.diffractionOrder
 *       which both the ray-tracer (rayTrace.ts AOM branch) and the
 *       backend solver consume. Order 0 = RF off (transmitted only);
 *       ±1 = the deflected branch is rotated by ±2·θ_B. Live readouts
 *       below the picker show the current Bragg angle and η so the
 *       user can sanity-check the choice. */
function AomAdjustControls({
  sceneObject,
  element,
}: {
  sceneObject: SceneObject;
  element: OpticalElement;
}) {
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const scene = useSceneStore((state) => state.scene);

  const params = (element.kindParams ?? {}) as {
    centerFreqMhz?: number;
    acousticVelocityMPerS?: number;
    refractiveIndex?: number;
    baseEfficiency?: number;
    figureOfMeritM2?: number;
    crystalLengthMm?: number;
    acousticBeamWidthMm?: number;
    rfDrivePowerW?: number;
    rfPowerMaxW?: number;
    diffractionOrder?: number;
    // Phase 5: new frame-suffixed names; legacy names kept for read
    // compat across un-migrated rows.
    acousticAxisBodyLocal?: number[];
    acousticAxisLocal?: number[];
    rfPropagationDirectionBodyLocal?: number[];
    rfPropagationDirectionLocal?: number[];
    braggAngularAcceptanceMrad?: number;
    maxDiffractionOrder?: number;
    sidebandVisibilityThreshold?: number;
    braggTiltAxisDegLab?: number;
    braggTiltAxisAngleDeg?: number;  // legacy
    /** Phase 7 (AOM align rewrite): optional override for the body-local
     *  pivot used by the Bragg rotation. Defaults to the midpoint of
     *  the asset's intercept_in / intercept_out anchors. */
    braggInteractionPointMmBodyLocal?: number[] | null;
    /** Phase 7.4 align rewrite: how Stage 1 pins the rotation about
     *  beam direction (the only DoF left after the Bragg constraint
     *  beam·D2 = sin θ_B is imposed). See physics.ts for the modes. */
    stage1RotationMode?: Stage1RotationMode;
    /** Phase 7.4 align rewrite: whether the user-selected order m maps
     *  to the same physical lab side regardless of state ("lab-fixed"),
     *  or flips with state-B traversal ("physical-traversal"). */
    stage2SignConvention?: Stage2SignConvention;
  };
  // (Phase 7.1) `braggTiltAxisDegLab` legacy field reading removed —
  // align now derives the tilt axis from b̂_world × â_world. Schema
  // field is kept for backward compat with stored data but no longer
  // consulted by either UI or align.
  const componentRef = scene.components.find((c) => c.id === sceneObject.componentId);
  const compProps = (componentRef?.properties ?? {}) as { wavelengthRangeNm?: number[] };
  const wavelengthForAngleNm = (() => {
    const range = compProps.wavelengthRangeNm;
    if (Array.isArray(range) && range.length === 2) {
      return (range[0] + range[1]) / 2;
    }
    return 780;
  })();

  // Phase 7: physics formulas live in optical/kinds/aom/physics.ts. The
  // panel computes the on-Bragg case at the rated mid-band so the user
  // sees the operating-point of the AOM; the ray-tracer applies the
  // same formulas plus an off-Bragg `braggAngularFactor` per actual
  // beam direction. Single source = panel ↔ scene cannot disagree.
  const thetaBRad = braggAngleRad(params, wavelengthForAngleNm);
  const thetaBMrad = thetaBRad * 1e3;
  const efficiencyEst = diffractionEfficiency(params, wavelengthForAngleNm, thetaBRad);
  const phaseModDepth = phaseModulationDepth(
    params, wavelengthForAngleNm, thetaBRad, efficiencyEst,
  );

  const orderRaw = params.diffractionOrder;
  const currentOrder: -1 | 0 | 1 =
    orderRaw === 0 ? 0 : orderRaw === -1 ? -1 : 1;
  const braggAcceptanceMrad = params.braggAngularAcceptanceMrad ?? 2.0;
  // Phase 5: prefer the new frame-suffixed key, fall back to legacy.
  const rfArr = params.rfPropagationDirectionBodyLocal ?? params.rfPropagationDirectionLocal;
  const acousticArr = params.acousticAxisBodyLocal ?? params.acousticAxisLocal;
  const rfDirectionLocal = Array.isArray(rfArr) && rfArr.length >= 3
    ? [
        Number(rfArr[0]) || 0,
        Number(rfArr[1]) || 0,
        Number(rfArr[2]) || 0,
      ]
    : Array.isArray(acousticArr) && acousticArr.length >= 3
      ? [
          Number(acousticArr[0]) || 0,
          Number(acousticArr[1]) || 0,
          Number(acousticArr[2]) || 0,
        ]
      : [-1, 0, 0];
  const opticalCarrierThz = 299_792_458 / (wavelengthForAngleNm * 1e-9) / 1e12;
  const maxDiffractionOrder = Math.max(1, Math.min(10, Math.round(params.maxDiffractionOrder ?? 3)));
  const sidebandVisibilityThreshold = Math.max(0, Math.min(1, params.sidebandVisibilityThreshold ?? 0.01));

  const intensityByOrder = sidebandIntensitiesOnBragg(
    currentOrder, efficiencyEst, phaseModDepth, maxDiffractionOrder,
  );
  const zerothIntensity = intensityByOrder.get(0)!;
  const selectedFirstOrderIntensity = currentOrder === 0 ? 0 : efficiencyEst;

  const orders: number[] = [];
  for (let nn = -maxDiffractionOrder; nn <= maxDiffractionOrder; nn++) orders.push(nn);

  const sidebandRows: Array<{
    order: number;
    angleMrad: number;
    frequencyOffsetMhz: number;
    centerFrequencyThz: number;
    intensity: number;
    matched: boolean;
    visible: boolean; // would the ray-tracer draw it?
  }> = orders.map((order) => {
    const intensity = intensityByOrder.get(order) ?? 0;
    const matched = order === currentOrder;
    const alwaysShow = order === 0 || order === currentOrder;
    return {
      order,
      angleMrad: order === 0 ? 0 : order * 2 * thetaBMrad,
      frequencyOffsetMhz: order * (params.centerFreqMhz ?? 80),
      centerFrequencyThz: opticalCarrierThz + order * (params.centerFreqMhz ?? 80) * 1e-6,
      intensity,
      matched,
      visible: alwaysShow || intensity >= sidebandVisibilityThreshold,
    };
  });

  const persist = async (patch: Record<string, unknown>) => {
    await upsertOpticalElement({
      objectId: sceneObject.id,
      elementKind: element.elementKind,
      kindParams: { ...params, ...patch },
      inputPorts: element.inputPorts,
      outputPorts: element.outputPorts,
    });
  };

  const setOrder = (order: -1 | 0 | 1) => {
    if (order === currentOrder) return;
    void persist({ diffractionOrder: order });
  };

  // (Removed in Phase 7) The "Flip RF" control is intentionally absent.
  // With braggTiltAxisDegLab defining the rotation plane and
  // diffractionOrder ∈ {-1, 0, +1} selecting which side of that plane
  // the diffracted ray emerges, the ±1 geometry is fully determined.
  // Flipping `acousticAxisBodyLocal` was a redundant second path to
  // the same swap (it negates the dot in the Bragg constraint, which
  // is equivalent to flipping orderSign). Keeping both knobs let users
  // accidentally set inconsistent state. The acoustic axis is now
  // treated as fixed asset metadata (MT80 default body -X, transducer
  // -> absorber); to swap which side gets +1, change the order radio
  // instead.

  // RF drive power slider — η depends on it via the closed-form sin².
  // Keep raw input as a string so live typing doesn't lose focus, commit
  // on blur or Enter. If the user wants to maximise η at the chosen
  // order, the "Maximise η" button inverts the sin² to find the P_d
  // that places arg = π/2 (peak transmission to ±1).
  const rfDraft0 = (params.rfDrivePowerW ?? 1.0).toFixed(3);
  const [rfDraft, setRfDraft] = useState<string>(rfDraft0);
  useEffect(() => setRfDraft((params.rfDrivePowerW ?? 1.0).toFixed(3)), [params.rfDrivePowerW]);
  const rfMax = params.rfPowerMaxW ?? 2.0;

  const commitRfPower = (raw: string) => {
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) return;
    void persist({ rfDrivePowerW: Math.min(v, rfMax) });
  };

  // Inverse of the closed-form sin²: pick P_d so that arg = π/2.
  // Delegates the formula to optical/kinds/aom/physics.ts (returns null
  // when M2/L/W aren't all set, in which case fall back to pegging
  // baseEfficiency at 0.99).
  const maximiseEfficiency = () => {
    const peakPd = rfPowerForPeakEfficiencyW(params, wavelengthForAngleNm, thetaBRad);
    if (peakPd === null) {
      void persist({ baseEfficiency: 0.99 });
      return;
    }
    void persist({ rfDrivePowerW: Math.min(rfMax, Math.max(0, peakPd)) });
  };

  // Align the AOM body to the upstream beam in two stages, sharing a
  // single Bragg sign convention with rayTrace.ts via the helpers in
  // optical/kinds/aom/physics.ts (`expectedInputDotD2`,
  // `diffractedDirection`).
  //
  // Anchor contract (Phase 7.4 rewrite — vibe-coding-log 2026-05-08):
  //
  //   - Asset MUST declare both `intercept_in` and `intercept_out`
  //     anchors with `apertureMm` set. Migration 0021 backfills these.
  //
  //   - Body frame: D1 = unit(intercept_out − intercept_in)  (optical
  //     axis), D2 = rfPropagationDirectionBodyLocal (acoustic / RFin
  //     axis), D3 = D1 × D2 (Bragg rotation axis). For canonical MT80:
  //     D1 = body+Y, D2 = body−X, D3 = body+Z.
  //
  //   - State: sign of (in→out)·beam in WORLD picks state A
  //     (entry=intercept_in) or B (entry=intercept_out).
  //
  //   - Stage 1 (snap optical axis ∥ beam): pick D1_target = ±beam,
  //     D3_target by `params.stage1RotationMode`:
  //       "min-rot"  — minimum-angle rotation from current pose.
  //       "upright"  — D3 closest to lab+Z (default — keeps the AOM
  //                    body upright on a horizontal optical table).
  //       "keep-d2"  — D2 closest to its current lab direction.
  //     D2_target = D3_target × D1_target (right-handed).
  //
  //   - Stage 2 (Bragg rotation): rotate body about D3_target by
  //       ω = −traversalSignRaw · arcsin(expectedInputDotD2(...))
  //     so beam·D2_body lands on the value `physics.ts` derives from
  //     the user-selected order m and `params.stage2SignConvention`.
  //
  //   - Pivot for Stage 2: midpoint of in/out anchors (or
  //     `kindParams.braggInteractionPointMmBodyLocal` override). Pivot
  //     only matters for the "rock around interaction point" UX feel;
  //     the final pose is determined by orientation + entry-on-beam
  //     translation, which makes the math pivot-independent.
  //
  //   - Translation: after the full rotation, project the entry
  //     anchor's lab position onto the beam line.
  const [alignBusy, setAlignBusy] = useState(false);
  const [alignFeedback, setAlignFeedback] = useState<string | null>(null);

  const ALIGN_TOLERANCE_MM = 25;

  const alignToLaser = async () => {
    setAlignBusy(true);
    setAlignFeedback(null);
    try {
      // [1] Locate Asset3D and validate the anchor contract.
      const componentRow = scene.components.find((c) => c.id === sceneObject.componentId);
      const assetRow = componentRow?.asset3dId
        ? scene.assets.find((a) => a.id === componentRow.asset3dId)
        : undefined;
      if (!componentRow) {
        setAlignFeedback("AOM Component row not found in scene store.");
        return;
      }
      if (!assetRow) {
        setAlignFeedback(
          "AOM has no Asset3D — open PHY Editor → Optical → optical_component to assign or define anchors.",
        );
        return;
      }
      const inAnchor = assetRow.anchors.find((a) => a.id === "intercept_in");
      const outAnchor = assetRow.anchors.find((a) => a.id === "intercept_out");
      const missing: string[] = [];
      if (!inAnchor) missing.push("intercept_in");
      if (!outAnchor) missing.push("intercept_out");
      if (missing.length) {
        setAlignFeedback(
          `AOM asset ${assetRow.name} is missing ${missing.join(" and ")}. ` +
          "Open PHY Editor → Optical → optical_component and add the port anchor(s).",
        );
        return;
      }
      if (inAnchor!.apertureMm == null) missing.push("intercept_in.apertureMm");
      if (outAnchor!.apertureMm == null) missing.push("intercept_out.apertureMm");
      if (missing.length) {
        setAlignFeedback(
          `AOM asset ${assetRow.name} has anchor(s) without aperture: ${missing.join(", ")}. ` +
          "Set apertureMm in PHY Editor before aligning.",
        );
        return;
      }

      // [2] Body-local D1/D2/D3 from anchors + RF direction.
      const inBody = inAnchor!.positionMmBodyLocal;
      const outBody = outAnchor!.positionMmBodyLocal;
      const rfBody = {
        x: rfDirectionLocal[0],
        y: rfDirectionLocal[1],
        z: rfDirectionLocal[2],
      };
      const bodyFrame = aomBodyFrameBodyLocal(inBody, outBody, rfBody);
      if (!bodyFrame) {
        setAlignFeedback(
          "Cannot derive D1/D2/D3 from this asset — in/out anchors coincide " +
          "or RF direction is parallel/zero. Open PHY Editor and fix.",
        );
        return;
      }
      const D1Body = bodyFrame.D1;
      const D2Body = bodyFrame.D2;
      const D3Body = bodyFrame.D3;

      // [3] Current world-frame anchor positions (for upstream-beam search).
      const bodyToLab = (bodyMm: { x: number; y: number; z: number }) => {
        const rotated = rotateLabDir(bodyMm, sceneObject);
        return {
          x: sceneObject.xMm + rotated.x,
          y: sceneObject.yMm + rotated.y,
          z: sceneObject.zMm + rotated.z,
        };
      };
      const inLab = bodyToLab(inBody);
      const outLab = bodyToLab(outBody);

      // [4] Walk live ray-trace segments, pick the upstream beam whose
      //     closest-approach hits one of the AOM anchors. Beam-first
      //     (smaller forward t) wins as the entry port.
      type TraceSeg = {
        sourceObjectId: string;
        startThree: { x: number; y: number; z: number };
        endThree: { x: number; y: number; z: number };
      };
      const traces: TraceSeg[] = (typeof window !== "undefined"
        ? (window as unknown as { __rayTraceDebug?: TraceSeg[] }).__rayTraceDebug
        : undefined) ?? [];
      type Match = {
        portId: "intercept_in" | "intercept_out";
        entryBody: { x: number; y: number; z: number };
        entryT: number;
        otherT: number;
        closest: { x: number; y: number; z: number };
        dir: { x: number; y: number; z: number };
        miss: number;
        otherMiss: number;
        sourceId: string;
      };
      let best: Match | null = null;
      for (const seg of traces) {
        if (seg.sourceObjectId === sceneObject.id) continue;
        const a = threeToLabPointMm(seg.startThree);
        const b = threeToLabPointMm(seg.endThree);
        const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
        const lenSq = ab.x ** 2 + ab.y ** 2 + ab.z ** 2;
        if (lenSq < 1e-6) continue;
        const segLen = Math.sqrt(lenSq);
        const dir = { x: ab.x / segLen, y: ab.y / segLen, z: ab.z / segLen };
        const projects = (
          [inLab, outLab] as { x: number; y: number; z: number }[]
        ).map((p) => {
          const t = (p.x - a.x) * dir.x + (p.y - a.y) * dir.y + (p.z - a.z) * dir.z;
          const closest = { x: a.x + dir.x * t, y: a.y + dir.y * t, z: a.z + dir.z * t };
          const miss = Math.hypot(p.x - closest.x, p.y - closest.y, p.z - closest.z);
          return { t, closest, miss };
        });
        const [pIn, pOut] = projects;
        if (pIn.t < 0 && pOut.t < 0) continue;

        const candidates: Array<Match> = [];
        if (pIn.miss <= ALIGN_TOLERANCE_MM && pIn.t >= 0) {
          candidates.push({
            portId: "intercept_in",
            entryBody: { ...inBody },
            entryT: pIn.t,
            otherT: pOut.t,
            closest: pIn.closest,
            dir,
            miss: pIn.miss,
            otherMiss: pOut.miss,
            sourceId: seg.sourceObjectId,
          });
        }
        if (pOut.miss <= ALIGN_TOLERANCE_MM && pOut.t >= 0) {
          candidates.push({
            portId: "intercept_out",
            entryBody: { ...outBody },
            entryT: pOut.t,
            otherT: pIn.t,
            closest: pOut.closest,
            dir,
            miss: pOut.miss,
            otherMiss: pIn.miss,
            sourceId: seg.sourceObjectId,
          });
        }
        candidates.sort((m1, m2) => m1.entryT - m2.entryT);
        const local = candidates[0];
        if (!local) continue;
        if (!best || local.miss < best.miss || (local.miss === best.miss && local.entryT < best.entryT)) {
          best = local;
        }
      }
      if (!best) {
        setAlignFeedback(
          `No upstream beam reaches either AOM port within ${ALIGN_TOLERANCE_MM} mm. ` +
          "Rotate the AOM toward the desired beam first, or check the upstream chain is emitting.",
        );
        return;
      }

      // [5] Ambiguity guard — AOM nearly perpendicular to beam.
      const entryAp = (best.portId === "intercept_in" ? inAnchor! : outAnchor!).apertureMm ?? 0;
      const apertureDiamMm = 2 * entryAp;
      if (
        best.otherMiss <= ALIGN_TOLERANCE_MM &&
        best.otherT >= 0 &&
        Math.abs(best.entryT - best.otherT) < apertureDiamMm
      ) {
        setAlignFeedback(
          "AOM is nearly perpendicular to the beam — both ports are within one aperture of the same point on the beam. " +
          "Rotate the body manually first so the beam clearly enters one port and exits the other.",
        );
        return;
      }

      // [6] State (A/B). traversalSignRaw is the *physical* state; what
      //     we feed to expectedInputDotD2 may be over-ridden by the
      //     "lab-fixed" stage-2 sign convention.
      const traversalSignRaw = aomTraversalSignFromEntryPort(best.portId);
      const stage2SignConvention = params.stage2SignConvention ?? DEFAULT_STAGE2_SIGN;
      const traversalSignForExpect = resolveTraversalSign(traversalSignRaw, stage2SignConvention);
      const effectiveOrder = effectiveAomOrderForTraversal(currentOrder, traversalSignRaw);
      const isStateB = traversalSignRaw < 0;

      // [7] STAGE 1 — snap optical axis ∥ beam.
      //     D1_target = +beam (state A) or −beam (state B). The remaining
      //     rotation about beam direction is pinned by stage1RotationMode.
      const beamUnit = best.dir;
      const D1Target: { x: number; y: number; z: number } = isStateB
        ? { x: -beamUnit.x, y: -beamUnit.y, z: -beamUnit.z }
        : { x: beamUnit.x, y: beamUnit.y, z: beamUnit.z };

      const D1WorldCurrent = rotateLabDir(D1Body, sceneObject);
      const D2WorldCurrent = rotateLabDir(D2Body, sceneObject);
      const D3WorldCurrent = rotateLabDir(D3Body, sceneObject);

      const projectOntoPerp = (
        v: { x: number; y: number; z: number },
        unitN: { x: number; y: number; z: number },
      ): { x: number; y: number; z: number } | null => {
        const dot = v.x * unitN.x + v.y * unitN.y + v.z * unitN.z;
        const proj = {
          x: v.x - dot * unitN.x,
          y: v.y - dot * unitN.y,
          z: v.z - dot * unitN.z,
        };
        const m = Math.hypot(proj.x, proj.y, proj.z);
        return m > 1e-6 ? { x: proj.x / m, y: proj.y / m, z: proj.z / m } : null;
      };
      const cross3 = (
        a: { x: number; y: number; z: number },
        b: { x: number; y: number; z: number },
      ) => ({
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
      });

      const stage1Mode: Stage1RotationMode = params.stage1RotationMode ?? DEFAULT_STAGE1_MODE;
      let D2Target: { x: number; y: number; z: number } | null = null;
      let D3Target: { x: number; y: number; z: number } | null = null;

      if (stage1Mode === "min-rot") {
        // Apply the minimum-angle rotation taking current_D1 → D1_target
        // to current_D2 and current_D3.
        const dot = THREE.MathUtils.clamp(
          D1WorldCurrent.x * D1Target.x +
          D1WorldCurrent.y * D1Target.y +
          D1WorldCurrent.z * D1Target.z,
          -1, 1,
        );
        if (dot > 1 - 1e-9) {
          D2Target = D2WorldCurrent;
          D3Target = D3WorldCurrent;
        } else {
          let axis: { x: number; y: number; z: number };
          if (dot < -1 + 1e-9) {
            // Anti-parallel: rotate by π about ANY perpendicular vector;
            // pick D2 (which is ⊥ current D1).
            axis = D2WorldCurrent;
          } else {
            const ax = cross3(D1WorldCurrent, D1Target);
            const am = Math.hypot(ax.x, ax.y, ax.z);
            axis = { x: ax.x / am, y: ax.y / am, z: ax.z / am };
          }
          const angleRad = Math.acos(dot);
          const dqAxisThree = labDirToThree(axis).normalize();
          const dq = new THREE.Quaternion().setFromAxisAngle(dqAxisThree, angleRad);
          const applyDQ = (v: { x: number; y: number; z: number }) => {
            const v3 = labDirToThree(v);
            v3.applyQuaternion(dq);
            return { x: v3.x, y: -v3.z, z: v3.y };
          };
          D2Target = applyDQ(D2WorldCurrent);
          D3Target = applyDQ(D3WorldCurrent);
        }
      } else if (stage1Mode === "upright") {
        // Upright: keep body D2 (= acoustic / RF propagation axis, typically
        // body+Z for an AOM mounted with the transducer on top) close to
        // lab+Z so the chassis stays "upright" on a horizontal optical
        // table. D3 falls out from D3 = D1 × D2 — same convention as
        // aomBodyFrameBodyLocal in physics.ts.
        //
        // Bug fix 2026-05-09: previously this constrained D3 toward lab+Z
        // instead of D2. For typical AOMs (D2 = acoustic = body+Z, D3 =
        // body+X cross-product axis) that put the chassis on its SIDE
        // — body+X up, acoustic axis horizontal — and produced an Euler
        // result with a spurious extra ±90° about Y on top of the right
        // Z rotation (e.g. (0, -90, 90) instead of the user-expected
        // (0, 0, 90) for state-B beam entry).
        D2Target =
          projectOntoPerp({ x: 0, y: 0, z: 1 }, D1Target) ??
          projectOntoPerp({ x: 0, y: 1, z: 0 }, D1Target) ??
          projectOntoPerp({ x: 1, y: 0, z: 0 }, D1Target);
        if (D2Target) D3Target = cross3(D1Target, D2Target);
      } else {
        // "keep-d2"
        D2Target =
          projectOntoPerp(D2WorldCurrent, D1Target) ??
          projectOntoPerp({ x: 0, y: 0, z: 1 }, D1Target) ??
          projectOntoPerp({ x: 0, y: 1, z: 0 }, D1Target);
        if (D2Target) D3Target = cross3(D1Target, D2Target);
      }
      if (!D2Target || !D3Target) {
        setAlignFeedback(
          "Stage 1 fallback chain exhausted — beam direction degenerate against all reference axes. " +
          "Rotate the AOM manually first so its current pose isn't aligned along all three lab axes simultaneously.",
        );
        return;
      }

      // [8] Build the absolute Stage 1 quaternion. The body-local frame
      //     {D1_b, D2_b, D3_b} (in body coords) maps to the world target
      //     frame {D1_t, D2_t, D3_t} via R = M_target · M_body^{-1}.
      //     `makeBasis` builds the matrix mapping standard basis to a
      //     given basis triple, so M_body has body-local D1/D2/D3 as
      //     columns and M_target has world target D1/D2/D3 as columns.
      const D1BodyThree = bodyLocalDirToThree(D1Body);
      const D2BodyThree = bodyLocalDirToThree(D2Body);
      const D3BodyThree = bodyLocalDirToThree(D3Body);
      const mBody = new THREE.Matrix4().makeBasis(D1BodyThree, D2BodyThree, D3BodyThree);

      const D1TargetThree = labDirToThree(D1Target).normalize();
      const D2TargetThree = labDirToThree(D2Target).normalize();
      const D3TargetThree = labDirToThree(D3Target).normalize();
      const mTarget = new THREE.Matrix4().makeBasis(D1TargetThree, D2TargetThree, D3TargetThree);

      const mBodyInv = mBody.clone().invert();
      const mStage1 = new THREE.Matrix4().multiplyMatrices(mTarget, mBodyInv);
      const stage1Quat = new THREE.Quaternion().setFromRotationMatrix(mStage1);

      // [9] STAGE 2 — Bragg rotation by ω about D3_target_world.
      //     Derivation (post-Stage-1, beam = s·D1_target where s = +1
      //     for state A, −1 for state B):
      //         beam · D2_new(ω) = −s · sin(ω)
      //     Solving beam · D2_new = expectedInputDotD2(...) gives
      //         ω = −s · arcsin(expectedDotD2) = −traversalSignRaw · arcsin(...).
      //     For state A m=+1: expectedDotD2 = −sin θ_B ⇒ ω = +θ_B (CCW
      //     about +D3, body D2 swings toward −beam side ⇒ Bragg-mirror
      //     +1 emerges on +D2 side). The sign is structurally consistent
      //     with rayTrace.ts's `applyAxisAngle(rotAxis, +m·2·θ_B)`.
      const expectedDotD2 = expectedInputDotD2(currentOrder, traversalSignForExpect, thetaBRad);
      const omegaRad = -traversalSignRaw * Math.asin(THREE.MathUtils.clamp(expectedDotD2, -1, 1));
      const stage2DeltaQuat = new THREE.Quaternion().setFromAxisAngle(D3TargetThree, omegaRad);
      const finalQuat = stage2DeltaQuat.clone().multiply(stage1Quat);

      // [10] Translate so the entry anchor lands on the beam line under
      //      the new orientation. `bodyLocalDirToThree(bodyMm).applyQuaternion(finalQuat)`
      //      rotates a body-local OFFSET to lab; we then snap by
      //      projecting onto the beam line. This is pivot-independent —
      //      the midpoint pivot only matters for visualising "rocks
      //      around the interaction point", not for the final pose.
      const rotatedBodyOffset = (bodyMm: { x: number; y: number; z: number }) => {
        const v3 = bodyLocalDirToThree(bodyMm);
        v3.applyQuaternion(finalQuat);
        return { x: v3.x, y: -v3.z, z: v3.y };
      };
      const rotatedEntryDelta = rotatedBodyOffset(best.entryBody);
      let nextXMm = best.closest.x - rotatedEntryDelta.x;
      let nextYMm = best.closest.y - rotatedEntryDelta.y;
      let nextZMm = best.closest.z - rotatedEntryDelta.z;
      // After the above, the entry anchor sits exactly at best.closest;
      // best.closest is already on the beam line by construction (it's
      // the foot of the perpendicular from the original entryLab).

      // [11] Verify Bragg: compute residual = arcsin(beam · D2_new) − arcsin(expectedDotD2).
      const D2NewThree = bodyLocalDirToThree(D2Body);
      D2NewThree.applyQuaternion(finalQuat).normalize();
      const D2NewLab = { x: D2NewThree.x, y: -D2NewThree.z, z: D2NewThree.y };
      const beamDotD2New = beamUnit.x * D2NewLab.x + beamUnit.y * D2NewLab.y + beamUnit.z * D2NewLab.z;
      const residualMrad = (
        Math.asin(THREE.MathUtils.clamp(beamDotD2New, -1, 1)) -
        Math.asin(THREE.MathUtils.clamp(expectedDotD2, -1, 1))
      ) * 1e3;

      // [12] Decompose finalQuat back to SceneObject Euler.
      const finalEuler = new THREE.Euler().setFromQuaternion(finalQuat, "YXZ");
      const nextRxDeg = THREE.MathUtils.radToDeg(finalEuler.x);
      const nextRzDeg = THREE.MathUtils.radToDeg(finalEuler.y);
      const nextRyDeg = -THREE.MathUtils.radToDeg(finalEuler.z);

      // [13] Aperture clipping warning (best-effort; ray-tracer doesn't
      //      publish per-segment 1/e² waist, so use upstream seed waist
      //      as a coarse upper bound).
      const sourceObj = scene.objects.find((o) => o.id === best!.sourceId);
      const sourceComp = sourceObj
        ? scene.components.find((c) => c.id === sourceObj.componentId)
        : undefined;
      const sourceProps = (sourceComp?.properties ?? {}) as { beamWaistMm?: number };
      const upstreamWaistMm =
        typeof sourceProps.beamWaistMm === "number" ? sourceProps.beamWaistMm : null;
      const clippingWarning =
        upstreamWaistMm !== null && upstreamWaistMm > entryAp
          ? ` ⚠ upstream beam waist ${upstreamWaistMm.toFixed(2)} mm > entry aperture ${entryAp.toFixed(2)} mm — beam will clip.`
          : "";

      // [14] Persist + feedback.
      await updateSceneObject(sceneObject.id, {
        xMm: nextXMm,
        yMm: nextYMm,
        zMm: nextZMm,
        rxDeg: nextRxDeg,
        ryDeg: nextRyDeg,
        rzDeg: nextRzDeg,
      });
      const sourceName = sourceObj?.name ?? best!.sourceId.slice(0, 6);
      const stateLabel = isStateB ? "B (entry=out)" : "A (entry=in)";
      const orderLabel = currentOrder === 0 ? "0th" : currentOrder > 0 ? "+1" : "-1";
      const traversalNote =
        traversalSignRaw < 0 && currentOrder !== 0 && stage2SignConvention === "physical-traversal"
          ? ` (state-B traversal flips selected ${currentOrder > 0 ? "+1" : "-1"} → physical ${effectiveOrder > 0 ? "+1" : "-1"})`
          : "";
      setAlignFeedback(
        `Stage 1 (${stage1Mode}): D1 snapped ∥ beam. ` +
        `Stage 2: ω = ${(omegaRad * 1e3).toFixed(3)} mrad about D3 ` +
        `for state ${stateLabel}, m=${orderLabel}${traversalNote} ` +
        `(residual ${residualMrad.toFixed(3)} mrad). ` +
        `Aligned to ${sourceName} beam.${clippingWarning}`,
      );
    } catch (err) {
      setAlignFeedback(`Align failed: ${(err as Error).message}`);
    } finally {
      setAlignBusy(false);
    }
  };

  return (
    <div className="mirror-adjust">
      <div className="mirror-adjust-row">
        <label className="mirror-adjust-field" style={{ flex: 1 }}>
          <span>RF drive power (W, max {rfMax.toFixed(2)})</span>
          <input
            type="number"
            step={0.05}
            min={0}
            max={rfMax}
            value={rfDraft}
            onChange={(e) => setRfDraft(e.target.value)}
            onBlur={(e) => commitRfPower(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRfPower((e.target as HTMLInputElement).value);
              }
            }}
          />
        </label>
        <button
          type="button"
          className="secondary-button"
          onClick={maximiseEfficiency}
          title="Set RF drive power so the chosen ±1st order receives 100 % of the incident light (closed-form sin² → arg = π/2)."
        >
          Max η
        </button>
      </div>
      <p className="mirror-adjust-hint">
        Bragg angle θ_B at λ ≈ {wavelengthForAngleNm.toFixed(0)} nm:{" "}
        <strong>{thetaBMrad.toFixed(2)} mrad</strong> ({(thetaBRad * 180 / Math.PI).toFixed(3)}°).
        Estimated efficiency η = <strong>{(efficiencyEst * 100).toFixed(1)}%</strong>.
        {" "}Angular acceptance = <strong>{braggAcceptanceMrad.toFixed(2)} mrad</strong>.
      </p>
      <div className="mirror-adjust-hint" style={{ opacity: 0.9 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", fontWeight: 600 }}>Sideband</th>
              <th style={{ textAlign: "right", fontWeight: 600 }}>Angle</th>
              <th style={{ textAlign: "right", fontWeight: 600 }}>Shift</th>
              <th style={{ textAlign: "right", fontWeight: 600 }}>Center</th>
              <th style={{ textAlign: "right", fontWeight: 600 }}>Intensity</th>
            </tr>
          </thead>
          <tbody>
            {sidebandRows.map((row) => {
              const orderLabel = row.order > 0 ? `+${row.order}` : `${row.order}`;
              const isHighlighted = row.order === 0 || row.matched;
              const visibleStyle: React.CSSProperties = isHighlighted
                ? { background: "rgba(245, 158, 11, 0.10)", fontWeight: 600 }
                : row.visible
                  ? {}
                  : { opacity: 0.45 };
              return (
                <tr key={row.order} style={visibleStyle}>
                  <td>
                    {orderLabel}
                    {row.matched ? " ◀ selected" : ""}
                    {!row.visible ? " (hidden)" : ""}
                  </td>
                  <td style={{ textAlign: "right" }}>{row.angleMrad.toFixed(2)} mrad</td>
                  <td style={{ textAlign: "right" }}>{row.frequencyOffsetMhz > 0 ? "+" : ""}{row.frequencyOffsetMhz.toFixed(1)} MHz</td>
                  <td style={{ textAlign: "right" }}>{row.centerFrequencyThz.toFixed(6)} THz</td>
                  <td style={{ textAlign: "right" }}>{(row.intensity * 100).toFixed(row.intensity < 0.01 ? 3 : 1)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mirror-adjust-hint" style={{ marginTop: 4, fontSize: 11, opacity: 0.7 }}>
          Spawning orders ±{maxDiffractionOrder}; visibility threshold ={" "}
          {(sidebandVisibilityThreshold * 100).toFixed(1)}% of input. Orders below
          this don't draw a ray (0 and the selected ±1 always show).
        </p>
        {currentOrder !== 0 ? (
          <div style={{ marginTop: 6, padding: "4px 8px", background: "rgba(245, 158, 11, 0.12)", borderLeft: "2px solid rgb(245, 158, 11)", fontSize: 12 }}>
            <strong>Visible beams (0th ↔ {currentOrder > 0 ? "+1" : "−1"}):</strong>{" "}
            angular separation ={" "}
            <strong>{(2 * thetaBMrad).toFixed(3)} mrad</strong>{" "}
            ({(2 * thetaBRad * 180 / Math.PI).toFixed(4)}°).
            <br />
            Intensity split — 0th: <strong>{(zerothIntensity * 100).toFixed(1)}%</strong>,{" "}
            {currentOrder > 0 ? "+1" : "−1"}: <strong>{(selectedFirstOrderIntensity * 100).toFixed(1)}%</strong>.
          </div>
        ) : (
          <div style={{ marginTop: 6, padding: "4px 8px", background: "rgba(0,0,0,0.05)", borderLeft: "2px solid rgba(0,0,0,0.3)", fontSize: 12 }}>
            <strong>Visible beam:</strong> only 0th order — RF off, no diffraction, no angular separation.
          </div>
        )}
      </div>
      <div className="mirror-adjust-row" role="radiogroup" aria-label="Diffraction order">
        <span style={{ alignSelf: "center", fontSize: 12, opacity: 0.8 }}>Output order:</span>
        {([-1, 0, 1] as const).map((opt) => (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={currentOrder === opt}
            className={currentOrder === opt ? "primary-button" : "secondary-button"}
            onClick={() => setOrder(opt)}
            style={{ minWidth: 56 }}
          >
            {opt > 0 ? `+${opt}` : opt === 0 ? "0" : `${opt}`}
          </button>
        ))}
      </div>
      <div className="mirror-adjust-row">
        <label className="mirror-adjust-field" style={{ flex: 1 }}>
          <span>Show up to ±N order</span>
          <input
            type="number"
            min={1}
            max={10}
            step={1}
            value={maxDiffractionOrder}
            onChange={(e) => {
              const v = Math.max(1, Math.min(10, Math.round(Number(e.target.value) || 1)));
              void persist({ maxDiffractionOrder: v });
            }}
          />
        </label>
        <label className="mirror-adjust-field" style={{ flex: 1 }}>
          <span>Visibility threshold (%)</span>
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={(sidebandVisibilityThreshold * 100).toFixed(2)}
            onChange={(e) => {
              const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
              void persist({ sidebandVisibilityThreshold: pct / 100 });
            }}
          />
        </label>
      </div>
      <p className="mirror-adjust-hint" style={{ opacity: 0.8 }}>
        {currentOrder === 0
          ? "0 = RF off — all power on the transmitted (zeroth) path."
          : `${currentOrder > 0 ? "+1" : "−1"} = diffracted by ${currentOrder > 0 ? "+" : "−"}2θ_B; ` +
            `zeroth retains (1−η) ≈ ${((1 - efficiencyEst) * 100).toFixed(1)}%.`}
      </p>
      {/* (Phase 7.1 移除) Bragg tilt axis r (°) 手動輸入。Tilt 軸現在
          自動 = b̂×â（PHY Editor 的 intercept_in/out 定義 b̂、Component
          metadata 的 acousticAxisBodyLocal 定義 â），純幾何推導，沒有
          獨立 DoF。Schema 中的 `braggTiltAxisDegLab` 保留供舊資料讀取，
          但 align 不再讀取這個欄位。 */}
      <button
        type="button"
        className="primary-button"
        onClick={() => void alignToLaser()}
        disabled={alignBusy}
        title="Pick the AOM port (intercept_in / intercept_out) that the upstream beam reaches first, translate that anchor onto the beam line, then rotate the body 1-D around the tilt axis (defined in PHY Editor by α — body-local, ⊥ b̂; pivot = midpoint = Bragg interaction point) so dir·acoustic = orderSign·sin(θ_B)."
      >
        {alignBusy ? "Aligning…" : "Align AOM port + Bragg"}
      </button>
      {alignFeedback && (
        <div className="snap-to-beam-feedback" style={{ marginTop: 6 }}>
          {alignFeedback}
        </div>
      )}
    </div>
  );
}

/** TA-specific controls: live wavelength + drive current + computed
 *  forward / backward power readout. Drives ase_samples and (later)
 *  gain_samples interpolation. */
type AseSampleRow = {
  driveCurrentMa: number;
  forwardPowerMw: number;
  backwardPowerMw: number;
};
type GainSampleRow = {
  inputPowerMw: number;
  driveCurrentMa: number;
  forwardPowerMw: number;
  backwardPowerMw: number;
};

/** Linear interpolation of (drive_current → fwd, bwd) ASE samples — must
 *  mirror the ray-tracer's interpolateAse. */
function interpolateAseUi(samples: AseSampleRow[], driveCurrentMa: number) {
  if (!samples.length) return { forwardMw: 0, backwardMw: 0 };
  const sorted = [...samples].sort((a, b) => a.driveCurrentMa - b.driveCurrentMa);
  if (driveCurrentMa <= sorted[0].driveCurrentMa) {
    return { forwardMw: sorted[0].forwardPowerMw, backwardMw: sorted[0].backwardPowerMw };
  }
  const last = sorted[sorted.length - 1];
  if (driveCurrentMa >= last.driveCurrentMa) {
    return { forwardMw: last.forwardPowerMw, backwardMw: last.backwardPowerMw };
  }
  for (let i = 1; i < sorted.length; i++) {
    if (driveCurrentMa <= sorted[i].driveCurrentMa) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const t = (driveCurrentMa - a.driveCurrentMa) / (b.driveCurrentMa - a.driveCurrentMa);
      return {
        forwardMw: a.forwardPowerMw + (b.forwardPowerMw - a.forwardPowerMw) * t,
        backwardMw: a.backwardPowerMw + (b.backwardPowerMw - a.backwardPowerMw) * t,
      };
    }
  }
  return { forwardMw: 0, backwardMw: 0 };
}

function TaperedAmplifierAdjustControls({
  sceneObject,
  element,
}: {
  sceneObject: SceneObject;
  element: NonNullable<ReturnType<typeof useSceneStore.getState>["scene"]["opticalElements"][number]>;
}) {
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);

  const params = (element.kindParams ?? {}) as {
    centerWavelengthNm?: number;
    driveCurrentMa?: number;
    driveCurrentMaxMa?: number;
    aseSamples?: AseSampleRow[];
    gainSamples?: GainSampleRow[];
    backwardSpatialModeX?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number };
    backwardSpatialModeY?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number };
  };
  const wavelengthNm = params.centerWavelengthNm ?? 852;
  const driveCurrentMa = params.driveCurrentMa ?? 2400;
  const maxCurrentMa = params.driveCurrentMaxMa ?? 5000;
  const aseSamples = params.aseSamples ?? [];

  // Live readout of forward / backward ASE power at the configured drive
  // current (no seed; gain_samples will replace this once a real upstream
  // beam is detected — that's a future 2-pass-trace feature).
  const { forwardMw, backwardMw } = interpolateAseUi(aseSamples, driveCurrentMa);

  const [waveDraft, setWaveDraft] = useState<string>(wavelengthNm.toFixed(1));
  const [currentDraft, setCurrentDraft] = useState<string>(driveCurrentMa.toFixed(0));
  useEffect(() => setWaveDraft(wavelengthNm.toFixed(1)), [wavelengthNm]);
  useEffect(() => setCurrentDraft(driveCurrentMa.toFixed(0)), [driveCurrentMa]);

  const persist = async (patch: Record<string, unknown>) => {
    await upsertOpticalElement({
      objectId: sceneObject.id,
      elementKind: element.elementKind,
      kindParams: { ...params, ...patch },
      inputPorts: element.inputPorts,
      outputPorts: element.outputPorts,
    });
  };

  const commitWavelength = (raw: string) => {
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) return;
    void persist({ centerWavelengthNm: v });
  };
  const commitCurrent = (raw: string) => {
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) return;
    void persist({ driveCurrentMa: Math.min(v, maxCurrentMa) });
  };

  // Align INPUT to a nearby incoming beam. The INPUT centerline is the TA's
  // current local +X axis; when the detected beam travels toward -X, the
  // INPUT reference line uses +X. Alignment is translate-only: no rx/ry/rz
  // edits, so the two lines must already be nearly anti-parallel.
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const scene = useSceneStore((state) => state.scene);

  const alignInputToLaser = async () => {
    const component = scene.components.find((c) => c.id === sceneObject.componentId);
    const props = (component?.properties ?? {}) as {
      // Phase 6: new frame-suffixed names; legacy names accepted for
      // un-migrated rows.
      apertureForwardMmBodyLocal?: number[];
      apertureForwardLocalMm?: number[];
      apertureBackwardMmBodyLocal?: number[];
      apertureBackwardLocalMm?: number[];
    };

    // Prefer explicit aperture metadata over a housing bbox guess. For the
    // user-supplied BoosTA GLB, INPUT is on the +X side, so choose the
    // positive-X aperture when both forward/backward coordinates exist.
    const fwd = props.apertureForwardMmBodyLocal ?? props.apertureForwardLocalMm;
    const back = props.apertureBackwardMmBodyLocal ?? props.apertureBackwardLocalMm;
    const apertureOptions = [fwd, back]
      .filter((v): v is number[] => Array.isArray(v) && v.length === 3);
    const inputApertureBlenderMm = apertureOptions.length > 0
      ? [...apertureOptions].sort((a, b) => (b[0] ?? 0) - (a[0] ?? 0))[0]
      : null;

    let inputApertureLab: { x: number; y: number; z: number } | null = null;
    let inputAnchorWrapperLocal: { x: number; y: number; z: number } | null = null;
    if (typeof window !== "undefined") {
      const root = (window as unknown as { __beamGroup?: THREE.Group }).__beamGroup?.parent;
      if (root) {
        let wrapper: THREE.Object3D | null = null;
        root.traverse((n) => {
          if (!wrapper && n.userData?.objectId === sceneObject.id && n.children.length > 0 && !(n as THREE.Mesh).isMesh) {
            wrapper = n;
          }
        });
        if (wrapper) {
          (wrapper as THREE.Object3D).updateMatrixWorld(true);
          if (inputApertureBlenderMm) {
            const offsetBearing: THREE.Object3D[] = [];
            const meshParents: THREE.Object3D[] = [];
            (wrapper as THREE.Object3D).traverse((n) => {
              if (!(n as THREE.Mesh).isMesh) return;
              let cur: THREE.Object3D | null = n.parent;
              while (cur && cur !== wrapper) {
                if (!(cur as THREE.Mesh).isMesh && cur.position.lengthSq() > 1e-12) {
                  offsetBearing.push(cur);
                }
                if (!(cur as THREE.Mesh).isMesh && cur.children.some((cc) => (cc as THREE.Mesh).isMesh)) {
                  meshParents.push(cur);
                }
                cur = cur.parent;
              }
            });
            const glbSceneRoot = offsetBearing[0] ?? meshParents[0] ?? null;
            if (glbSceneRoot) {
              const [bxMeta, byMeta, bzMeta] = inputApertureBlenderMm;
              const apertureWorld = new THREE.Vector3(
                bxMeta ?? 0,
                bzMeta ?? 0,
                -(byMeta ?? 0),
              ).applyMatrix4(glbSceneRoot.matrixWorld);
              const labPoint = threeToLabPointMm(apertureWorld);
              inputApertureLab = {
                x: labPoint.x,
                y: labPoint.y,
                z: labPoint.z,
              };
            }
          }
          const wrapperWorldInv = new THREE.Matrix4().copy((wrapper as THREE.Object3D).matrixWorld).invert();
          const localBox = new THREE.Box3();
          (wrapper as THREE.Object3D).traverse((m) => {
            if (!(m as THREE.Mesh).isMesh) return;
            const mesh = m as THREE.Mesh;
            if (!mesh.geometry) return;
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
            const bb = mesh.geometry.boundingBox;
            if (!bb) return;
            mesh.updateMatrixWorld(true);
            for (let i = 0; i < 8; i++) {
              const c = new THREE.Vector3(
                (i & 1) ? bb.max.x : bb.min.x,
                (i & 2) ? bb.max.y : bb.min.y,
                (i & 4) ? bb.max.z : bb.min.z,
              );
              c.applyMatrix4(mesh.matrixWorld).applyMatrix4(wrapperWorldInv);
              localBox.expandByPoint(c);
            }
          });
          if (!localBox.isEmpty()) {
            // Input face = +X side; centre of that face in wrapper-local.
            inputAnchorWrapperLocal = {
              x: localBox.max.x,
              y: (localBox.min.y + localBox.max.y) / 2,
              z: (localBox.min.z + localBox.max.z) / 2,
            };
          }
        }
      }
    }
    if (!inputApertureLab && !inputAnchorWrapperLocal) {
      window.alert("Cannot read TA mesh bbox — alignment unavailable until the scene finishes loading.");
      return;
    }
    // Wrapper-local coords are in three.js Y-up frame. Convert to lab so
    // we can apply the SceneObject rotation: lab = (three.x, -three.z, three.y) × 100.
    // Rotate the local offset by SceneObject's lab-frame Euler.
    const rx = (sceneObject.rxDeg * Math.PI) / 180;
    const ry = (sceneObject.ryDeg * Math.PI) / 180;
    const rz = (sceneObject.rzDeg * Math.PI) / 180;
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cx = Math.cos(rx), sxk = Math.sin(rx);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    // Same Rz · Rx · Ry (lab) sequence used by transformUtils + beamPlacement.
    const apertureLab = inputApertureLab ?? (() => {
      const apLocalLab = {
        x: inputAnchorWrapperLocal!.x * 100,
        y: -inputAnchorWrapperLocal!.z * 100,
        z: inputAnchorWrapperLocal!.y * 100,
      };
      const [bx, by, bz] = [apLocalLab.x, apLocalLab.y, apLocalLab.z];
      let x = bx * cy + bz * sy;
      let y = by;
      let z = -bx * sy + bz * cy;
      let x2 = x;
      let y2 = y * cx - z * sxk;
      let z2 = y * sxk + z * cx;
      const wx = x2 * cz - y2 * sz;
      const wy = x2 * sz + y2 * cz;
      const wz = z2;
      return {
        x: sceneObject.xMm + wx,
        y: sceneObject.yMm + wy,
        z: sceneObject.zMm + wz,
      };
    })();
    const inputAxisLab = {
      x: cy * cz - sy * sxk * sz,
      y: cy * sz + sy * sxk * cz,
      z: -sy * cx,
    };
    const INPUT_ALIGN_TOLERANCE_MM = 25;
    const INPUT_AXIS_DOT_MAX = -0.995;

    // Pick the beam segment that's "supposed to feed" the TA — the one
    // whose ray comes CLOSEST to the input aperture. We iterate ALL
    // trace segments (laser-direct, mirror-reflected, lens-transmitted,
    // PBS-transmitted/reflected, etc.) so post-mirror beams are eligible
    // — what feeds a TA's input usually went through several optics
    // first. Only segments emitted BY THE TA ITSELF are excluded
    // (otherwise the TA's own backward ASE picks itself as the
    // alignment reference, which is nonsense). Among forward-pointing
    // candidates (t ≥ 0), prefer the smallest perpendicular miss; if
    // none point at the aperture forward, fall back to the smallest
    // perpendicular miss on the infinite line.
    type TraceSeg = {
      sourceObjectId: string;
      startThree: { x: number; y: number; z: number };
      endThree: { x: number; y: number; z: number };
    };
    const traces: TraceSeg[] = (typeof window !== "undefined"
      ? (window as unknown as { __rayTraceDebug?: TraceSeg[] }).__rayTraceDebug
      : undefined) ?? [];
    const threeToLab = threeToLabPointMm;
    type AxisCandidate = {
      origin: { x: number; y: number; z: number };
      dir: { x: number; y: number; z: number };
      missMm: number;
      closestPoint: { x: number; y: number; z: number };
      tForward: number;  // ≥ 0 means aperture is in the forward direction
    };
    let bestAligned: AxisCandidate | null = null;
    let closestAny: AxisCandidate | null = null;
    let closestNearButWrongDirection: AxisCandidate | null = null;
    for (const seg of traces) {
      // Skip segments emitted BY this TA (its own forward / backward
      // ASE — using these would have the TA align to itself).
      if (seg.sourceObjectId === sceneObject.id) continue;
      const a = threeToLab(seg.startThree);
      const b = threeToLab(seg.endThree);
      const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const lenSq = ab.x ** 2 + ab.y ** 2 + ab.z ** 2;
      if (lenSq < 1e-6) continue;
      const segLen = Math.sqrt(lenSq);
      const dir = { x: ab.x / segLen, y: ab.y / segLen, z: ab.z / segLen };
      const toAp = { x: apertureLab.x - a.x, y: apertureLab.y - a.y, z: apertureLab.z - a.z };
      const t = toAp.x * dir.x + toAp.y * dir.y + toAp.z * dir.z;
      const closest = { x: a.x + dir.x * t, y: a.y + dir.y * t, z: a.z + dir.z * t };
      const miss = Math.hypot(apertureLab.x - closest.x, apertureLab.y - closest.y, apertureLab.z - closest.z);
      const candidate: AxisCandidate = { origin: a, dir, missMm: miss, closestPoint: closest, tForward: t };
      const dotWithInput = dir.x * inputAxisLab.x + dir.y * inputAxisLab.y + dir.z * inputAxisLab.z;
      if (!closestAny || miss < closestAny.missMm) {
        closestAny = candidate;
      }
      if (miss > INPUT_ALIGN_TOLERANCE_MM || t <= 0) continue;
      if (dotWithInput > INPUT_AXIS_DOT_MAX) {
        if (!closestNearButWrongDirection || miss < closestNearButWrongDirection.missMm) {
          closestNearButWrongDirection = candidate;
        }
        continue;
      }
      if (!bestAligned || miss < bestAligned.missMm) {
        bestAligned = candidate;
      }
    }
    if (!closestAny) {
      window.alert("No beam axis found in the current trace.");
      return;
    }
    if (!bestAligned) {
      if (closestNearButWrongDirection) {
        window.alert(
          `A beam is within ${closestNearButWrongDirection.missMm.toFixed(2)} mm of the INPUT hole, ` +
          "but it is not opposite to the TA INPUT +X centerline. Rotate the TA manually first; align will not change angle.",
        );
      } else {
        window.alert(
          `No incoming beam is within ${INPUT_ALIGN_TOLERANCE_MM.toFixed(1)} mm of the INPUT hole. ` +
          `Closest beam is ${closestAny.missMm.toFixed(2)} mm away.`,
        );
      }
      return;
    }
    // Translate-only alignment: keep the user's current rotation,
    // translate the TA so the INPUT face is exactly on the laser beam's
    // (or upstream feed beam's) infinite centreline. Earlier this also
    // rotated the body to point along the beam, but the user prefers to
    // keep the orientation they set up and just snap the position.
    //
    // `apertureLab` is the input-face anchor in lab coords given the
    // TA's CURRENT rotation. `bestAligned.closestPoint` is the perpendicular
    // foot from that anchor onto the chosen beam ray.
    const delta = {
      x: bestAligned.closestPoint.x - apertureLab.x,
      y: bestAligned.closestPoint.y - apertureLab.y,
      z: bestAligned.closestPoint.z - apertureLab.z,
    };
    await updateSceneObject(sceneObject.id, {
      xMm: sceneObject.xMm + delta.x,
      yMm: sceneObject.yMm + delta.y,
      zMm: sceneObject.zMm + delta.z,
    });
  };

  return (
    <div className="mirror-adjust">
      <label className="mirror-adjust-field">
        <span>Wavelength (nm)</span>
        <input
          type="number"
          step={0.1}
          value={waveDraft}
          onChange={(e) => setWaveDraft(e.target.value)}
          onBlur={(e) => commitWavelength(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitWavelength((e.target as HTMLInputElement).value);
            }
          }}
        />
      </label>
      <label className="mirror-adjust-field">
        <span>Drive current (mA, max {maxCurrentMa})</span>
        <input
          type="number"
          step={50}
          min={0}
          max={maxCurrentMa}
          value={currentDraft}
          onChange={(e) => setCurrentDraft(e.target.value)}
          onBlur={(e) => commitCurrent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitCurrent((e.target as HTMLInputElement).value);
            }
          }}
        />
      </label>
      <p className="mirror-adjust-hint">
        ASE @ {driveCurrentMa.toFixed(0)} mA: forward{" "}
        <strong>{forwardMw.toFixed(1)} mW</strong> · backward{" "}
        <strong>{backwardMw.toFixed(1)} mW</strong>
      </p>
      <button
        type="button"
        className="primary-button"
        onClick={() => void alignInputToLaser()}
        title="Translate the TA so its INPUT +X centerline coincides with a beam within 25 mm; rotation is unchanged."
      >
        Align INPUT to laser beam
      </button>
      <p className="mirror-adjust-hint" style={{ opacity: 0.7 }}>
        INPUT seed port is on the +X face for this TA model; output is on the opposite face. Even
        without a seed the chip leaks ASE in both directions; once a seed
        beam reaches the input port, the gain table will saturate the
        forward output and partly suppress the backward emission.
      </p>
    </div>
  );
}
