import { Check, Layers3, Link2, Lock, Move3D, Plus, RotateCw, Trash2, Unlock } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { resolveAssetUrl } from "../api/client";
import { useSceneStore } from "../store/sceneStore";
import type { AssemblyRelation, GeometrySelector, PlacementPatch, RelationType, Vec3 } from "../types/digitalTwin";
import { getComponentName } from "../utils/components";
import {
  anchorOptions,
  normalizeAnchorId,
  relationDistance,
  relationOffset,
  relationPriority,
  relationTarget as getRelationTarget,
  selectorByAnchor,
  selectorOffset,
  worldAnchor,
} from "../utils/relationAnchors";

type DraftPlacement = Required<Omit<PlacementPatch, "parentComponentId" | "objectName" | "properties">> & {
  objectName: string;
};

const emptyDraft: DraftPlacement = {
  objectName: "",
  xMm: 0,
  yMm: 0,
  zMm: 0,
  rxDeg: 0,
  ryDeg: 0,
  rzDeg: 0,
  visible: true,
  locked: false,
};

const relationTypes: { label: string; value: RelationType }[] = [
  { label: "Same position", value: "same_position" },
  { label: "Offset position", value: "offset_position" },
  { label: "Distance", value: "distance" },
  { label: "Same direction", value: "same_direction" },
  { label: "Opposite direction", value: "opposite_direction" },
  { label: "Perpendicular direction", value: "perpendicular_direction" },
  { label: "Face touch", value: "face_touch" },
  { label: "Face parallel", value: "face_parallel" },
  { label: "Face offset", value: "face_offset" },
  { label: "Face align center", value: "face_align_center" },
];

function dotNormals(left?: Vec3, right?: Vec3): number | null {
  if (!left || !right) return null;
  const lengthLeft = Math.hypot(...left);
  const lengthRight = Math.hypot(...right);
  if (!lengthLeft || !lengthRight) return null;
  return left.reduce((sum, item, index) => sum + item * right[index], 0) / (lengthLeft * lengthRight);
}

function constrainedPositionKey(selector: GeometrySelector): "xMm" | "yMm" | "zMm" | null {
  const normal = selector.normal;
  if (!normal) return null;
  const axisIndex = normal.reduce(
    (bestIndex, item, index) => (Math.abs(item) > Math.abs(normal[bestIndex]) ? index : bestIndex),
    0,
  );
  if (Math.abs(normal[axisIndex]) < 0.999) return null;
  return (["xMm", "yMm", "zMm"] as const)[axisIndex];
}

function stateBadge(state: Record<string, unknown>): { label: string; tone: string } {
  if (state.enabled === false) return { label: "Disabled", tone: "muted" };
  if (typeof state.temperatureC === "number" && state.temperatureC > 45) {
    return { label: "Hot", tone: "danger" };
  }
  if (typeof state.pressurePa === "number" && state.pressurePa > 0.01) {
    return { label: "Pressure", tone: "danger" };
  }
  if (state.locked === true) return { label: "Locked", tone: "good" };
  if (state.enabled === true) return { label: "Enabled", tone: "good" };
  return { label: "Nominal", tone: "neutral" };
}

type RelationDraft = {
  offsetX: string;
  offsetY: string;
  offsetZ: string;
  distance: string;
  priority: string;
  enabled: boolean;
};

function relationDraft(relation: AssemblyRelation): RelationDraft {
  const offset = relationOffset(relation);
  return {
    offsetX: String(offset.x),
    offsetY: String(offset.y),
    offsetZ: String(offset.z),
    distance: String(relationDistance(relation)),
    priority: String(relationPriority(relation)),
    enabled: relation.enabled,
  };
}

function isComponentLocked(component?: { properties?: Record<string, unknown> }): boolean {
  return component?.properties?.locked === true;
}

export function ComponentPanel() {
  const scene = useSceneStore((state) => state.scene);
  const selectedComponentId = useSceneStore((state) => state.selectedComponentId);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const selectedRelationId = useSceneStore((state) => state.selectedRelationId);
  const ensureObjectForComponent = useSceneStore((state) => state.ensureObjectForComponent);
  const updateComponent = useSceneStore((state) => state.updateComponent);
  const deleteComponent = useSceneStore((state) => state.deleteComponent);
  const createAssemblyRelation = useSceneStore((state) => state.createAssemblyRelation);
  const updateAssemblyRelation = useSceneStore((state) => state.updateAssemblyRelation);
  const deleteAssemblyRelation = useSceneStore((state) => state.deleteAssemblyRelation);
  const updateObjectPlacement = useSceneStore((state) => state.updateObjectPlacement);
  const deleteObject = useSceneStore((state) => state.deleteObject);
  const previewObjectTransform = useSceneStore((state) => state.previewObjectTransform);
  const clearPreviewObjectTransform = useSceneStore((state) => state.clearPreviewObjectTransform);
  const setRelationDraftTarget = useSceneStore((state) => state.setRelationDraftTarget);
  const selectRelation = useSceneStore((state) => state.selectRelation);

  const selectedObject = scene.objects.find((item) => item.id === selectedObjectId);
  const componentById = useMemo(
    () => new Map(scene.components.map((item) => [item.id, item])),
    [scene.components],
  );
  const assetById = useMemo(
    () => new Map(scene.assets.map((item) => [item.id, item])),
    [scene.assets],
  );
  const component =
    (selectedObject ? componentById.get(selectedObject.componentId) : undefined) ??
    scene.components.find((item) => item.id === selectedComponentId) ??
    scene.components[0];
  const placement = selectedObject;
  const isObjectSelection = Boolean(selectedObject);
  const deviceState = scene.deviceStates.find((item) => item.componentId === component?.id);
  const asset = scene.assets.find((item) => item.id === component?.asset3dId);
  const modelViewerUrl =
    asset?.assetType === "edrawing_html" || asset?.filePath.toLowerCase().endsWith(".html")
      ? resolveAssetUrl(asset.filePath)
      : undefined;

  const [draft, setDraft] = useState<DraftPlacement>(emptyDraft);
  const [componentNameDraft, setComponentNameDraft] = useState("");
  const [relationType, setRelationType] = useState<RelationType>("face_touch");
  const [relationObjectBId, setRelationObjectBId] = useState("");
  const [relationAnchorA, setRelationAnchorA] = useState("+x");
  const [relationAnchorB, setRelationAnchorB] = useState("-x");
  const [relationOffsetMm, setRelationOffsetMm] = useState("25");
  const [relationError, setRelationError] = useState("");
  const [relationDrafts, setRelationDrafts] = useState<Record<string, RelationDraft>>({});
  const dirtyRef = useRef(false);
  const componentLocked = isComponentLocked(component);

  useEffect(() => {
    setComponentNameDraft(component ? getComponentName(component) : "");
  }, [component?.id, component?.name, component?.componentName]);

  useEffect(() => {
    if (!placement) {
      setDraft(emptyDraft);
      return;
    }
    setDraft({
      objectName: placement.objectName,
      xMm: placement.xMm,
      yMm: placement.yMm,
      zMm: placement.zMm,
      rxDeg: placement.rxDeg,
      ryDeg: placement.ryDeg,
      rzDeg: placement.rzDeg,
      visible: placement.visible,
      locked: placement.locked,
    });
    dirtyRef.current = false;
  }, [
    placement?.id,
    placement?.objectName,
    placement?.componentId,
    placement?.xMm,
    placement?.yMm,
    placement?.zMm,
    placement?.rxDeg,
    placement?.ryDeg,
    placement?.rzDeg,
    placement?.visible,
    placement?.locked,
  ]);

  useEffect(() => {
    if (!placement?.id || !dirtyRef.current) return;
    const objectId = placement.id;
    const handle = window.setTimeout(() => {
      void updateObjectPlacement(objectId, draft);
    }, 320);
    return () => window.clearTimeout(handle);
  }, [draft, placement, updateObjectPlacement]);

  const badge = useMemo(() => stateBadge(deviceState?.state ?? {}), [deviceState]);
  const relationObjectOptions = useMemo(
    () => scene.objects.filter((object) => object.id !== placement?.id),
    [placement?.id, scene.objects],
  );
  const relationsForObject = useMemo(
    () =>
      placement
        ? scene.assemblyRelations.filter(
          (relation) => relation.objectAId === placement.id || relation.objectBId === placement.id,
        )
        : [],
    [placement, scene.assemblyRelations],
  );
  const constrainedPositionKeys = useMemo(() => {
    if (!placement) return new Set<"xMm" | "yMm" | "zMm">();
    return new Set(
      relationsForObject
        .filter((relation) => {
          const drivenObjectId = relation.properties?.drivenObjectId;
          return (
            relation.enabled &&
            drivenObjectId === placement.id &&
            ["same_position", "offset_position", "distance", "face_touch", "face_offset", "face_align_center"].includes(
              relation.relationType,
            )
          );
        })
        .map((relation) =>
          constrainedPositionKey(relation.objectAId === placement.id ? relation.selectorA : relation.selectorB),
        )
        .filter((key): key is "xMm" | "yMm" | "zMm" => key !== null),
    );
  }, [placement, relationsForObject]);
  const relationTarget = relationObjectOptions.find((object) => object.id === relationObjectBId);
  const selectedAnchorA = selectorByAnchor(relationAnchorA);
  const selectedAnchorB = selectorByAnchor(relationAnchorB);
  const normalsDot = dotNormals(selectedAnchorA.normal, selectedAnchorB.normal);
  const requiresParallel = relationType === "same_direction" || relationType === "face_parallel";
  const requiresOpposite = relationType === "opposite_direction" || relationType === "face_touch" || relationType === "face_offset";
  const requiresPerpendicular = relationType === "perpendicular_direction";
  const relationGeometryValid =
    !requiresParallel || (normalsDot !== null && Math.abs(normalsDot) >= 0.999);
  const oppositeGeometryValid =
    !requiresOpposite || (normalsDot !== null && normalsDot <= -0.999);
  const perpendicularGeometryValid =
    !requiresPerpendicular || (normalsDot !== null && Math.abs(normalsDot) <= 0.001);

  useEffect(() => {
    if (!relationObjectBId && relationObjectOptions[0]) {
      setRelationObjectBId(relationObjectOptions[0].id);
    }
  }, [relationObjectBId, relationObjectOptions]);

  useEffect(() => {
    if (!placement || !relationTarget) {
      setRelationDraftTarget(null);
      return;
    }
    setRelationDraftTarget({
      objectAId: placement.id,
      objectBId: relationTarget.id,
      anchorAId: relationAnchorA,
      anchorBId: relationAnchorB,
    });
    return () => setRelationDraftTarget(null);
  }, [placement?.id, relationTarget?.id, relationAnchorA, relationAnchorB, setRelationDraftTarget]);

  useEffect(() => {
    setRelationDrafts((current) => {
      const next: Record<string, RelationDraft> = {};
      for (const relation of relationsForObject) {
        next[relation.id] = current[relation.id] ?? relationDraft(relation);
      }
      return next;
    });
  }, [relationsForObject]);

  const setNumber = (key: keyof DraftPlacement, value: string) => {
    dirtyRef.current = true;
    const numeric = Number(value);
    setDraft((current) => ({
      ...current,
      [key]: Number.isFinite(numeric) ? numeric : 0,
    }));
  };

  const setBoolean = (key: keyof DraftPlacement, value: boolean) => {
    dirtyRef.current = true;
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const setText = (key: "objectName", value: string) => {
    dirtyRef.current = true;
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const removeSelectedObject = () => {
    if (!placement) return;
    if (window.confirm(`Remove ${placement.objectName} from the scene?`)) {
      void deleteObject(placement.id);
    }
  };

  const setComponentLocked = (locked: boolean) => {
    if (!component) return;
    void updateComponent(component.id, {
      properties: {
        ...(component.properties ?? {}),
        locked,
      },
    });
  };

  const saveComponentName = () => {
    const nextName = componentNameDraft.trim();
    if (!component || !nextName || nextName === component.name) return;
    void updateComponent(component.id, { name: nextName });
  };

  const removeComponent = () => {
    if (!component) return;
    if (componentLocked) return;
    const objectCount = scene.objects.filter((object) => object.componentId === component.id).length;
    const suffix = objectCount === 1 ? "1 object" : `${objectCount} objects`;
    if (window.confirm(`Delete ${getComponentName(component)} and remove its ${suffix} from the scene?`)) {
      void deleteComponent(component.id);
    }
  };

  const addRelation = async () => {
    if (!placement || !relationTarget) return;
    setRelationError("");
    if (requiresParallel && !relationGeometryValid) {
      setRelationError("Selected anchors must point in the same direction.");
      return;
    }
    if (requiresOpposite && !oppositeGeometryValid) {
      setRelationError("Selected anchors must point in opposite directions.");
      return;
    }
    if (requiresPerpendicular && !perpendicularGeometryValid) {
      setRelationError("Selected anchors must be perpendicular.");
      return;
    }
    const offsetMm = Number(relationOffsetMm);
    const needsOffset = relationType === "offset_position" || relationType === "distance" || relationType === "face_offset";
    if (needsOffset && !Number.isFinite(offsetMm)) {
      setRelationError("Offset or distance must be a number.");
      return;
    }
    const params =
      relationType === "offset_position" || relationType === "face_offset"
        ? { offset: selectorOffset(selectedAnchorA, offsetMm) }
        : relationType === "distance"
          ? { distance: offsetMm }
          : {};
    try {
      const anchorAId = normalizeAnchorId(selectedAnchorA.anchorId ?? "center");
      const anchorBId = normalizeAnchorId(selectedAnchorB.anchorId ?? "center");

      const relation = await createAssemblyRelation({
        name: `${placement.objectName} ${relationType} ${relationTarget.objectName}`,
        relationType,
        objectAId: placement.id,
        objectBId: relationTarget.id,
        selectorA: {
          ...selectedAnchorA,
          anchorId: anchorAId,
        },
        selectorB: {
          ...selectedAnchorB,
          anchorId: anchorBId,
        },
        offsetMm: needsOffset ? offsetMm : null,
        angleDeg: null,
        properties: {
          a: {
            objectId: placement.id,
            anchorId: anchorAId,
          },
          b: {
            objectId: relationTarget.id,
            anchorId: anchorBId,
          },
          driverObjectId: placement.id,
          drivenObjectId: relationTarget.id,
          params,
          priority: 0,
        },
      });

      setRelationError("");
      selectRelation(relation.id);
    } catch (error) {
      setRelationError(error instanceof Error ? error.message : "Failed to create relation.");
    }
  };

  const setRelationDraftValue = (relationId: string, patch: Partial<RelationDraft>) => {
    setRelationDrafts((current) => ({
      ...current,
      [relationId]: {
        ...(current[relationId] ?? relationDraft(relationsForObject.find((item) => item.id === relationId)!)),
        ...patch,
      },
    }));
  };

  const previewRelation = (relation: AssemblyRelation) => {
    const draft = relationDrafts[relation.id] ?? relationDraft(relation);
    const targetA = getRelationTarget(relation, "a");
    const targetB = getRelationTarget(relation, "b");
    const drivenObjectId = String(relation.properties?.drivenObjectId ?? relation.objectBId);
    const driverTarget = targetB.objectId !== drivenObjectId ? targetB : targetA;
    const drivenTarget = targetA.objectId === drivenObjectId ? targetA : targetB;
    const driver = scene.objects.find((object) => object.id === driverTarget.objectId);
    const driven = scene.objects.find((object) => object.id === drivenTarget.objectId);
    if (!driver || !driven) return;
    const driverComponent = componentById.get(driver.componentId);
    const drivenComponent = componentById.get(driven.componentId);
    const driverAsset = driverComponent?.asset3dId ? assetById.get(driverComponent.asset3dId) : null;
    const drivenAsset = drivenComponent?.asset3dId ? assetById.get(drivenComponent.asset3dId) : null;
    const driverAnchor = worldAnchor(driver, driverComponent, driverTarget.anchorId, driverAsset);
    const drivenAnchor = worldAnchor(driven, drivenComponent, drivenTarget.anchorId, drivenAsset);
    const anchorDelta = {
      x: drivenAnchor.position.x - driven.xMm,
      y: drivenAnchor.position.y - driven.yMm,
      z: drivenAnchor.position.z - driven.zMm,
    };
    const offset = {
      x: Number(draft.offsetX) || 0,
      y: Number(draft.offsetY) || 0,
      z: Number(draft.offsetZ) || 0,
    };
    const distance = Number(draft.distance) || 0;
    const direction = driverAnchor.direction ?? { x: 0, y: 1, z: 0 };
    let nextAnchor = { ...driverAnchor.position };
    if (relation.relationType === "offset_position" || relation.relationType === "face_offset") {
      nextAnchor = {
        x: driverAnchor.position.x + offset.x,
        y: driverAnchor.position.y + offset.y,
        z: driverAnchor.position.z + offset.z,
      };
    } else if (relation.relationType === "distance") {
      nextAnchor = {
        x: driverAnchor.position.x + direction.x * distance,
        y: driverAnchor.position.y + direction.y * distance,
        z: driverAnchor.position.z + direction.z * distance,
      };
    } else if (relation.relationType === "face_align_center") {
      const dominant = Object.entries(direction).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]?.[0];
      nextAnchor = { ...drivenAnchor.position };
      for (const axis of ["x", "y", "z"] as const) {
        if (axis !== dominant) nextAnchor[axis] = driverAnchor.position[axis];
      }
    }
    previewObjectTransform(driven.id, {
      xMm: nextAnchor.x - anchorDelta.x,
      yMm: nextAnchor.y - anchorDelta.y,
      zMm: nextAnchor.z - anchorDelta.z,
    });
  };

  const applyRelationDraft = async (relation: AssemblyRelation) => {
    const draft = relationDrafts[relation.id] ?? relationDraft(relation);
    const offset = {
      x: Number(draft.offsetX) || 0,
      y: Number(draft.offsetY) || 0,
      z: Number(draft.offsetZ) || 0,
    };
    const distance = Number(draft.distance) || 0;
    const priority = Number(draft.priority) || 0;
    const params =
      relation.relationType === "distance"
        ? { distance }
        : relation.relationType === "offset_position" || relation.relationType === "face_offset"
          ? { offset }
          : (relation.properties?.params as Record<string, unknown> | undefined) ?? {};
    try {
      await updateAssemblyRelation(relation.id, {
        enabled: draft.enabled,
        offsetMm:
          relation.relationType === "distance" ||
            relation.relationType === "offset_position" ||
            relation.relationType === "face_offset"
            ? relation.relationType === "distance"
              ? distance
              : Math.hypot(offset.x, offset.y, offset.z)
            : relation.offsetMm,
        properties: {
          ...relation.properties,
          params,
          priority,
        },
      });
      clearPreviewObjectTransform(String(relation.properties?.drivenObjectId ?? relation.objectBId));
    } catch (error) {
      setRelationError(error instanceof Error ? error.message : "Failed to update relation.");
    }
  };

  if (!component) {
    return (
      <aside className="side-panel right-panel empty-panel">
        <p className="eyebrow">Selection</p>
        <h2>No Component</h2>
      </aside>
    );
  }

  return (
    <aside className="side-panel right-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">{isObjectSelection ? "Object" : "Component"}</p>
          <h2>{isObjectSelection ? placement?.objectName : getComponentName(component)}</h2>
        </div>
        <span className={`status-badge ${badge.tone}`}>{badge.label}</span>
      </div>

      <dl className="detail-list">
        {placement && (
          <div>
            <dt>Object ID</dt>
            <dd>{placement.id ?? "pending"}</dd>
          </div>
        )}
        {isObjectSelection ? (
          <div>
            <dt>Component ID</dt>
            <dd>{component.id}</dd>
          </div>
        ) : (
          <>
            <div>
              <dt>Component</dt>
              <dd>{getComponentName(component)}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{component.componentType}</dd>
            </div>
            <div>
              <dt>Brand</dt>
              <dd>{component.brand ?? "-"}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{component.model ?? "-"}</dd>
            </div>
            <div>
              <dt>Asset</dt>
              <dd>{asset?.name ?? "primitive"}</dd>
            </div>
          </>
        )}
      </dl>

      {!isObjectSelection && (
        <section className="edit-section">
          <h3>
            <Layers3 size={17} />
            Component
          </h3>
          <label>
            <span>Name</span>
            <input value={componentNameDraft} onChange={(event) => setComponentNameDraft(event.target.value)} />
          </label>
          <div className="action-row">
            <button
              className="primary-button"
              disabled={!componentNameDraft.trim() || componentNameDraft.trim() === component.name}
              onClick={saveComponentName}
            >
              <Check size={16} />
              Save name
            </button>
            <label className="lock-toggle">
              <input
                type="checkbox"
                checked={componentLocked}
                onChange={(event) => setComponentLocked(event.target.checked)}
              />
              {componentLocked ? <Lock size={15} /> : <Unlock size={15} />}
              Lock
            </label>
            <button
              className="danger-button"
              disabled={componentLocked}
              title={componentLocked ? "Locked component cannot be deleted" : "Delete component"}
              onClick={removeComponent}
            >
              {componentLocked ? <Lock size={16} /> : <Trash2 size={16} />}
              Delete component
            </button>
          </div>
        </section>
      )}

      {!isObjectSelection && Object.keys(component.properties ?? {}).length > 0 && (
        <section className="state-section">
          <h3>
            <Layers3 size={17} />
            Component Spec
          </h3>
          <pre>{JSON.stringify(component.properties, null, 2)}</pre>
        </section>
      )}

      {!isObjectSelection && modelViewerUrl && (
        <section className="model-preview-section">
          <h3>
            <Layers3 size={17} />
            3D Model
          </h3>
          <iframe title={`${getComponentName(component)} 3D model`} src={modelViewerUrl} />
          <a className="primary-button model-link" href={modelViewerUrl} target="_blank" rel="noreferrer">
            Open eDrawing
          </a>
        </section>
      )}

      {!placement && (
        <button className="primary-button" onClick={() => void ensureObjectForComponent(component.id)}>
          <Plus size={16} />
          Add object to scene
        </button>
      )}

      {placement && (
        <>
          <section className="edit-section">
            <h3>
              <Layers3 size={17} />
              Object
            </h3>
            <label>
              <span>Name</span>
              <input
                value={draft.objectName}
                disabled={draft.locked}
                onChange={(event) => setText("objectName", event.target.value)}
              />
            </label>
          </section>

          <section className="edit-section">
            <h3>
              <Move3D size={17} />
              Object position mm
            </h3>
            <div className="number-grid">
              {(["xMm", "yMm", "zMm"] as const).map((key) => (
                <label key={key}>
                  <span>{key.replace("Mm", "").toUpperCase()}</span>
                  <input
                    type="number"
                    value={draft[key]}
                    disabled={draft.locked || constrainedPositionKeys.has(key)}
                    title={
                      constrainedPositionKeys.has(key)
                        ? "This axis is controlled by a face distance relation"
                        : undefined
                    }
                    onChange={(event) => setNumber(key, event.target.value)}
                  />
                </label>
              ))}
            </div>
          </section>

          <section className="edit-section">
            <h3>
              <RotateCw size={17} />
              Object rotation deg
            </h3>
            <div className="number-grid">
              {(["rxDeg", "ryDeg", "rzDeg"] as const).map((key) => (
                <label key={key}>
                  <span>{key.replace("Deg", "").toUpperCase()}</span>
                  <input
                    type="number"
                    value={draft[key]}
                    disabled={draft.locked}
                    onChange={(event) => setNumber(key, event.target.value)}
                  />
                </label>
              ))}
            </div>
          </section>

          <div className="toggle-row">
            <label>
              <input
                type="checkbox"
                checked={draft.visible}
                onChange={(event) => setBoolean("visible", event.target.checked)}
              />
              Visible
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.locked}
                onChange={(event) => setBoolean("locked", event.target.checked)}
              />
              {draft.locked ? <Lock size={15} /> : <Unlock size={15} />}
              Locked
            </label>
          </div>

          <button
            className="danger-button"
            title="Remove object"
            onClick={removeSelectedObject}
          >
            <Trash2 size={16} />
            Remove object
          </button>

          <section className="edit-section relation-section">
            <h3>
              <Link2 size={17} />
              Relations
            </h3>
            <label>
              <span>Type</span>
              <select value={relationType} onChange={(event) => setRelationType(event.target.value as RelationType)}>
                {relationTypes.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Driven object</span>
              <select value={relationObjectBId} onChange={(event) => setRelationObjectBId(event.target.value)}>
                {relationObjectOptions.map((object) => (
                  <option key={object.id} value={object.id}>
                    {object.objectName}
                  </option>
                ))}
              </select>
            </label>
            <div className="number-grid">
              <label>
                <span>A anchor</span>
                <select value={relationAnchorA} onChange={(event) => setRelationAnchorA(event.target.value)}>
                  {anchorOptions.map((option) => (
                    <option key={option.selector.anchorId} value={option.selector.anchorId}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>B anchor</span>
                <select value={relationAnchorB} onChange={(event) => setRelationAnchorB(event.target.value)}>
                  {anchorOptions.map((option) => (
                    <option key={option.selector.anchorId} value={option.selector.anchorId}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {relationType === "offset_position" || relationType === "distance" || relationType === "face_offset" ? (
                <label>
                  <span>{relationType === "distance" ? "Distance mm" : "Offset mm"}</span>
                  <input value={relationOffsetMm} onChange={(event) => setRelationOffsetMm(event.target.value)} />
                </label>
              ) : null}
            </div>
            {relationError && <p className="form-error">{relationError}</p>}
            <button
              className="primary-button"
              disabled={
                !relationTarget ||
                (requiresParallel && !relationGeometryValid) ||
                (requiresOpposite && !oppositeGeometryValid) ||
                (requiresPerpendicular && !perpendicularGeometryValid)
              }
              onClick={() => void addRelation()}
            >
              <Plus size={16} />
              Add relation
            </button>
            {relationsForObject.length > 0 && (
              <div className="relation-list">
                {relationsForObject.map((relation) => {
                  const otherObjectId = relation.objectAId === placement.id ? relation.objectBId : relation.objectAId;
                  const otherObject = scene.objects.find((object) => object.id === otherObjectId);
                  const draft = relationDrafts[relation.id] ?? relationDraft(relation);
                  return (
                    <div
                      className={`relation-row ${selectedRelationId === relation.id ? "active" : ""}`}
                      key={relation.id}
                      onClick={() => selectRelation(relation.id)}
                    >
                      <span>
                        <strong>{relation.relationType}</strong>
                        <small>
                          {otherObject?.objectName ?? otherObjectId}
                          {typeof relation.offsetMm === "number" ? ` / ${relation.offsetMm} mm` : ""}
                          {relation.solved ? " / solved" : relation.properties?.solveMessage ? ` / ${relation.properties.solveMessage}` : ""}
                        </small>
                      </span>
                      {(relation.relationType === "offset_position" || relation.relationType === "face_offset") && (
                        <div className="number-grid relation-grid">
                          <label>
                            <span>X</span>
                            <input value={draft.offsetX} onChange={(event) => setRelationDraftValue(relation.id, { offsetX: event.target.value })} />
                          </label>
                          <label>
                            <span>Y</span>
                            <input value={draft.offsetY} onChange={(event) => setRelationDraftValue(relation.id, { offsetY: event.target.value })} />
                          </label>
                          <label>
                            <span>Z</span>
                            <input value={draft.offsetZ} onChange={(event) => setRelationDraftValue(relation.id, { offsetZ: event.target.value })} />
                          </label>
                        </div>
                      )}
                      {relation.relationType === "distance" && (
                        <label className="relation-inline-field">
                          <span>Distance</span>
                          <input value={draft.distance} onChange={(event) => setRelationDraftValue(relation.id, { distance: event.target.value })} />
                        </label>
                      )}
                      <div className="relation-controls">
                        <label className="relation-inline-field">
                          <span>Priority</span>
                          <input value={draft.priority} onChange={(event) => setRelationDraftValue(relation.id, { priority: event.target.value })} />
                        </label>
                        <label className="relation-check">
                          <input
                            type="checkbox"
                            checked={draft.enabled}
                            onChange={(event) => setRelationDraftValue(relation.id, { enabled: event.target.checked })}
                          />
                          enabled
                        </label>
                        <button
                          className="secondary-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            selectRelation(relation.id);
                            previewRelation(relation);
                          }}
                        >
                          Preview
                        </button>
                        <button
                          className="primary-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            selectRelation(relation.id);
                            void applyRelationDraft(relation);
                          }}
                        >
                          Apply
                        </button>
                        <button
                          className="secondary-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            selectRelation(relation.id);
                            setRelationDraftValue(relation.id, relationDraft(relation));
                            clearPreviewObjectTransform(String(relation.properties?.drivenObjectId ?? relation.objectBId));
                          }}
                        >
                          Reset
                        </button>
                      </div>
                      <button
                        className="icon-button"
                        title="Delete relation"
                        onClick={(event) => {
                          event.stopPropagation();
                          void deleteAssemblyRelation(relation.id);
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      <section className="state-section">
        <h3>Device State</h3>
        <pre>{JSON.stringify(deviceState?.state ?? {}, null, 2)}</pre>
      </section>
    </aside>
  );
}
