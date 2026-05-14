/**
 * Floating panel wrappers for the left-side catalog + outliner.
 *
 * Components catalog and Outliner each render inside a FloatingPanel chrome
 * provided by WorkspaceProvider. They share the same scene/visibility state
 * but are independently movable / resizable / closable.
 */
import {
  Box,
  ChevronDown,
  ChevronRight,
  Plus,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { OutlinerPanel } from "./OutlinerPanel";
import { useSceneStore } from "../store/sceneStore";
import type { ComponentItem } from "../types/digitalTwin";
import { getComponentDisplayLabel, getComponentName } from "../utils/components";
import { FloatingPanel } from "./workspace/FloatingPanel";

const EXPANDED_GROUPS_STORAGE_KEY = "qmem.componentGroups.expanded";
const EXPANDED_CATEGORIES_STORAGE_KEY = "qmem.componentCategories.expanded";

type CategoryKey = "optical" | "electronics" | "mechanical" | "infrastructure" | "misc" | "other";

type CategoryDef = { key: CategoryKey; label: string; order: number };

const CATEGORY_DEFS: Record<CategoryKey, CategoryDef> = {
  optical: { key: "optical", label: "Optical / 光學", order: 1 },
  electronics: { key: "electronics", label: "Electronics & RF / 電子・RF", order: 2 },
  mechanical: { key: "mechanical", label: "Mounts & Mechanics / 機械", order: 3 },
  infrastructure: { key: "infrastructure", label: "Workspace / 桌面・機箱", order: 4 },
  misc: { key: "misc", label: "Annotations / 註解", order: 5 },
  other: { key: "other", label: "Uncategorized / 未分類", order: 99 },
};

const OPTICAL_TYPES = new Set<string>([
  "mirror",
  "lens",
  "lens_plano_convex",
  "beam_splitter",
  "waveplate",
  "isolator",
  "fiber",
  "aom",
  "eom",
  "laser",
  "laser_source",
  "tapered_amplifier",
  "vacuum_chamber",
]);

const ELECTRONICS_TYPES = new Set<string>([
  "rf_generator",
  "rf_amplifier",
  "rf_switch",
  "dds_ad9959_pcb",
  "mcu_board",
  "tcxo_module",
  "power_supply_ac_dc",
  "sma_cable",
  "rf_cable",
  "sma_jack",
  "usb_b_jack",
  "iec_c14_inlet",
  "instrument_chassis",
]);

const MECHANICAL_TYPES = new Set<string>([
  "clamping_fork",
  "optical_post",
  "post_holder",
  "pedestal_post",
  "pedestal_base",
  "pedestal_fork",
  "post_spacer",
  "post_adapter",
  "mirror_mount",
  "laser_diode_mount",
  "mounting_clamp",
  "polaris_clamping_arm",
  "bench_enhancement",
]);

const INFRASTRUCTURE_TYPES = new Set<string>([
  "optical_table",
]);

const MISC_TYPES = new Set<string>([
  "text_annotation",
  "tool",
]);

function categoryForComponentType(componentType: string): CategoryDef {
  if (OPTICAL_TYPES.has(componentType)) return CATEGORY_DEFS.optical;
  if (ELECTRONICS_TYPES.has(componentType)) return CATEGORY_DEFS.electronics;
  if (MECHANICAL_TYPES.has(componentType)) return CATEGORY_DEFS.mechanical;
  if (INFRASTRUCTURE_TYPES.has(componentType)) return CATEGORY_DEFS.infrastructure;
  if (MISC_TYPES.has(componentType)) return CATEGORY_DEFS.misc;
  return CATEGORY_DEFS.other;
}

function isComponentLocked(component?: { properties?: Record<string, unknown> }): boolean {
  return component?.properties?.locked === true;
}

function loadStringSet(storageKey: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function formatGroupLabel(key: string): string {
  return key
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export function ComponentsCatalogPanel() {
  // Components catalog is a TEMPLATE library — visibility / solo are
  // instance-level concerns and live on the Outliner (which lists scene
  // objects). The catalog row only offers selection + "place as new
  // object" (the +). No eye / EyeOff / Star buttons here.
  const scene = useSceneStore((state) => state.scene);
  const selectComponent = useSceneStore((state) => state.selectComponent);
  const ensureObjectForComponent = useSceneStore((state) => state.ensureObjectForComponent);
  const selectedComponentId = useSceneStore((state) => state.selectedComponentId);

  const [filter, setFilter] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() =>
    loadStringSet(EXPANDED_GROUPS_STORAGE_KEY),
  );
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(() => {
    const stored = loadStringSet(EXPANDED_CATEGORIES_STORAGE_KEY);
    // First-time users: default every category to expanded so RF and optical
    // are both immediately visible (rather than collapsed in a single root).
    if (stored.size === 0) return new Set(Object.keys(CATEGORY_DEFS));
    return stored;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(EXPANDED_GROUPS_STORAGE_KEY, JSON.stringify([...expandedGroups]));
    } catch {
      /* ignore storage errors */
    }
  }, [expandedGroups]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(EXPANDED_CATEGORIES_STORAGE_KEY, JSON.stringify([...expandedCategories]));
    } catch {
      /* ignore storage errors */
    }
  }, [expandedCategories]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleCategory = (key: string) => {
    setExpandedCategories((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const visibleComponents = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return scene.components;
    return scene.components.filter((component) =>
      `${getComponentName(component)} ${component.componentType} ${component.brand ?? ""} ${component.model ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [filter, scene.components]);

  const isFiltering = filter.trim().length > 0;

  // Two-level grouping: Category (Optical / Electronics & RF / Mechanical /
  // …) wraps the existing componentType buckets so RF/electronics don't
  // intermix with optical parts in the alphabetical list.
  const componentCategories = useMemo(() => {
    const categories = new Map<CategoryKey, { def: CategoryDef; types: Map<string, ComponentItem[]> }>();
    for (const component of visibleComponents) {
      const typeKey = component.componentType?.trim() || "uncategorized";
      const def = categoryForComponentType(typeKey);
      let bucket = categories.get(def.key);
      if (!bucket) {
        bucket = { def, types: new Map() };
        categories.set(def.key, bucket);
      }
      const typeBucket = bucket.types.get(typeKey);
      if (typeBucket) typeBucket.push(component);
      else bucket.types.set(typeKey, [component]);
    }
    return [...categories.values()]
      .map((entry) => ({
        def: entry.def,
        types: [...entry.types.entries()].sort(([a], [b]) => a.localeCompare(b)),
        total: [...entry.types.values()].reduce((sum, list) => sum + list.length, 0),
      }))
      .sort((a, b) => a.def.order - b.def.order);
  }, [visibleComponents]);

  return (
    <FloatingPanel id="components" title="Components" badge={visibleComponents.length}>
      <div className="search-row">
        <Search size={16} />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter components"
        />
      </div>
      <div className="component-list">
        {componentCategories.map(({ def, types, total }) => {
          const containsSelectedInCategory = types.some(([, items]) =>
            items.some((item) => item.id === selectedComponentId),
          );
          const categoryExpanded = isFiltering || containsSelectedInCategory || expandedCategories.has(def.key);
          return (
            <div className="component-category" key={def.key}>
              <button
                type="button"
                className="component-category-header"
                aria-expanded={categoryExpanded}
                onClick={() => toggleCategory(def.key)}
              >
                {categoryExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="category-name">{def.label}</span>
                <span className="category-count">{total}</span>
              </button>
              {categoryExpanded && (
                <div className="component-category-children">
                  {types.map(([groupKey, items]) => {
                    const containsSelected = items.some((item) => item.id === selectedComponentId);
                    const expanded = isFiltering || containsSelected || expandedGroups.has(groupKey);
                    const collapsed = !expanded;
                    return (
                      <div className="component-group" key={groupKey}>
                        <div className="component-group-header-row">
                          <button
                            type="button"
                            className="component-group-header"
                            aria-expanded={!collapsed}
                            onClick={() => toggleGroup(groupKey)}
                          >
                            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                            <span className="group-name">{formatGroupLabel(groupKey)}</span>
                            <span className="group-count">{items.length}</span>
                          </button>
                        </div>
                        {!collapsed && (
                          <div className="component-group-children">
                            {items.map((component) => {
                              return (
                                <button
                                  key={component.id}
                                  className={
                                    component.id === selectedComponentId
                                      ? "component-row selected"
                                      : "component-row"
                                  }
                                  onClick={() => selectComponent(component.id)}
                                  title={getComponentName(component)}
                                >
                                  <Box size={17} />
                                  <span>
                                    <strong>{getComponentDisplayLabel(component)}</strong>
                                    {isComponentLocked(component) && <small>locked</small>}
                                  </span>
                                  <span
                                    className="row-action"
                                    title="Place component as object"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void ensureObjectForComponent(component.id);
                                    }}
                                  >
                                    <Plus size={15} />
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </FloatingPanel>
  );
}

export function OutlinerFloatingPanel() {
  const objectsCount = useSceneStore((state) => state.scene.objects.length);
  return (
    <FloatingPanel id="outliner" title="Outliner" badge={objectsCount}>
      <OutlinerPanel />
    </FloatingPanel>
  );
}

/**
 * Backwards-compat shim — App.tsx used to import this name. With the new
 * workspace it isn't rendered directly; everything is routed through the two
 * floating-panel components above. Kept as a thin re-export so accidental
 * imports still type-check.
 */
export function AssetLibraryPanel() {
  return null;
}
