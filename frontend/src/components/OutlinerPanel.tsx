/**
 * Blender-style Outliner.
 *
 * Renders the user-defined Collection tree alongside the objects that live in
 * each collection. Objects have one active collection home; dragging an object
 * to another collection moves it there instead of creating a linked copy.
 *
 * UX choices that mirror Blender intentionally:
 *  - The active collection is highlighted; new objects placed via the
 *    component library are added to it.
 *  - Drag a collection onto another to reparent it.
 *  - Drag an object onto a collection to move it.
 */

import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FolderPlus,
  Layers3,
  Pencil,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useSceneStore } from "../store/sceneStore";
import type {
  Collection,
  CollectionMember,
  ComponentItem,
  SceneObject,
} from "../types/digitalTwin";
import { getComponentName } from "../utils/components";
import {
  isCollectionVisible,
  isObjectVisible,
  makeRenderableContext,
} from "../utils/visibility";

const EXPANDED_COLLECTIONS_STORAGE_KEY = "qmem.outliner.expandedCollections";

function loadStringSet(storageKey: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

type DragPayload =
  | { kind: "collection"; collectionId: string }
  | { kind: "object"; objectId: string; sourceCollectionId: string };

const DRAG_MIME = "application/x-qmem-outliner";

type ChildrenIndex = Map<string | null, Collection[]>;

type ObjectsByCollection = Map<string, SceneObject[]>;

function buildChildrenIndex(collections: Collection[]): ChildrenIndex {
  const out: ChildrenIndex = new Map();
  for (const collection of collections) {
    const list = out.get(collection.parentId);
    if (list) list.push(collection);
    else out.set(collection.parentId, [collection]);
  }
  for (const [, list] of out) list.sort((a, b) => a.sortOrder - b.sortOrder);
  return out;
}

function buildObjectsByCollection(
  objects: SceneObject[],
  members: CollectionMember[],
): ObjectsByCollection {
  const objectById = new Map(objects.map((object) => [object.id, object]));
  const out: ObjectsByCollection = new Map();
  for (const member of members) {
    const object = objectById.get(member.objectId);
    if (!object) continue;
    const list = out.get(member.collectionId);
    if (list) list.push(object);
    else out.set(member.collectionId, [object]);
  }
  for (const [, list] of out) list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function isAncestorOrSelf(
  collections: Collection[],
  ancestorId: string,
  candidateId: string,
): boolean {
  if (ancestorId === candidateId) return true;
  const byId = new Map(collections.map((c) => [c.id, c]));
  let cursor: string | null | undefined = candidateId;
  while (cursor) {
    if (cursor === ancestorId) return true;
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}

export function OutlinerPanel() {
  const scene = useSceneStore((state) => state.scene);
  const overlayFlags = useSceneStore((state) => state.overlayFlags);
  const sessionState = useSceneStore((state) => state.session);
  const activeViewId = useSceneStore((state) => state.activeViewId);
  const activeCollectionId = useSceneStore((state) => state.activeCollectionId);
  const setActiveCollection = useSceneStore((state) => state.setActiveCollection);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const selectedObjectIds = useSceneStore((state) => state.selectedObjectIds);
  const selectObject = useSceneStore((state) => state.selectObject);
  const setSelectedObjects = useSceneStore((state) => state.setSelectedObjects);
  const updateCollection = useSceneStore((state) => state.updateCollection);
  const toggleCollectionVisibility = useSceneStore((state) => state.toggleCollectionVisibility);
  const deleteCollection = useSceneStore((state) => state.deleteCollection);
  const moveCollection = useSceneStore((state) => state.moveCollection);
  const createCollection = useSceneStore((state) => state.createCollection);
  const moveObjectToCollection = useSceneStore((state) => state.moveObjectToCollection);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const toggleSessionHiddenObject = useSceneStore((state) => state.toggleSessionHiddenObject);
  const forceShowObject = useSceneStore((state) => state.forceShowObject);
  const deleteObject = useSceneStore((state) => state.deleteObject);

  const [expanded, setExpanded] = useState<Set<string>>(() =>
    loadStringSet(EXPANDED_COLLECTIONS_STORAGE_KEY),
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        EXPANDED_COLLECTIONS_STORAGE_KEY,
        JSON.stringify([...expanded]),
      );
    } catch {
      /* ignore storage errors */
    }
  }, [expanded]);

  const collections = useMemo(() => scene.collections ?? [], [scene.collections]);
  const collectionMembers = useMemo(
    () => scene.collectionMembers ?? [],
    [scene.collectionMembers],
  );
  const componentById = useMemo(
    () => new Map(scene.components.map((component) => [component.id, component])),
    [scene.components],
  );

  const childrenIndex = useMemo(() => buildChildrenIndex(collections), [collections]);
  const objectsByCollection = useMemo(
    () => buildObjectsByCollection(scene.objects, collectionMembers),
    [scene.objects, collectionMembers],
  );

  /** All object IDs reachable from a collection, walking child collections
   * recursively. Used by double-click "select all in collection". */
  const collectAllObjectIdsUnder = useCallback(
    (collectionId: string): string[] => {
      const seen = new Set<string>();
      const visit = (id: string) => {
        for (const obj of objectsByCollection.get(id) ?? []) {
          seen.add(obj.id);
        }
        for (const child of childrenIndex.get(id) ?? []) {
          visit(child.id);
        }
      };
      visit(collectionId);
      return Array.from(seen);
    },
    [childrenIndex, objectsByCollection],
  );

  const activeView = useMemo(
    () =>
      activeViewId
        ? (scene.sceneViews ?? []).find((v) => v.id === activeViewId) ?? null
        : null,
    [activeViewId, scene.sceneViews],
  );
  const visibilityCtx = useMemo(
    () => makeRenderableContext(overlayFlags, sessionState, activeView, scene),
    [overlayFlags, sessionState, activeView, scene],
  );

  const masterCollection = useMemo(
    () => collections.find((collection) => collection.parentId === null) ?? null,
    [collections],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const startEditing = useCallback((collection: Collection) => {
    setEditingId(collection.id);
    setDraftName(collection.name);
  }, []);

  const submitEditing = useCallback(async () => {
    if (!editingId) return;
    const trimmed = draftName.trim();
    if (trimmed.length === 0) {
      setEditingId(null);
      return;
    }
    await updateCollection(editingId, { name: trimmed });
    setEditingId(null);
  }, [draftName, editingId, updateCollection]);

  const handleAddChild = useCallback(
    async (parentId: string | null) => {
      const created = await createCollection({
        name: "New Collection",
        parentId: parentId ?? undefined,
      });
      setExpanded((current) => {
        if (parentId === null) return current;
        const next = new Set(current);
        next.add(parentId);
        return next;
      });
      setActiveCollection(created.id);
      startEditing(created);
    },
    [createCollection, setActiveCollection, startEditing],
  );

  const handleDelete = useCallback(
    async (collection: Collection) => {
      if (collection.parentId === null) return;
      const childCount = (childrenIndex.get(collection.id) ?? []).length;
      const memberCount = (objectsByCollection.get(collection.id) ?? []).length;
      const note =
        childCount + memberCount > 0
          ? `\n\nThis collection contains ${childCount} sub-collection${childCount === 1 ? "" : "s"} and ${memberCount} object${memberCount === 1 ? "" : "s"}. Sub-collections will be deleted.`
          : "";
      if (!window.confirm(`Delete collection "${collection.name}"?${note}`)) return;
      await deleteCollection(collection.id);
    },
    [childrenIndex, deleteCollection, objectsByCollection],
  );

  const handleDragStart = useCallback(
    (event: React.DragEvent, payload: DragPayload) => {
      try {
        event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
        event.dataTransfer.effectAllowed = "move";
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const readDragPayload = useCallback(
    (event: React.DragEvent): DragPayload | null => {
      try {
        const raw = event.dataTransfer.getData(DRAG_MIME);
        if (!raw) return null;
        return JSON.parse(raw) as DragPayload;
      } catch {
        return null;
      }
    },
    [],
  );

  const handleDropOnCollection = useCallback(
    async (event: React.DragEvent, targetCollection: Collection) => {
      event.preventDefault();
      const payload = readDragPayload(event);
      setDragOverId(null);
      if (!payload) return;
      if (payload.kind === "collection") {
        if (
          payload.collectionId === targetCollection.id ||
          isAncestorOrSelf(collections, payload.collectionId, targetCollection.id)
        ) {
          return;
        }
        await moveCollection(payload.collectionId, {
          parentId: targetCollection.id,
        });
        setExpanded((current) => {
          const next = new Set(current);
          next.add(targetCollection.id);
          return next;
        });
        return;
      }
      if (payload.sourceCollectionId === targetCollection.id) return;
      await moveObjectToCollection(targetCollection.id, payload.objectId);
    },
    [collections, moveCollection, moveObjectToCollection, readDragPayload],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent, targetId: string) => {
      if (event.dataTransfer.types.includes(DRAG_MIME)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDragOverId(targetId);
      }
    },
    [],
  );

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    if (event.currentTarget === event.target) setDragOverId(null);
  }, []);

  const renderCollectionRow = (collection: Collection, depth: number) => {
    const isMaster = collection.parentId === null;
    const isExpanded = isMaster || expanded.has(collection.id);
    const isActive = collection.id === activeCollectionId;
    const isOver = dragOverId === collection.id;
    const collectionVisible = isCollectionVisible(collection.id, visibilityCtx);
    const collectionForced = sessionState.forceVisibleCollectionIds.has(collection.id);
    const childCollections = childrenIndex.get(collection.id) ?? [];
    const childObjects = objectsByCollection.get(collection.id) ?? [];
    const totalCount = childCollections.length + childObjects.length;
    return (
      <div
        key={collection.id}
        className={`outliner-node${isActive ? " active" : ""}${isOver ? " drop-target" : ""}`}
        draggable={!isMaster}
        onDragStart={
          isMaster
            ? undefined
            : (event) => handleDragStart(event, { kind: "collection", collectionId: collection.id })
        }
        onDragOver={(event) => handleDragOver(event, collection.id)}
        onDragLeave={handleDragLeave}
        onDrop={(event) => handleDropOnCollection(event, collection)}
        style={{ paddingLeft: `${4 + depth * 14}px` }}
        onClick={(event) => {
          event.stopPropagation();
          setActiveCollection(collection.id);
        }}
        onDoubleClick={(event) => {
          // Double-click on a collection → select every object inside it
          // (recursively walks sub-collections too). Mirrors Blender's "A"
          // shortcut on the outliner.
          event.stopPropagation();
          event.preventDefault();
          const ids = collectAllObjectIdsUnder(collection.id);
          if (ids.length > 0) setSelectedObjects(ids);
        }}
      >
        <div className="outliner-row collection-row">
          <button
            type="button"
            className="outliner-toggle"
            onClick={(event) => {
              event.stopPropagation();
              if (!isMaster) toggleExpanded(collection.id);
            }}
            aria-label={isExpanded ? "Collapse" : "Expand"}
            disabled={isMaster && childCollections.length === 0 && childObjects.length === 0}
          >
            {totalCount === 0 ? (
              <span className="outliner-dot" />
            ) : isExpanded ? (
              <ChevronDown size={13} />
            ) : (
              <ChevronRight size={13} />
            )}
          </button>
          <span
            className="outliner-swatch"
            style={{ background: collection.color }}
            title={isMaster ? "Master Collection" : `Color: ${collection.color}`}
          />
          {editingId === collection.id ? (
            <input
              autoFocus
              className="outliner-name-input"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitEditing();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setEditingId(null);
                }
              }}
              onBlur={() => void submitEditing()}
            />
          ) : (
            <span
              className="outliner-name"
              title={isMaster ? "Master Collection (cannot be moved or deleted)" : collection.name}
            >
              {collection.name}
            </span>
          )}
          <span className="outliner-count">{totalCount}</span>
          <button
            type="button"
            className={`outliner-action${collectionVisible ? "" : " muted"}${collectionForced ? " active" : ""}`}
            title={
              collectionVisible
                ? collectionForced
                  ? "Hide collection override"
                  : "Hide collection"
                : collection.visible
                  ? "Show collection here (parent hidden)"
                  : "Show collection"
            }
            onClick={(event) => {
              event.stopPropagation();
              void toggleCollectionVisibility(collection.id);
            }}
          >
            {collectionVisible ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
          <button
            type="button"
            className="outliner-action"
            title="Add sub-collection"
            onClick={(event) => {
              event.stopPropagation();
              void handleAddChild(collection.id);
            }}
          >
            <FolderPlus size={13} />
          </button>
          {!isMaster && editingId !== collection.id && (
            <button
              type="button"
              className="outliner-action"
              title="Rename"
              onClick={(event) => {
                event.stopPropagation();
                startEditing(collection);
              }}
            >
              <Pencil size={13} />
            </button>
          )}
          {!isMaster && (
            <button
              type="button"
              className="outliner-action danger-action"
              title="Delete collection"
              onClick={(event) => {
                event.stopPropagation();
                void handleDelete(collection);
              }}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
        {isExpanded && (
          <div className="outliner-children">
            {childCollections.map((child) => renderCollectionRow(child, depth + 1))}
            {childObjects.map((object) => {
              const component = componentById.get(object.componentId);
              const visible = isObjectVisible(object, visibilityCtx);
              const forceVisible = sessionState.forceVisibleObjectIds.has(object.id);
              const isSelected = selectedObjectIds.includes(object.id) || object.id === selectedObjectId;
              return (
                <div
                  key={`${collection.id}:${object.id}`}
                  data-object-id={object.id}
                  className={`outliner-row object-row${isSelected ? " selected" : ""}`}
                  draggable
                  onDragStart={(event) => {
                    event.stopPropagation();
                    handleDragStart(event, {
                      kind: "object",
                      objectId: object.id,
                      sourceCollectionId: collection.id,
                    });
                  }}
                  style={{ paddingLeft: `${22 + (depth + 1) * 14}px` }}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectObject(object.id, {
                      additive: event.ctrlKey || event.metaKey || event.shiftKey,
                    });
                    setActiveCollection(collection.id);
                  }}
                  title={object.name}
                >
                  <Layers3 size={14} />
                  <span className="outliner-name">
                    <em>{object.name}</em>
                    {component && (
                      <small>{getComponentName(component as ComponentItem)}</small>
                    )}
                  </span>
                  <button
                    type="button"
                    className={`outliner-action${visible ? "" : " muted"}${forceVisible ? " active" : ""}`}
                    title={
                      visible
                        ? forceVisible
                          ? "Hide object override"
                          : "Hide object"
                        : object.visible
                          ? "Show object here"
                          : "Show object"
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!visible && object.visible && !forceVisible) {
                        // "Show object here": object DB-visible but hidden by
                        // collection cascade, view filter, or session — force-show
                        // it, bypassing all session-level gates.
                        forceShowObject(object.id);
                      } else if (forceVisible) {
                        // "Hide object override": remove force-visible override.
                        toggleSessionHiddenObject(object.id);
                      } else {
                        void updateSceneObject(object.id, { visible: !object.visible });
                      }
                    }}
                  >
                    {visible ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                  <button
                    type="button"
                    className="outliner-action danger-action"
                    title="Delete object"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (
                        window.confirm(
                          `Delete "${object.name}" from the scene? This removes the object from every collection.`,
                        )
                      ) {
                        void deleteObject(object.id);
                      }
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  if (collections.length === 0 || !masterCollection) {
    return (
      <section className="library-section outliner-section">
        <div className="section-title">
          <span>Outliner</span>
          <small>collections</small>
        </div>
        <p className="outliner-empty">No collections yet.</p>
      </section>
    );
  }

  return (
    <section className="library-section outliner-section">
      <div className="section-title">
        <span>Outliner</span>
        <small>active: {collections.find((c) => c.id === activeCollectionId)?.name ?? "—"}</small>
        <button
          type="button"
          className="outliner-action"
          title="New top-level collection"
          onClick={() => void handleAddChild(masterCollection.id)}
        >
          <FolderPlus size={14} />
        </button>
      </div>
      <MarqueeTree
        objects={scene.objects}
        selectedObjectIds={selectedObjectIds}
        setSelectedObjects={setSelectedObjects}
      >
        {renderCollectionRow(masterCollection, 0)}
      </MarqueeTree>
    </section>
  );
}

/** Wraps the outliner tree to provide drag-marquee selection.
 *  - Pointer down on whitespace (not on an .outliner-row) starts a marquee
 *  - Pointer move expands the rect; rows inside are previewed-selected
 *  - Pointer up commits via setSelectedObjects (or additive merge on Shift)
 *  - Pointer down on a row falls through to the row's own onClick
 */
function MarqueeTree({
  objects,
  selectedObjectIds,
  setSelectedObjects,
  children,
}: {
  objects: { id: string }[];
  selectedObjectIds: string[];
  setSelectedObjects: (ids: string[]) => void;
  children: React.ReactNode;
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = React.useState<
    | {
        startX: number;
        startY: number;
        currentX: number;
        currentY: number;
        additive: boolean;
        initialIds: string[];
      }
    | null
  >(null);

  const DRAG_THRESHOLD_PX = 4;
  const pendingRef = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    additive: boolean;
    initialIds: string[];
    escalated: boolean;
  } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Marquee starts ONLY from explicit whitespace (the .marquee-gutter
    // below the tree, or the bare host). Rows have draggable=true which
    // hijacks pointer events to fire HTML5 dragstart before our pointermove
    // ever runs — so we can't start a marquee from inside a row.
    const target = event.target as HTMLElement;
    const host = containerRef.current;
    const onWhitespace = target === host || target.classList.contains("marquee-gutter");
    if (!onWhitespace) return;
    if (event.button !== 0) return;
    pendingRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      additive: event.shiftKey || event.ctrlKey || event.metaKey,
      initialIds: selectedObjectIds.slice(),
      escalated: false,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pending = pendingRef.current;
    if (!pending || event.pointerId !== pending.pointerId) return;
    if (!pending.escalated) {
      const dx = event.clientX - pending.startX;
      const dy = event.clientY - pending.startY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      // Threshold crossed → escalate to a marquee drag.
      pending.escalated = true;
      setDrag({
        startX: pending.startX,
        startY: pending.startY,
        currentX: event.clientX,
        currentY: event.clientY,
        additive: pending.additive,
        initialIds: pending.initialIds,
      });
      try {
        (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
      } catch {
        // ignore — capture is best-effort
      }
      event.preventDefault();
      return;
    }
    setDrag((prev) =>
      prev ? { ...prev, currentX: event.clientX, currentY: event.clientY } : prev,
    );
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return;
    if (!pending.escalated) {
      // Quick click — let the row's own onClick handle it.
      return;
    }
    // Marquee drag end → compute hits.
    const minX = Math.min(pending.startX, event.clientX);
    const maxX = Math.max(pending.startX, event.clientX);
    const minY = Math.min(pending.startY, event.clientY);
    const maxY = Math.max(pending.startY, event.clientY);
    const rows = containerRef.current?.querySelectorAll<HTMLElement>(
      ".outliner-row.object-row[data-object-id]",
    );
    if (!rows) {
      setDrag(null);
      return;
    }
    const knownObjectIds = new Set(objects.map((o) => o.id));
    const hits: string[] = [];
    rows.forEach((row) => {
      const objId = row.dataset.objectId;
      if (!objId || !knownObjectIds.has(objId)) return;
      const r = row.getBoundingClientRect();
      const intersects = !(r.right < minX || r.left > maxX || r.bottom < minY || r.top > maxY);
      if (intersects) hits.push(objId);
    });
    const next = pending.additive
      ? Array.from(new Set([...pending.initialIds, ...hits]))
      : hits;
    setSelectedObjects(next);
    setDrag(null);
    event.preventDefault();
  };

  // Compute marquee overlay rect in container-local coords
  const overlay = (() => {
    if (!drag || !containerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    const left = Math.min(drag.startX, drag.currentX) - rect.left;
    const top = Math.min(drag.startY, drag.currentY) - rect.top;
    const width = Math.abs(drag.currentX - drag.startX);
    const height = Math.abs(drag.currentY - drag.startY);
    if (width < 2 && height < 2) return null;
    return { left, top, width, height };
  })();

  return (
    <div
      ref={containerRef}
      className="outliner-tree marquee-host"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      {children}
      {/* Whitespace gutter below the tree — guarantees a draggable area for
          marquee selection regardless of how many rows are visible. */}
      <div className="marquee-gutter" />
      {overlay && (
        <div
          className="outliner-marquee"
          style={{
            left: overlay.left,
            top: overlay.top,
            width: overlay.width,
            height: overlay.height,
          }}
        />
      )}
    </div>
  );
}
