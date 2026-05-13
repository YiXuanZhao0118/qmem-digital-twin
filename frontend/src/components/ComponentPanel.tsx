import { Check, Clock, Crosshair, Layers3, Lock, Move3D, Plus, RotateCw, Trash2, Type, Unlock } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { resolveAssetUrl } from "../api/client";
import { useSceneStore, type LabPoint, type TransformAxis } from "../store/sceneStore";
import type { ComponentItem, SceneObject, SceneObjectPatch } from "../types/digitalTwin";
import { resolveBeamPosition } from "../utils/beamPlacement";
import { getBeamAnchor, objectPosForAnchorOnBeam } from "../utils/beamAnchor";
import { getComponentName } from "../utils/components";
import { getFiberPortLabPose } from "../utils/fiberAlignment";
import { CollapsibleSection } from "./CollapsibleSection";
import { LinkedSchematicsSection } from "./LinkedSchematicsSection";
import { RfChainReadout } from "./RfChainReadout";
import { ScrubTimeRfReadout } from "./ScrubTimeRfReadout";
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

/** Editor for free-form text annotations (componentType === "text_annotation").
 *  All fields write to the COMPONENT's properties — text/textColor/bgColor/
 *  accentColor/fontSizePx/scaleMm — which `createTextAnnotation` reads when
 *  the canvas-textured sprite is built. We keep the SceneObject untouched
 *  here; position/rotation are handled by the standard transform widgets
 *  shared with every other object. */
function TextAnnotationEditor({ component }: { component: ComponentItem }) {
  const updateComponent = useSceneStore((state) => state.updateComponent);
  const props = (component.properties ?? {}) as {
    text?: unknown;
    textColor?: unknown;
    bgColor?: unknown;
    accentColor?: unknown;
    fontSizePx?: unknown;
    scaleMm?: unknown;
  };
  const initialText = typeof props.text === "string" ? props.text : "";
  const initialTextColor = typeof props.textColor === "string" ? props.textColor : "#ffffff";
  const initialAccent = typeof props.accentColor === "string" ? props.accentColor : "#38bdf8";
  const initialBg = typeof props.bgColor === "string" ? props.bgColor : "rgba(15, 23, 42, 0.85)";
  const initialFontSize = typeof props.fontSizePx === "number" ? props.fontSizePx : 56;
  const initialScale = typeof props.scaleMm === "number" ? props.scaleMm : 80;

  const [textDraft, setTextDraft] = useState(initialText);
  // Re-sync local draft when the user selects a different annotation. We
  // key on component.id so flipping between two text annotations doesn't
  // leak the previous draft into the new one.
  useEffect(() => {
    setTextDraft(initialText);
  }, [component.id, initialText]);

  const writeProps = (patch: Record<string, unknown>) => {
    void updateComponent(component.id, {
      properties: { ...(component.properties ?? {}), ...patch },
    });
  };

  const commitText = () => {
    const next = textDraft;
    if (next === initialText) return;
    // Also update the component name so the Outliner row tracks the label.
    writeProps({ text: next });
    if (next.trim().length > 0) {
      void updateComponent(component.id, {
        name: next.trim(),
        properties: { ...(component.properties ?? {}), text: next },
      });
    }
  };

  // <input type="color"> can only emit `#rrggbb`. The bg colour stores an
  // rgba() string by default to support translucency, so we round-trip
  // through hex for the picker but preserve any user-typed CSS string in a
  // sibling text field.
  const bgHex = (() => {
    const m = /^#([0-9a-f]{6})$/i.exec(initialBg);
    return m ? `#${m[1]}` : "#0f172a";
  })();

  return (
    <section className="edit-section">
      <h3>
        <Type size={17} />
        Text annotation
      </h3>
      <label>
        <span>Content</span>
        <textarea
          value={textDraft}
          onChange={(event) => setTextDraft(event.target.value)}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              commitText();
              (event.currentTarget as HTMLTextAreaElement).blur();
            }
          }}
          rows={2}
          placeholder="Label text"
        />
      </label>
      <div className="number-grid">
        <label>
          <span>Width mm</span>
          <NumberField
            value={initialScale}
            onChange={(next) => writeProps({ scaleMm: Math.max(10, next) })}
          />
        </label>
        <label>
          <span>Font px</span>
          <NumberField
            value={initialFontSize}
            onChange={(next) => writeProps({ fontSizePx: Math.max(12, Math.min(256, next)) })}
          />
        </label>
      </div>
      <div className="number-grid">
        <label>
          <span>Text</span>
          <input
            type="color"
            value={initialTextColor}
            onChange={(event) => writeProps({ textColor: event.target.value })}
          />
        </label>
        <label>
          <span>Border</span>
          <input
            type="color"
            value={initialAccent}
            onChange={(event) => writeProps({ accentColor: event.target.value })}
          />
        </label>
        <label>
          <span>Panel</span>
          <input
            type="color"
            value={bgHex}
            onChange={(event) => writeProps({ bgColor: event.target.value })}
          />
        </label>
      </div>
    </section>
  );
}

/** Editor controls for `fiber` components. The actual node + tangent
 *  handle gizmo lives in DigitalTwinViewer (raycaster-based); this panel
 *  only toggles edit mode and exposes the overall tube radius. Per-node
 *  tension is dragged via the cyan handle tips in 3D, not from this
 *  panel. */
/** Fiber warnings: minimum bend radius (computed from spline curvature),
 *  wavelength out of operating range, input power above max. Read-only;
 *  surfaced in the FiberEditor section so the user sees them at a glance. */
function FiberWarnings({ component }: { component: ComponentItem }) {
  const opticalElement = useSceneStore((state) =>
    state.scene.opticalElements.find((e) => {
      const obj = state.scene.objects.find((o) => o.id === e.objectId);
      return obj?.componentId === component.id;
    }),
  );
  // Per-instance fiberNodes live on SceneObject.properties (V2); fall back
  // to the catalog template (Component.properties) for legacy data.
  const sceneObjectForFiber = useSceneStore((state) =>
    state.scene.objects.find((o) => o.componentId === component.id),
  );
  const objProps = (sceneObjectForFiber?.properties ?? {}) as {
    fiberNodes?: { posMm: [number, number, number]; handleInMm?: [number, number, number]; handleOutMm?: [number, number, number] }[];
  };
  const compProps = (component.properties ?? {}) as {
    fiberNodes?: { posMm: [number, number, number]; handleInMm?: [number, number, number]; handleOutMm?: [number, number, number] }[];
  };
  const warnings: string[] = [];
  // 1. Minimum bend radius — sample curvature at 32 points along each segment
  const nodes =
    (objProps.fiberNodes && objProps.fiberNodes.length >= 2)
      ? objProps.fiberNodes
      : compProps.fiberNodes;
  if (nodes && nodes.length >= 2 && opticalElement?.elementKind === "fiber") {
    const minBend = ((opticalElement.kindParams as Record<string, unknown>).minBendRadiusMm ?? 25) as number;
    let minR = Number.POSITIVE_INFINITY;
    for (let i = 0; i < nodes.length - 1; i += 1) {
      const a = nodes[i];
      const b = nodes[i + 1];
      const p0 = a.posMm;
      const p3 = b.posMm;
      const handleOut = a.handleOutMm ?? [
        (p3[0] - p0[0]) / 3, (p3[1] - p0[1]) / 3, (p3[2] - p0[2]) / 3,
      ];
      const handleIn = b.handleInMm ?? [
        -(p3[0] - p0[0]) / 3, -(p3[1] - p0[1]) / 3, -(p3[2] - p0[2]) / 3,
      ];
      const p1: [number, number, number] = [p0[0] + handleOut[0], p0[1] + handleOut[1], p0[2] + handleOut[2]];
      const p2: [number, number, number] = [p3[0] + handleIn[0], p3[1] + handleIn[1], p3[2] + handleIn[2]];
      // Sample curvature at t = 0.1, 0.2 ..., 0.9
      for (let j = 1; j < 10; j += 1) {
        const t = j / 10;
        const u = 1 - t;
        // Cubic Bezier first derivative
        const dx = 3 * u * u * (p1[0] - p0[0]) + 6 * u * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]);
        const dy = 3 * u * u * (p1[1] - p0[1]) + 6 * u * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]);
        const dz = 3 * u * u * (p1[2] - p0[2]) + 6 * u * t * (p2[2] - p1[2]) + 3 * t * t * (p3[2] - p2[2]);
        // Second derivative
        const ddx = 6 * u * (p2[0] - 2 * p1[0] + p0[0]) + 6 * t * (p3[0] - 2 * p2[0] + p1[0]);
        const ddy = 6 * u * (p2[1] - 2 * p1[1] + p0[1]) + 6 * t * (p3[1] - 2 * p2[1] + p1[1]);
        const ddz = 6 * u * (p2[2] - 2 * p1[2] + p0[2]) + 6 * t * (p3[2] - 2 * p2[2] + p1[2]);
        const speed = Math.hypot(dx, dy, dz);
        const cx = dy * ddz - dz * ddy;
        const cy = dz * ddx - dx * ddz;
        const cz = dx * ddy - dy * ddx;
        const crossMag = Math.hypot(cx, cy, cz);
        if (crossMag > 1e-6) {
          const R = Math.pow(speed, 3) / crossMag;
          if (R < minR) minR = R;
        }
      }
    }
    if (Number.isFinite(minR) && minR < minBend) {
      warnings.push(
        `⚠ Minimum bend radius ${minR.toFixed(1)} mm is below spec ${minBend} mm — extra bend loss + long-term stress fatigue.`,
      );
    }
  }
  // 2. Wavelength out of range — fiber kind has operatingWavelengthRangeNm
  // (we'd need an actual incoming beam wavelength; we'll skip live check
  // here, as it requires Phase H ray-tracer. For v1, surface if cutoff
  // is unset for SM/PM.)
  if (opticalElement?.elementKind === "fiber") {
    const kp = opticalElement.kindParams as Record<string, unknown>;
    if (kp.fiberType !== "multi_mode" && kp.cutoffWavelengthNm == null) {
      warnings.push(`ℹ SM/PM fiber has no cutoff wavelength set — cannot validate single-mode operation.`);
    }
  }
  // 3. Power: requires actual beam power — surfaced from Phase H ray-trace
  // metadata in a future iteration.
  if (warnings.length === 0) return null;
  return (
    <div style={{
      marginTop: 8,
      padding: 6,
      background: "rgba(252, 165, 41, 0.12)",
      border: "1px solid rgba(252, 165, 41, 0.4)",
      borderRadius: 4,
      fontSize: 11,
      lineHeight: 1.5,
    }}>
      {warnings.map((w, i) => <div key={i}>{w}</div>)}
    </div>
  );
}

/** Read-only efficiency display: calls the Phase B coupling library
 *  to show η_total + breakdown for an idealized 780 nm Gaussian probe
 *  beam matched to the fiber's own MFD. This is a sanity-check / pedagogy
 *  display — once Phase H ray-tracer integration is live, the actual
 *  per-segment coupling will replace this with the real beam state. */
function FiberEfficiencyDisplay({ component }: { component: ComponentItem }) {
  const opticalElement = useSceneStore((state) =>
    state.scene.opticalElements.find((e) => {
      const obj = state.scene.objects.find((o) => o.id === e.objectId);
      return obj?.componentId === component.id;
    }),
  );
  // Prefer per-instance fiberNodes (SceneObject.properties); fall back to
  // catalog template for legacy data. Same pattern as FiberWarnings above.
  const sceneObjectForEff = useSceneStore((state) =>
    state.scene.objects.find((o) => o.componentId === component.id),
  );
  const objProps = (sceneObjectForEff?.properties ?? {}) as { fiberNodes?: number[][] };
  const compProps = (component.properties ?? {}) as { fiberNodes?: number[][] };
  if (!opticalElement || opticalElement.elementKind !== "fiber") {
    return (
      <p style={{ fontSize: 11, opacity: 0.6, marginTop: 8 }}>
        Coupling efficiency breakdown will appear once the fiber is placed in the scene.
      </p>
    );
  }
  const kp = opticalElement.kindParams as Record<string, unknown>;
  const fiberType = (kp.fiberType ?? "single_mode") as
    | "multi_mode"
    | "single_mode"
    | "polarization_maintaining";
  const endA = (kp.endA ?? {}) as { modeFieldDiameterUm?: number; numericalAperture?: number };
  const lambda = ((kp.designWavelengthNm ?? 780) as number) * 1e-9;
  const mfdM = ((endA.modeFieldDiameterUm ?? 5.3) as number) * 1e-6;
  const wF = mfdM / 2;
  // Idealized self-matched probe: w_b = w_f, perfect alignment.
  const expectedEtaCoupling = 1.0;
  const expectedEtaFresnel = Math.pow(1 - 0.0338, 1); // 1 face PC, no AR
  const resolvedFiberNodes =
    (Array.isArray(objProps.fiberNodes) && objProps.fiberNodes.length >= 2)
      ? objProps.fiberNodes
      : compProps.fiberNodes;
  const nodeCount = Array.isArray(resolvedFiberNodes) ? resolvedFiberNodes.length : 2;
  void wF;
  void lambda;
  return (
    <div style={{ fontSize: 11, opacity: 0.85, marginTop: 8, padding: 6, background: "rgba(255,255,255,0.04)", borderRadius: 4 }}>
      <strong>Coupling efficiency (ideal mode-matched probe)</strong>
      <div>type: {fiberType}, nodes: {nodeCount}</div>
      <div>η_coupling (perfect mode match): {expectedEtaCoupling.toFixed(4)}</div>
      <div>η_fresnel (per face PC): {expectedEtaFresnel.toFixed(4)}</div>
      <div style={{ opacity: 0.6, marginTop: 4 }}>
        Actual η (including offset, bend loss, attenuation, polarization) will be shown
        per segment in the beam scope panel after ray-tracer integration (Phase H+).
      </div>
    </div>
  );
}

/** Slow-axis editor for a placed PM fiber. Lives next to the Jacket-radius
 *  slider in ComponentPanel — moved here from the PHY Editor's FiberInspector
 *  on 2026-05-09 because slow axis is per-physical-unit (Layer 4, manufacturing
 *  tolerance) and the layered-design rule says PhyEditor only writes Layer 2.
 *  Persists into OpticalElement.kindParams.endA/B.slowAxisDegInBodyFrame.
 *  Disabled (with hint) for non-PM fibers since slow axis is undefined. */
function FiberSlowAxisEditor({ component }: { component: ComponentItem }) {
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);
  const opticalElement = useSceneStore((state) =>
    state.scene.opticalElements.find((e) => {
      const obj = state.scene.objects.find((o) => o.id === e.objectId);
      return obj?.componentId === component.id;
    }),
  );
  type EndKp = {
    polish?: string;
    slowAxisDegInBodyFrame?: number | null;
    facePositionMmBodyLocal?: { x: number; y: number; z: number } | null;
  };
  const kp = (opticalElement?.kindParams ?? {}) as {
    fiberType?: "single_mode" | "polarization_maintaining" | "multi_mode";
    endA?: EndKp;
    endB?: EndKp;
  };
  const isPm = kp.fiberType === "polarization_maintaining";
  const slowA =
    typeof kp.endA?.slowAxisDegInBodyFrame === "number" ? kp.endA.slowAxisDegInBodyFrame : 0;
  const slowB =
    typeof kp.endB?.slowAxisDegInBodyFrame === "number" ? kp.endB.slowAxisDegInBodyFrame : 0;

  const writeSlow = async (end: "A" | "B", value: number) => {
    if (!opticalElement) return;
    const endKey = end === "A" ? "endA" : "endB";
    const nextKindParams = {
      ...kp,
      [endKey]: {
        ...((kp as Record<string, unknown>)[endKey] ?? {}),
        slowAxisDegInBodyFrame: Number.isFinite(value) ? value : null,
      },
    };
    await upsertOpticalElement({
      objectId: opticalElement.objectId,
      elementKind: opticalElement.elementKind,
      wavelengthRangeNm: opticalElement.wavelengthRangeNm,
      inputPorts: opticalElement.inputPorts,
      outputPorts: opticalElement.outputPorts,
      kindParams: nextKindParams,
    });
  };

  if (!opticalElement) {
    return (
      <p style={{ fontSize: 11, opacity: 0.55, marginTop: 8 }}>
        Slow axis editor will appear once the fiber is placed in the scene.
      </p>
    );
  }
  return (
    <div
      style={{
        marginTop: 10,
        padding: 8,
        border: "1px solid var(--line)",
        borderRadius: 4,
        opacity: isPm ? 1 : 0.55,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
        Slow axis (PM only)
      </div>
      {!isPm && (
        <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 6 }}>
          Slow axis is undefined for {kp.fiberType ?? "?"} fiber.
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto 1fr", gap: 6, alignItems: "center" }}>
        <label style={{ fontSize: 12 }}>End A</label>
        <input
          type="number"
          step="0.5"
          value={slowA}
          disabled={!isPm}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) void writeSlow("A", v);
          }}
        />
        <label style={{ fontSize: 12 }}>End B</label>
        <input
          type="number"
          step="0.5"
          value={slowB}
          disabled={!isPm}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) void writeSlow("B", v);
          }}
        />
      </div>
      <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>
        deg, body-local. 0° aligns slow axis with connector key.
      </div>
    </div>
  );
}

// ─ Euler ↔ outward-direction helpers (YXZ convention matching
//   `sceneObjectToQuaternion`: euler = THREE.Euler(rxRad, rzRad, -ryRad,
//   "YXZ")). Outward is the connector's +Y body axis, rotated into lab.
//   The Euler representation has 1 redundant DOF (twist around outward,
//   irrelevant for SM cross-sections) which we resolve by picking the
//   shortest rotation from lab+Y to the target outward.
function eulerDegToOutwardLab(
  rxDeg: number,
  ryDeg: number,
  rzDeg: number,
): [number, number, number] {
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(rxDeg),
    THREE.MathUtils.degToRad(rzDeg),
    THREE.MathUtils.degToRad(-ryDeg),
    "YXZ",
  );
  const v = new THREE.Vector3(0, 1, 0).applyEuler(euler);
  return [v.x, v.y, v.z];
}

function outwardLabToEulerDeg(
  outwardLab: [number, number, number],
): { rxDeg: number; ryDeg: number; rzDeg: number } {
  const v = new THREE.Vector3(
    outwardLab[0],
    outwardLab[1],
    outwardLab[2],
  ).normalize();
  const quat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    v,
  );
  const euler = new THREE.Euler().setFromQuaternion(quat, "YXZ");
  return {
    rxDeg: THREE.MathUtils.radToDeg(euler.x),
    ryDeg: -THREE.MathUtils.radToDeg(euler.z),
    rzDeg: THREE.MathUtils.radToDeg(euler.y),
  };
}

/** Per-fiber-end optical-port pose editor. Displays the ferrule-tip lab
 *  position (x, y, z) and the outward orientation (rx, ry, rz) — same
 *  Euler convention as SceneObject's (rxDeg, ryDeg, rzDeg), applied to
 *  lab+Y to produce the outward direction. Editing any field back-derives
 *  the spline node + handle via `setFiberPortLabPose`, so the touched
 *  endpoint snaps to the requested pose while interior nodes don't move. */
function FiberPortPoseEditor({
  component,
  end,
}: {
  component: ComponentItem;
  end: "A" | "B";
}) {
  const fiberSceneObject = useSceneStore((state) =>
    state.scene.objects.find((o) => o.componentId === component.id),
  );
  const setFiberPortLabPose = useSceneStore((state) => state.setFiberPortLabPose);
  const objProps = (fiberSceneObject?.properties ?? {}) as {
    fiberNodes?: { posMm: [number, number, number]; handleInMm?: [number, number, number]; handleOutMm?: [number, number, number] }[];
  };
  const compProps = (component.properties ?? {}) as {
    fiberNodes?: { posMm: [number, number, number]; handleInMm?: [number, number, number]; handleOutMm?: [number, number, number] }[];
  };
  const nodes = (objProps.fiberNodes && objProps.fiberNodes.length >= 2)
    ? objProps.fiberNodes
    : compProps.fiberNodes;
  if (!fiberSceneObject || !nodes || nodes.length < 2) return null;

  const portPose = getFiberPortLabPose(end, nodes, {
    xMm: fiberSceneObject.xMm,
    yMm: fiberSceneObject.yMm,
    zMm: fiberSceneObject.zMm,
    rxDeg: fiberSceneObject.rxDeg,
    ryDeg: fiberSceneObject.ryDeg,
    rzDeg: fiberSceneObject.rzDeg,
  });
  if (!portPose) return null;
  const { rxDeg, ryDeg, rzDeg } = outwardLabToEulerDeg(portPose.outwardLab);

  const apply = (field: "x" | "y" | "z" | "rx" | "ry" | "rz", value: number) => {
    if (!Number.isFinite(value)) return;
    const nextPos: [number, number, number] = [
      portPose.posLab[0],
      portPose.posLab[1],
      portPose.posLab[2],
    ];
    let nextRx = rxDeg, nextRy = ryDeg, nextRz = rzDeg;
    if (field === "x") nextPos[0] = value;
    else if (field === "y") nextPos[1] = value;
    else if (field === "z") nextPos[2] = value;
    else if (field === "rx") nextRx = value;
    else if (field === "ry") nextRy = value;
    else if (field === "rz") nextRz = value;
    const nextOutward = eulerDegToOutwardLab(nextRx, nextRy, nextRz);
    void setFiberPortLabPose(component.id, end, nextPos, nextOutward);
  };

  const portAnchorId = end === "A" ? "intercept_in" : "intercept_out";

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 4 }}>
        End {end} port (<code>{portAnchorId}</code>) — ferrule tip lab pose
      </div>
      <div className="number-grid" style={{ marginBottom: 4 }}>
        {(["x", "y", "z"] as const).map((axis) => (
          <label key={axis}>
            <span>{axis.toUpperCase()} mm</span>
            <NumberField
              value={portPose.posLab[axis === "x" ? 0 : axis === "y" ? 1 : 2]}
              onChange={(n) => apply(axis, n)}
            />
          </label>
        ))}
      </div>
      <div className="number-grid">
        {(["rx", "ry", "rz"] as const).map((axis) => {
          const cur = axis === "rx" ? rxDeg : axis === "ry" ? ryDeg : rzDeg;
          return (
            <label key={axis}>
              <span>{axis.toUpperCase()} deg</span>
              <NumberField value={cur} onChange={(n) => apply(axis, n)} />
            </label>
          );
        })}
      </div>
    </div>
  );
}

function FiberEditor({ component }: { component: ComponentItem }) {
  const fiberEditingComponentId = useSceneStore((state) => state.fiberEditingComponentId);
  const enterFiberEdit = useSceneStore((state) => state.enterFiberEdit);
  const exitFiberEdit = useSceneStore((state) => state.exitFiberEdit);
  const updateFiberRadius = useSceneStore((state) => state.updateFiberRadius);
  const alignFiberEndToBeam = useSceneStore((state) => state.alignFiberEndToBeam);
  // Explicit node-removal button — surfaced in the panel because the
  // 3D-viewer right-click affordance is hard to discover. Endpoints (A
  // and B) are guarded out by the store action, so this only fires for
  // interior nodes.
  const removeFiberNode = useSceneStore((state) => state.removeFiberNode);
  const [alignFeedback, setAlignFeedback] = useState<string | null>(null);
  const isEditing = fiberEditingComponentId === component.id;
  const onAlign = async (end: "A" | "B") => {
    setAlignFeedback(null);
    try {
      const res = await alignFiberEndToBeam(component.id, end, 25);
      if (res === null) {
        setAlignFeedback(`End ${end}: no beam found within 25 mm — alignment skipped.`);
      } else {
        setAlignFeedback(
          `End ${end} aligned to beam ${res.beamId.slice(0, 6)} (was ${res.offsetMm.toFixed(2)} mm off, now 0).`,
        );
      }
    } catch (err) {
      setAlignFeedback(`Align failed: ${(err as Error).message}`);
    }
  };
  // Per-instance values first (V2: fiber spline + jacket radius live on
  // SceneObject.properties), then catalog template as legacy fallback.
  const fiberSceneObject = useSceneStore((state) =>
    state.scene.objects.find((o) => o.componentId === component.id),
  );
  const objProps = (fiberSceneObject?.properties ?? {}) as {
    fiberNodes?: { posMm: number[] }[]; radiusMm?: number;
  };
  const compProps = (component.properties ?? {}) as {
    fiberNodes?: { posMm: number[] }[]; radiusMm?: number;
  };
  const resolvedNodes =
    (Array.isArray(objProps.fiberNodes) && objProps.fiberNodes.length >= 2)
      ? objProps.fiberNodes
      : compProps.fiberNodes;
  const nodeCount = Array.isArray(resolvedNodes) ? resolvedNodes.length : 0;
  const radius =
    typeof objProps.radiusMm === "number" ? objProps.radiusMm :
    typeof compProps.radiusMm === "number" ? compProps.radiusMm : 1.0;

  return (
    <section className="edit-section">
      <h3>Fiber editing</h3>
      <button
        type="button"
        className="primary-button"
        style={{ width: "100%", marginBottom: 8 }}
        onClick={() => (isEditing ? exitFiberEdit() : enterFiberEdit(component.id))}
      >
        {isEditing ? "✓ Done editing" : "✏ Edit fiber path"}
      </button>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "4px 0 8px", lineHeight: 1.5 }}>
        Nodes: {nodeCount} (End A + End B{nodeCount > 2 ? ` + ${nodeCount - 2} interior` : ""})
        {isEditing && (
          <>
            <br />· Drag orange/yellow anchor to move a node
            <br />· Drag cyan handle tip to adjust tension (direction + length)
            <br />· Double-click on the tube to insert an interior node
            <br />· Right-click on an interior anchor to delete it (or use buttons below)
          </>
        )}
      </p>
      {/* Explicit per-interior-node delete row. The two endpoint nodes
          (index 0 = End A, index N-1 = End B) are hidden because they
          must always exist — the store action also defensively rejects
          attempts to remove them. */}
      {nodeCount > 2 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>
            Interior nodes
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {(resolvedNodes ?? []).map((n, idx) => {
              if (idx === 0 || idx === nodeCount - 1) return null; // endpoints
              const p = n.posMm;
              return (
                <div
                  key={idx}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 6,
                    fontSize: 11,
                    padding: "3px 6px",
                    background: "rgba(255,255,255,0.04)",
                    borderRadius: 4,
                  }}
                >
                  <span style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>
                    #{idx}: ({p[0].toFixed(1)}, {p[1].toFixed(1)}, {p[2].toFixed(1)}) mm
                  </span>
                  <button
                    type="button"
                    className="secondary-button"
                    style={{ padding: "2px 8px", fontSize: 11 }}
                    title={`Remove interior node #${idx}. Endpoints (End A / End B) cannot be removed.`}
                    onClick={() => {
                      if (window.confirm(`Remove interior node #${idx}?`)) {
                        void removeFiberNode(component.id, idx);
                      }
                    }}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <label style={{ display: "block" }}>
        <span>Jacket radius ({radius.toFixed(2)} mm)</span>
        <input
          type="range"
          min="0.4"
          max="6"
          step="0.1"
          value={radius}
          onChange={(event) => {
            void updateFiberRadius(component.id, Number(event.target.value));
          }}
          style={{ width: "100%" }}
        />
      </label>
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void onAlign("A")}
          style={{ flex: 1 }}
        >
          Align End A to beam
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void onAlign("B")}
          style={{ flex: 1 }}
        >
          Align End B to beam
        </button>
      </div>
      {alignFeedback && (
        <p style={{ fontSize: 11, opacity: 0.85, marginTop: 6 }}>{alignFeedback}</p>
      )}
      <FiberPortPoseEditor component={component} end="A" />
      <FiberPortPoseEditor component={component} end="B" />
      <FiberSlowAxisEditor component={component} />
      <FiberEfficiencyDisplay component={component} />
      <FiberWarnings component={component} />
    </section>
  );
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

          {component.componentType === "text_annotation" && (
            <TextAnnotationEditor component={component} />
          )}

          {component.componentType === "fiber" && (
            <FiberEditor component={component} />
          )}

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
      {isObjectSelection && component && <TimingEditorButton component={component} />}
      {isObjectSelection && selectedObject && (
        <LinkedSchematicsSection
          sceneObjectId={selectedObject.id}
          sceneObjectName={getComponentName(component) ?? "Object"}
          componentId={selectedObject.componentId ?? component?.id ?? null}
        />
      )}
      {isObjectSelection && selectedObject && (
        <>
          <RfChainReadout sceneObjectId={selectedObject.id} />
          <ScrubTimeRfReadout sceneObjectId={selectedObject.id} />
        </>
      )}
      </FloatingPanel>

      <FloatingPanel id="device-state" title="Device state">
        <pre>{JSON.stringify(deviceState?.state ?? {}, null, 2)}</pre>
      </FloatingPanel>
    </>
  );
}
