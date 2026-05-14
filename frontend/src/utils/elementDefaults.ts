/**
 * Element defaults — thin re-export layer over the plugin registry.
 *
 * Pre-P2 this file held the source-of-truth tables for
 *   - COMPONENT_TYPE_TO_KIND   (componentType → ElementKind)
 *   - KIND_LABELS              (ElementKind → human-readable label)
 *   - DEFAULT_KIND_PARAMS      (per-kind kindParams defaults)
 *   - KIND_GROUPS              (Components-panel grouping)
 *   - RF_DOMAIN_KINDS          (kinds whose primary domain is RF)
 *
 * Post-M3 all five derive from the PhysicsPlugin registry in
 * `kinds/_plugins.ts`. The exports below preserve their original
 * names + types so existing consumers keep working unchanged; the
 * underlying drift between this file, `_registry.ts`, and the backend
 * is gone.
 *
 * `componentTypeToElementKind`, `domainForElementKind`,
 * `DOMAIN_TITLES`, and the `ElementDomain` type stay where they are —
 * they're plain helpers on top of the derived data, not separate
 * sources of truth.
 */
import type { ElementKind } from "../types/digitalTwin";
import {
  derivedComponentTypeToKind,
  derivedDefaultKindParams,
  derivedKindGroups,
  derivedKindLabels,
  derivedRfDomainKinds,
} from "../kinds/_plugins";

const COMPONENT_TYPE_TO_KIND: Record<string, ElementKind> =
  derivedComponentTypeToKind() as Record<string, ElementKind>;

export function componentTypeToElementKind(
  componentType: string | null | undefined,
): ElementKind | null {
  if (!componentType) return null;
  return COMPONENT_TYPE_TO_KIND[componentType.trim()] ?? null;
}

export const KIND_LABELS: Record<ElementKind, string> =
  derivedKindLabels() as Record<ElementKind, string>;

/** Top-level physics domain for an ElementKind. Drives the panel chrome
 *  (header / pill colour) so an AD9959 reads the Electronics & RF title
 *  instead of the optical one — registering RF inside the PhysicsElement
 *  table was a Phase RF.2 shortcut; the user-facing label should reflect
 *  what the element actually is. Titles mirror the Components catalog
 *  categories in AssetLibraryPanel.tsx so the Object panel and the
 *  catalog speak the same language. */
export type ElementDomain = "optical" | "rf";

const RF_DOMAIN_KINDS: ReadonlySet<ElementKind> =
  derivedRfDomainKinds() as ReadonlySet<ElementKind>;

export function domainForElementKind(kind: ElementKind | null | undefined): ElementDomain {
  if (kind && RF_DOMAIN_KINDS.has(kind)) return "rf";
  return "optical";
}

export const DOMAIN_TITLES: Record<ElementDomain, string> = {
  optical: "Optical / 光學",
  rf: "Electronics & RF / 電子・RF",
};

export const KIND_GROUPS: { label: string; kinds: ElementKind[] }[] =
  derivedKindGroups() as { label: string; kinds: ElementKind[] }[];

export const DEFAULT_KIND_PARAMS: Record<ElementKind, Record<string, unknown>> =
  derivedDefaultKindParams() as Record<ElementKind, Record<string, unknown>>;
