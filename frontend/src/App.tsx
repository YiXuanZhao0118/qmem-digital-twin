import { useEffect, useState } from "react";

import { WS_URL } from "./api/client";
import { AssetLibraryPanel } from "./components/AssetLibraryPanel";
import { ComponentPanel } from "./components/ComponentPanel";
import { DigitalTwinViewer } from "./components/DigitalTwinViewer";
import { SceneToolbar } from "./components/SceneToolbar";
import { useSceneStore } from "./store/sceneStore";
import type { SceneEvent } from "./types/digitalTwin";

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

export default function App() {
  const [roomDimensions, setRoomDimensions] = useState(loadRoomDimensions);
  const loadScene = useSceneStore((state) => state.loadScene);
  const applyEvent = useSceneStore((state) => state.applyEvent);
  const setSocketStatus = useSceneStore((state) => state.setSocketStatus);
  const loadStatus = useSceneStore((state) => state.loadStatus);
  const error = useSceneStore((state) => state.error);

  useEffect(() => {
    void loadScene();
  }, [loadScene]);

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

  return (
    <main className="app-shell">
      <AssetLibraryPanel />
      <section className="scene-shell">
        <SceneToolbar roomDimensions={roomDimensions} onRoomDimensionsChange={setRoomDimensions} />
        <DigitalTwinViewer roomDimensions={roomDimensions} />
        {loadStatus === "loading" && <div className="scene-overlay">Loading scene</div>}
        {loadStatus === "error" && <div className="scene-overlay error">{error}</div>}
      </section>
      <ComponentPanel />
    </main>
  );
}
