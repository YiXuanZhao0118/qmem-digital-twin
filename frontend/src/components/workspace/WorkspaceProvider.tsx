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

export type PanelLayout = {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
  collapsed: boolean;
  z: number;
};

export type PanelId =
  | "components"
  | "outliner"
  | "object"
  | "device-state"
  | "timing-editor"
  | "beam-scope"
  | "touch-coincidence";

const PANEL_DEFS: { id: PanelId; title: string; defaultLayout: PanelLayout }[] = [
  {
    id: "components",
    // Y starts at 116 so the panel sits below BOTH the Wireframe / Rendered
    // overlay pills (top:14 h:44 → end y=58) AND the Cursor (mm) X/Y/Z
    // editor (top:64 h:~36 → end y=100), plus 16 px breathing room.
    title: "Components",
    defaultLayout: { x: 16, y: 116, w: 300, h: 420, visible: true, collapsed: false, z: 1 },
  },
  {
    id: "outliner",
    // y=552 = components y(116) + components h(420) + 16 px gap.
    title: "Outliner",
    defaultLayout: { x: 16, y: 552, w: 300, h: 320, visible: true, collapsed: false, z: 1 },
  },
  {
    id: "object",
    title: "Object",
    // Y starts at 296 so the panel sits below the right-side stack of XYZ
    // axis gizmo (top:14, h:132 → ends at 146) + Tools pie (top:162, h:120
    // → ends at 282) + 14 px breathing room.
    defaultLayout: { x: -340, y: 296, w: 320, h: 520, visible: true, collapsed: false, z: 1 },
  },
  {
    id: "device-state",
    title: "Device state",
    // Hidden by default per UX request — the panel was rarely useful and
    // ate vertical space on the right column. User can re-open via the
    // Window menu if needed.
    defaultLayout: { x: -340, y: 824, w: 320, h: 80, visible: false, collapsed: true, z: 1 },
  },
  {
    id: "timing-editor",
    title: "QM — timeline editor",
    defaultLayout: { x: 332, y: 480, w: 720, h: 320, visible: false, collapsed: false, z: 2 },
  },
  {
    id: "beam-scope",
    title: "Beam scope",
    defaultLayout: { x: 332, y: 80, w: 560, h: 460, visible: false, collapsed: false, z: 2 },
  },
  {
    id: "touch-coincidence",
    title: "Touch coincidence",
    defaultLayout: { x: 332, y: 200, w: 380, h: 280, visible: false, collapsed: false, z: 3 },
  },
];

export const PANEL_TITLES: Record<PanelId, string> = Object.fromEntries(
  PANEL_DEFS.map((p) => [p.id, p.title]),
) as Record<PanelId, string>;

type LayoutMap = Record<PanelId, PanelLayout>;

// Bumped on every panel-default move so existing user layouts don't
// stick at the OLD positions. v4: components y 70 → 116, outliner y
// 506 → 552 (clear of the new Cursor (mm) X/Y/Z editor at top:64).
const STORAGE_KEY = "qmem.workspaceLayout.v4";

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
