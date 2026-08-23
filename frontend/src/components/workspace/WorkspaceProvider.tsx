/**
 * Workspace context — Blender-style floating panel layout.
 *
 * Holds per-panel `{ x, y, w, h, visible, collapsed, z }` state, persists it
 * to localStorage, and exposes actions for the FloatingPanel chrome.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** Dock zone a panel lives in. "float" = the legacy free-floating window
 *  (absolute x/y/w/h). The three docks reserve space in the workspace grid so
 *  the viewer is never covered; panels stacked in a dock can't overlap. */
export type DockZone = "left" | "right" | "bottom" | "float";

export type PanelLayout = {
  // Float-mode geometry (also the restore target when a docked panel pops out).
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
  collapsed: boolean;
  z: number;
  dock: DockZone;
  /** Share of the dock zone this panel takes when stacked with siblings —
   *  a flex-grow weight, so 2 next to 1 means twice the height. Undefined =
   *  1 (equal split); set by the splitter between two docked panels. */
  dockWeight?: number;
};

export type PanelId =
  | "components"
  | "outliner"
  | "object"
  | "pulse-timing"
  | "instrument-power"
  | "beam-scope"
  | "touch-coincidence"
  | "rf-link"
  | "magnetics"
  | "ai-binding";

const PANEL_DEFS: { id: PanelId; title: string; defaultLayout: PanelLayout }[] = [
  {
    id: "components",
    // Y starts at 116 so the panel sits below BOTH the Wireframe / Rendered
    // overlay pills (top:14 h:44 → end y=58) AND the Cursor (mm) X/Y/Z
    // editor (top:64 h:~36 → end y=100), plus 16 px breathing room.
    title: "Components",
    defaultLayout: { x: 16, y: 116, w: 300, h: 420, visible: true, collapsed: false, z: 1, dock: "left" },
  },
  {
    id: "outliner",
    // y=552 = components y(116) + components h(420) + 16 px gap.
    title: "Outliner",
    defaultLayout: { x: 16, y: 552, w: 300, h: 320, visible: true, collapsed: false, z: 1, dock: "left" },
  },
  {
    id: "object",
    title: "Object",
    // Y starts at 296 so the panel sits below the right-side stack of XYZ
    // axis gizmo (top:14, h:132 → ends at 146) + Tools pie (top:162, h:120
    // → ends at 282) + 14 px breathing room.
    defaultLayout: { x: -340, y: 296, w: 320, h: 520, visible: true, collapsed: false, z: 1, dock: "right" },
  },
  {
    id: "pulse-timing",
    title: "Pulse & Timing",
    defaultLayout: { x: 332, y: 480, w: 760, h: 380, visible: false, collapsed: false, z: 2, dock: "bottom" },
  },
  {
    id: "instrument-power",
    title: "Instrument Power",
    defaultLayout: { x: 332, y: 80, w: 380, h: 360, visible: false, collapsed: false, z: 2, dock: "float" },
  },
  {
    id: "beam-scope",
    title: "Beam scope",
    defaultLayout: { x: 332, y: 80, w: 560, h: 460, visible: false, collapsed: false, z: 2, dock: "float" },
  },
  {
    id: "touch-coincidence",
    title: "Touch coincidence",
    defaultLayout: { x: 332, y: 200, w: 380, h: 280, visible: false, collapsed: false, z: 3, dock: "float" },
  },
  {
    id: "rf-link",
    title: "RF link",
    defaultLayout: { x: 360, y: 80, w: 720, h: 520, visible: false, collapsed: false, z: 2, dock: "float" },
  },
  {
    id: "magnetics",
    title: "Magnetics overlay",
    // Hidden by default; user opens via Window menu when they want to
    // compute a B-field on top of the current Optics scene.
    defaultLayout: { x: -340, y: 80, w: 320, h: 460, visible: false, collapsed: false, z: 2, dock: "right" },
  },
  {
    id: "ai-binding",
    title: "AI Binding",
    // Three gates control this panel; all read VITE_ENABLE_AI_PANEL.
    // When the flag is off (current default), the component doesn't
    // mount (App.tsx), this `visible: false` keeps the panel closed
    // even when someone flips only the env var on, and TopBar.tsx
    // hides it from the Window menu too.
    defaultLayout: { x: -340, y: 80, w: 380, h: 520, visible: false, collapsed: false, z: 3, dock: "right" },
  },
];

export const PANEL_TITLES: Record<PanelId, string> = Object.fromEntries(
  PANEL_DEFS.map((p) => [p.id, p.title]),
) as Record<PanelId, string>;

/** The zone each panel returns to when re-docked from a floating state. */
export const PANEL_DEFAULT_DOCKS: Record<PanelId, DockZone> = Object.fromEntries(
  PANEL_DEFS.map((p) => [p.id, p.defaultLayout.dock]),
) as Record<PanelId, DockZone>;

type LayoutMap = Record<PanelId, PanelLayout>;

// Bumped on every panel-default move so existing user layouts don't
// stick at the OLD positions. v4: components y 70 → 116, outliner y
// 506 → 552 (clear of the new Cursor (mm) X/Y/Z editor at top:64).
// v8: introduced the `dock` field + dock-zone layout. The bump drops stale
// free-float coords so existing users adopt the new default docks.
const STORAGE_KEY = "qmem.workspaceLayout.v8";

const DOCK_ZONES: DockZone[] = ["left", "right", "bottom", "float"];

function defaultLayoutFor(viewportWidth: number): LayoutMap {
  const out = {} as LayoutMap;
  for (const def of PANEL_DEFS) {
    const layout = { ...def.defaultLayout };
    // Negative x in defs means "from right edge" — resolve against viewport.
    if (layout.x < 0) {
      layout.x = Math.max(16, viewportWidth + layout.x);
    }
    out[def.id] = layout;
  }
  return out;
}

function loadLayout(viewportWidth: number): LayoutMap {
  if (typeof window === "undefined") return defaultLayoutFor(viewportWidth);
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultLayoutFor(viewportWidth);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultLayoutFor(viewportWidth);
    const fallback = defaultLayoutFor(viewportWidth);
    const out = {} as LayoutMap;
    for (const def of PANEL_DEFS) {
      const stored = parsed[def.id];
      if (stored && typeof stored === "object") {
        out[def.id] = {
          x: typeof stored.x === "number" ? stored.x : fallback[def.id].x,
          y: typeof stored.y === "number" ? stored.y : fallback[def.id].y,
          w: typeof stored.w === "number" ? stored.w : fallback[def.id].w,
          h: typeof stored.h === "number" ? stored.h : fallback[def.id].h,
          visible: stored.visible !== false,
          collapsed: stored.collapsed === true,
          z: typeof stored.z === "number" ? stored.z : fallback[def.id].z,
          dock: DOCK_ZONES.includes(stored.dock) ? stored.dock : fallback[def.id].dock,
          dockWeight:
            typeof stored.dockWeight === "number" && stored.dockWeight > 0
              ? stored.dockWeight
              : undefined,
        };
      } else {
        out[def.id] = fallback[def.id];
      }
    }
    return out;
  } catch {
    return defaultLayoutFor(viewportWidth);
  }
}

type WorkspaceContextValue = {
  layouts: LayoutMap;
  panelIds: PanelId[];
  panelTitles: Record<PanelId, string>;
  movePanel: (id: PanelId, x: number, y: number) => void;
  resizePanel: (id: PanelId, w: number, h: number) => void;
  setPanelLayout: (id: PanelId, patch: Partial<PanelLayout>) => void;
  setPanelDock: (id: PanelId, dock: DockZone) => void;
  focusPanel: (id: PanelId) => void;
  togglePanelVisible: (id: PanelId, visible?: boolean) => void;
  togglePanelCollapsed: (id: PanelId, collapsed?: boolean) => void;
  resetLayout: () => void;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const initialWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
  const [layouts, setLayouts] = useState<LayoutMap>(() => loadLayout(initialWidth));
  const zCounterRef = useRef(
    Math.max(...Object.values(layouts).map((l) => l.z), 1),
  );

  // Persist on every change
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layouts));
    } catch {
      /* ignore quota errors */
    }
  }, [layouts]);

  const setPanelLayout = useCallback((id: PanelId, patch: Partial<PanelLayout>) => {
    setLayouts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  }, []);

  const setPanelDock = useCallback((id: PanelId, dock: DockZone) => {
    setLayouts((current) => {
      const panel = current[id];
      if (!panel || panel.dock === dock) return current;
      // Popping out to float: raise above everything (incl. the viewer HUD at
      // z 3–4) and nudge off the default pile so multiple pop-outs cascade.
      if (dock === "float") {
        const maxZ = Math.max(5, ...Object.values(current).map((l) => l.z));
        zCounterRef.current = maxZ + 1;
        const offset = (zCounterRef.current % 6) * 28;
        return {
          ...current,
          [id]: { ...panel, dock, z: maxZ + 1, x: 120 + offset, y: 96 + offset },
        };
      }
      return { ...current, [id]: { ...panel, dock } };
    });
  }, []);

  const movePanel = useCallback((id: PanelId, x: number, y: number) => {
    setLayouts((current) => ({ ...current, [id]: { ...current[id], x, y } }));
  }, []);

  const resizePanel = useCallback((id: PanelId, w: number, h: number) => {
    setLayouts((current) => ({ ...current, [id]: { ...current[id], w, h } }));
  }, []);

  const focusPanel = useCallback((id: PanelId) => {
    setLayouts((current) => {
      const top = current[id];
      if (!top) return current;
      // Already on top? skip.
      const maxZ = Math.max(...Object.values(current).map((l) => l.z));
      if (top.z >= maxZ) return current;
      zCounterRef.current = maxZ + 1;
      return { ...current, [id]: { ...top, z: maxZ + 1 } };
    });
  }, []);

  const togglePanelVisible = useCallback((id: PanelId, visible?: boolean) => {
    setLayouts((current) => {
      const next = visible !== undefined ? visible : !current[id].visible;
      return { ...current, [id]: { ...current[id], visible: next } };
    });
  }, []);

  const togglePanelCollapsed = useCallback((id: PanelId, collapsed?: boolean) => {
    setLayouts((current) => {
      const next = collapsed !== undefined ? collapsed : !current[id].collapsed;
      return { ...current, [id]: { ...current[id], collapsed: next } };
    });
  }, []);

  const resetLayout = useCallback(() => {
    const w = typeof window === "undefined" ? 1440 : window.innerWidth;
    setLayouts(defaultLayoutFor(w));
  }, []);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      layouts,
      panelIds: PANEL_DEFS.map((p) => p.id),
      panelTitles: PANEL_TITLES,
      movePanel,
      resizePanel,
      setPanelLayout,
      setPanelDock,
      focusPanel,
      togglePanelVisible,
      togglePanelCollapsed,
      resetLayout,
    }),
    [
      layouts,
      movePanel,
      resizePanel,
      setPanelLayout,
      setPanelDock,
      focusPanel,
      togglePanelVisible,
      togglePanelCollapsed,
      resetLayout,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return ctx;
}

export function usePanelLayout(id: PanelId): PanelLayout {
  const ws = useWorkspace();
  return ws.layouts[id];
}
