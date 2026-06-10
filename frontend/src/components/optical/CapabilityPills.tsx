import { useSceneStore } from "../../store/sceneStore";
import type { ComponentItem } from "../../types/digitalTwin";
import {
  DOMAIN_TITLES,
  domainForElementKind,
  kindIdToElementKind,
  type ElementDomain,
} from "../../utils/elementDefaults";

const DOMAIN_COLOR: Record<ElementDomain, string> = {
  optical: "#fbbf24",
  rf: "#34d399",
};

type Props = {
  component: ComponentItem;
};

/**
 * Read-only **domain** readout for a component.
 *
 * Was the editable `physicsCapabilities` picker before 2026-06-10. Domain is
 * now asset-kind-authoritative — it is derived from the component's bound
 * assets' kinds (`Asset3D.kind_id` → `domainForElementKind`), matching the
 * domain rails elsewhere. `physicsCapabilities` no longer determines domain,
 * so this is display-only. Empty (no optical/rf bound asset) ⇒ mechanical.
 */
export function CapabilityPills({ component }: Props) {
  const componentBindings = useSceneStore((s) => s.scene.componentBindings);
  const assets = useSceneStore((s) => s.scene.assets);

  const domains = new Set<ElementDomain>();
  for (const b of componentBindings ?? []) {
    if (b.componentId !== component.id || b.targetKind !== "asset" || !b.asset3dId) continue;
    const a = assets.find((x) => x.id === b.asset3dId);
    const ek = a?.kindId && a.kindId !== "none" ? kindIdToElementKind(a.kindId) : null;
    if (ek) domains.add(domainForElementKind(ek));
  }
  if (domains.size === 0) {
    const ownEk =
      component.kindId && component.kindId !== "none" ? kindIdToElementKind(component.kindId) : null;
    if (ownEk) domains.add(domainForElementKind(ownEk));
  }
  const list = [...domains];

  return (
    <div className="capability-pills">
      <span className="capability-label">Domain:</span>
      {list.length === 0 ? (
        <span className="capability-pill disabled">mechanical</span>
      ) : (
        list.map((d) => (
          <span
            key={d}
            className="capability-pill enabled"
            style={{ borderColor: DOMAIN_COLOR[d], color: DOMAIN_COLOR[d] }}
            title={DOMAIN_TITLES[d]}
          >
            {d === "rf" ? "RF" : "Optical"}
          </span>
        ))
      )}
    </div>
  );
}
