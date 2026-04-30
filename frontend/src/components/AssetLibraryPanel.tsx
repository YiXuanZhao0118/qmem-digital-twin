import { Box, Layers3, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { useSceneStore } from "../store/sceneStore";
import { getComponentName } from "../utils/components";

function isComponentLocked(component?: { properties?: Record<string, unknown> }): boolean {
  return component?.properties?.locked === true;
}

export function AssetLibraryPanel() {
  const scene = useSceneStore((state) => state.scene);
  const selectComponent = useSceneStore((state) => state.selectComponent);
  const selectObject = useSceneStore((state) => state.selectObject);
  const ensureObjectForComponent = useSceneStore((state) => state.ensureObjectForComponent);
  const deleteObject = useSceneStore((state) => state.deleteObject);
  const selectedComponentId = useSceneStore((state) => state.selectedComponentId);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);

  const [filter, setFilter] = useState("");

  const visibleComponents = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return scene.components;
    return scene.components.filter((component) =>
      `${getComponentName(component)} ${component.componentType} ${component.brand ?? ""} ${component.model ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [filter, scene.components]);

  const visibleObjects = useMemo(() => {
    const componentById = new Map(scene.components.map((component) => [component.id, component]));
    return scene.objects
      .map((object) => ({
        object,
        component: componentById.get(object.componentId),
      }))
      .filter((item) => item.component);
  }, [scene.components, scene.objects]);

  return (
    <aside className="side-panel left-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Library</p>
          <h2>Assets & Components</h2>
        </div>
        <span className="count-pill">{visibleComponents.length + visibleObjects.length}</span>
      </div>

      <div className="search-row">
        <Search size={16} />
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter" />
      </div>

      <section className="library-section components-section">
        <div className="section-title">
          <span>Components</span>
          <small>library</small>
        </div>
        <div className="component-list">
          {visibleComponents.map((component) => (
            <button
              key={component.id}
              className={component.id === selectedComponentId ? "component-row selected" : "component-row"}
              onClick={() => selectComponent(component.id)}
            >
              <Box size={17} />
              <span>
                <strong>{getComponentName(component)}</strong>
                <small>{component.componentType}{isComponentLocked(component) ? " locked" : ""}</small>
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
          ))}
        </div>
      </section>

      <section className="library-section objects-section">
        <div className="section-title">
          <span>Objects</span>
          <small>in scene</small>
        </div>
        <div className="component-list">
          {visibleObjects.map(({ object, component }) => {
            return (
              <button
                key={object.id}
                className={object.id === selectedObjectId ? "component-row object-row selected" : "component-row object-row"}
                onClick={() => selectObject(object.id)}
              >
                <Layers3 size={17} />
                <span>
                  <strong>{object.objectName}</strong>
                  <small>
                    {getComponentName(component!)} {object.visible ? "" : " hidden"}
                  </small>
                </span>
                <span
                  className="row-action danger-action"
                  title="Remove object"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (window.confirm(`Remove ${object.objectName} from the scene?`)) {
                      void deleteObject(object.id);
                    }
                  }}
                >
                  <Trash2 size={15} />
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </aside>
  );
}
