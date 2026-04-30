import { Activity, Box, MousePointer2, RefreshCw, Settings2, Wifi, WifiOff } from "lucide-react";
import { useState } from "react";

import { useSceneStore } from "../store/sceneStore";
import { isOpticalTableComponent } from "../utils/components";

type RoomDimensions = {
  widthMm: number;
  depthMm: number;
  heightMm: number;
};

type SceneToolbarProps = {
  roomDimensions: RoomDimensions;
  onRoomDimensionsChange: (dimensions: RoomDimensions) => void;
};

export function SceneToolbar({ roomDimensions, onRoomDimensionsChange }: SceneToolbarProps) {
  const [setupOpen, setSetupOpen] = useState(false);
  const [draftDimensions, setDraftDimensions] = useState(roomDimensions);
  const loadScene = useSceneStore((state) => state.loadScene);
  const socketStatus = useSceneStore((state) => state.socketStatus);
  const scene = useSceneStore((state) => state.scene);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const opticalTableComponents = scene.components.filter(isOpticalTableComponent);
  const componentById = new Map(scene.components.map((component) => [component.id, component]));
  const opticalTableObjects = scene.objects.filter((placement) => {
    const component = componentById.get(placement.componentId);
    return component ? isOpticalTableComponent(component) : false;
  });
  const selectedObject = opticalTableObjects.find((placement) => placement.id === selectedObjectId);
  const connected = socketStatus === "connected";

  const updateDraft = (key: keyof RoomDimensions, value: string) => {
    const nextValue = Math.max(100, Number(value) || 0);
    setDraftDimensions((current) => ({ ...current, [key]: nextValue }));
  };

  const applyRoomDimensions = () => {
    onRoomDimensionsChange(draftDimensions);
    setSetupOpen(false);
  };

  return (
    <div className="scene-toolbar">
      <div className="toolbar-group">
        <button className="setup-button" title="Initial setup" onClick={() => setSetupOpen((open) => !open)}>
          <Settings2 size={17} />
          Initial Setup
        </button>
        <button className="icon-button" title="Reload scene" onClick={() => void loadScene()}>
          <RefreshCw size={18} />
        </button>
        <button className="icon-button active" title="Select component">
          <MousePointer2 size={18} />
        </button>
        <span className="toolbar-stat" title="Components">
          <Box size={16} />
          {opticalTableComponents.length}
        </span>
        <span className="toolbar-stat" title="Objects">
          <Activity size={16} />
          {opticalTableObjects.length}
        </span>
      </div>

      <div className="toolbar-group">
        <span className={connected ? "socket-pill connected" : "socket-pill"}>
          {connected ? <Wifi size={16} /> : <WifiOff size={16} />}
          {socketStatus}
        </span>
        <span className="selected-pill">{selectedObject?.objectName ?? "No selection"}</span>
      </div>

      {setupOpen && (
        <div className="initial-setup-panel">
          <label>
            Length (mm)
            <input
              type="number"
              min="100"
              step="100"
              value={draftDimensions.widthMm}
              onChange={(event) => updateDraft("widthMm", event.target.value)}
            />
          </label>
          <label>
            Width (mm)
            <input
              type="number"
              min="100"
              step="100"
              value={draftDimensions.depthMm}
              onChange={(event) => updateDraft("depthMm", event.target.value)}
            />
          </label>
          <label>
            Height (mm)
            <input
              type="number"
              min="100"
              step="100"
              value={draftDimensions.heightMm}
              onChange={(event) => updateDraft("heightMm", event.target.value)}
            />
          </label>
          <button className="primary-button" onClick={applyRoomDimensions}>
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
