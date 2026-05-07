// TargetLinksSection — shared link list + Add-link form for a single
// SceneObject. Used by:
//   - OpticalElementPanel (full-detail OE editor)
//   - BeamPlacementPanel (compact, alongside placement controls so user
//     can manage links + adjust position from the same panel)
//
// Renders the object's incoming + outgoing optical_links with
// validation status badges (ok / clipping / broken) and an inline
// "Add link" form when this object has output ports.

import { AlertTriangle, Link2, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useSceneStore } from "../../store/sceneStore";
import type {
  ComponentItem,
  OpticalElement,
  SceneObject,
} from "../../types/digitalTwin";
import {
  validateAllOpticalLinks,
  type LinkValidation,
} from "../../utils/beamPlacement";

type Props = {
  sceneObject: SceneObject | undefined;
  /** Compact mode for embedding in narrow panels (Beam Placement). Hides
   *  the "Links" header and uses tighter spacing. */
  compact?: boolean;
};

export function TargetLinksSection({ sceneObject, compact }: Props) {
  const opticalElements = useSceneStore((state) => state.scene.opticalElements);
  const opticalLinks = useSceneStore((state) => state.scene.opticalLinks);
  const sceneObjects = useSceneStore((state) => state.scene.objects);
  const components = useSceneStore((state) => state.scene.components);
  const scene = useSceneStore((state) => state.scene);
  const createOpticalLink = useSceneStore((state) => state.createOpticalLink);
  const deleteOpticalLink = useSceneStore((state) => state.deleteOpticalLink);

  const existing = sceneObject
    ? opticalElements.find((e) => e.objectId === sceneObject.id)
    : undefined;

  const linkValidations = useMemo<Map<string, LinkValidation>>(
    () => validateAllOpticalLinks(scene),
    [scene],
  );

  const incomingLinks = useMemo(
    () => (sceneObject ? opticalLinks.filter((l) => l.toObjectId === sceneObject.id) : []),
    [opticalLinks, sceneObject],
  );
  const outgoingLinks = useMemo(
    () => (sceneObject ? opticalLinks.filter((l) => l.fromObjectId === sceneObject.id) : []),
    [opticalLinks, sceneObject],
  );

  const linkableTargets = useMemo(() => {
    if (!sceneObject) return [];
    return opticalElements
      .filter((element) => element.objectId !== sceneObject.id && element.inputPorts.length > 0)
      .map((element) => {
        const targetObject = sceneObjects.find((obj) => obj.id === element.objectId);
        const targetComponent = targetObject
          ? components.find((item) => item.id === targetObject.componentId)
          : undefined;
        return { element, object: targetObject, component: targetComponent };
      })
      .filter((entry): entry is { element: OpticalElement; object: SceneObject; component: ComponentItem } =>
        Boolean(entry.object && entry.component),
      );
  }, [opticalElements, components, sceneObjects, sceneObject]);

  const [linkFromPort, setLinkFromPort] = useState<string>("");
  const [linkToObjectId, setLinkToObjectId] = useState<string>("");
  const [linkToPort, setLinkToPort] = useState<string>("");
  const [linkFreeSpaceMm, setLinkFreeSpaceMm] = useState<string>("");
  const [linkError, setLinkError] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!linkFromPort && existing?.outputPorts?.[0]) {
      setLinkFromPort(existing.outputPorts[0].portId);
    }
  }, [existing?.objectId, existing?.outputPorts, linkFromPort]);

  useEffect(() => {
    if (!linkToObjectId && linkableTargets[0]) {
      setLinkToObjectId(linkableTargets[0].element.objectId);
    }
  }, [linkableTargets, linkToObjectId]);

  useEffect(() => {
    const target = linkableTargets.find((entry) => entry.element.objectId === linkToObjectId);
    if (target && (!linkToPort || !target.element.inputPorts.some((port) => port.portId === linkToPort))) {
      setLinkToPort(target.element.inputPorts[0]?.portId ?? "");
    }
  }, [linkToObjectId, linkableTargets, linkToPort]);

  const guessFreeSpaceMm = (toObjectId: string): number => {
    if (!sceneObject) return 0;
    const toObject = sceneObjects.find((obj) => obj.id === toObjectId);
    if (!toObject) return 0;
    const dx = toObject.xMm - sceneObject.xMm;
    const dy = toObject.yMm - sceneObject.yMm;
    const dz = toObject.zMm - sceneObject.zMm;
    return Math.round(Math.hypot(dx, dy, dz) * 10) / 10;
  };

  const onCreateLink = async () => {
    setLinkError("");
    if (!sceneObject || !existing) {
      setLinkError("Select a scene object instance with an OpticalElement first.");
      return;
    }
    if (!linkFromPort || !linkToObjectId || !linkToPort) {
      setLinkError("Pick an output port, target object, and input port.");
      return;
    }
    const userMm = Number(linkFreeSpaceMm);
    const freeSpaceMm =
      Number.isFinite(userMm) && linkFreeSpaceMm.trim() !== ""
        ? userMm
        : guessFreeSpaceMm(linkToObjectId);
    setBusy(true);
    try {
      await createOpticalLink({
        fromObjectId: sceneObject.id,
        fromPort: linkFromPort,
        toObjectId: linkToObjectId,
        toPort: linkToPort,
        freeSpaceMm,
      });
      setLinkFreeSpaceMm("");
    } catch (e) {
      setLinkError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDeleteLink = async (linkId: string) => {
    setLinkError("");
    setBusy(true);
    try {
      await deleteOpticalLink(linkId);
    } catch (e) {
      setLinkError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!sceneObject) {
    return (
      <div className={`optical-links${compact ? " optical-links--compact" : ""}`}>
        <p className="empty-state">Select an object to manage its links.</p>
      </div>
    );
  }
  if (!existing) {
    return (
      <div className={`optical-links${compact ? " optical-links--compact" : ""}`}>
        <p className="empty-state">
          This object has no OpticalElement registered — links unavailable.
        </p>
      </div>
    );
  }

  const objName = (id: string) => sceneObjects.find((o) => o.id === id)?.name ?? id.slice(0, 8);

  const renderLinkRow = (link: typeof opticalLinks[number], dir: "in" | "out") => {
    const v = linkValidations.get(link.id);
    const status = v?.status ?? "ok";
    return (
      <div key={link.id} className={`optical-link-row optical-link-row--${status}`}>
        {dir === "in" ? (
          <>
            <code title={objName(link.fromObjectId)}>{objName(link.fromObjectId)}/{link.fromPort}</code>
            <span> → </span>
            <code>{link.toPort}</code>
          </>
        ) : (
          <>
            <code>{link.fromPort}</code>
            <span> → </span>
            <code title={objName(link.toObjectId)}>{objName(link.toObjectId)}/{link.toPort}</code>
          </>
        )}
        <span className="optical-link-distance">{link.freeSpaceMm.toFixed(1)} mm</span>
        {status !== "ok" && (
          <span
            className={`optical-link-status optical-link-status--${status}`}
            title={v?.reason ?? ""}
          >
            <AlertTriangle size={12} />
            {status === "broken" ? "broken" : "clipping"}
          </span>
        )}
        <button
          type="button"
          className="icon-button danger"
          title={status === "broken" ? "Remove broken link" : "Delete link"}
          onClick={() => void onDeleteLink(link.id)}
        >
          <Trash2 size={13} />
        </button>
      </div>
    );
  };

  return (
    <div className={`optical-links${compact ? " optical-links--compact" : ""}`}>
      {!compact && (
        <h4>
          <Link2 size={13} />
          Links
        </h4>
      )}

      {(existing.outputPorts?.length ?? 0) > 0 && linkableTargets.length > 0 ? (
        <div className="optical-link-builder">
          <div className="optical-link-builder-row">
            <label>
              <span>From port</span>
              <select value={linkFromPort} onChange={(e) => setLinkFromPort(e.target.value)}>
                {(existing.outputPorts ?? []).map((port) => (
                  <option key={port.portId} value={port.portId}>
                    {port.portId}
                    {port.label ? ` (${port.label})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>To object</span>
              <select
                value={linkToObjectId}
                onChange={(e) => setLinkToObjectId(e.target.value)}
              >
                {linkableTargets.map(({ element, object, component }) => (
                  <option key={element.objectId} value={element.objectId}>
                    {object.name ?? component.name ?? component.componentName ?? element.objectId.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>To port</span>
              <select value={linkToPort} onChange={(e) => setLinkToPort(e.target.value)}>
                {(linkableTargets.find((entry) => entry.element.objectId === linkToObjectId)
                  ?.element.inputPorts ?? []
                ).map((port) => (
                  <option key={port.portId} value={port.portId}>
                    {port.portId}
                    {port.label ? ` (${port.label})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Free space mm</span>
              <input
                type="number"
                placeholder={String(guessFreeSpaceMm(linkToObjectId))}
                value={linkFreeSpaceMm}
                onChange={(e) => setLinkFreeSpaceMm(e.target.value)}
              />
            </label>
          </div>
          <button
            type="button"
            className="primary-button optical-link-create-btn"
            onClick={() => void onCreateLink()}
            disabled={busy}
          >
            <Plus size={14} /> Add link
          </button>
          {linkError ? <div className="optical-error">{linkError}</div> : null}
        </div>
      ) : null}

      {incomingLinks.length > 0 && (
        <div>
          <div className="optical-links-label">Incoming</div>
          {incomingLinks.map((link) => renderLinkRow(link, "in"))}
        </div>
      )}
      {outgoingLinks.length > 0 && (
        <div>
          <div className="optical-links-label">Outgoing</div>
          {outgoingLinks.map((link) => renderLinkRow(link, "out"))}
        </div>
      )}
    </div>
  );
}
