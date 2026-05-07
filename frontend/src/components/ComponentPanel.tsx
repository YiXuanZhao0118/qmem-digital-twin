import { Check, Clock, Crosshair, Layers3, Lock, Move3D, Plus, RotateCw, Trash2, Unlock } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { resolveAssetUrl } from "../api/client";
import { useSceneStore, type LabPoint, type TransformAxis } from "../store/sceneStore";
import type { ComponentItem, SceneObject, SceneObjectPatch } from "../types/digitalTwin";
import { resolveBeamPosition } from "../utils/beamPlacement";
import { getBeamAnchor, objectPosForAnchorOnBeam } from "../utils/beamAnchor";
import { getComponentName } from "../utils/components";
import { CollapsibleSection } from "./CollapsibleSection";
import { FloatingPanel } from "./workspace/FloatingPanel";
import { useWorkspace } from "./workspace/WorkspaceProvider";
import { CapabilityPills } from "./optical/CapabilityPills";
import { OpticalElementPanel } from "./optical/OpticalElementPanel";
import { AlignPanel } from "./AlignPanel";
import { NumberField } from "./NumberField";
import { componentTypeToOpticalKind } from "../utils/opticalDefaults";

type DraftObject = Required<Omit<SceneObjectPatch, "name" | "properties" | "serialNumber">> & {
  name: string;
  serialNumber: string | null;
};

const emptyDraft: DraftObject = {
  name: "",
  xMm: 0,
  yMm: 0,
  zMm: 0,
  rxDeg: 0,
  ryDeg: 0,
  rzDeg: 0,
  visible: true,
  locked: false,
  serialNumber: null,
};

function timingCapabilityFor(
  component: ComponentItem | undefined,
  opticalElements: { objectId: string; elementKind: string; kindParams: Record<string, unknown> }[],
  sceneObjects: { id: string; componentId: string }[],
): { allowed: boolean; label: string; mode: "full" | "rf_arbitrary" | "gate_only" | "none" } {
  if (!component) return { allowed: false, label: "Timing", mode: "none" };
  // Optical elements are per-object — find any OE that belongs to a scene
  // object of this component. Two BB1 mirrors can have different kinds in
  // theory, but they shouldn't; the first match wins.
  const objIds = new Set(sceneObjects.filter((o) => o.componentId === component.id).map((o) => o.id));
  const element = opticalElements.find((oe) => objIds.has(oe.objectId));
  const kind = element?.elementKind ?? component.componentType;
  if (kind === "laser_source" || kind === "tapered_amplifier") {
    return { allowed: true, label: "Open timing editor", mode: "full" };
  }
  if (kind === "aom" || kind === "eom") {
    const rfId = (element?.kindParams ?? {})["rfDriverComponentId"] as string | null | undefined;
    if (rfId) return { allowed: true, label: "Open timing editor (RF arbitrary)", mode: "rf_arbitrary" };
    return { allowed: true, label: "Open timing editor (on/off)", mode: "gate_only" };
  }
  return { allowed: false, label: "Timing not applicable", mode: "none" };
}

function TimingEditorButton({ component }: { component: ComponentItem }) {
  const opticalElements = useSceneStore((state) => state.scene.opticalElements);
  const sceneObjects = useSceneStore((state) => state.scene.objects);
  const { togglePanelVisible, focusPanel } = useWorkspace();
  const cap = useMemo(
    () => timingCapabilityFor(component, opticalElements, sceneObjects),
    [component, opticalElements, sceneObjects],
  );
  if (!cap.allowed) return null;
  return (
    <button
      type="button"
      className="secondary-button timing-open-button"
      onClick={() => {
        togglePanelVisible("timing-editor", true);
        focusPanel("timing-editor");
      }}
    >
      <Clock size={14} />
      {cap.label}
    </button>
  );
}

function isComponentLocked(component?: { properties?: Record<string, unknown> }): boolean {
  return component?.properties?.locked === true;
}

function objectOriginMm(object: Pick<SceneObject, "xMm" | "yMm" | "zMm">): LabPoint {
  return { x: object.xMm, y: object.yMm, z: object.zMm };
}

function fmtMmShort(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return Number.isInteger(v) ? `${v}` : v.toFixed(1).replace(/\.0$/, "");
}

/** Floating-panel title for the Object panel. Single-select: name + (x, y, z).
 * Multi-select: count + truncated name list.  Component-only: component name. */
function objectPanelTitle(
  isObjectSelection: boolean,
  placement: SceneObject | undefined,
  selectedObjects: SceneObject[],
  component: ComponentItem,
): string {
  if (!isObjectSelection) return getComponentName(component);
  if (selectedObjects.length > 1) {
    const NAMES_TO_SHOW = 3;
    const names = selectedObjects.slice(0, NAMES_TO_SHOW).map((o) => o.name).join(", ");
    const tail = selectedObjects.length > NAMES_TO_SHOW
      ? ` +${selectedObjects.length - NAMES_TO_SHOW} more`
      : "";
    return `${selectedObjects.length} objects: ${names}${tail}`;
  }
  if (!placement) return "Object";
  return `${placement.name}  (${fmtMmShort(placement.xMm)}, ${fmtMmShort(placement.yMm)}, ${fmtMmShort(placement.zMm)} mm)`;
}

/** Object panel section shown when ≥ 2 objects are selected. Top: a "Group
 * centre" widget that edits the mean position/rotation and applies a delta
 * to all selected objects (Blender-style group move). Below: a scrollable
 * list of per-object transforms so the user can fine-tune one without
 * deselecting. Locked objects are read-only. */
function MultiSelectTransformPanel({ objects }: { objects: SceneObject[] }) {
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const editable = objects.filter((o) => !o.locked);

  const center = {
    xMm: average(editable.map((o) => o.xMm)),
    yMm: average(editable.map((o) => o.yMm)),
    zMm: average(editable.map((o) => o.zMm)),
    rxDeg: average(editable.map((o) => o.rxDeg)),
    ryDeg: average(editable.map((o) => o.ryDeg)),
    rzDeg: average(editable.map((o) => o.rzDeg)),
  };

  /** Apply a delta to every editable object's position. */
  const setCenterPos = async (axis: "xMm" | "yMm" | "zMm", next: number) => {
    const delta = next - center[axis];
    if (Math.abs(delta) < 1e-9) return;
    await Promise.all(
      editable.map((o) =>
        updateSceneObject(o.id, { [axis]: o[axis] + delta } as { xMm?: number; yMm?: number; zMm?: number }),
      ),
    );
  };

  const setCenterRot = async (axis: "rxDeg" | "ryDeg" | "rzDeg", next: number) => {
    const delta = next - center[axis];
    if (Math.abs(delta) < 1e-9) return;
    await Promise.all(
      editable.map((o) =>
        updateSceneObject(o.id, { [axis]: o[axis] + delta } as {
          rxDeg?: number;
          ryDeg?: number;
          rzDeg?: number;
        }),
      ),
    );
  };

  return (
    <>
      <section className="edit-section multiselect-summary">
        <h3>
          <Layers3 size={17} />
          Multi-select ({objects.length} objects, {editable.length} editable)
        </h3>
      </section>

      <section className="edit-section">
        <h3>
          <Crosshair size={17} />
          Group centre position mm
        </h3>
        <div className="number-grid">
          {(["xMm", "yMm", "zMm"] as const).map((key) => (
            <label key={key}>
              <span>{key.replace("Mm", "").toUpperCase()}</span>
              <NumberField
                value={center[key]}
                onChange={(v) => void setCenterPos(key, v)}
                disabled={editable.length === 0}
                title="Edits delta — applied to every selected object"
              />
            </label>
          ))}
        </div>
        <div className="multiselect-hint">
          Editing here moves every selected object by the same delta.
        </div>
      </section>

      <section className="edit-section">
        <h3>
          <RotateCw size={17} />
          Group centre rotation deg
        </h3>
        <div className="number-grid">
          {(["rxDeg", "ryDeg", "rzDeg"] as const).map((key) => (
            <label key={key}>
              <span>{key.replace("Deg", "").toUpperCase()}</span>
              <NumberField
                value={center[key]}
                onChange={(v) => void setCenterRot(key, v)}
                disabled={editable.length === 0}
                title="Adds delta to each object's own rotation"
              />
            </label>
          ))}
        </div>
        <div className="multiselect-hint">
          Adds the same delta to each object's rotation independently (does
          not orbit them around the centre).
        </div>
      </section>

      <section className="edit-section">
        <h3>
          <Move3D size={17} />
          Per-object transforms
        </h3>
        <div className="multiselect-list">
          {objects.map((o) => (
            <PerObjectRow key={o.id} object={o} updateSceneObject={updateSceneObject} />
          ))}
        </div>
      </section>
    </>
  );
}

function PerObjectRow({
  object,
  updateSceneObject,
}: {
  object: SceneObject;
  updateSceneObject: (id: string, patch: Partial<Pick<SceneObject, "xMm" | "yMm" | "zMm" | "rxDeg" | "ryDeg" | "rzDeg">>) => Promise<void>;
}) {
  const setField = (key: "xMm" | "yMm" | "zMm" | "rxDeg" | "ryDeg" | "rzDeg") => (next: number) =>
    void updateSceneObject(object.id, { [key]: next } as Partial<Pick<SceneObject, "xMm" | "yMm" | "zMm" | "rxDeg" | "ryDeg" | "rzDeg">>);
  return (
    <div className={`multiselect-row${object.locked ? " locked" : ""}`}>
      <div className="multiselect-row-header" title={object.id}>
        {object.locked ? <Lock size={11} /> : null}
        <span className="multiselect-row-name">{object.name}</span>
      </div>
      <div className="multiselect-row-fields">
        <span className="multiselect-row-axis-group">pos</span>
        {(["xMm", "yMm", "zMm"] as const).map((key) => (
          <label key={key}>
            <span>{key.replace("Mm", "").toUpperCase()}</span>
            <NumberField
              value={object[key]}
              onChange={setField(key)}
              disabled={object.locked}
            />
          </label>
        ))}
      </div>
      <div className="multiselect-row-fields">
        <span className="multiselect-row-axis-group">rot</span>
        {(["rxDeg", "ryDeg", "rzDeg"] as const).map((key) => (
          <label key={key}>
            <span>{key.replace("Deg", "").toUpperCase()}</span>
            <NumberField
              value={object[key]}
              onChange={setField(key)}
              disabled={object.locked}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function PlacedRelativeToReadout({ placement }: { placement: SceneObject | undefined }) {
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const scene = useSceneStore((state) => state.scene);
  const [resnapError, setResnapError] = useState<string | null>(null);

  if (!placement) return null;
  const meta = (placement.properties as {
    placedRelativeTo?: {
      kind: string;
      recordedAt?: string;
      // Current per-OBJECT beam_along schema (alembic 0014+):
      fromObjectId?: string;
      fromPort?: string;
      offsetMm?: number;
      bridgedViaObjectId?: string;
      // Open-bridge metadata (target was lifted from a chain-tail position;
      // the segment extends from upstream past target's old slot to ∞).
      bridgedOpen?: boolean;
      bridgedDirection?: { x: number; y: number; z: number };
      // Interim per-COMPONENT schema (between segment-rewrite and 0014):
      fromComponentId?: string;
      bridgedViaComponentId?: string;
      // Legacy beam_along fields (original):
      linkId?: string;
      toComponentId?: string;
      distanceMm?: number;
      // Touch tools:
      refObjectId?: string;
      refAnchorId?: string;
    };
  } | undefined)?.placedRelativeTo;
  if (!meta || meta.kind === "absolute") return null;

  const human = (() => {
    switch (meta.kind) {
      case "beam_along": {
        const off = meta.offsetMm ?? meta.distanceMm;
        // Prefer per-object name (current schema), fall back to component
        // (interim schema), then "?".
        let fromName = "?";
        if (meta.fromObjectId) {
          const obj = scene.objects.find((o) => o.id === meta.fromObjectId);
          fromName = obj?.name ?? meta.fromObjectId.slice(0, 6);
        } else if (meta.fromComponentId) {
          fromName = scene.components.find((c) => c.id === meta.fromComponentId)?.name ?? "?";
        }
        const sign = off !== undefined && off < 0 ? "" : off !== undefined && off > 0 ? "+" : "";
        const bridgeNote = meta.bridgedOpen
          ? " (open bridge ∞)"
          : meta.bridgedViaObjectId
            ? " (bridged)"
            : "";
        return `${sign}${off?.toFixed(1) ?? "?"} mm from ${fromName}${meta.fromPort ? ` (${meta.fromPort})` : ""}${bridgeNote}`;
      }
      case "beam_centerline":
        return `centreline of beam …${meta.linkId?.slice(-4) ?? "?"}`;
      // Touch ops: vv/ve/vf/ee/ef/ff_touch (current) + legacy face/edge/vertex_touch.
      case "vv_touch":
      case "vertex_touch": {
        const ref = scene.objects.find((o) => o.id === meta.refObjectId);
        return `vertex⇄vertex with ${ref?.name ?? meta.refObjectId?.slice(0, 6) ?? "?"}`;
      }
      case "ve_touch": {
        const ref = scene.objects.find((o) => o.id === meta.refObjectId);
        return `vertex⇄edge with ${ref?.name ?? meta.refObjectId?.slice(0, 6) ?? "?"}`;
      }
      case "vf_touch": {
        const ref = scene.objects.find((o) => o.id === meta.refObjectId);
        return `vertex⇄face with ${ref?.name ?? meta.refObjectId?.slice(0, 6) ?? "?"}`;
      }
      case "ee_touch":
      case "edge_touch": {
        const ref = scene.objects.find((o) => o.id === meta.refObjectId);
        return `edge⇄edge with ${ref?.name ?? meta.refObjectId?.slice(0, 6) ?? "?"}`;
      }
      case "ef_touch": {
        const ref = scene.objects.find((o) => o.id === meta.refObjectId);
        return `edge⇄face with ${ref?.name ?? meta.refObjectId?.slice(0, 6) ?? "?"}`;
      }
      case "ff_touch":
      case "face_touch": {
        const ref = scene.objects.find((o) => o.id === meta.refObjectId);
        return `face⇄face with ${ref?.name ?? meta.refObjectId?.slice(0, 6) ?? "?"}`;
      }
      case "anchor_match": {
        const ref = scene.objects.find((o) => o.id === meta.refObjectId);
        return `anchor "${meta.refAnchorId}" of ${ref?.name ?? "?"}`;
      }
      case "vertex_snap": {
        const ref = scene.objects.find((o) => o.id === meta.refObjectId);
        return `vertex of ${ref?.name ?? "?"}`;
      }
      case "cursor":
        return "at 3D cursor";
      default:
        return meta.kind;
    }
  })();

  // Re-snap reuses the BeamPlacement resolver. We accept three schema
  // generations: per-object (current), per-component (interim), and
  // legacy {linkId, distanceMm}. Touch kinds throw away picking geometry,
  // so no Re-snap for those.
  const canResnap = meta.kind === "beam_along" &&
    ((meta.fromObjectId && meta.fromPort && meta.offsetMm !== undefined) ||
     (meta.fromComponentId && meta.fromPort && meta.offsetMm !== undefined) ||
     meta.distanceMm !== undefined);

  const onResnap = async () => {
    if (!canResnap) return;
    setResnapError(null);

    // Normalise schemas for the resolver. Schemas seen in the wild:
    //  (current, alembic 0014+) { fromObjectId, fromPort, offsetMm, bridgedViaObjectId? }
    //  (interim) { fromComponentId, fromPort, offsetMm } — pre-0014, post-segment-rewrite
    //  (legacy) { linkId, distanceMm, fromComponentId?, toComponentId? } — original
    type ResolveMeta = {
      fromObjectId: string;
      fromPort: string;
      offsetMm: number;
      bridgedViaObjectId?: string;
      bridgedOpen?: boolean;
      bridgedDirection?: { x: number; y: number; z: number };
    };
    let resolveMeta: ResolveMeta | null = null;
    const newOffsetMm = (meta as { offsetMm?: number }).offsetMm;
    const newFromPort = (meta as { fromPort?: string }).fromPort;
    const newFromObjectId = (meta as { fromObjectId?: string }).fromObjectId;
    const newBridgedViaObjectId = (meta as { bridgedViaObjectId?: string }).bridgedViaObjectId;
    const newBridgedOpen = (meta as { bridgedOpen?: boolean }).bridgedOpen;
    const newBridgedDirection = (meta as { bridgedDirection?: { x: number; y: number; z: number } }).bridgedDirection;

    if (newFromObjectId && newFromPort && newOffsetMm !== undefined) {
      // Newest per-object schema — direct.
      resolveMeta = {
        fromObjectId: newFromObjectId,
        fromPort: newFromPort,
        offsetMm: newOffsetMm,
        bridgedViaObjectId: newBridgedViaObjectId,
        bridgedOpen: newBridgedOpen,
        bridgedDirection: newBridgedDirection,
      };
    } else if (meta.fromComponentId && newFromPort && newOffsetMm !== undefined) {
      // Interim per-component schema → find first scene object of that component.
      const obj = scene.objects.find((o) => o.componentId === meta.fromComponentId);
      if (!obj) {
        setResnapError("Original component no longer in scene. Use the wand toolbar button to re-place.");
        return;
      }
      resolveMeta = {
        fromObjectId: obj.id,
        fromPort: newFromPort,
        offsetMm: newOffsetMm,
        bridgedViaObjectId: meta.bridgedViaComponentId
          ? scene.objects.find((o) => o.componentId === meta.bridgedViaComponentId)?.id
          : undefined,
      };
    } else if (meta.distanceMm !== undefined) {
      // Legacy path: find the link, derive fromObject + fromPort.
      let link = undefined as typeof scene.opticalLinks[number] | undefined;
      // `linkId` is volatile; can't trust it. Try component pair → find
      // link whose endpoint scene-objects' component_ids match.
      if (meta.fromComponentId && meta.toComponentId) {
        link = scene.opticalLinks.find((l) => {
          const fObj = scene.objects.find((o) => o.id === l.fromObjectId);
          const tObj = scene.objects.find((o) => o.id === l.toObjectId);
          return fObj?.componentId === meta.fromComponentId && tObj?.componentId === meta.toComponentId;
        });
      }
      if (!link) {
        const tol = Math.max(1, meta.distanceMm * 0.01);
        const cands = scene.opticalLinks.filter((l) => Math.abs((l.freeSpaceMm ?? 0) - meta.distanceMm!) < tol);
        if (cands.length === 1) link = cands[0];
      }
      if (!link) {
        setResnapError("Original beam no longer exists. Use the wand toolbar button to re-place.");
        return;
      }
      resolveMeta = { fromObjectId: link.fromObjectId, fromPort: link.fromPort, offsetMm: meta.distanceMm };
    }
    if (!resolveMeta) {
      setResnapError("Couldn't reconstruct placement intent from saved metadata.");
      return;
    }

    const beamPos = resolveBeamPosition(resolveMeta, scene);
    if (!beamPos) {
      setResnapError("Couldn't resolve the beam position — segment endpoints missing or solver hasn't run.");
      return;
    }
    const anchor = getBeamAnchor(placement.id, scene);
    const finalPos = objectPosForAnchorOnBeam(
      beamPos,
      placement.rxDeg,
      placement.ryDeg,
      placement.rzDeg,
      anchor,
    );
    await updateSceneObject(placement.id, {
      xMm: finalPos.x,
      yMm: finalPos.y,
      zMm: finalPos.z,
      properties: {
        ...(placement.properties ?? {}),
        placedRelativeTo: {
          kind: "beam_along",
          fromObjectId: resolveMeta.fromObjectId,
          fromPort: resolveMeta.fromPort,
          offsetMm: resolveMeta.offsetMm,
          ...(resolveMeta.bridgedViaObjectId
            ? { bridgedViaObjectId: resolveMeta.bridgedViaObjectId }
            : {}),
          ...(resolveMeta.bridgedOpen
            ? {
                bridgedOpen: true,
                bridgedDirection: resolveMeta.bridgedDirection,
              }
            : {}),
          recordedAt: new Date().toISOString(),
        },
      },
    });
  };

  const onRelease = async () => {
    setResnapError(null);
    // Strip the placedRelativeTo metadata so future drags don't re-snap
    // against stale geometry. Position stays where it is — only the
    // "this is locked to that beam" semantic is removed.
    const props = { ...(placement.properties ?? {}) };
    delete (props as Record<string, unknown>).placedRelativeTo;
    await updateSceneObject(placement.id, { properties: props });
  };

  return (
    <div className="placed-relative-to">
      <span className="placed-relative-to-label">Placed by:</span>
      <span className="placed-relative-to-value">{human}</span>
      {canResnap && (
        <button
          type="button"
          className="placed-relative-to-resnap"
          title="Re-apply this placement against current upstream geometry"
          onClick={() => void onResnap()}
        >
          Re-snap
        </button>
      )}
      <button
        type="button"
        className="placed-relative-to-release"
        title="Forget this placement (object stays where it is, but no longer linked to that segment)"
        onClick={() => void onRelease()}
      >
        Release
      </button>
      {resnapError && (
        <span className="placed-relative-to-error" role="alert">
          ⚠ {resnapError}
        </span>
      )}
    </div>
  );
}

function averageLabPoints(points: LabPoint[]): LabPoint | null {
  if (points.length === 0) return null;
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    z: points.reduce((sum, point) => sum + point.z, 0) / points.length,
  };
}

function formatMm(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function formatLabPoint(point: LabPoint): string {
  return `X ${formatMm(point.x)} / Y ${formatMm(point.y)} / Z ${formatMm(point.z)} mm`;
}

function parseMmInput(value: string, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function ComponentPanel() {
  const scene = useSceneStore((state) => state.scene);
  const selectedComponentId = useSceneStore((state) => state.selectedComponentId);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const selectedObjectIds = useSceneStore((state) => state.selectedObjectIds);
  const ensureObjectForComponent = useSceneStore((state) => state.ensureObjectForComponent);
  const updateComponent = useSceneStore((state) => state.updateComponent);
  const deleteComponent = useSceneStore((state) => state.deleteComponent);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const deleteObject = useSceneStore((state) => state.deleteObject);

  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const confirmRemoveTimer = useRef<number | null>(null);

  const selectedObject = scene.objects.find((item) => item.id === selectedObjectId);
  const componentById = useMemo(
    () => new Map(scene.components.map((item) => [item.id, item])),
    [scene.components],
  );
  const component =
    (selectedObject ? componentById.get(selectedObject.componentId) : undefined) ??
    scene.components.find((item) => item.id === selectedComponentId) ??
    scene.components[0];
  const placement = selectedObject;
  const isObjectSelection = Boolean(selectedObject);
  // Device state is now per-OBJECT (alembic 0015). Match by selected object,
  // not by component template — siblings of the same component each have
  // their own runtime state.
  const deviceState = scene.deviceStates.find(
    (item) => selectedObject && item.objectId === selectedObject.id,
  );
  const asset = scene.assets.find((item) => item.id === component?.asset3dId);
  const modelViewerUrl =
    asset?.assetType === "edrawing_html" || asset?.filePath.toLowerCase().endsWith(".html")
      ? resolveAssetUrl(asset.filePath)
      : undefined;
  const selectedObjects = useMemo(() => {
    const selectedIdSet = new Set(selectedObjectIds);
    const objects = scene.objects.filter((object) => selectedIdSet.has(object.id));
    return objects.length > 0 ? objects : placement ? [placement] : [];
  }, [placement, scene.objects, selectedObjectIds]);
  const [draft, setDraft] = useState<DraftObject>(emptyDraft);
  const [componentNameDraft, setComponentNameDraft] = useState("");
  const dirtyRef = useRef(false);
  const componentLocked = isComponentLocked(component);
  // Direct x/y/z/rx/ry/rz editing is always allowed. The previous P2
  // (lock when object has incoming optical_link) was removed when the
  // Beam Placement panel was retired — users align via the per-object
  // "Snap to beam" button instead and can still nudge by typing.
  const positionLocked = draft.locked;

  useEffect(() => {
    setComponentNameDraft(component ? getComponentName(component) : "");
  }, [component?.id, component?.name, component?.componentName]);

  useEffect(() => {
    setConfirmingRemove(false);
    if (confirmRemoveTimer.current) {
      window.clearTimeout(confirmRemoveTimer.current);
      confirmRemoveTimer.current = null;
    }
  }, [placement?.id]);

  useEffect(() => () => {
    if (confirmRemoveTimer.current) window.clearTimeout(confirmRemoveTimer.current);
  }, []);

  useEffect(() => {
    if (!placement) {
      setDraft(emptyDraft);
      return;
    }
    setDraft({
      name: placement.name,
      xMm: placement.xMm,
      yMm: placement.yMm,
      zMm: placement.zMm,
      rxDeg: placement.rxDeg,
      ryDeg: placement.ryDeg,
      rzDeg: placement.rzDeg,
      visible: placement.visible,
      locked: placement.locked,
      serialNumber: placement.serialNumber ?? null,
    });
    dirtyRef.current = false;
  }, [
    placement?.id,
    placement?.name,
    placement?.componentId,
    placement?.xMm,
    placement?.yMm,
    placement?.zMm,
    placement?.rxDeg,
    placement?.ryDeg,
    placement?.rzDeg,
    placement?.visible,
    placement?.locked,
    placement?.serialNumber,
  ]);

  useEffect(() => {
    if (!placement?.id || !dirtyRef.current) return;
    const objectId = placement.id;
    const handle = window.setTimeout(() => {
      void updateSceneObject(objectId, draft);
    }, 320);
    return () => window.clearTimeout(handle);
  }, [draft, placement, updateSceneObject]);

  const setNumber = (key: keyof DraftObject, value: string) => {
    dirtyRef.current = true;
    const numeric = Number(value);
    setDraft((current) => ({
      ...current,
      [key]: Number.isFinite(numeric) ? numeric : 0,
    }));
  };

  const setBoolean = (key: keyof DraftObject, value: boolean) => {
    dirtyRef.current = true;
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const setText = (key: "name", value: string) => {
    dirtyRef.current = true;
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const removeSelectedObject = () => {
    if (!placement) return;
    if (confirmingRemove) {
      void deleteObject(placement.id);
      setConfirmingRemove(false);
      if (confirmRemoveTimer.current) {
        window.clearTimeout(confirmRemoveTimer.current);
        confirmRemoveTimer.current = null;
      }
      return;
    }
    setConfirmingRemove(true);
    if (confirmRemoveTimer.current) window.clearTimeout(confirmRemoveTimer.current);
    confirmRemoveTimer.current = window.setTimeout(() => {
      setConfirmingRemove(false);
      confirmRemoveTimer.current = null;
    }, 3000);
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

  if (!component) {
    return (
      <>
        <FloatingPanel id="object" title="Object">
          <p className="empty-state">No selection</p>
        </FloatingPanel>
        <FloatingPanel id="device-state" title="Device state">
          <p className="empty-state">No selection</p>
        </FloatingPanel>
      </>
    );
  }

  return (
    <>
      <FloatingPanel
        id="object"
        title={objectPanelTitle(isObjectSelection, placement, selectedObjects, component)}
      >

      {!isObjectSelection && (
        <dl className="detail-list">
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
        </dl>
      )}

      {!isObjectSelection && component && <CapabilityPills component={component} />}

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
        <CollapsibleSection
          id="component-spec"
          icon={<Layers3 size={15} />}
          title="Component spec"
          className="state-section"
        >
          <pre>{JSON.stringify(component.properties, null, 2)}</pre>
        </CollapsibleSection>
      )}

      {!isObjectSelection && modelViewerUrl && (
        <CollapsibleSection
          id="component-3d-model"
          icon={<Layers3 size={15} />}
          title="3D model"
          className="model-preview-section"
        >
          <iframe title={`${getComponentName(component)} 3D model`} src={modelViewerUrl} />
          <a className="primary-button model-link" href={modelViewerUrl} target="_blank" rel="noreferrer">
            Open eDrawing
          </a>
        </CollapsibleSection>
      )}

      {!placement && (
        <button className="primary-button" onClick={() => void ensureObjectForComponent(component.id)}>
          <Plus size={16} />
          Add object at cursor
        </button>
      )}

      {placement && selectedObjects.length > 1 && (
        <MultiSelectTransformPanel objects={selectedObjects} />
      )}

      {placement && selectedObjects.length <= 1 && (
        <>
          <section className="edit-section">
            <h3>
              <Layers3 size={17} />
              Object
            </h3>
            <label>
              <span>Name</span>
              <input
                value={draft.name}
                disabled={draft.locked}
                onChange={(event) => setText("name", event.target.value)}
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
                  <NumberField
                    value={draft[key] as number}
                    onChange={(next) => setNumber(key, String(next))}
                    disabled={positionLocked}
                    midOnAxis={(a, b) => {
                      const aObj = scene.objects.find((o) => o.name === a);
                      const bObj = scene.objects.find((o) => o.name === b);
                      if (!aObj || !bObj) return null;
                      return ((aObj[key] as number) + (bObj[key] as number)) / 2;
                    }}
                  />
                </label>
              ))}
            </div>
            <PlacedRelativeToReadout placement={placement} />
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
                    disabled={positionLocked}
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
            className={`danger-button${confirmingRemove ? " confirming" : ""}`}
            title={confirmingRemove ? "Click again to confirm deletion" : "Remove object"}
            onClick={removeSelectedObject}
          >
            <Trash2 size={16} />
            {confirmingRemove ? "Click again to confirm" : "Remove object"}
          </button>

          {(component?.physicsCapabilities?.includes("optical") ||
            componentTypeToOpticalKind(component?.componentType) !== null) && (
            <OpticalElementPanel component={component} sceneObject={placement} />
          )}
        </>
      )}

      <AlignPanel />
      {component && <TimingEditorButton component={component} />}
      </FloatingPanel>

      <FloatingPanel id="device-state" title="Device state">
        <pre>{JSON.stringify(deviceState?.state ?? {}, null, 2)}</pre>
      </FloatingPanel>
    </>
  );
}
