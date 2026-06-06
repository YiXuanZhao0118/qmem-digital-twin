/**
 * Shared helper components used by multiple physics inspectors.
 * Split out of PhysicsElementPanel.tsx (god-file) so the main file
 * stays small (~120 lines of dispatcher).
 *
 *   - wavelengthHex          (number -> color hex via three.js)
 *   - EmissionVisualRow      (color picker + visibility toggle)
 *   - AlignToBeamSection     (snap-to-beam UI for any SceneObject)
 *
 * Consumed by PhysicsElementPanel + the inspectors that need them.
 */
import { type ReactNode } from "react";

import { CollapsibleSection } from "../CollapsibleSection";
import { useSceneStore } from "../../store/sceneStore";
import type {
  ElementKind,
  PhysicsElement,
  SceneObject,
} from "../../types/digitalTwin";
import {
  type EmissionKey,
  getEmissionVisual,
  setEmissionVisualPatch,
} from "../../utils/emissionVisuals";
import { wavelengthToColor } from "../../three/opticalBeams";

/**
 * Collapsible "card" for a physics-inspector section. Replaces the duplicated
 * inline `sectionStyle`/`titleStyle` blocks — same cyan-card look (via the
 * `.physics-section` CSS), but the body collapses and the open state persists
 * (CollapsibleSection's localStorage). `id` is namespaced per-kind by callers
 * (`physics.<kind>.<slug>`) so every instance of a kind opens the same way.
 */
export function SectionCard({
  id,
  title,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <CollapsibleSection id={id} title={title} defaultOpen={defaultOpen} className="physics-section">
      {children}
    </CollapsibleSection>
  );
}
// The kind-specific settings Controls live in sibling files;
// AlignToBeamSection dispatches into them based on element.elementKind.
// (Snap-to-beam align moved to the Object panel — ComponentPanel →
// AlignToBeamControls; this section is the per-kind PARAMETER editors only.)
import { LaserSourceControls } from "./LaserSourceControls";
import { TaperedAmplifierAdjustControls } from "./TaperedAmplifierAdjustControls";
import { MirrorAdjustControls } from "./SimpleAdjustControls";

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

export function AlignToBeamSection({
  sceneObject,
  elementKind,
  element,
}: {
  sceneObject: SceneObject;
  elementKind: ElementKind;
  element: PhysicsElement;
}) {
  if (elementKind === "tapered_amplifier") {
    return <TaperedAmplifierAdjustControls sceneObject={sceneObject} element={element} />;
  }
  if (elementKind === "laser_source") {
    return <LaserSourceControls sceneObject={sceneObject} element={element} />;
  }

  // Mirrors keep a dedicated control: it nudges the SceneObject POSE (transverse
  // shift on the face + rotation), which reaches the trace. The former
  // Waveplate / BeamSplitter / Lens dedicated editors were retired — they wrote
  // PhysicsElement.kindParams, which the v3 anchor tracer does NOT read (it
  // merges asset.default_params ⊕ dynamic_sources), so their edits never reached
  // the beam. Those kinds now use the generic per-instance coefficient editor
  // (BindingCoefficientOverrides → paramOverrides[bindingId]) like every other
  // passive optic.
  if (elementKind === "mirror" || elementKind === "dichroic_mirror") {
    return (
      <div className="snap-to-beam">
        <MirrorAdjustControls sceneObject={sceneObject} />
      </div>
    );
  }

  // aom / isolator / fiber / emitters / RF have no dedicated settings panel
  // here — the optical kinds get the generic coefficient editor from
  // OpticalSettingPanel.
  return null;
}
