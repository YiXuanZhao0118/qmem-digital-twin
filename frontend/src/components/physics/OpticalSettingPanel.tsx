import { Sparkles } from "lucide-react";
import { Component, useMemo, useState, type ReactNode } from "react";

import { useSceneStore } from "../../store/sceneStore";
import type {
  Asset3D,
  ComponentItem,
  ElementKind,
  PhysicsElement,
  SceneObject,
} from "../../types/digitalTwin";
import {
  KIND_LABELS,
  kindIdToElementKind,
  domainForElementKind,
} from "../../utils/elementDefaults";
import {
  resolveBindingTree,
  type ResolvedBindingNode,
} from "../../utils/componentBindings";
import { BindingCoefficientOverrides, isEditableValue } from "./ObjectCoefficientOverrides";
import { BindingTreeAdjustControls } from "../BindingTreeAdjustControls";
import { IntrinsicSpecPanel } from "../IntrinsicSpecPanel";
import { AlignToBeamSection, SectionCard } from "./_shared";

/** Optical kinds whose dedicated controls (dispatched by AlignToBeamSection)
 *  own their per-instance editing — they handle nested params (laser spectrum /
 *  polarization, fiber endpoints, TA line shape) the generic coefficient editor
 *  can't reach, so the generic per-binding editor is skipped for them. Every
 *  OTHER optical kind uses the generic per-instance coefficient editor
 *  (paramOverrides[bindingId] → the path the v3 anchor loader merges per slot). */
const KINDS_WITHOUT_GENERIC_COEFFICIENTS: ReadonlySet<ElementKind> = new Set([
  "laser_source",
  "tapered_amplifier",
  "fiber",
]);

type CompositeKind = {
  /** Slot binding_id (= ComponentBinding.role || id) — MUST match the key the
   *  backend anchor loader uses to look up param_overrides for this slot. */
  bindingKey: string;
  label: string;
  asset: Asset3D;
  /** Mapped optical ElementKind, or null when the asset's kindId has no
   *  registered plugin (e.g. faraday_rotator). */
  elementKind: ElementKind | null;
  /** Human label for the kind (KIND_LABELS entry, or humanised kindId). */
  kindLabel: string;
};

/** Walk a component's resolved binding tree and collect every optical asset
 *  slot as an independently-editable kind. Works for single optics (one root
 *  asset → one entry) AND composites (e.g. the isolator: front Glan + back
 *  Glan → multiple entries). */
function collectOpticalBindingKinds(
  component: ComponentItem,
  sceneObject: SceneObject,
  scene: Parameters<typeof resolveBindingTree>[2],
): CompositeKind[] {
  const out: CompositeKind[] = [];
  const seen = new Set<string>();
  const walk = (nodes: ResolvedBindingNode[]) => {
    for (const node of nodes) {
      if (node.target.kind === "asset") {
        const asset = node.target.asset;
        const ek = asset.kindId ? kindIdToElementKind(asset.kindId) : null;
        // Optical asset slot = optical domain AND (a mapped kind — its plugin
        // supplies the param fields — OR an unmapped kind that carries its own
        // editable defaultParams, e.g. faraday_rotator). Drops structural
        // housing pieces that have no editable params.
        const assetHasParams = Object.values(
          (asset.defaultParams ?? {}) as Record<string, unknown>,
        ).some(isEditableValue);
        if (domainForElementKind(ek) === "optical" && (ek != null || assetHasParams)) {
          const bindingKey = node.binding.role || node.binding.id;
          if (!seen.has(bindingKey)) {
            seen.add(bindingKey);
            const roleLabel = (node.binding.properties as { role_label?: unknown } | null)
              ?.role_label;
            const label =
              (typeof roleLabel === "string" && roleLabel) ||
              node.binding.role ||
              asset.name ||
              "Element";
            const kindLabel = ek
              ? KIND_LABELS[ek]
              : (asset.kindId ?? "Element")
                  .replace(/_/g, " ")
                  .replace(/^\w/, (c) => c.toUpperCase());
            out.push({ bindingKey, label, asset, elementKind: ek, kindLabel });
          }
        }
      }
      walk(node.children);
    }
  };
  walk(resolveBindingTree(component, sceneObject, scene));
  return out;
}

type Props = {
  component: ComponentItem;
  /** The specific scene-object instance whose optical params are being
   *  edited. When omitted, the panel renders the auto-register/empty hints. */
  sceneObject?: SceneObject;
};

function findElementForObject(elements: PhysicsElement[], objectId: string): PhysicsElement | undefined {
  return elements.find((item) => item.objectId === objectId);
}

/**
 * Standalone "Optical setting" page — the single home for an optic's intrinsic
 * spec + per-instance coefficients. Reached by clicking an optic in the 3D
 * scene (OpticalLinkViewerPanel's drawer). Deliberately NOT embedded in the
 * Object panel: keeping physics in one place removes the two-panel editing
 * "death loop" the Object panel + drawer used to create.
 */
export function OpticalSettingPanel({ component, sceneObject }: Props) {
  const scene = useSceneStore((state) => state.scene);
  const physicsElements = scene.physicsElements;
  const autoRegisterOptical = useSceneStore((state) => state.autoRegisterOptical);

  const existing = sceneObject
    ? findElementForObject(physicsElements, sceneObject.id)
    : undefined;
  const mappedKind = component.kindId != null ? kindIdToElementKind(component.kindId) : null;

  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  // Every optical asset slot (single optic = 1, composite = N), minus the kinds
  // whose dedicated controls own their params. Each becomes a coefficient block
  // writing SceneObject.paramOverrides[bindingKey].
  const coeffKinds = useMemo(() => {
    if (!sceneObject) return [] as CompositeKind[];
    return collectOpticalBindingKinds(component, sceneObject, scene).filter(
      (k) => !(k.elementKind && KINDS_WITHOUT_GENERIC_COEFFICIENTS.has(k.elementKind)),
    );
  }, [component, sceneObject, scene]);

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

  // Optical-ness derives from the KIND (not the stored physicsCapabilities,
  // which no longer determines domain — 2026-06-10). True when: the
  // component's own kind is optical (single optic like a mirror), OR any
  // bound asset is optical (composite like the isolator, kindId="none").
  const isOptical = useMemo(() => {
    if (mappedKind != null && domainForElementKind(mappedKind) === "optical") return true;
    return (scene.componentBindings ?? []).some((b) => {
      if (b.componentId !== component.id || b.targetKind !== "asset" || !b.asset3dId) return false;
      const a = scene.assets.find((x) => x.id === b.asset3dId);
      const ek = a?.kindId ? kindIdToElementKind(a.kindId) : null;
      return ek != null && domainForElementKind(ek) === "optical";
    });
  }, [component, mappedKind, scene.componentBindings, scene.assets]);

  return (
    <div className="physics-inspector">
      {sceneObject && <IntrinsicSpecPanel component={component} sceneObject={sceneObject} />}

      {!existing && mappedKind && (
        <div className="physics-auto-register">
          <div className="physics-auto-register-text">
            <strong>Not yet registered.</strong>
            <span>
              Component type <code>{component.kindId}</code> maps to{" "}
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

      {/* Dedicated kind controls (laser / TA full editors; mirror pose nudge).
          Only render when a top-level PhysicsElement exists (single optics);
          composites carry no top-level element and edit via the per-slot
          coefficient blocks + binding-tree adjustments below. */}
      {existing && sceneObject && (
        <AdjustErrorBoundary key={sceneObject.id}>
          <AlignToBeamSection
            sceneObject={sceneObject}
            elementKind={existing.elementKind as ElementKind}
            element={existing}
          />
        </AdjustErrorBoundary>
      )}

      {/* Per-instance coefficients. One block for a single optic; for a
          composite (isolator) one card per contained optical asset kind. Writes
          SceneObject.paramOverrides[bindingKey] — the path the anchor loader
          merges into each slot, so every element's coefficients reach the
          trace independently. */}
      {sceneObject && coeffKinds.length === 1 && (
        <div className="physics-panel-kind-params" style={{ marginTop: 6 }}>
          <div className="physics-panel-kind-params-header">Per-instance coefficients</div>
          <BindingCoefficientOverrides
            sceneObject={sceneObject}
            asset={coeffKinds[0].asset}
            bindingKey={coeffKinds[0].bindingKey}
            elementKind={coeffKinds[0].elementKind}
          />
          <p className="mirror-adjust-hint">
            Overrides apply only to this instance and revert to the asset default
            on reset.
          </p>
        </div>
      )}

      {sceneObject && coeffKinds.length > 1 && (
        <div className="physics-panel-kind-params" style={{ marginTop: 6 }}>
          <div className="physics-panel-kind-params-header">Optical elements</div>
          {coeffKinds.map((k) => (
            <SectionCard
              key={k.bindingKey}
              id={`optical.composite.${k.bindingKey}`}
              title={`${k.label} — ${k.kindLabel}`}
            >
              <BindingCoefficientOverrides
                sceneObject={sceneObject}
                asset={k.asset}
                bindingKey={k.bindingKey}
                elementKind={k.elementKind}
              />
            </SectionCard>
          ))}
        </div>
      )}

      {/* Geometric "optical setting" — per-instance binding-tree adjustments
          (composite front/back polariser Rz, see-through). Self-gates (returns
          null when there are no tunable binding axes), so this is a no-op for
          plain single optics. */}
      {isOptical && <BindingTreeAdjustControls component={component} />}
    </div>
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
