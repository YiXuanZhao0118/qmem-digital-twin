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
import { isEditableValue } from "../../utils/paramLeaves";
import { InstanceDynamicSourcesEditor } from "./InstanceDynamicSourcesEditor";
import { BindingTreeAdjustControls } from "../BindingTreeAdjustControls";
import { IntrinsicSpecPanel } from "../IntrinsicSpecPanel";
import { AlignToBeamSection } from "./_shared";

type CompositeKind = {
  /** Slot binding_id (= ComponentBinding.role || id) — distinguishes a
   *  composite's sub-asset slots in the panel. Per-instance values live in the
   *  object-scoped dynamicSources, so this is display-only. */
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

  // Every optical asset slot (single optic = 1, composite = N) that exposes at
  // least one author-blessed tunable param. Each becomes a block of editable
  // runtime values writing SceneObject.dynamicSources. Assets with no tunable
  // params (most passive optics) drop out, so the section hides itself.
  const coeffKinds = useMemo(() => {
    if (!sceneObject) return [] as CompositeKind[];
    return collectOpticalBindingKinds(component, sceneObject, scene).filter(
      (k) => (k.asset.tunableParams?.length ?? 0) > 0,
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

      {/* Tunable parameters. Only the params the asset author marked tunable
          (Asset3D.tunableParams) appear here — e.g. a laser's power/wavelength.
          Values are per-instance and live in SceneObject.dynamicSources, which
          the anchor loader merges over the asset default_params at trace time.
          A composite shows a per-asset sub-label; a single optic renders the
          bare grid. Intrinsic optical coefficients are no longer editable here. */}
      {sceneObject && coeffKinds.length >= 1 && (
        <div className="physics-panel-kind-params" style={{ marginTop: 6 }}>
          <div className="physics-panel-kind-params-header">Tunable parameters</div>
          {coeffKinds.map((k) => (
            <div key={k.bindingKey} style={{ marginTop: coeffKinds.length > 1 ? 8 : 0 }}>
              {coeffKinds.length > 1 && (
                <div
                  className="physics-panel-kind-params-header"
                  style={{ fontSize: 11, opacity: 0.75, marginTop: 0 }}
                >
                  {k.label} — {k.kindLabel}
                </div>
              )}
              <InstanceDynamicSourcesEditor sceneObject={sceneObject} asset={k.asset} />
            </div>
          ))}
          <p className="mirror-adjust-hint">
            Values apply only to this instance and revert to the asset default on
            reset.
          </p>
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
