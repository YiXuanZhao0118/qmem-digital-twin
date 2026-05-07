import { Play, Sparkles, Trash2 } from "lucide-react";
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
  bodyLocalDirToThree,
  labDirToThree,
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
  const runOpticalSimulation = useSceneStore((state) => state.runOpticalSimulation);

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
  const [runResult, setRunResult] = useState<string>("");

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

  const onRun = async () => {
    setBusy(true);
    setRunResult("");
    try {
      const result = await runOpticalSimulation();
      const lines: string[] = [`run ${result.runId.slice(0, 8)}: ${result.segmentCount} segments`];
      if (result.errors.length) lines.push("errors:", ...result.errors.map((e) => `  - ${e}`));
      if (result.warnings.length) lines.push("warnings:", ...result.warnings.map((w) => `  - ${w}`));
      setRunResult(lines.join("\n"));
    } catch (e) {
      setRunResult(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="optical-panel">
      <header className="optical-panel-header">
        <h3>Optical Element</h3>
        <button type="button" className="optical-run-btn" onClick={onRun} disabled={busy}>
          <Play size={14} /> Run Solver
        </button>
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
        {runResult ? <pre className="optical-run-output">{runResult}</pre> : null}

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
  };
  // Continuous angle (lab/scene Z-up frame): 0° = tilt axis along
  // scene+Z (fan in XY plane), 90° = tilt axis along scene+Y (fan in
  // XZ plane). Default 90°.
  const braggTiltAxisAngleDeg = typeof params.braggTiltAxisDegLab === "number"
    ? params.braggTiltAxisDegLab
    : typeof params.braggTiltAxisAngleDeg === "number"
      ? params.braggTiltAxisAngleDeg
      : 90;
  const componentRef = scene.components.find((c) => c.id === sceneObject.componentId);
  const compProps = (componentRef?.properties ?? {}) as { wavelengthRangeNm?: number[] };
  const wavelengthForAngleNm = (() => {
    const range = compProps.wavelengthRangeNm;
    if (Array.isArray(range) && range.length === 2) {
      return (range[0] + range[1]) / 2;
    }
    return 780;
  })();

  // Live derived readouts (mirror rayTrace.ts AOM branch). Sized for
  // wavelengthForAngleNm so the user sees the value at the AOM's rated
  // mid-band — the ray-tracer evaluates per actual emitted wavelength.
  const fHz = (params.centerFreqMhz ?? 80) * 1e6;
  const v = params.acousticVelocityMPerS ?? 4200;
  const n = params.refractiveIndex ?? 2.26;
  const lambdaM = wavelengthForAngleNm * 1e-9;
  const sinThetaB = (lambdaM * fHz) / (2 * n * v);
  const thetaBRad = Math.asin(Math.max(-1, Math.min(1, sinThetaB)));
  const thetaBMrad = thetaBRad * 1e3;
  let efficiencyEst = params.baseEfficiency ?? 0.85;
  if (
    typeof params.figureOfMeritM2 === "number" &&
    typeof params.rfDrivePowerW === "number" &&
    typeof params.crystalLengthMm === "number" &&
    typeof params.acousticBeamWidthMm === "number"
  ) {
    const L = params.crystalLengthMm * 1e-3;
    const W = params.acousticBeamWidthMm * 1e-3;
    const Pd = params.rfDrivePowerW;
    const inner = Math.sqrt((2 * params.figureOfMeritM2 * Pd) / W);
    const arg = (Math.PI * L / (2 * lambdaM * Math.cos(thetaBRad))) * inner;
    efficiencyEst = Math.min(1, Math.max(0, Math.sin(arg) ** 2));
  }

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
      : [0, 0, 1];
  const opticalCarrierThz = 299_792_458 / lambdaM / 1e12;
  const maxDiffractionOrder = Math.max(1, Math.min(10, Math.round(params.maxDiffractionOrder ?? 3)));
  const sidebandVisibilityThreshold = Math.max(0, Math.min(1, params.sidebandVisibilityThreshold ?? 0.01));
  // Phase-modulation depth v — same formula the ray-tracer's Raman-Nath
  // branch uses for |n| ≥ 2. Falls back to 2·√η when M2/L/W aren't all set.
  const phaseModDepth = (() => {
    if (
      typeof params.figureOfMeritM2 === "number" &&
      typeof params.rfDrivePowerW === "number" &&
      typeof params.crystalLengthMm === "number" &&
      typeof params.acousticBeamWidthMm === "number"
    ) {
      const L = params.crystalLengthMm * 1e-3;
      const W = params.acousticBeamWidthMm * 1e-3;
      const Pd = params.rfDrivePowerW;
      const inner = Math.sqrt((2 * params.figureOfMeritM2 * Pd) / W);
      return (Math.PI * L / (2 * lambdaM * Math.cos(thetaBRad))) * inner;
    }
    return 2 * Math.sqrt(Math.max(0, Math.min(1, efficiencyEst)));
  })();
  // Bessel J_n(x) series — must mirror rayTrace.ts so panel ↔ scene agree.
  const besselJ = (nn: number, x: number): number => {
    if (nn < 0) return ((-nn) % 2 === 0 ? 1 : -1) * besselJ(-nn, x);
    if (Math.abs(x) < 1e-12) return nn === 0 ? 1 : 0;
    let nFact = 1;
    for (let i = 2; i <= nn; i++) nFact *= i;
    const half = x / 2;
    let term = Math.pow(half, nn) / nFact;
    let sum = term;
    for (let k = 1; k < 100; k++) {
      term *= -(half * half) / (k * (nn + k));
      sum += term;
      if (Math.abs(term) < 1e-16) break;
    }
    return sum;
  };
  const selectedFirstOrderIntensity = currentOrder === 0 ? 0 : efficiencyEst;
  const suppressedFirstOrderIntensity = currentOrder === 0 ? 0 : 0.001;

  const fractionForOrder = (order: number): number => {
    if (currentOrder === 0) return order === 0 ? 1 : 0;
    if (order === currentOrder) return selectedFirstOrderIntensity;
    if (Math.abs(order) === 1) return suppressedFirstOrderIntensity;
    if (order === 0) return Number.NaN; // filled in below
    return besselJ(order, phaseModDepth) ** 2;
  };

  const orders: number[] = [];
  for (let n = -maxDiffractionOrder; n <= maxDiffractionOrder; n++) orders.push(n);

  let nonZeroSum = 0;
  const intensityByOrder = new Map<number, number>();
  for (const o of orders) {
    if (o === 0) continue;
    const f = fractionForOrder(o);
    intensityByOrder.set(o, f);
    nonZeroSum += f;
  }
  // Mirror the ray-tracer's normalisation so the panel table shows the
  // same numbers the scene actually emits.
  if (nonZeroSum > 1) {
    const scale = 1 / nonZeroSum;
    for (const [k, v] of intensityByOrder) intensityByOrder.set(k, v * scale);
    nonZeroSum = 1;
  }
  intensityByOrder.set(0, Math.max(0, 1 - nonZeroSum));
  const zerothIntensity = intensityByOrder.get(0)!;

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

  const flipRfDirection = () => {
    const flipped = rfDirectionLocal.map((v) => -v);
    void persist({
      rfPropagationDirectionBodyLocal: flipped,
      acousticAxisBodyLocal: flipped,
    });
  };

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
  // arg = (π·L / (2·λ·cosθ_B)) · √(2·M₂·P_d / W)  ⇒  P_d = W·cos²θ_B·λ² / (2·M₂·L²)
  const maximiseEfficiency = () => {
    if (
      typeof params.figureOfMeritM2 !== "number" ||
      typeof params.crystalLengthMm !== "number" ||
      typeof params.acousticBeamWidthMm !== "number"
    ) {
      // Without M₂ / L / W, the sin² model isn't usable — fall back to
      // pegging baseEfficiency at 0.99.
      void persist({ baseEfficiency: 0.99 });
      return;
    }
    const L = params.crystalLengthMm * 1e-3;
    const W = params.acousticBeamWidthMm * 1e-3;
    const cos2 = Math.cos(thetaBRad) ** 2;
    const lambda2 = lambdaM * lambdaM;
    const Pd = (W * cos2 * lambda2) / (2 * params.figureOfMeritM2 * L * L);
    void persist({ rfDrivePowerW: Math.min(rfMax, Math.max(0, Pd)) });
  };

  // Align the AOM body so the input aperture ends up on the closest
  // forward-incoming beam axis (within INPUT_ALIGN_TOLERANCE_MM). This
  // is bidirectional — we anchor the BBOX face perpendicular to the
  // current local +X (and try both ±X faces); pick whichever is closer
  // to a candidate beam, then translate the AOM so that face centre
  // lies exactly on that beam's infinite line. Rotation unchanged.
  const [alignBusy, setAlignBusy] = useState(false);
  const [alignFeedback, setAlignFeedback] = useState<string | null>(null);

  const alignToLaser = async () => {
    setAlignBusy(true);
    setAlignFeedback(null);
    try {
      // 1. Compute every face centre (±X / ±Y / ±Z) of the AOM wrapper in
      //    lab via its world-bbox, then convert the wrapper-local centres
      //    to lab via the SceneObject Euler. Each face also carries the
      //    BODY axis (three.js local) along which the beam should travel
      //    after entering through it — this is what gets aligned to the
      //    (Bragg-tilted) beam direction.
      type CandidateFace = {
        label: string;
        wrapper: { x: number; y: number; z: number };
        bodyAxisThree: THREE.Vector3;
      };
      let candidateFaces: CandidateFace[] = [];
      if (typeof window !== "undefined") {
        const root = (window as unknown as { __beamGroup?: THREE.Group }).__beamGroup?.parent;
        if (root) {
          let wrapper: THREE.Object3D | null = null;
          root.traverse((nNode) => {
            if (
              !wrapper &&
              nNode.userData?.objectId === sceneObject.id &&
              nNode.children.length > 0 &&
              !(nNode as THREE.Mesh).isMesh
            ) {
              wrapper = nNode;
            }
          });
          if (wrapper) {
            (wrapper as THREE.Object3D).updateMatrixWorld(true);
            const wrapperWorldInv = new THREE.Matrix4().copy(
              (wrapper as THREE.Object3D).matrixWorld,
            ).invert();
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
              const cx = (localBox.min.x + localBox.max.x) / 2;
              const cy = (localBox.min.y + localBox.max.y) / 2;
              const cz = (localBox.min.z + localBox.max.z) / 2;
              // Six candidate input/output faces — historically the code only
              // tried ±X, which broke for AOM GLBs that drill the optical hole
              // along a different body axis (e.g., the user's MT80 which has
              // the hole along body +Y). Considering all six faces lets the
              // align find whichever face the beam actually goes through.
              candidateFaces = [
                { label: "-X", wrapper: { x: localBox.min.x, y: cy, z: cz }, bodyAxisThree: new THREE.Vector3(1, 0, 0) },
                { label: "+X", wrapper: { x: localBox.max.x, y: cy, z: cz }, bodyAxisThree: new THREE.Vector3(-1, 0, 0) },
                { label: "-Y", wrapper: { x: cx, y: localBox.min.y, z: cz }, bodyAxisThree: new THREE.Vector3(0, 1, 0) },
                { label: "+Y", wrapper: { x: cx, y: localBox.max.y, z: cz }, bodyAxisThree: new THREE.Vector3(0, -1, 0) },
                { label: "-Z", wrapper: { x: cx, y: cy, z: localBox.min.z }, bodyAxisThree: new THREE.Vector3(0, 0, 1) },
                { label: "+Z", wrapper: { x: cx, y: cy, z: localBox.max.z }, bodyAxisThree: new THREE.Vector3(0, 0, -1) },
              ];
            }
          }
        }
      }
      if (!candidateFaces.length) {
        setAlignFeedback("AOM mesh not found — wait for the scene to finish loading.");
        return;
      }

      // 2. Map wrapper-local (three Y-up) → lab (mm) using SceneObject Euler.
      //    Same Rz · Rx · Ry sequence as transformUtils + beamPlacement.
      const rx = (sceneObject.rxDeg * Math.PI) / 180;
      const ry = (sceneObject.ryDeg * Math.PI) / 180;
      const rz = (sceneObject.rzDeg * Math.PI) / 180;
      const cyR = Math.cos(ry), syR = Math.sin(ry);
      const cxR = Math.cos(rx), sxR = Math.sin(rx);
      const czR = Math.cos(rz), szR = Math.sin(rz);
      const wrapperLocalToLab = (p: { x: number; y: number; z: number }) => {
        const apLab = threeToLabPointMm(p);
        const [bx, by, bz] = [apLab.x, apLab.y, apLab.z];
        const x1 = bx * cyR + bz * syR;
        const y1 = by;
        const z1 = -bx * syR + bz * cyR;
        const x2 = x1;
        const y2 = y1 * cxR - z1 * sxR;
        const z2 = y1 * sxR + z1 * cxR;
        const wx = x2 * czR - y2 * szR;
        const wy = x2 * szR + y2 * czR;
        const wz = z2;
        return {
          x: sceneObject.xMm + wx,
          y: sceneObject.yMm + wy,
          z: sceneObject.zMm + wz,
        };
      };
      const facesLab = candidateFaces.map((f) => ({
        ...f,
        lab: wrapperLocalToLab(f.wrapper),
      }));

      // 3. Walk live ray-trace segments. For each face/beam pair compute
      //    perpendicular miss distance; pick the (face, segment) pair
      //    with the smallest miss inside tolerance.
      type TraceSeg = {
        sourceObjectId: string;
        startThree: { x: number; y: number; z: number };
        endThree: { x: number; y: number; z: number };
      };
      const traces: TraceSeg[] = (typeof window !== "undefined"
        ? (window as unknown as { __rayTraceDebug?: TraceSeg[] }).__rayTraceDebug
        : undefined) ?? [];
      const threeToLab = threeToLabPointMm;
      type Match = {
        face: string;
        bodyAxisThree: THREE.Vector3;
        faceWrapper: { x: number; y: number; z: number };
        faceLab: { x: number; y: number; z: number };
        closest: { x: number; y: number; z: number };
        dir: { x: number; y: number; z: number };
        miss: number;
        sourceId: string;
      };
      const ALIGN_TOLERANCE_MM = 25;
      let best: Match | null = null;
      for (const seg of traces) {
        // The AOM's own emissions (zeroth + ±1st) are tagged with
        // sourceObjectId === sceneObject.id; skip them so the AOM
        // doesn't try to align to its own outgoing rays.
        if (seg.sourceObjectId === sceneObject.id) continue;
        const a = threeToLab(seg.startThree);
        const b = threeToLab(seg.endThree);
        const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
        const lenSq = ab.x ** 2 + ab.y ** 2 + ab.z ** 2;
        if (lenSq < 1e-6) continue;
        const segLen = Math.sqrt(lenSq);
        const dir = { x: ab.x / segLen, y: ab.y / segLen, z: ab.z / segLen };
        for (const cf of facesLab) {
          const toFace = {
            x: cf.lab.x - a.x, y: cf.lab.y - a.y, z: cf.lab.z - a.z,
          };
          const t = toFace.x * dir.x + toFace.y * dir.y + toFace.z * dir.z;
          // Forward-incoming = beam reaches the face (t ≥ 0).
          if (t < 0) continue;
          const closest = {
            x: a.x + dir.x * t,
            y: a.y + dir.y * t,
            z: a.z + dir.z * t,
          };
          const miss = Math.hypot(
            cf.lab.x - closest.x,
            cf.lab.y - closest.y,
            cf.lab.z - closest.z,
          );
          if (miss > ALIGN_TOLERANCE_MM) continue;
          if (!best || miss < best.miss) {
            best = {
              face: cf.label,
              bodyAxisThree: cf.bodyAxisThree,
              faceWrapper: cf.wrapper,
              faceLab: cf.lab,
              closest,
              dir,
              miss,
              sourceId: seg.sourceObjectId,
            };
          }
        }
      }
      if (!best) {
        setAlignFeedback(
          `No upstream beam within ${ALIGN_TOLERANCE_MM} mm of any AOM face. ` +
          "Rotate the AOM so its body axis points along the desired beam first.",
        );
        return;
      }

      // 1-D align: only the user-chosen axis (rx OR ry) is changed; the
      // other two Euler components are LEFT ALONE. This mirrors a real
      // tip-tilt mount where one knob moves at a time and the rest of
      // the AOM orientation stays where the user put it. Bragg condition
      //
      //     dir · acoustic_world = orderSign · sin(θ_B)
      //
      // is a single equation, so a single rotation DoF is sufficient.
      // Brute-force scan the chosen Euler component over the full circle
      // and pick the value that minimises |actual − expected|. Resolution
      // 0.005° (~0.087 mrad) — much finer than the typical 1–2 mrad
      // angular acceptance, so we land essentially on Bragg.
      // 1-D align around an ARBITRARY user-chosen tilt axis. The tilt
      // axis sits in the scene Y-Z plane (perpendicular to the
      // canonical scene+X beam direction), parametrised by a single
      // continuous angle:
      //   r = 0°   → axis = scene+Z → fan in scene XY (horizontal)
      //   r = 90°  → axis = scene+Y → fan in scene XZ (vertical)
      // Bragg condition (dir·acoustic = sign·sinθ_B) is one equation,
      // so a single rotation amount around any non-degenerate axis
      // suffices. Apply it as a quaternion delta on top of the current
      // orientation — keeps the user's pre-existing pose intact aside
      // from the necessary tilt.
      const tiltAngleRad = THREE.MathUtils.degToRad(braggTiltAxisAngleDeg);
      // scene(0, sin(r), cos(r)) → three(0, cos(r), -sin(r))
      const tiltAxisThree = new THREE.Vector3(
        0,
        Math.cos(tiltAngleRad),
        -Math.sin(tiltAngleRad),
      ).normalize();

      const acousticThreeLocal = bodyLocalDirToThree({
        x: rfDirectionLocal[0],
        y: rfDirectionLocal[1],
        z: rfDirectionLocal[2],
      });
      const expectedDot = currentOrder * Math.sin(thetaBRad);
      const dirThree = labDirToThree(best.dir).normalize();

      const startEuler = new THREE.Euler(
        THREE.MathUtils.degToRad(sceneObject.rxDeg),
        THREE.MathUtils.degToRad(sceneObject.rzDeg),
        THREE.MathUtils.degToRad(-sceneObject.ryDeg),
        "YXZ",
      );
      const startQuat = new THREE.Quaternion().setFromEuler(startEuler);

      const computeMismatchForOmega = (omegaDeg: number) => {
        const dq = new THREE.Quaternion().setFromAxisAngle(
          tiltAxisThree,
          THREE.MathUtils.degToRad(omegaDeg),
        );
        const testQuat = dq.clone().multiply(startQuat);
        const testEuler = new THREE.Euler().setFromQuaternion(testQuat, "YXZ");
        const aWorld = acousticThreeLocal.clone().applyEuler(testEuler).normalize();
        const dot = THREE.MathUtils.clamp(dirThree.dot(aWorld), -1, 1);
        return Math.asin(dot) - expectedDot;
      };

      // Coarse scan (1°) then fine refine (0.005°) around the winner.
      let bestOmega = 0;
      let bestAbsMis = Math.abs(computeMismatchForOmega(0));
      for (let coarse = -180; coarse <= 180; coarse += 1) {
        const m = Math.abs(computeMismatchForOmega(coarse));
        if (m < bestAbsMis) { bestAbsMis = m; bestOmega = coarse; }
      }
      bestAbsMis = Infinity;
      for (let fine = bestOmega - 1; fine <= bestOmega + 1; fine += 0.005) {
        const m = Math.abs(computeMismatchForOmega(fine));
        if (m < bestAbsMis) { bestAbsMis = m; bestOmega = fine; }
      }

      const finalDeltaQuat = new THREE.Quaternion().setFromAxisAngle(
        tiltAxisThree,
        THREE.MathUtils.degToRad(bestOmega),
      );
      const finalQuat = finalDeltaQuat.multiply(startQuat);
      const finalEuler = new THREE.Euler().setFromQuaternion(finalQuat, "YXZ");
      const nextRxDeg = THREE.MathUtils.radToDeg(finalEuler.x);
      const nextRzDeg = THREE.MathUtils.radToDeg(finalEuler.y);
      const nextRyDeg = -THREE.MathUtils.radToDeg(finalEuler.z);

      const wrapperLocalToLabWithPose = (
        p: { x: number; y: number; z: number },
        rxDeg: number,
        ryDeg: number,
        rzDeg: number,
      ) => {
        const rx2 = (rxDeg * Math.PI) / 180;
        const ry2 = (ryDeg * Math.PI) / 180;
        const rz2 = (rzDeg * Math.PI) / 180;
        const cy2 = Math.cos(ry2), sy2 = Math.sin(ry2);
        const cx2 = Math.cos(rx2), sx2 = Math.sin(rx2);
        const cz2 = Math.cos(rz2), sz2 = Math.sin(rz2);
        const apLab = threeToLabPointMm(p);
        const [bx, by, bz] = [apLab.x, apLab.y, apLab.z];
        const x1 = bx * cy2 + bz * sy2;
        const y1 = by;
        const z1 = -bx * sy2 + bz * cy2;
        const x2 = x1;
        const y2 = y1 * cx2 - z1 * sx2;
        const z2 = y1 * sx2 + z1 * cx2;
        const wx = x2 * cz2 - y2 * sz2;
        const wy = x2 * sz2 + y2 * cz2;
        const wz = z2;
        return {
          x: sceneObject.xMm + wx,
          y: sceneObject.yMm + wy,
          z: sceneObject.zMm + wz,
        };
      };
      const rotatedFaceLab = wrapperLocalToLabWithPose(
        best.faceWrapper,
        nextRxDeg,
        nextRyDeg,
        nextRzDeg,
      );
      const fromLine = {
        x: rotatedFaceLab.x - best.closest.x,
        y: rotatedFaceLab.y - best.closest.y,
        z: rotatedFaceLab.z - best.closest.z,
      };
      const tAfter = fromLine.x * best.dir.x + fromLine.y * best.dir.y + fromLine.z * best.dir.z;
      const closestAfter = {
        x: best.closest.x + best.dir.x * tAfter,
        y: best.closest.y + best.dir.y * tAfter,
        z: best.closest.z + best.dir.z * tAfter,
      };
      const delta = {
        x: closestAfter.x - rotatedFaceLab.x,
        y: closestAfter.y - rotatedFaceLab.y,
        z: closestAfter.z - rotatedFaceLab.z,
      };
      await updateSceneObject(sceneObject.id, {
        xMm: sceneObject.xMm + delta.x,
        yMm: sceneObject.yMm + delta.y,
        zMm: sceneObject.zMm + delta.z,
        rxDeg: nextRxDeg,
        ryDeg: nextRyDeg,
        rzDeg: nextRzDeg,
      });
      const sourceName =
        scene.objects.find((o) => o.id === best!.sourceId)?.name ??
        best.sourceId.slice(0, 6);
      setAlignFeedback(
        `${best.face} face aligned to ${sourceName} beam; ` +
        `body rotated ${bestOmega.toFixed(3)}° about tilt axis @ r=${braggTiltAxisAngleDeg.toFixed(0)}° ` +
        `for ${currentOrder === 0 ? "0th" : currentOrder > 0 ? "+1" : "-1"} Bragg ` +
        `(residual mismatch ${(bestAbsMis * 1e3).toFixed(3)} mrad; face miss was ${best.miss.toFixed(2)} mm).`,
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
      <div className="mirror-adjust-row">
        <span style={{ alignSelf: "center", fontSize: 12, opacity: 0.8 }}>
          RF k local: [{rfDirectionLocal.map((v) => v.toFixed(0)).join(", ")}]
        </span>
        <button
          type="button"
          className="secondary-button"
          onClick={flipRfDirection}
          title="Flip the local RF/acoustic wavevector. This swaps the physical side where +1 and -1 diffract."
        >
          Flip RF
        </button>
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
      <div className="mirror-adjust-row">
        <label className="mirror-adjust-field" style={{ flex: 1 }}>
          <span>Bragg tilt axis r (°): 0=Z (XY fan) · 90=Y (XZ fan)</span>
          <input
            type="number"
            step={1}
            value={braggTiltAxisAngleDeg.toFixed(1)}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v)) return;
              void persist({ braggTiltAxisDegLab: v });
            }}
          />
        </label>
        {[
          { label: "Z (0°)", val: 0, hint: "Tilt axis = scene +Z. Bragg fan in scene XY plane (horizontal)." },
          { label: "Y (90°)", val: 90, hint: "Tilt axis = scene +Y. Bragg fan in scene XZ plane (vertical)." },
        ].map((preset) => (
          <button
            key={preset.label}
            type="button"
            className={Math.abs(((braggTiltAxisAngleDeg % 360) + 360) % 360 - preset.val) < 0.01
              ? "primary-button" : "secondary-button"}
            onClick={() => void persist({ braggTiltAxisDegLab: preset.val })}
            title={preset.hint}
            style={{ minWidth: 64 }}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="primary-button"
        onClick={() => void alignToLaser()}
        disabled={alignBusy}
        title="Translate the chosen AOM face onto the closest upstream beam, then rotate the body around the user-chosen tilt axis (1-D scan) so dir·acoustic = orderSign·sin(θ_B)."
      >
        {alignBusy ? "Aligning…" : `Align AOM aperture + Bragg (r=${braggTiltAxisAngleDeg.toFixed(0)}°)`}
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
 *  gain_samples interpolation. Also exposes a one-shot "Apply BoosTA pro
 *  defaults" button that backfills the new aseSamples / gainSamples /
 *  backwardSpatialMode fields on legacy chip-TA records (which were
 *  created before those fields existed and would otherwise emit 0 mW
 *  in the bidirectional ray-tracer). */
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

const BOOSTA_PRO_DEFAULT_ASE: AseSampleRow[] = [
  { driveCurrentMa: 0,    forwardPowerMw: 0,   backwardPowerMw: 0 },
  { driveCurrentMa: 1000, forwardPowerMw: 5,   backwardPowerMw: 25 },
  { driveCurrentMa: 2400, forwardPowerMw: 80,  backwardPowerMw: 200 },
  { driveCurrentMa: 5000, forwardPowerMw: 250, backwardPowerMw: 500 },
];
const BOOSTA_PRO_DEFAULT_GAIN: GainSampleRow[] = [
  { inputPowerMw: 0,  driveCurrentMa: 2400, forwardPowerMw: 80,   backwardPowerMw: 200 },
  { inputPowerMw: 5,  driveCurrentMa: 2400, forwardPowerMw: 1200, backwardPowerMw: 120 },
  { inputPowerMw: 10, driveCurrentMa: 2400, forwardPowerMw: 1800, backwardPowerMw: 80 },
  { inputPowerMw: 20, driveCurrentMa: 2400, forwardPowerMw: 2500, backwardPowerMw: 50 },
  { inputPowerMw: 40, driveCurrentMa: 2400, forwardPowerMw: 3000, backwardPowerMw: 35 },
];

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

  const applyBoostaProDefaults = () => {
    void persist({
      centerWavelengthNm: params.centerWavelengthNm ?? 852,
      driveCurrentMa: 2400,
      driveCurrentMaxMa: 5000,
      aseSamples: BOOSTA_PRO_DEFAULT_ASE,
      gainSamples: BOOSTA_PRO_DEFAULT_GAIN,
      backwardSpatialModeX: { waistUm: 600, waistZOffsetMm: 0, mSquared: 1.5 },
      backwardSpatialModeY: { waistUm: 600, waistZOffsetMm: 0, mSquared: 1.5 },
    });
  };

  const needsBackfill = !params.aseSamples || params.aseSamples.length === 0;

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
        {needsBackfill && (
          <>
            <br />⚠ This TA's kindParams predate the bidirectional model — its
            ASE samples are empty so both beams emit 0 mW. Click below to
            populate BoosTA pro defaults.
          </>
        )}
      </p>
      <button
        type="button"
        className="primary-button"
        onClick={() => void alignInputToLaser()}
        title="Translate the TA so its INPUT +X centerline coincides with a beam within 25 mm; rotation is unchanged."
      >
        Align INPUT to laser beam
      </button>
      <button
        type="button"
        className="primary-button"
        onClick={applyBoostaProDefaults}
      >
        Apply BoosTA pro defaults (ASE + gain table + bwd profile)
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
