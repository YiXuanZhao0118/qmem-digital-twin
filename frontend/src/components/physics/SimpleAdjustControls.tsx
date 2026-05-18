/**
 * Per-kind "Adjust" controls — split out of PhysicsElementPanel.tsx
 * (god-file) so the simple beam-aligned editors live in their own
 * 700-line file instead of buried inside a 3641-line panel.
 *
 * The 4 controls here share a similar shape:
 *   - read the SceneObject and the matching beam axis
 *   - mutate kindParams or scene-object transform on blur / Enter
 *   - render a small set of number inputs
 *
 * The 3 bigger controls (LaserSource, Aom, TaperedAmplifier) stay in
 * PhysicsElementPanel.tsx for now — they have richer hook usage and
 * tighter coupling to internal helpers; separate extraction passes.
 */
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";

import { useSceneStore } from "../../store/sceneStore";
import type { PhysicsElement, SceneObject } from "../../types/digitalTwin";
import {
  findSnapToBeam,
  perpendicularBasis,
} from "../../utils/beamPlacement";
import { labDirToThree } from "../../optical/frames";

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
export function WaveplateAdjustControls({
  sceneObject,
  element,
}: {
  sceneObject: SceneObject;
  element: PhysicsElement;
}) {
  const scene = useSceneStore((state) => state.scene);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);

  const candidate = useMemo(
    () => findSnapToBeam(sceneObject.id, scene),
    [scene, sceneObject.id],
  );

  type WaveplateKindParams = {
    retardanceLambda?: number;
    transmission?: number;
    groupDelayPs?: number;
    gvdFs2?: number;
  };

  const params = (element.kindParams ?? {}) as WaveplateKindParams;

  // ---- field readers (with V2 default fallbacks) --------------------------
  // Per-instance rotation around the beam axis (asset-level fast-axis lives
  // on Asset3D anchor.fastAxisDegBodyLocal, edited in PHY Editor). Effective
  // Jones-frame angle = asset value + this scalar.
  const sceneProps = (sceneObject.properties ?? {}) as Record<string, unknown>;
  const rotationAroundBeamDeg =
    typeof sceneProps.rotationAroundBeamAxisDeg === "number"
      ? sceneProps.rotationAroundBeamAxisDeg
      : 0;
  const retardance = params.retardanceLambda ?? 0.5;
  const transmission = params.transmission ?? 0.99;
  const groupDelayPs = params.groupDelayPs ?? 0;
  const gvdFs2 = params.gvdFs2 ?? 0;

  const platePreset: "HWP" | "QWP" | "custom" =
    Math.abs(retardance - 0.5) < 1e-6 ? "HWP"
    : Math.abs(retardance - 0.25) < 1e-6 ? "QWP"
    : "custom";

  // ---- writer: shallow-merge a patch into kindParams + persist ------------
  const persist = async (patch: Partial<WaveplateKindParams>) => {
    await upsertOpticalElement({
      objectId: sceneObject.id,
      elementKind: element.elementKind,
      kindParams: { ...params, ...patch },
      inputPorts: element.inputPorts,
      outputPorts: element.outputPorts,
    });
  };

  // Rotation-around-beam commit. The 3D mesh tracks the user's typed angle
  // by composing Δθ around `candidate.axisDirection` into the SceneObject
  // Euler; the scalar is persisted to SceneObject.properties so the optical
  // solver (asset.fastAxisDegBodyLocal + rotationAroundBeamAxisDeg) and
  // future renders read a consistent value. Snap-align is required for the
  // 3D mesh to update; the stored angle persists either way.
  const commitRotationAroundBeam = async (next: number) => {
    if (!Number.isFinite(next)) return;
    const delta = next - rotationAroundBeamDeg;
    if (Math.abs(delta) < 1e-6) return;

    const transformPatch: Partial<SceneObject> = {};
    if (candidate?.axisDirection) {
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
      transformPatch.rxDeg = THREE.MathUtils.radToDeg(newEuler.x);
      transformPatch.rzDeg = THREE.MathUtils.radToDeg(newEuler.y);
      transformPatch.ryDeg = -THREE.MathUtils.radToDeg(newEuler.z);
    }
    const newProps = { ...sceneProps, rotationAroundBeamAxisDeg: next };
    await updateSceneObject(sceneObject.id, {
      ...transformPatch,
      properties: newProps as SceneObject["properties"],
    });
  };

  // Numeric input cell that commits on blur / Enter (uncontrolled-ish).
  const NumberCell = ({
    label,
    value,
    step = 0.1,
    onCommit,
    suffix,
    style,
  }: {
    label: string;
    value: number;
    step?: number;
    onCommit: (v: number) => void;
    suffix?: string;
    style?: React.CSSProperties;
  }) => {
    const [draft, setDraft] = useState(value.toString());
    useEffect(() => setDraft(value.toString()), [value]);
    const commit = (raw: string) => {
      const v = Number(raw);
      if (!Number.isFinite(v)) return;
      onCommit(v);
    };
    return (
      <label className="component-editor-coord" style={style}>
        <span style={{ fontSize: 11 }}>{label}{suffix ? ` (${suffix})` : ""}</span>
        <input
          type="number"
          step={step}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit((e.target as HTMLInputElement).value);
            }
          }}
        />
      </label>
    );
  };

  // ---- handlers -----------------------------------------------------------
  const setPlatePreset = (next: "HWP" | "QWP" | "custom") => {
    if (next === "HWP") void persist({ retardanceLambda: 0.5 });
    else if (next === "QWP") void persist({ retardanceLambda: 0.25 });
    // "custom" leaves the existing retardance value unchanged so the user
    // can type a new one in the input below.
  };

  // ---- shared section style (mirrors LaserSourceControls) -----------------
  const sectionStyle: React.CSSProperties = {
    marginTop: 8,
    padding: "6px 8px",
    background: "rgba(56, 189, 248, 0.06)",
    borderLeft: "2px solid #38bdf8",
    fontSize: 11,
  };
  const titleStyle: React.CSSProperties = { color: "#38bdf8", fontWeight: 600, marginBottom: 6 };
  const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 };

  return (
    <div className="snap-to-beam">
      {/* Plate type */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Plate type</div>
        <label className="component-editor-coord" style={{ marginBottom: 6 }}>
          <span style={{ fontSize: 11 }}>Preset</span>
          <select
            value={platePreset}
            onChange={(e) => setPlatePreset(e.target.value as "HWP" | "QWP" | "custom")}
          >
            <option value="HWP">HWP — λ/2 (linear rotates by 2×θ)</option>
            <option value="QWP">QWP — λ/4 (linear ↔ circular at ±45°)</option>
            <option value="custom">custom retardance</option>
          </select>
        </label>
        {platePreset === "custom" && (
          <NumberCell
            label="Retardance"
            suffix="λ"
            value={retardance}
            step={0.01}
            onCommit={(v) => v > 0 && void persist({ retardanceLambda: v })}
          />
        )}
      </div>

      {/* Rotation around beam axis — per-instance knob.
          Asset-level fast-axis angle (fastAxisDegBodyLocal) lives on the
          intercept_in anchor and is edited in PHY Editor → Optical →
          Components. */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Rotation around beam axis</div>
        <NumberCell
          label="Rotation"
          suffix="° CW"
          value={rotationAroundBeamDeg}
          step={1}
          onCommit={(v) => void commitRotationAroundBeam(v)}
        />
        {!candidate ? (
          <div style={{ opacity: 0.7, marginTop: 4, fontSize: 10 }}>
            ⚠ Snap-align to beam first so the rotation stays around the optical axis.
          </div>
        ) : (
          <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
            Asset fast-axis (PHY Editor) + this rotation = effective Jones-frame angle.
          </div>
        )}
      </div>

      {/* Throughput */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Throughput</div>
        <NumberCell
          label="Transmission"
          value={transmission}
          step={0.01}
          onCommit={(v) => v >= 0 && v <= 1 && void persist({ transmission: v })}
        />
      </div>

      {/* Dispersion (advanced) */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Dispersion</div>
        <div style={grid2}>
          <NumberCell
            label="Group delay"
            suffix="ps"
            value={groupDelayPs}
            step={0.01}
            onCommit={(v) => void persist({ groupDelayPs: v })}
          />
          <NumberCell
            label="GVD"
            suffix="fs²"
            value={gvdFs2}
            step={1}
            onCommit={(v) => void persist({ gvdFs2: v })}
          />
        </div>
      </div>
    </div>
  );
}

/** Beam-splitter / PBS controls. Mirrors the LaserSourceControls and
 *  WaveplateAdjustControls layout: section blocks with field-level commits
 *  to kindParams via upsertOpticalElement. Geometry (coating normal, PBS
 *  transmission axis) lives on V2 anchor bindings — these controls only
 *  cover the transfer-physics knobs (split ratio, polarising flag,
 *  extinction ratio, overall transmission). */
export function BeamSplitterControls({
  sceneObject,
  element,
}: {
  sceneObject: SceneObject;
  element: PhysicsElement;
}) {
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);

  type BeamSplitterKindParams = {
    splitRatioTransmitted?: number;
    polarizing?: boolean;
    extinctionRatioDb?: number;
    transmission?: number;
  };

  const params = (element.kindParams ?? {}) as BeamSplitterKindParams;

  const splitT = params.splitRatioTransmitted ?? 0.5;
  const polarizing = params.polarizing ?? false;
  const extinctionDb = params.extinctionRatioDb ?? 30.0;
  const transmission = params.transmission ?? 0.99;

  const persist = async (patch: Partial<BeamSplitterKindParams>) => {
    await upsertOpticalElement({
      objectId: sceneObject.id,
      elementKind: element.elementKind,
      kindParams: { ...params, ...patch },
      inputPorts: element.inputPorts,
      outputPorts: element.outputPorts,
    });
  };

  // Numeric input that commits on blur / Enter.
  const NumberCell = ({
    label,
    value,
    step = 0.01,
    onCommit,
    suffix,
    style,
  }: {
    label: string;
    value: number;
    step?: number;
    onCommit: (v: number) => void;
    suffix?: string;
    style?: React.CSSProperties;
  }) => {
    const [draft, setDraft] = useState(value.toString());
    useEffect(() => setDraft(value.toString()), [value]);
    const commit = (raw: string) => {
      const v = Number(raw);
      if (!Number.isFinite(v)) return;
      onCommit(v);
    };
    return (
      <label className="component-editor-coord" style={style}>
        <span style={{ fontSize: 11 }}>{label}{suffix ? ` (${suffix})` : ""}</span>
        <input
          type="number"
          step={step}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit((e.target as HTMLInputElement).value);
            }
          }}
        />
      </label>
    );
  };

  const sectionStyle: React.CSSProperties = {
    marginTop: 8,
    padding: "6px 8px",
    background: "rgba(56, 189, 248, 0.06)",
    borderLeft: "2px solid #38bdf8",
    fontSize: 11,
  };
  const titleStyle: React.CSSProperties = { color: "#38bdf8", fontWeight: 600, marginBottom: 6 };
  const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 };

  const reflected = Math.max(0, Math.min(1, 1 - splitT));

  return (
    <div className="snap-to-beam">
      {/* Splitter type */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Splitter type</div>
        <label className="component-editor-coord" style={{ marginBottom: 6 }}>
          <span style={{ fontSize: 11 }}>Mode</span>
          <select
            value={polarizing ? "PBS" : "BS"}
            onChange={(e) => void persist({ polarizing: e.target.value === "PBS" })}
          >
            <option value="BS">Non-polarising (BS) — split by amplitude</option>
            <option value="PBS">Polarising (PBS) — split by polarisation</option>
          </select>
        </label>
        <div style={{ opacity: 0.6, fontSize: 10 }}>
          {polarizing
            ? "Transmits p, reflects s (per V2 polarizationReference binding)."
            : "Splits both polarisations by the ratio below."}
        </div>
      </div>

      {/* Split ratio — non-polarising only. For PBS the split is dictated
          by the input polarisation (p transmits, s reflects), so the
          amplitude-ratio knob is hidden. */}
      {!polarizing && (
        <div style={sectionStyle}>
          <div style={titleStyle}>Split ratio</div>
          <div style={grid2}>
            <NumberCell
              label="Transmitted"
              value={splitT}
              step={0.01}
              onCommit={(v) => v >= 0 && v <= 1 && void persist({ splitRatioTransmitted: v })}
            />
            <label className="component-editor-coord">
              <span style={{ fontSize: 11 }}>Reflected (derived)</span>
              <input type="number" value={reflected.toFixed(3)} disabled readOnly />
            </label>
          </div>
          <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
            0 = full reflect · 0.5 = 50/50 · 1 = full transmit. Reflected is auto = 1 − T.
          </div>
        </div>
      )}

      {/* Polarising-only: extinction ratio */}
      {polarizing && (
        <div style={sectionStyle}>
          <div style={titleStyle}>Polarising extinction</div>
          <NumberCell
            label="Extinction ratio"
            suffix="dB"
            value={extinctionDb}
            step={1}
            onCommit={(v) => v >= 0 && void persist({ extinctionRatioDb: v })}
          />
          <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
            Power leakage of the rejected polarisation: 10^(−ER/10). 30 dB = 0.001.
          </div>
        </div>
      )}

      {/* Throughput */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Throughput</div>
        <NumberCell
          label="Transmission"
          value={transmission}
          step={0.01}
          onCommit={(v) => v >= 0 && v <= 1 && void persist({ transmission: v })}
        />
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
          Overall efficiency multiplier on top of the split ratio (coating losses, AR, etc.).
        </div>
      </div>
    </div>
  );
}

/** Lens controls — handles all 3 lens kinds (biconvex / plano-convex /
 *  cylindrical). Spherical lenses share `LensSphericalParams` (focal_mm,
 *  numerical_aperture, transmission, material, gvd_fs2); cylindrical
 *  lenses use `LensCylindricalParams` which swaps `numerical_aperture`
 *  for `cylindrical_axis` ("x" or "y"). The two are merged into one UI
 *  here, with the kind-specific field rendered conditionally. The
 *  per-object aperture (`clear_aperture_mm`) lives on the SceneObject
 *  (PerObjectApertureEditor) per V2 §3, so it is intentionally not
 *  surfaced here. */
export function LensControls({
  sceneObject,
  element,
}: {
  sceneObject: SceneObject;
  element: PhysicsElement;
}) {
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);

  type LensKindParams = {
    focalMm?: number;
    numericalAperture?: number | null;
    cylindricalAxis?: "x" | "y";
    transmission?: number;
    gvdFs2?: number;
    material?: string | null;
  };

  const params = (element.kindParams ?? {}) as LensKindParams;
  const isCylindrical = element.elementKind === "lens_cylindrical";
  const isPlanoConvex = element.elementKind === "lens_plano_convex";

  const focalMm = params.focalMm ?? 100;
  const na = typeof params.numericalAperture === "number" ? params.numericalAperture : 0.1;
  const cylAxis: "x" | "y" = params.cylindricalAxis === "y" ? "y" : "x";
  const transmission = params.transmission ?? 0.99;
  const gvdFs2 = params.gvdFs2 ?? 0;
  const material = params.material ?? "";

  const persist = async (patch: Partial<LensKindParams>) => {
    await upsertOpticalElement({
      objectId: sceneObject.id,
      elementKind: element.elementKind,
      kindParams: { ...params, ...patch },
      inputPorts: element.inputPorts,
      outputPorts: element.outputPorts,
    });
  };

  // Numeric input that commits on blur / Enter.
  const NumberCell = ({
    label,
    value,
    step = 0.1,
    onCommit,
    suffix,
    style,
  }: {
    label: string;
    value: number;
    step?: number;
    onCommit: (v: number) => void;
    suffix?: string;
    style?: React.CSSProperties;
  }) => {
    const [draft, setDraft] = useState(value.toString());
    useEffect(() => setDraft(value.toString()), [value]);
    const commit = (raw: string) => {
      const v = Number(raw);
      if (!Number.isFinite(v)) return;
      onCommit(v);
    };
    return (
      <label className="component-editor-coord" style={style}>
        <span style={{ fontSize: 11 }}>{label}{suffix ? ` (${suffix})` : ""}</span>
        <input
          type="number"
          step={step}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit((e.target as HTMLInputElement).value);
            }
          }}
        />
      </label>
    );
  };

  const sectionStyle: React.CSSProperties = {
    marginTop: 8,
    padding: "6px 8px",
    background: "rgba(56, 189, 248, 0.06)",
    borderLeft: "2px solid #38bdf8",
    fontSize: 11,
  };
  const titleStyle: React.CSSProperties = { color: "#38bdf8", fontWeight: 600, marginBottom: 6 };
  const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 };

  // Quick reference: f-number when both NA and focal length are known.
  const fNumber = na > 0 ? 1 / (2 * na) : null;

  return (
    <div className="snap-to-beam">
      {/* Optics */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Optics</div>
        <div style={grid2}>
          <NumberCell
            label="Focal length"
            suffix="mm"
            value={focalMm}
            step={1}
            onCommit={(v) => Math.abs(v) > 0 && void persist({ focalMm: v })}
          />
          {isCylindrical ? (
            <label className="component-editor-coord">
              <span style={{ fontSize: 11 }}>Cylindrical axis</span>
              <select
                value={cylAxis}
                onChange={(e) => void persist({ cylindricalAxis: e.target.value as "x" | "y" })}
              >
                <option value="x">x — focuses Y, leaves X collimated</option>
                <option value="y">y — focuses X, leaves Y collimated</option>
              </select>
            </label>
          ) : (
            <NumberCell
              label="Numerical aperture"
              value={na}
              step={0.01}
              onCommit={(v) => v >= 0 && void persist({ numericalAperture: v })}
            />
          )}
        </div>
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
          {isCylindrical
            ? "Cylindrical: power along one axis only — used for beam shaping or compensating astigmatism."
            : isPlanoConvex
              ? "Plano-convex: one flat, one curved surface. Aperture lives on the SceneObject."
              : "Biconvex: both surfaces curved."}
          {!isCylindrical && fNumber !== null
            ? ` · f/# ≈ ${fNumber.toFixed(2)}`
            : ""}
        </div>
      </div>

      {/* Throughput / material */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Throughput</div>
        <NumberCell
          label="Transmission"
          value={transmission}
          step={0.01}
          onCommit={(v) => v >= 0 && v <= 1 && void persist({ transmission: v })}
        />
        <label className="component-editor-coord" style={{ marginTop: 6 }}>
          <span style={{ fontSize: 11 }}>Material</span>
          <select
            value={material}
            onChange={(e) => void persist({ material: e.target.value || null })}
          >
            <option value="">(unspecified)</option>
            <option value="BK7">N-BK7 — visible / NIR</option>
            <option value="fused_silica">Fused silica — UV / NIR / low GVD</option>
            <option value="CaF2">CaF₂ — UV–MIR</option>
            <option value="ZnSe">ZnSe — MIR / CO₂ optics</option>
            <option value="sapphire">Sapphire — UV–MIR, hard</option>
            <option value="custom">custom (set via JSON)</option>
          </select>
        </label>
      </div>

      {/* Dispersion */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Dispersion</div>
        <NumberCell
          label="GVD"
          suffix="fs²"
          value={gvdFs2}
          step={1}
          onCommit={(v) => void persist({ gvdFs2: v })}
        />
      </div>
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
