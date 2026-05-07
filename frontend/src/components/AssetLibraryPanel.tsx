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

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(EXPANDED_GROUPS_STORAGE_KEY, JSON.stringify([...expandedGroups]));
    } catch {
      /* ignore storage errors */
    }
  }, [expandedGroups]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => {
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

  const componentGroups = useMemo(() => {
    const groups = new Map<string, ComponentItem[]>();
    for (const component of visibleComponents) {
      const key = component.componentType?.trim() || "uncategorized";
      const bucket = groups.get(key);
      if (bucket) bucket.push(component);
      else groups.set(key, [component]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
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
        {componentGroups.map(([groupKey, items]) => {
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
