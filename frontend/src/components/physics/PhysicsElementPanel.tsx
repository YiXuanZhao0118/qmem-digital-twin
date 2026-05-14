import { Sparkles } from "lucide-react";
import * as THREE from "three";
import { Component, useEffect, useMemo, useState, type ReactNode } from "react";

import { useSceneStore } from "../../store/sceneStore";
import type { ComponentItem, ElementKind, PhysicsElement, SceneObject } from "../../types/digitalTwin";
import {
  DOMAIN_TITLES,
  KIND_LABELS,
  componentTypeToElementKind,
  domainForElementKind,
} from "../../utils/elementDefaults";
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
import {
  getEffectiveApertureMm,
  getPerObjectAperture,
  getRfDirectionBodyLocal,
  setPerObjectAperture,
  type V2Aperture,
} from "../../utils/v2Bindings";
import { resolveAomRfDriveFromScene } from "../../utils/aomRfDrive";
import {
  type EmissionKey,
  getEmissionVisual,
  setEmissionVisualPatch,
} from "../../utils/emissionVisuals";
import { wavelengthToColor } from "../../three/opticalBeams";
// Split-out adjust controls — 4 small panels moved into a sibling
// file so the LaserSource / Aom / TaperedAmplifier behemoths can be
// reviewed in isolation. No behavioural change, just file location.
import {
  MirrorAdjustControls,
  WaveplateAdjustControls,
  BeamSplitterControls,
  LensControls,
} from "./SimpleAdjustControls";
import { LaserSourceControls } from "./LaserSourceControls";
import { AomAdjustControls } from "./AomAdjustControls";
import { TaperedAmplifierAdjustControls } from "./TaperedAmplifierAdjustControls";
import { AlignToBeamSection } from "./_shared";

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

export function PhysicsElementPanel({ component, sceneObject }: Props) {
  const physicsElements = useSceneStore((state) => state.scene.physicsElements);
  const autoRegisterOptical = useSceneStore((state) => state.autoRegisterOptical);

  const existing = sceneObject
    ? findElementForObject(physicsElements, sceneObject.id)
    : undefined;
  const mappedKind = componentTypeToElementKind(component.componentType);

  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

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

  // Use the existing element's kind when registered; fall back to the
  // mapped kind for the not-yet-registered preview. Defaults to optical.
  const activeKind = (existing?.elementKind as ElementKind | undefined) ?? mappedKind ?? null;
  const domain = domainForElementKind(activeKind);
  const panelTitle = DOMAIN_TITLES[domain];

  return (
    <section className={`physics-panel physics-panel-${domain}`}>
      <header className="physics-panel-header">
        <h3>{panelTitle}</h3>
      </header>

      {!existing && mappedKind && (
        <div className="physics-auto-register">
          <div className="physics-auto-register-text">
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
            className="primary-button physics-auto-register-btn"
            onClick={onAutoRegister}
            disabled={busy}
          >
            <Sparkles size={14} />
            Auto-register as {KIND_LABELS[mappedKind]}
          </button>
        </div>
      )}

      {error ? <div className="physics-error">{error}</div> : null}

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

