import { useEffect, useState } from "react";

import {
  WS_URL,
  fetchRoomDimensionsApi,
  updateRoomDimensionsApi,
  type RoomDimensions,
} from "./api/client";
import {
  ComponentsCatalogPanel,
  OutlinerFloatingPanel,
} from "./components/AssetLibraryPanel";
import { AIBindingPanel } from "./components/AIBindingPanel";
import { ComponentPanel } from "./components/ComponentPanel";
import { DualViewerSplit } from "./components/DualViewerSplit";
import { PhyEditor } from "./components/PhyEditor";
import { InstrumentPowerPanel } from "./components/InstrumentPowerPanel";
import { PulseTimingPanel } from "./components/PulseTimingPanel";
import { TouchCoincidencePanel } from "./components/TouchCoincidencePanel";
import { OpticalLinkViewerPanel } from "./components/optical/OpticalLinkViewerPanel";
import { RfLinkPanel } from "./components/RfLinkPanel";
// BeamPlacementPanel + SuggestedLinksPanel removed — replaced with simpler
// per-object "Snap to beam" action (in OE panel) plus aperture warnings.
import { CursorMenu } from "./components/optical/CursorMenu";
import { SceneToolbar } from "./components/SceneToolbar";
import { ScrubTimeBar } from "./components/workspace/ScrubTimeBar";
import { SolverConsole } from "./components/workspace/SolverConsole";
import { TopBar } from "./components/workspace/TopBar";
import { WorkspaceProvider } from "./components/workspace/WorkspaceProvider";
import { ElectronicsWorkspace } from "./modules/electronics/ElectronicsWorkspace";
import { EmWorkspace } from "./modules/em/EmWorkspace";
import { MagneticsPanel } from "./modules/magnetics/MagneticsPanel";
import { OpticsHost } from "./modules/optics_cavity/OpticsHost";
import { getModule } from "./modules/_registry";
import { ModulePlaceholder } from "./modules/ModulePlaceholder";
import { useSceneStore } from "./store/sceneStore";
import type { SceneEvent } from "./types/digitalTwin";
import type { OverlayKind } from "./types/visibility";

// Room dimensions live in app_settings.room_dimensions (alembic 0043),
// shared across users. We deliberately do NOT seed a default here:
// rendering the 3D viewer with a placeholder size and then swapping to
// the real one would tear down + rebuild the whole scene (the viewer's
// init effect depends on roomDimensions), producing a visible "jump".
// Instead we gate the optics layout on the fetch resolving.

// Feature flag for the AI binding agent panel. The panel + backend
// endpoints (agent_sessions) ship in this build, but the Claude Agent
// SDK driver that calls into agent_tools.py is not wired yet — so the
// panel is hidden behind this flag to keep users out of a half-built
// UI. Set VITE_ENABLE_AI_PANEL=true in .env to turn it on for dev.
const _viteEnv =
  ((import.meta as unknown) as { env?: Record<string, string> }).env ?? {};
const AI_PANEL_ENABLED = _viteEnv.VITE_ENABLE_AI_PANEL === "true";

const NUMBER_KEY_OVERLAYS: Record<string, OverlayKind> = {
  "1": "components",
  "2": "connections",
  "3": "assembly_relations",
  "4": "optical_links",
  "5": "beam_segments",
  "6": "beam_paths",
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export default function App() {
  const [roomDimensions, setRoomDimensions] = useState<RoomDimensions | null>(null);
  const loadScene = useSceneStore((state) => state.loadScene);
  const loadTimingPrograms = useSceneStore((state) => state.loadTimingPrograms);
  const loadRfChains = useSceneStore((state) => state.loadRfChains);
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
    void loadTimingPrograms();
    void loadRfChains();
  }, [loadScene, loadTimingPrograms, loadRfChains]);

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
    let cancelled = false;
    fetchRoomDimensionsApi()
      .then((dims) => {
        if (cancelled) return;
        setRoomDimensions(dims);
        // First-time visit (no per-browser cursor saved yet): place the 3D
        // cursor at table-ish height in the middle of the room so users
        // open looking AT the lab instead of at floor-center (0,0,0). Once
        // the user moves it via Shift+S the new position lives in
        // localStorage and survives reloads — handled by sceneStore.
        const hadSavedCursor =
          window.localStorage.getItem("qmem.transformCursorMm.v2") ??
          window.localStorage.getItem("qmem.transformCursorMm.v1");
        if (!hadSavedCursor) {
          const center = { x: 0, y: dims.heightMm / 4, z: 0 };
          const store = useSceneStore.getState();
          store.setTransformCursorMm("left", center);
          store.setTransformCursorMm("right", center);
        }
      })
      .catch(() => {
        // Backend unreachable on first load — fall through to the same
        // values the backend would have returned for an empty row, so the
        // viewer still mounts instead of getting stuck on the loading
        // screen forever. Once the backend comes back up, a manual reload
        // (or any future fetch) picks up the real value.
        if (cancelled) return;
        setRoomDimensions({ widthMm: 4200, depthMm: 1800, heightMm: 4000 });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const persistRoomDimensions = (dims: RoomDimensions) => {
    setRoomDimensions(dims);
    void updateRoomDimensionsApi(dims);
    // Changing roomDimensions re-runs DigitalTwinViewer's big init effect,
    // which tears down componentGroupRef. The component-build effect only
    // re-runs when sceneData's reference changes, so without this the user
    // sees an empty room until something else triggers a reload. Force a
    // fresh fetch so the new sceneData ref re-triggers the build.
    void loadScene();
  };

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

  // Multiphysics: top-level module switcher.
  //   optics_seq -> existing 3D scene + optics panels (Phase A).
  //   spice      -> ElectronicsWorkspace netlist+results (Phase B).
  //   em_fem     -> EmWorkspace ports/freq/results (Phase C).
  //   optics_fdtd reserved -> placeholder.
  // SolverConsole is mounted across all available modules.
  const moduleDef = getModule(currentModule);
  const isOptics = currentModule === "optics_seq";
  const isCavity = currentModule === "optics_cavity";
  const isElectronics = currentModule === "spice";
  const isEm = currentModule === "em_fem";
  const showSolverConsole = isOptics || isCavity || isElectronics || isEm;

  return (
    <WorkspaceProvider>
      <main className="workspace-shell">
        <TopBar>
          {/* SceneToolbar is Lab-only — its buttons (Initial Setup,
              Display overlays, Scene-view picker, dual viewport) only
              act on the 3D scene. Other tabs (Optics calculator,
              Electronics, EM) get module-specific Run controls inside
              their own workspaces. */}
          {isOptics && roomDimensions && (
            <SceneToolbar
              roomDimensions={roomDimensions}
              onRoomDimensionsChange={persistRoomDimensions}
            />
          )}
        </TopBar>
        <div className="workspace-canvas">
          {isOptics && roomDimensions && (
            <>
              <DualViewerSplit roomDimensions={roomDimensions} />
              {loadStatus === "loading" && <div className="scene-overlay">Loading scene</div>}
              {loadStatus === "error" && <div className="scene-overlay error">{error}</div>}
              <ComponentsCatalogPanel />
              <OutlinerFloatingPanel />
              <ComponentPanel />
              <PulseTimingPanel />
              <InstrumentPowerPanel />
              <OpticalLinkViewerPanel />
              <RfLinkPanel />
              <TouchCoincidencePanel />
              <MagneticsPanel />
              {AI_PANEL_ENABLED && <AIBindingPanel />}
              <ScrubTimeBar />
              <CursorMenu />
            </>
          )}
          {isOptics && !roomDimensions && (
            <div className="scene-overlay">Loading lab configuration…</div>
          )}
          {isCavity && <OpticsHost />}
          {isElectronics && <ElectronicsWorkspace />}
          {isEm && <EmWorkspace />}
          {!isOptics && !isCavity && !isElectronics && !isEm && (
            <ModulePlaceholder module={moduleDef} />
          )}
          {showSolverConsole && <SolverConsole />}
        </div>
      </main>
    </WorkspaceProvider>
  );
}
