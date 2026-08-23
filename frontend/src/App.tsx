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
import { RfLinkPanel } from "./components/RfLinkPanel";
// BeamPlacementPanel + SuggestedLinksPanel removed — replaced with simpler
// per-object "Snap to beam" action (in OE panel) plus aperture warnings.
import { CursorMenu } from "./components/optical/CursorMenu";
import { SceneToolbar } from "./components/SceneToolbar";
import { DockZones } from "./components/workspace/DockZones";
import { ScrubTimeBar } from "./components/workspace/ScrubTimeBar";
import { TopBar } from "./components/workspace/TopBar";
import { WorkspaceProvider } from "./components/workspace/WorkspaceProvider";
import { MagneticsPanel } from "./modules/magnetics/MagneticsPanel";
import { useSceneStore } from "./store/sceneStore";
import { useV3Catalog } from "./store/catalogStore";
import { invalidateRfConnectorCache } from "./three/loadAsset/rf_cable/connectorModels";
import { invalidateFiberConnectorCache } from "./three/loadAsset/fiber/fiberConnectorModels";
import type { SceneEvent, SceneObject } from "./types/digitalTwin";
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

// How long incoming WebSocket broadcasts are buffered before being
// applied as one batch (~one frame). Long enough to catch the echo of a
// multi-object write, short enough to stay imperceptible.
const WS_FLUSH_MS = 16;

// Only the four surfaced overlays (see OVERLAY_GROUPS) get number-key
// shortcuts, numbered 1–4 to match their popover order.
const NUMBER_KEY_OVERLAYS: Record<string, OverlayKind> = {
  "1": "components",
  "2": "connections",
  "3": "beam_segments",
  "4": "anchors",
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
  const applyEvents = useSceneStore((state) => state.applyEvents);
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
      // Undo / Redo intercept — must run BEFORE the generic "ignore
      // Ctrl/Meta combos" guard below. Cmd+Z / Ctrl+Z = undo;
      // Cmd+Shift+Z / Ctrl+Shift+Z / Cmd+Y / Ctrl+Y = redo.
      const isMod = event.metaKey || event.ctrlKey;
      if (isMod && !event.altKey && (event.key === "z" || event.key === "Z")) {
        event.preventDefault();
        if (event.shiftKey) {
          void useSceneStore.getState().redo();
        } else {
          void useSceneStore.getState().undo();
        }
        return;
      }
      if (isMod && !event.altKey && !event.shiftKey && (event.key === "y" || event.key === "Y")) {
        event.preventDefault();
        void useSceneStore.getState().redo();
        return;
      }
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

      if (event.key === "Delete") {
        // Multi-delete. `selectedObjectIds` always holds the full selection
        // (a plain click leaves exactly one id in it), so one call covers
        // both the single- and multi-object cases and goes through the same
        // batch path the Outliner uses — locked members are skipped and
        // cables / PPGs cascade with their peers. Deletes are NOT on the
        // undo stack, hence the confirm. PHY Editor has its own selection
        // model, so the key stays Lab-only.
        if (state.editorMode !== "scene") return;
        const objectsById = new Map(state.scene.objects.map((o) => [o.id, o]));
        const doomed = state.selectedObjectIds
          .map((id) => objectsById.get(id))
          .filter((o): o is SceneObject => o !== undefined && !o.locked);
        if (doomed.length === 0) return;
        event.preventDefault();
        const label = doomed.length === 1 ? `"${doomed[0].name}"` : `${doomed.length} objects`;
        if (
          window.confirm(
            `Delete ${label} from the scene? This removes ${doomed.length === 1 ? "it" : "them"} from every collection and cannot be undone.`,
          )
        ) {
          void state.deleteObjects(doomed.map((o) => o.id));
        }
        return;
      }
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
    // Broadcast coalescing. Each message arrives as its own task, so
    // applying them individually gave a 13-object group move 13 separate
    // store commits — 13 scene rebuilds and 13 optical / RF re-traces
    // for one user action. Buffer whatever lands inside a frame and
    // apply it as one batch; the delay is invisible and the recompute
    // then runs once, on the settled scene.
    let pending: SceneEvent[] = [];
    let flushTimer: number | undefined;
    const flush = () => {
      flushTimer = undefined;
      const batch = pending;
      pending = [];
      if (batch.length > 0) applyEvents(batch);
    };

    const connect = () => {
      setSocketStatus("connecting");
      socket = new WebSocket(WS_URL);

      socket.onopen = () => setSocketStatus("connected");
      socket.onerror = () => setSocketStatus("error");
      socket.onmessage = (message) => {
        try {
          pending.push(JSON.parse(message.data) as SceneEvent);
        } catch {
          setSocketStatus("error");
          return;
        }
        if (flushTimer === undefined) flushTimer = window.setTimeout(flush, WS_FLUSH_MS);
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
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      socket?.close();
    };
  }, [applyEvents, setSocketStatus]);

  // bfcache guard. iOS Chrome/Safari restore a backgrounded tab from the
  // back-forward cache WITHOUT re-running JS, so the catalog store (and every
  // in-memory mesh cache) stays frozen at whatever it held when the tab was
  // parked. After replacing an asset's geometry, a "reload" that is really a
  // bfcache restore then keeps showing the OLD mesh (e.g. a re-uploaded fiber
  // connector) — the exact symptom that incognito, which can't restore from
  // bfcache, does not have. Force a true reload on a persisted pageshow so the
  // restored tab refetches the catalog and reloads meshes from their current
  // file_path. Fires only on bfcache restore (persisted), not on every tab
  // switch, so it isn't disruptive.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  // Connector cache invalidation. The baked-connector caches (rf_cable / fiber)
  // are module singletons keyed by connector kind / catalogId — both stable
  // across a re-upload or anchor edit — so a changed connector asset keeps
  // serving its OLD baked mesh until a viewer unmounts and clears the resolver
  // (the "switch to ASSET3D and back" workaround). Drop the caches whenever the
  // catalog's assets change; the firing of the load listeners makes the mounted
  // viewer (Object Sense / COMPONENT preview) bump its connectorEpoch, rebuild,
  // and re-load the current mesh.
  useEffect(() => {
    return useV3Catalog.subscribe((state, prev) => {
      if (state.assets !== prev.assets) {
        invalidateRfConnectorCache();
        invalidateFiberConnectorCache();
      }
    });
  }, []);

  // Load the Asset3D / Component catalog at app startup. Until now `fetchAll`
  // ran ONLY inside the ASSET3D editor (Asset3DEditor), so a fresh app that
  // landed on the Lab (or the PHY-editor Component preview) had an EMPTY
  // catalog store. The cable connector resolver
  // (`getAssetsByKind("fiber_connector")` / RF) then found nothing → returned
  // null → the spline drew its procedural FC/SMA fallback (low-detail "blurry"
  // connector). Visiting the ASSET3D tab populated the catalog, so coming back
  // the connector finally resolved to the real GLB — the "looks low-detail
  // until I open ASSET3D then it's full" symptom. Fetching here makes the
  // catalog available to every view from the start.
  useEffect(() => {
    if (useV3Catalog.getState().status === "idle") {
      void useV3Catalog.getState().fetchAll();
    }
  }, []);

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

  // Multiphysics: top-level module switcher. Only the integrated Lab
  // (optics_seq) is the only tab; the Optics / Electronics / EM tabs and
  // their backend solvers/enum/DB tables were removed on 2026-06-10.
  const isOptics = currentModule === "optics_seq";

  return (
    <WorkspaceProvider>
      <main className="workspace-shell">
        <TopBar>
          {/* SceneToolbar is Lab-only — its buttons (Initial Setup,
              Display overlays, Scene-view picker, dual viewport) only
              act on the 3D scene. */}
          {isOptics && roomDimensions && (
            <SceneToolbar
              roomDimensions={roomDimensions}
              onRoomDimensionsChange={persistRoomDimensions}
            />
          )}
        </TopBar>
        <div className={`workspace-canvas${isOptics ? " has-docks" : ""}`}>
          {isOptics && roomDimensions && (
            <>
              {/* Dock zones reserve space so the viewer is never covered.
                  Panels portal into these (docked) or render as floats. */}
              <DockZones />
              <div className="workspace-center">
                <DualViewerSplit roomDimensions={roomDimensions} />
                {loadStatus === "loading" && <div className="scene-overlay">Loading scene</div>}
                {loadStatus === "error" && <div className="scene-overlay error">{error}</div>}
                <ScrubTimeBar />
              </div>
              <ComponentsCatalogPanel />
              <OutlinerFloatingPanel />
              <ComponentPanel />
              <PulseTimingPanel />
              <InstrumentPowerPanel />
              <RfLinkPanel />
              <TouchCoincidencePanel />
              <MagneticsPanel />
              {AI_PANEL_ENABLED && <AIBindingPanel />}
              <CursorMenu />
            </>
          )}
          {isOptics && !roomDimensions && (
            <div className="scene-overlay">Loading lab configuration…</div>
          )}
        </div>
      </main>
    </WorkspaceProvider>
  );
}
