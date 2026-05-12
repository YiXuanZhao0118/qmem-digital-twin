import { useEffect, useState } from "react";

import { WS_URL } from "./api/client";
import {
  ComponentsCatalogPanel,
  OutlinerFloatingPanel,
} from "./components/AssetLibraryPanel";
import { ComponentPanel } from "./components/ComponentPanel";
import { DualViewerSplit } from "./components/DualViewerSplit";
import { PhyEditor } from "./components/PhyEditor";
import { TimingEditorPanel } from "./components/TimingEditorPanel";
import { TouchCoincidencePanel } from "./components/TouchCoincidencePanel";
import { OpticalLinkViewerPanel } from "./components/optical/OpticalLinkViewerPanel";
// BeamPlacementPanel + SuggestedLinksPanel removed — replaced with simpler
// per-object "Snap to beam" action (in OE panel) plus aperture warnings.
import { CursorMenu } from "./components/optical/CursorMenu";
import { SceneToolbar } from "./components/SceneToolbar";
import { SolverConsole } from "./components/workspace/SolverConsole";
import { TopBar } from "./components/workspace/TopBar";
import { WorkspaceProvider } from "./components/workspace/WorkspaceProvider";
import { getModule } from "./modules/_registry";
import { ModulePlaceholder } from "./modules/ModulePlaceholder";
import { useSceneStore } from "./store/sceneStore";
import type { SceneEvent } from "./types/digitalTwin";
import type { OverlayKind } from "./types/visibility";

const DEFAULT_ROOM_DIMENSIONS = {
  widthMm: 4200,
  depthMm: 1800,
  heightMm: 4000,
};

function loadRoomDimensions() {
  const saved = window.localStorage.getItem("qmem-room-dimensions");
  if (!saved) return DEFAULT_ROOM_DIMENSIONS;

  try {
    const parsed = JSON.parse(saved) as Partial<typeof DEFAULT_ROOM_DIMENSIONS>;
    return {
      widthMm: Number(parsed.widthMm) || DEFAULT_ROOM_DIMENSIONS.widthMm,
      depthMm: Number(parsed.depthMm) || DEFAULT_ROOM_DIMENSIONS.depthMm,
      heightMm: Number(parsed.heightMm) || DEFAULT_ROOM_DIMENSIONS.heightMm,
    };
  } catch {
    return DEFAULT_ROOM_DIMENSIONS;
  }
}

const NUMBER_KEY_OVERLAYS: Record<string, OverlayKind> = {
  "1": "components",
  "2": "anchors",
  "3": "connections",
  "4": "assembly_relations",
  "5": "optical_links",
  "6": "beam_segments",
  "7": "regions",
  "8": "warnings",
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export default function App() {
  const [roomDimensions, setRoomDimensions] = useState(loadRoomDimensions);
  const loadScene = useSceneStore((state) => state.loadScene);
  const applyEvent = useSceneStore((state) => state.applyEvent);
  const setSocketStatus = useSceneStore((state) => state.setSocketStatus);
  const loadStatus = useSceneStore((state) => state.loadStatus);
  const error = useSceneStore((state) => state.error);
  const toggleOverlayFlag = useSceneStore((state) => state.toggleOverlayFlag);
  const resetOverlayFlags = useSceneStore((state) => state.resetOverlayFlags);
  const editorMode = useSceneStore((state) => state.editorMode);
  const currentModule = useSceneStore((state) => state.currentModule);
  const showAllHidden = useSceneStore((state) => state.showAllHidden);
  const toggleSoloObject = useSceneStore((state) => state.toggleSoloObject);
  const setSoloObjects = useSceneStore((state) => state.setSoloObjects);
  const exitSolo = useSceneStore((state) => state.exitSolo);
  const toggleSessionHiddenObject = useSceneStore((state) => state.toggleSessionHiddenObject);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);

  useEffect(() => {
    void loadScene();
  }, [loadScene]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const overlay = NUMBER_KEY_OVERLAYS[event.key];
      if (overlay) {
        event.preventDefault();
        toggleOverlayFlag(overlay);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        resetOverlayFlags();
        return;
      }
      if (event.key === "Escape") {
        showAllHidden();
        return;
      }

      const state = useSceneStore.getState();
      const objectId = state.selectedObjectId;
      const componentId =
        state.selectedComponentId ??
        (objectId ? state.scene.objects.find((o) => o.id === objectId)?.componentId ?? null : null);

      if (event.key === "h" || event.key === "H") {
        event.preventDefault();
        if (event.shiftKey && objectId) {
          void updateSceneObject(objectId, { visible: false });
        } else if (objectId) {
          toggleSessionHiddenObject(objectId);
        }
        return;
      }
      if (event.key === "s" || event.key === "S") {
        // Solo at the instance level. If a single object is selected, toggle
        // solo on it; otherwise (only a component template is selected) solo
        // every SceneObject of that component template.
        event.preventDefault();
        if (event.shiftKey) {
          exitSolo();
          return;
        }
        if (objectId) {
          toggleSoloObject(objectId);
        } else if (componentId) {
          const ids = state.scene.objects
            .filter((o) => o.componentId === componentId)
            .map((o) => o.id);
          if (ids.length > 0) setSoloObjects(ids);
        }
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    toggleOverlayFlag,
    resetOverlayFlags,
    showAllHidden,
    toggleSoloObject,
    setSoloObjects,
    exitSolo,
    toggleSessionHiddenObject,
    updateSceneObject,
  ]);

  useEffect(() => {
    window.localStorage.setItem("qmem-room-dimensions", JSON.stringify(roomDimensions));
  }, [roomDimensions]);

  useEffect(() => {
    let closed = false;
    let reconnectTimer: number | undefined;
    let socket: WebSocket | undefined;

    const connect = () => {
      setSocketStatus("connecting");
      socket = new WebSocket(WS_URL);

      socket.onopen = () => setSocketStatus("connected");
      socket.onerror = () => setSocketStatus("error");
      socket.onmessage = (message) => {
        try {
          applyEvent(JSON.parse(message.data) as SceneEvent);
        } catch {
          setSocketStatus("error");
        }
      };
      socket.onclose = () => {
        if (closed) return;
        setSocketStatus("disconnected");
        reconnectTimer = window.setTimeout(connect, 1500);
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [applyEvent, setSocketStatus]);

  // PHY Editor sub-page: full-page take-over when active. The back
  // button inside `PhyEditor` flips `editorMode` back to "scene",
  // which falls through to the normal layout below.
  if (editorMode === "phy-editor") {
    return (
      <WorkspaceProvider>
        <PhyEditor />
      </WorkspaceProvider>
    );
  }

  // Multiphysics Phase A: top-level module switcher. Optics keeps the
  // existing scene + panels layout; Electronics/EM render a placeholder
  // card until Phase B/C implement them.
  const moduleDef = getModule(currentModule);
  const opticsActive = moduleDef.status === "available";

  return (
    <WorkspaceProvider>
      <main className="workspace-shell">
        <TopBar>
          <SceneToolbar
            roomDimensions={roomDimensions}
            onRoomDimensionsChange={setRoomDimensions}
          />
        </TopBar>
        <div className="workspace-canvas">
          {opticsActive ? (
            <>
              <DualViewerSplit roomDimensions={roomDimensions} />
              {loadStatus === "loading" && <div className="scene-overlay">Loading scene</div>}
              {loadStatus === "error" && <div className="scene-overlay error">{error}</div>}
              <ComponentsCatalogPanel />
              <OutlinerFloatingPanel />
              <ComponentPanel />
              <TimingEditorPanel />
              <OpticalLinkViewerPanel />
              <TouchCoincidencePanel />
              <SolverConsole />
              <CursorMenu />
            </>
          ) : (
            <ModulePlaceholder module={moduleDef} />
          )}
        </div>
      </main>
    </WorkspaceProvider>
  );
}
