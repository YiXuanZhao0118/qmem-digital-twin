/**
 * Blender-style Outliner.
 *
 * Renders the user-defined Collection tree alongside the objects that live in
 * each collection. Objects have one active collection home; dragging an object
 * to another collection moves it there instead of creating a linked copy.
 *
 * UX choices that mirror Blender intentionally:
 *  - The active collection is highlighted; new objects placed via the
 *    component library are added to it. It changes ONLY when a collection
 *    row is clicked (or a new collection is created) — never by selecting
 *    an object.
 *  - Drag a collection onto the middle of another to reparent it, or onto a
 *    row's top / bottom edge to reorder it among that row's siblings.
 *  - Drag an object onto a collection to move it.
 */

import {
  Bookmark,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  EyeOff,
  FolderPlus,
  Layers3,
  Library,
  Link2,
  Link2Off,
  Lock,
  LockOpen,
  Pencil,
  Search,
  Stamp,
  Trash2,
  X,
} from "lucide-react";
import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useSceneStore } from "../store/sceneStore";
import type {
  Collection,
  CollectionMember,
  CollectionTemplate,
  ComponentItem,
  SceneObject,
} from "../types/digitalTwin";
import {
  getComponentName,
  normalizeSearchText,
  objectSearchHaystack,
} from "../utils/components";
import { computeRigidCollectionIds } from "../utils/rigidGroup";
import { capabilityProfile } from "../kinds/_capabilityProfile";
import {
  isCollectionVisible,
  isObjectVisible,
  makeRenderableContext,
} from "../utils/visibility";

const EXPANDED_COLLECTIONS_STORAGE_KEY = "qmem.outliner.expandedCollections";
const MASTER_COLLAPSED_STORAGE_KEY = "qmem.outliner.masterCollapsed";

/** Nesting is shown by COLOUR, not by indentation — every row starts at the
 *  same x and wears a left rail + tint band instead (see styles.css). Each
 *  top-level branch under Master owns a hue; depth fades the band.
 *
 *  Collection.color exists in the model but nothing ever writes it — the API
 *  default is a single teal for every collection, so the swatch carried no
 *  information. A branch still sitting on that default is therefore given a
 *  palette hue by its position under Master; a colour that was explicitly set
 *  to anything else always wins and cascades to that branch's sub-tree. */
const DEFAULT_COLLECTION_COLOR = "#0f766e";
const BRANCH_PALETTE = [
  "#0f766e", // teal
  "#1d4ed8", // blue
  "#b45309", // amber
  "#be123c", // rose
  "#6d28d9", // violet
  "#4d7c0f", // olive
  "#0891b2", // cyan
  "#475569", // slate
];

/** Band opacity for a collection row at `depth` (Master = 0). Objects use a
 *  weaker share of their collection's band so they read as its contents. */
function bandAlpha(depth: number): number {
  return 0.2 * Math.pow(0.72, depth);
}

function withAlpha(hex: string, alpha: number): string {
  const raw = hex.replace("#", "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  const int = Number.parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(int)) return `rgba(15, 118, 110, ${alpha})`;
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
}

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
  /** Object drag is always a list — single-row drag wraps the one id, multi-
   *  select drag (when the dragged row is part of `selectedObjectIds`) puts
   *  every selected id in. Locked ids are filtered out at dragstart-time so
   *  the drop handler doesn't have to re-check; if every candidate is locked
   *  the drag is suppressed entirely (e.preventDefault() in the row handler). */
  | { kind: "object"; objectIds: string[]; sourceCollectionId: string };

const DRAG_MIME = "application/x-qmem-outliner";

/** Drop position relative to the hovered collection row. */
type DropZone = "before" | "inside" | "after";

/** Fraction of the row height that counts as an "insert between siblings"
 *  band at each edge. The middle 50% stays "drop into this collection". */
const REORDER_EDGE = 0.25;

type ChildrenIndex = Map<string | null, Collection[]>;

type ObjectsByCollection = Map<string, SceneObject[]>;

function buildChildrenIndex(collections: Collection[]): ChildrenIndex {
  const out: ChildrenIndex = new Map();
  for (const collection of collections) {
    const list = out.get(collection.parentId);
    if (list) list.push(collection);
    else out.set(collection.parentId, [collection]);
  }
  // createdAt breaks sortOrder ties: fresh collections all default to 0, and
  // the store's upsertById appends on every update, so without a stable
  // secondary key an unrelated edit (rename, visibility) would bump a
  // collection to the bottom of its sibling run.
  for (const [, list] of out)
    list.sort(
      (a, b) => a.sortOrder - b.sortOrder || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
    );
  return out;
}

function buildObjectsByCollection(
  objects: SceneObject[],
  members: CollectionMember[],
  masterCollectionId: string | null,
): ObjectsByCollection {
  const objectById = new Map(objects.map((object) => [object.id, object]));
  const out: ObjectsByCollection = new Map();
  const assigned = new Set<string>();
  for (const member of members) {
    const object = objectById.get(member.objectId);
    if (!object) continue;
    assigned.add(object.id);
    const list = out.get(member.collectionId);
    if (list) list.push(object);
    else out.set(member.collectionId, [object]);
  }
  // Objects with no CollectionMember row fall back to Master so they stay
  // visible and removable. The normal create_object API always assigns a
  // home, but data seeded outside that flow can skip it (e.g.
  // upsert_optical_table.py) — without this they render in 3D yet vanish
  // from the tree, leaving no way to rename/lock/delete them.
  if (masterCollectionId) {
    for (const object of objects) {
      if (assigned.has(object.id)) continue;
      const list = out.get(masterCollectionId);
      if (list) list.push(object);
      else out.set(masterCollectionId, [object]);
    }
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
  const deleteObjects = useSceneStore((state) => state.deleteObjects);
  const collectionTemplates = useSceneStore((state) => state.collectionTemplates);
  const loadCollectionTemplates = useSceneStore((state) => state.loadCollectionTemplates);
  const saveCollectionAsTemplate = useSceneStore((state) => state.saveCollectionAsTemplate);
  const instantiateCollectionTemplateAtCursor = useSceneStore(
    (state) => state.instantiateCollectionTemplateAtCursor,
  );
  const deleteCollectionTemplate = useSceneStore((state) => state.deleteCollectionTemplate);
  const cursorMm = useSceneStore((state) => state.transformCursorMm.left);

  const [expanded, setExpanded] = useState<Set<string>>(() =>
    loadStringSet(EXPANDED_COLLECTIONS_STORAGE_KEY),
  );
  // Master lives outside `expanded` — it's the one collection that defaults to
  // open, so we persist its collapsed flag instead of its expanded flag.
  const [masterCollapsed, setMasterCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(MASTER_COLLAPSED_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // Where the drop lands relative to the hovered collection row: the middle
  // band reparents (drop *into*), the top/bottom bands reorder among the
  // target's siblings. Only ever leaves "inside" for collection drags.
  const [dropZone, setDropZone] = useState<DropZone>("inside");
  // The drop handler reads the zone from a ref, not from state: dragover and
  // drop can land in the same task, and a state write from dragover isn't
  // visible to the drop closure yet. State exists only to paint the line.
  const dropZoneRef = useRef<DropZone>("inside");
  // dataTransfer.getData() is blocked during dragover (drag-data protection
  // mode), so the zone split needs the payload kind from somewhere else. The
  // drag never leaves this document, so a ref set at dragstart is enough.
  const dragPayloadRef = useRef<DragPayload | null>(null);
  // Collection queued for deletion — the confirm dialog offers two outcomes
  // (keep the objects, or delete them too), which window.confirm can't express.
  const [pendingDelete, setPendingDelete] = useState<Collection | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [filter, setFilter] = useState("");

  // Lazy fetch: templates panel is collapsed by default, so the first time the
  // user opens it (or this panel mounts after a saved template event) we pull
  // the list. WebSocket broadcast for templates is out of scope for v1 —
  // saves / deletes from this client mutate local state directly, and a
  // second client just sees a stale list until they re-open the dropdown.
  useEffect(() => {
    if (!templatesOpen) return;
    void loadCollectionTemplates();
  }, [templatesOpen, loadCollectionTemplates]);

  useEffect(() => {
    if (!pendingDelete) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingDelete(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingDelete]);

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

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(MASTER_COLLAPSED_STORAGE_KEY, masterCollapsed ? "1" : "0");
    } catch {
      /* ignore storage errors */
    }
  }, [masterCollapsed]);

  const collections = useMemo(() => scene.collections ?? [], [scene.collections]);
  const collectionMembers = useMemo(
    () => scene.collectionMembers ?? [],
    [scene.collectionMembers],
  );
  const componentById = useMemo(
    () => new Map(scene.components.map((component) => [component.id, component])),
    [scene.components],
  );
  // Hide every SceneObject whose ElementKind opts out of `outlinerVisible`
  // in the capability profile — currently `programmable_pulse_generator`
  // (managed from RF Link / Pulse & Timing) and, once the fiber split
  // lands, the derived `fiber` body wrapper. New kinds that need hiding
  // just add an OVERRIDES entry; no edit here.
  const outlinerHiddenKinds = useMemo(() => {
    const out = new Set<string>();
    for (const pe of scene.physicsElements) {
      if (!capabilityProfile(pe.elementKind).outlinerVisible) {
        out.add(pe.objectId);
      }
    }
    return out;
  }, [scene.physicsElements]);
  const visibleObjects = useMemo(
    () => scene.objects.filter((o) => !outlinerHiddenKinds.has(o.id)),
    [scene.objects, outlinerHiddenKinds],
  );
  // The complement of `visibleObjects` — rendered in the "Managed" section
  // at the bottom with an eye toggle and nothing else (see the JSX for why).
  const managedObjects = useMemo(() => {
    const kindByObject = new Map(scene.physicsElements.map((pe) => [pe.objectId, pe.elementKind]));
    return scene.objects
      .filter((o) => outlinerHiddenKinds.has(o.id))
      .map((object) => ({
        object,
        kindLabel: (kindByObject.get(object.id) ?? "object").replace(/_/g, " "),
      }))
      .sort((a, b) => a.object.name.localeCompare(b.object.name));
  }, [scene.objects, scene.physicsElements, outlinerHiddenKinds]);
  const objectsById = useMemo(
    () => new Map(visibleObjects.map((o) => [o.id, o])),
    [visibleObjects],
  );

  const masterCollectionId = useMemo(
    () => collections.find((collection) => collection.parentId === null)?.id ?? null,
    [collections],
  );
  const childrenIndex = useMemo(() => buildChildrenIndex(collections), [collections]);
  const objectsByCollection = useMemo(
    () => buildObjectsByCollection(visibleObjects, collectionMembers, masterCollectionId),
    [visibleObjects, collectionMembers, masterCollectionId],
  );

  /** Reverse of `objectsByCollection`: the collection row each object is
   *  drawn under, Master fallback included. */
  const collectionIdByObjectId = useMemo(() => {
    const out = new Map<string, string>();
    for (const [collectionId, objects] of objectsByCollection) {
      for (const object of objects) out.set(object.id, collectionId);
    }
    return out;
  }, [objectsByCollection]);

  // --- Search -----------------------------------------------------------
  // `null` means "no filter"; an empty Set means "filter matched nothing".
  // The two have to stay distinguishable or a blank box would hide the tree.
  const searchNeedle = normalizeSearchText(filter);
  const matchingObjectIds = useMemo(() => {
    if (!searchNeedle) return null;
    const out = new Set<string>();
    // Every scene object, not just the tree ones — the Managed section below
    // answers the same search and its rows are exactly the ones missing here.
    for (const object of scene.objects) {
      const haystack = objectSearchHaystack(object, componentById.get(object.componentId));
      if (haystack.includes(searchNeedle)) out.add(object.id);
    }
    return out;
  }, [searchNeedle, scene.objects, componentById]);

  // Collections kept on screen while filtering: every collection holding a
  // match plus its ancestors, so a hit is never orphaned from Master.
  const matchingCollectionIds = useMemo(() => {
    if (!matchingObjectIds) return null;
    const parentById = new Map(collections.map((c) => [c.id, c.parentId]));
    const out = new Set<string>();
    for (const objectId of matchingObjectIds) {
      const home = collectionIdByObjectId.get(objectId);
      for (let id: string | null | undefined = home; id && !out.has(id); id = parentById.get(id)) {
        out.add(id);
      }
    }
    return out;
  }, [matchingObjectIds, collectionIdByObjectId, collections]);

  // The Managed section is outside the tree but still lists objects, so it
  // has to answer the same search — leaving seven unrelated cables on screen
  // under a filter that matched none of them just reads as broken.
  const visibleManagedObjects = useMemo(
    () =>
      matchingObjectIds === null
        ? managedObjects
        : managedObjects.filter((entry) => matchingObjectIds.has(entry.object.id)),
    [managedObjects, matchingObjectIds],
  );

  // Selecting an object anywhere (3D view, marquee, another panel) reveals its
  // row here: open every collection from Master down to the object's home, or
  // the selection highlight sits inside a folder the user cannot see. Expand
  // only — nothing the user opened by hand is ever closed, and the active
  // collection is left alone (see the object-row onClick note below).
  const autoExpandedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedObjectId) {
      autoExpandedForRef.current = null;
      return;
    }
    // Expand once per selection, not on every scene update: dragging the
    // selected object rewrites `scene.objects` continuously, and without this
    // a collection the user collapsed after selecting would pop back open on
    // the next frame.
    if (autoExpandedForRef.current === selectedObjectId) return;
    const home = collectionIdByObjectId.get(selectedObjectId);
    if (!home) return; // members not loaded yet — retry on the next update
    autoExpandedForRef.current = selectedObjectId;
    const parentById = new Map(collections.map((c) => [c.id, c.parentId]));
    const chain = new Set<string>();
    for (let id: string | null | undefined = home; id && !chain.has(id); id = parentById.get(id)) {
      chain.add(id);
    }
    setExpanded((current) => {
      const missing = [...chain].filter(
        (id) => parentById.get(id) !== null && !current.has(id),
      );
      if (missing.length === 0) return current;
      const next = new Set(current);
      for (const id of missing) next.add(id);
      return next;
    });
    // A parentless row renders as a "master" row (see `isMaster` below), and
    // those read `masterCollapsed` instead of `expanded` — this scene has two
    // of them, so match on the parent, not on `masterCollectionId`.
    if ([...chain].some((id) => parentById.get(id) === null)) setMasterCollapsed(false);
  }, [selectedObjectId, collectionIdByObjectId, collections]);

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

  /** Effective rigidTransform: a collection's flag OR any ancestor's flag.
   *  Ancestors with rigidTransform=true cascade the rigid-group property
   *  to all descendants — we surface that as a "rigid (inherited)" indicator
   *  on the child row. Same set used by utils/rigidGroup.ts when expanding
   *  a transform patch. */
  const rigidCollectionIds = useMemo(
    () => computeRigidCollectionIds(collections),
    [collections],
  );

  /** Three-state lock summary for the bulk Lock icon on a collection row.
   *  Walks every descendant SceneObject; "all" / "none" / "mixed" / "empty"
   *  drives icon variant and click action. */
  const collectionLockState = useCallback(
    (collectionId: string): "all" | "none" | "mixed" | "empty" => {
      const ids = collectAllObjectIdsUnder(collectionId);
      if (ids.length === 0) return "empty";
      const objsById = new Map(visibleObjects.map((o) => [o.id, o]));
      let locked = 0;
      let unlocked = 0;
      for (const id of ids) {
        const obj = objsById.get(id);
        if (!obj) continue;
        if (obj.locked) locked += 1;
        else unlocked += 1;
      }
      if (locked === 0) return "none";
      if (unlocked === 0) return "all";
      return "mixed";
    },
    [collectAllObjectIdsUnder, visibleObjects],
  );

  /** Bulk-toggle the lock state of every descendant SceneObject in a
   *  collection. "all locked" → unlock all; otherwise → lock all. Mirrors
   *  Blender outliner's lock icon. State lives only on SceneObject — no
   *  collection-level lock field (alembic 0035). */
  const bulkToggleCollectionLocked = useCallback(
    async (collectionId: string) => {
      const ids = collectAllObjectIdsUnder(collectionId);
      if (ids.length === 0) return;
      const state = collectionLockState(collectionId);
      const nextLocked = state !== "all";
      await Promise.all(ids.map((id) => updateSceneObject(id, { locked: nextLocked })));
    },
    [collectAllObjectIdsUnder, collectionLockState, updateSceneObject],
  );

  const visibilityCtx = useMemo(
    () => makeRenderableContext(overlayFlags, sessionState, scene),
    [overlayFlags, sessionState, scene],
  );

  const masterCollection = useMemo(
    () => collections.find((collection) => collection.parentId === null) ?? null,
    [collections],
  );

  /** collectionId → the hue its row (and its objects) are banded with.
   *  Built off the UNFILTERED tree so the colours don't shuffle while the
   *  search box is narrowing the list. */
  const branchHues = useMemo(() => {
    const hues = new Map<string, string>();
    if (!masterCollection) return hues;
    hues.set(masterCollection.id, masterCollection.color);
    const walk = (parentId: string, inherited: string) => {
      (childrenIndex.get(parentId) ?? []).forEach((child, index) => {
        const explicit =
          child.color && child.color.toLowerCase() !== DEFAULT_COLLECTION_COLOR
            ? child.color
            : null;
        const hue =
          explicit ??
          (parentId === masterCollection.id
            ? BRANCH_PALETTE[index % BRANCH_PALETTE.length]
            : inherited);
        hues.set(child.id, hue);
        walk(child.id, hue);
      });
    };
    walk(masterCollection.id, masterCollection.color);
    return hues;
  }, [childrenIndex, masterCollection]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Collections whose expander actually does something: they hold a
   *  sub-collection or an object. Master is excluded — it carries its own
   *  collapsed flag, not an entry in `expanded`. */
  const expandableCollectionIds = useMemo(() => {
    const out: string[] = [];
    for (const collection of collections) {
      if (collection.parentId === null) continue;
      const hasContents =
        (childrenIndex.get(collection.id)?.length ?? 0) > 0 ||
        (objectsByCollection.get(collection.id)?.length ?? 0) > 0;
      if (hasContents) out.push(collection.id);
    }
    return out;
  }, [collections, childrenIndex, objectsByCollection]);

  const allExpanded =
    !masterCollapsed && expandableCollectionIds.every((id) => expanded.has(id));

  /** One button for both directions, Blender-style: anything still closed
   *  means the next click opens everything; only a fully open tree collapses. */
  const toggleExpandAll = useCallback(() => {
    if (allExpanded) {
      setExpanded(new Set());
      setMasterCollapsed(true);
    } else {
      setExpanded(new Set(expandableCollectionIds));
      setMasterCollapsed(false);
    }
  }, [allExpanded, expandableCollectionIds]);

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

  const handleDelete = useCallback((collection: Collection) => {
    if (collection.parentId === null) return;
    setPendingDelete(collection);
  }, []);

  /** Runs the queued deletion. `withObjects` decides the fate of every object
   *  under the subtree: delete them too, or leave them behind — the backend
   *  cascade drops their `collection_members` row, so survivors reappear
   *  under the Master Collection. Objects go first: deleting the collection
   *  first would orphan them into Master and we'd lose the id list. */
  const confirmDelete = useCallback(
    async (collection: Collection, withObjects: boolean) => {
      setPendingDelete(null);
      if (withObjects) {
        const ids = collectAllObjectIdsUnder(collection.id);
        // Locked ids are skipped inside deleteObjects (silent no-op), so
        // they survive and land in Master — the dialog says as much.
        if (ids.length > 0) await deleteObjects(ids);
      }
      await deleteCollection(collection.id);
    },
    [collectAllObjectIdsUnder, deleteCollection, deleteObjects],
  );

  const handleSaveAsTemplate = useCallback(
    async (collection: Collection) => {
      const defaultName = collection.name;
      const name = window.prompt(
        `Save "${collection.name}" (and all sub-collections + their objects) as a reusable template.\n\nTemplate name:`,
        defaultName,
      );
      if (name === null) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      await saveCollectionAsTemplate(collection.id, { name: trimmed });
      setTemplatesOpen(true);
    },
    [saveCollectionAsTemplate],
  );

  const handleInstantiateTemplate = useCallback(
    async (template: CollectionTemplate) => {
      // Drops the template at the 3D cursor (transformCursorMm.left). The
      // store action computes target = cursor; the backend places every new
      // object at cursor + that member's saved relativeOffset, so the new
      // bundle's centroid lands exactly on the cursor and relative geometry
      // matches the saved configuration.
      await instantiateCollectionTemplateAtCursor(template.id, null);
    },
    [instantiateCollectionTemplateAtCursor],
  );

  const handleDeleteTemplate = useCallback(
    async (template: CollectionTemplate) => {
      if (!window.confirm(`Delete template "${template.name}"? This cannot be undone.`))
        return;
      await deleteCollectionTemplate(template.id);
    },
    [deleteCollectionTemplate],
  );

  const handleDragStart = useCallback(
    (event: React.DragEvent, payload: DragPayload) => {
      dragPayloadRef.current = payload;
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

  /** Re-file `draggedId` next to `target` among the target's siblings and
   *  renumber the whole sibling row 0..n-1. Sibling sortOrder starts out all
   *  zero (the create API defaults it), so a partial write would leave the
   *  order ambiguous — writing the full run is what makes the arrangement
   *  stick across reloads. Only the rows whose number actually changes get a
   *  PUT. */
  const reorderCollection = useCallback(
    async (draggedId: string, target: Collection, zone: "before" | "after") => {
      const parentId = target.parentId;
      // Master is the tree root: nothing can sit beside it.
      if (parentId === null) return;
      if (draggedId === target.id) return;
      // Dropping a collection beside one of its own descendants would make it
      // its own ancestor.
      if (isAncestorOrSelf(collections, draggedId, parentId)) return;
      const dragged = collections.find((c) => c.id === draggedId);
      if (!dragged) return;
      const siblings = (childrenIndex.get(parentId) ?? []).filter((c) => c.id !== draggedId);
      const targetIndex = siblings.findIndex((c) => c.id === target.id);
      if (targetIndex < 0) return;
      const insertAt = zone === "before" ? targetIndex : targetIndex + 1;
      const ordered = [...siblings];
      ordered.splice(insertAt, 0, dragged);
      // The dragged row goes through /move (its parent may be changing too);
      // the rest only need their number rewritten.
      await moveCollection(draggedId, { parentId, sortOrder: insertAt });
      await Promise.all(
        ordered.map((collection, index) =>
          collection.id === draggedId || collection.sortOrder === index
            ? null
            : updateCollection(collection.id, { sortOrder: index }),
        ),
      );
    },
    [childrenIndex, collections, moveCollection, updateCollection],
  );

  const handleDropOnCollection = useCallback(
    async (event: React.DragEvent, targetCollection: Collection) => {
      event.preventDefault();
      // Collection nodes are NESTED (a node renders its children inside its
      // own div), so a drop on a sub-collection also bubbles to every
      // ancestor node — each one firing its own move for the same object.
      // Those competing POSTs raced on the single `collection_members` home
      // row and the last commit won, so a drop landed in the intended
      // collection only sometimes (and a multi-select drop scattered:
      // some members in, some snapped back to an ancestor). The innermost
      // node under the cursor is the only legitimate drop target.
      event.stopPropagation();
      const payload = readDragPayload(event);
      const zone = dropZoneRef.current;
      dragPayloadRef.current = null;
      setDragOverId(null);
      setDropZone("inside");
      dropZoneRef.current = "inside";
      if (!payload) return;
      if (payload.kind === "collection") {
        if (zone !== "inside") {
          await reorderCollection(payload.collectionId, targetCollection, zone);
          return;
        }
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
      // Object drop: iterate over every dragged id (single or multi-select).
      // store.moveObjectToCollection silent-skips locked, so even if a
      // pre-filter at dragstart missed something, locked stays put. We don't
      // skip "objects already in targetCollection" — the API handles the
      // no-op cheaply and it keeps the multi-select code branch-free.
      if (payload.objectIds.length === 0) return;
      await Promise.all(
        payload.objectIds.map((id) => moveObjectToCollection(targetCollection.id, id)),
      );
    },
    [collections, moveCollection, moveObjectToCollection, readDragPayload, reorderCollection],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent, target: Collection) => {
      if (event.dataTransfer.types.includes(DRAG_MIME)) {
        event.preventDefault();
        // Same nesting story as the drop handler: without this the ancestor
        // handlers run last and `dragOverId` always settled on the outermost
        // (Master) node, so the highlight pointed at the wrong row.
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDragOverId(target.id);
        // Only a collection dragged next to a non-root row can reorder; an
        // object drag always means "move into this collection". The node div
        // wraps its children, so the bands are measured against the node's
        // OWN row, not the whole subtree.
        const dragged = dragPayloadRef.current;
        const canReorder = dragged?.kind === "collection" && target.parentId !== null;
        const row = canReorder
          ? (event.currentTarget as HTMLElement).querySelector(":scope > .outliner-row")
          : null;
        let zone: DropZone = "inside";
        if (row) {
          const rect = row.getBoundingClientRect();
          const offset = (event.clientY - rect.top) / (rect.height || 1);
          zone =
            offset < REORDER_EDGE ? "before" : offset > 1 - REORDER_EDGE ? "after" : "inside";
        }
        dropZoneRef.current = zone;
        setDropZone(zone);
      }
    },
    [],
  );

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    if (event.currentTarget === event.target) {
      setDragOverId(null);
      setDropZone("inside");
      dropZoneRef.current = "inside";
    }
  }, []);

  /** Cancelled drag (Esc, drop outside the tree): clear the hover state so a
   *  stale insertion line doesn't linger. */
  const handleDragEnd = useCallback(() => {
    dragPayloadRef.current = null;
    setDragOverId(null);
    setDropZone("inside");
    dropZoneRef.current = "inside";
  }, []);

  const renderCollectionRow = (collection: Collection, depth: number) => {
    const isMaster = collection.parentId === null;
    // While a search is active every surviving branch is forced open —
    // same rule the Components catalog uses for its own filter.
    const isExpanded =
      matchingCollectionIds !== null || (isMaster ? !masterCollapsed : expanded.has(collection.id));
    const isActive = collection.id === activeCollectionId;
    const isOver = dragOverId === collection.id;
    const overZone = isOver ? dropZone : "inside";
    const collectionVisible = isCollectionVisible(collection.id, visibilityCtx);
    const collectionForced = sessionState.forceVisibleCollectionIds.has(collection.id);
    const childCollections = (childrenIndex.get(collection.id) ?? []).filter(
      (child) => matchingCollectionIds === null || matchingCollectionIds.has(child.id),
    );
    const childObjects = (objectsByCollection.get(collection.id) ?? []).filter(
      (object) => matchingObjectIds === null || matchingObjectIds.has(object.id),
    );
    const totalCount = childCollections.length + childObjects.length;
    const hue = branchHues.get(collection.id) ?? collection.color;
    return (
      <div
        key={collection.id}
        className={`outliner-node${isActive ? " active" : ""}${
          isOver && overZone === "inside" ? " drop-target" : ""
        }${isOver && overZone !== "inside" ? ` drop-${overZone}` : ""}`}
        draggable={!isMaster}
        onDragStart={
          isMaster
            ? undefined
            : (event) => {
                // Collection nodes are NESTED and `dragstart` bubbles, so the
                // ancestor node's handler ran last and overwrote dataTransfer
                // with ITS id: grabbing a sub-collection actually dragged the
                // whole outer branch. Dropping "Mirror and Mount" onto another
                // collection therefore moved its parent "Repumping" — with
                // every sibling and object under it — instead. The object rows
                // already stop propagation here for the same reason; the
                // drop/dragover handlers do it on their side.
                event.stopPropagation();
                handleDragStart(event, { kind: "collection", collectionId: collection.id });
              }
        }
        onDragEnd={handleDragEnd}
        onDragOver={(event) => handleDragOver(event, collection)}
        onDragLeave={handleDragLeave}
        onDrop={(event) => handleDropOnCollection(event, collection)}
        // No indentation: depth is carried by the colour band. The three
        // custom properties cascade to this collection's own row AND to the
        // object rows nested under it.
        style={
          {
            "--otl-hue": hue,
            "--otl-tint": withAlpha(hue, bandAlpha(depth)),
            "--otl-tint-obj": withAlpha(hue, bandAlpha(depth) * 0.45),
          } as React.CSSProperties
        }
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
              if (isMaster) setMasterCollapsed((current) => !current);
              else toggleExpanded(collection.id);
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
            style={{ background: hue }}
            title={isMaster ? "Master Collection" : `Color: ${hue}`}
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
          {(() => {
            const lockState = collectionLockState(collection.id);
            const lockTitle =
              lockState === "empty"
                ? "No objects to lock"
                : lockState === "all"
                  ? "Unlock all objects in this collection"
                  : lockState === "none"
                    ? "Lock all objects in this collection"
                    : "Lock all (some currently unlocked)";
            return (
              <button
                type="button"
                className={`outliner-action${lockState === "all" ? " active" : ""}${lockState === "mixed" ? " muted" : ""}`}
                title={lockTitle}
                disabled={lockState === "empty"}
                onClick={(event) => {
                  event.stopPropagation();
                  void bulkToggleCollectionLocked(collection.id);
                }}
              >
                {lockState === "all" || lockState === "mixed" ? (
                  <Lock size={13} />
                ) : (
                  <LockOpen size={13} />
                )}
              </button>
            );
          })()}
          {(() => {
            const ownRigid = collection.rigidTransform;
            const inheritedRigid = !ownRigid && rigidCollectionIds.has(collection.id);
            const effectiveRigid = ownRigid || inheritedRigid;
            // Frozen-group detector: a rigid group containing any locked
            // descendant object can't be transformed at all (the rigid-group
            // expander rejects the whole patch when a non-leading member is
            // locked). Surface this with an amber "warning" class on the
            // icon + a more pointed tooltip so the user knows why the gizmo
            // appears unresponsive.
            const lockedDescendantCount = effectiveRigid
              ? collectAllObjectIdsUnder(collection.id).reduce((acc, id) => {
                  return acc + (objectsById.get(id)?.locked ? 1 : 0);
                }, 0)
              : 0;
            const isFrozen = effectiveRigid && lockedDescendantCount > 0;
            const rigidTitle = isFrozen
              ? `Rigid group is frozen — ${lockedDescendantCount} member${lockedDescendantCount === 1 ? "" : "s"} locked. Unlock to move.`
              : ownRigid
                ? "Rigid group ON — disable to unlink relative pose"
                : inheritedRigid
                  ? "Rigid group inherited from ancestor"
                  : "Rigid group OFF — enable to lock A↔B↔C relative pose";
            return (
              <button
                type="button"
                className={`outliner-action${ownRigid ? " active" : ""}${inheritedRigid && !isFrozen ? " muted" : ""}${isFrozen ? " warning" : ""}`}
                title={rigidTitle}
                disabled={isMaster && !ownRigid && !inheritedRigid}
                onClick={(event) => {
                  event.stopPropagation();
                  void updateCollection(collection.id, { rigidTransform: !ownRigid });
                }}
              >
                {effectiveRigid ? <Link2 size={13} /> : <Link2Off size={13} />}
              </button>
            );
          })()}
          <button
            type="button"
            className="outliner-action is-command"
            title="Add sub-collection"
            onClick={(event) => {
              event.stopPropagation();
              void handleAddChild(collection.id);
            }}
          >
            <FolderPlus size={13} />
          </button>
          <button
            type="button"
            className="outliner-action is-command"
            title="Save as template (Collection Drift) — captures structure, sub-collections and relative poses"
            onClick={(event) => {
              event.stopPropagation();
              void handleSaveAsTemplate(collection);
            }}
          >
            <Bookmark size={13} />
          </button>
          {!isMaster && editingId !== collection.id && (
            <button
              type="button"
              className="outliner-action is-command"
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
              className="outliner-action danger-action is-command"
              title="Delete collection"
              onClick={(event) => {
                event.stopPropagation();
                handleDelete(collection);
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
              // Drag-source ids: if this object is part of the current
              // selection, drag the whole selection (multi-select group
              // move); otherwise drag just this row. Locked ids are
              // pre-filtered — store.moveObjectToCollection silent-skips
              // locked anyway, but the pre-filter lets us suppress the
              // entire drag when there's nothing draggable left.
              const dragSourceIds = isSelected ? selectedObjectIds : [object.id];
              const dragableIds = dragSourceIds.filter((id) => !objectsById.get(id)?.locked);
              const dragable = dragableIds.length > 0;
              return (
                <div
                  key={`${collection.id}:${object.id}`}
                  data-object-id={object.id}
                  className={`outliner-row object-row${isSelected ? " selected" : ""}`}
                  draggable={dragable}
                  onDragStart={(event) => {
                    event.stopPropagation();
                    if (!dragable) {
                      event.preventDefault();
                      return;
                    }
                    handleDragStart(event, {
                      kind: "object",
                      objectIds: dragableIds,
                      sourceCollectionId: collection.id,
                    });
                  }}
                  onDragEnd={handleDragEnd}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectObject(object.id, {
                      additive: event.ctrlKey || event.metaKey || event.shiftKey,
                    });
                    // Deliberately does NOT touch the active collection.
                    // It used to, which meant merely clicking a mirror in
                    // the outliner silently re-homed every subsequently
                    // created component into that mirror's collection —
                    // and `activeCollectionId` is persisted, so it survived
                    // reloads. Blender does the same: selecting an object
                    // never changes the active collection, only clicking a
                    // collection row does.
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
                    className={`outliner-action${object.locked ? " active" : ""}`}
                    title={object.locked ? "Unlock object" : "Lock object (block move + delete)"}
                    onClick={(event) => {
                      event.stopPropagation();
                      void updateSceneObject(object.id, { locked: !object.locked });
                    }}
                  >
                    {object.locked ? <Lock size={13} /> : <LockOpen size={13} />}
                  </button>
                  <button
                    type="button"
                    className="outliner-action danger-action is-command"
                    title={object.locked ? "Locked — unlock to delete" : "Delete object"}
                    disabled={object.locked}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (object.locked) return;
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
          title={allExpanded ? "Collapse all collections" : "Expand all collections"}
          aria-label={allExpanded ? "Collapse all collections" : "Expand all collections"}
          onClick={toggleExpandAll}
        >
          {allExpanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
        </button>
        <button
          type="button"
          className={`outliner-action${templatesOpen ? " active" : ""}`}
          title={
            templatesOpen
              ? "Hide collection templates"
              : `Collection templates (Drift) — ${collectionTemplates.length} saved`
          }
          onClick={() => setTemplatesOpen((open) => !open)}
        >
          <Library size={14} />
        </button>
        <button
          type="button"
          className="outliner-action"
          title="New top-level collection"
          onClick={() => void handleAddChild(masterCollection.id)}
        >
          <FolderPlus size={14} />
        </button>
      </div>
      {/* Objects are matched on their Component's identity as well as their
          own name (see objectSearchHaystack) — the thing a user is looking
          for is the part ("Post Spacer 2.0 mm"), which is what the catalog
          calls it, not the name the placed instance happens to carry. */}
      <div className="search-row outliner-search">
        <Search size={14} />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search objects / components"
        />
        {matchingObjectIds && <span className="outliner-count">{matchingObjectIds.size}</span>}
        {filter.length > 0 && (
          <button
            type="button"
            className="outliner-action"
            title="Clear search"
            onClick={() => setFilter("")}
          >
            <X size={13} />
          </button>
        )}
      </div>
      <MarqueeTree
        objects={visibleObjects}
        selectedObjectIds={selectedObjectIds}
        setSelectedObjects={setSelectedObjects}
      >
        {renderCollectionRow(masterCollection, 0)}
        {matchingObjectIds?.size === 0 && (
          <p className="outliner-empty">No object matches "{filter.trim()}".</p>
        )}
      </MarqueeTree>
      {/* Managed objects — the kinds deliberately kept out of the tree above
          (`capabilityProfile.outlinerVisible === false`: rf_cable, PPG). They
          are created and removed from the RF Link panel, so listing them as
          normal rows would invite exactly the out-of-band edits that profile
          prevents. But they still need ONE affordance: visibility. Picking in
          the 3D viewer now ignores invisible objects, so without a row here a
          permanently-hidden cable would be unreachable from every surface at
          once. Hence eye-only — no drag, no lock, no delete. */}
      {visibleManagedObjects.length > 0 && (
        <div className="outliner-managed">
          <div className="outliner-managed-header">
            <span>Managed</span>
            <small>RF Link / Pulse &amp; Timing owns these — visibility only</small>
          </div>
          {visibleManagedObjects.map(({ object, kindLabel }) => (
            <div key={object.id} className="outliner-row object-row" title={object.name}>
              <Layers3 size={14} />
              <span className="outliner-name">
                <em>{object.name}</em>
                <small>{kindLabel}</small>
              </span>
              <button
                type="button"
                className={`outliner-action${object.visible ? "" : " muted"}`}
                title={object.visible ? "Hide object" : "Show object"}
                onClick={() => void updateSceneObject(object.id, { visible: !object.visible })}
              >
                {object.visible ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
            </div>
          ))}
        </div>
      )}
      {templatesOpen && (
        <div className="outliner-templates">
          <div className="outliner-templates-header">
            <span>Templates</span>
            <small>
              instantiate @ cursor ({cursorMm.x.toFixed(0)}, {cursorMm.y.toFixed(0)},{" "}
              {cursorMm.z.toFixed(0)}) mm
            </small>
          </div>
          {collectionTemplates.length === 0 ? (
            <p className="outliner-empty">
              No templates yet. Save any collection (bookmark icon) to add one here.
            </p>
          ) : (
            <ul className="outliner-templates-list">
              {collectionTemplates.map((template) => {
                const totalMembers = countTemplateMembers(template.tree);
                const totalCollections = countTemplateCollections(template.tree);
                return (
                  <li key={template.id} className="outliner-templates-row">
                    <button
                      type="button"
                      className="outliner-templates-instantiate"
                      title={`Instantiate "${template.name}" at the 3D cursor — places ${totalMembers} object${totalMembers === 1 ? "" : "s"} across ${totalCollections} collection${totalCollections === 1 ? "" : "s"}`}
                      onClick={() => void handleInstantiateTemplate(template)}
                    >
                      <Stamp size={13} />
                      <span className="outliner-name">
                        <em>{template.name}</em>
                        <small>
                          {totalCollections} col · {totalMembers} obj
                        </small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="outliner-action danger-action"
                      title="Delete template"
                      onClick={() => void handleDeleteTemplate(template)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {pendingDelete && (
        <DeleteCollectionDialog
          collection={pendingDelete}
          subCollectionCount={countCollectionsUnder(childrenIndex, pendingDelete.id) - 1}
          objectIds={collectAllObjectIdsUnder(pendingDelete.id)}
          objectsById={objectsById}
          onCancel={() => setPendingDelete(null)}
          onConfirm={(withObjects) => void confirmDelete(pendingDelete, withObjects)}
        />
      )}
    </section>
  );
}

/** Total collections in the subtree rooted at `rootId`, itself included. */
function countCollectionsUnder(childrenIndex: ChildrenIndex, rootId: string): number {
  let total = 1;
  for (const child of childrenIndex.get(rootId) ?? []) {
    total += countCollectionsUnder(childrenIndex, child.id);
  }
  return total;
}

/** Delete confirmation with two outcomes, because the objects inside a
 *  collection can either follow it into the bin or stay in the scene. Sub-
 *  collections have no such choice — the FK cascade always takes them. */
function DeleteCollectionDialog({
  collection,
  subCollectionCount,
  objectIds,
  objectsById,
  onCancel,
  onConfirm,
}: {
  collection: Collection;
  subCollectionCount: number;
  objectIds: string[];
  objectsById: Map<string, SceneObject>;
  onCancel: () => void;
  onConfirm: (withObjects: boolean) => void;
}) {
  const lockedCount = objectIds.filter((id) => objectsById.get(id)?.locked).length;
  const objectCount = objectIds.length;
  const plural = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card outliner-delete-card"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Delete "{collection.name}"</h2>
        </div>
        <div className="modal-body">
          <p>
            {subCollectionCount > 0
              ? `This collection and its ${plural(subCollectionCount, "sub-collection")} will be deleted.`
              : "This collection will be deleted."}
          </p>
          {objectCount > 0 ? (
            <p>
              It holds {plural(objectCount, "object")}. Choose what happens to them:
              keeping them moves them back to the Master Collection.
            </p>
          ) : (
            <p>It holds no objects.</p>
          )}
          {lockedCount > 0 && (
            <p className="outliner-delete-note">
              {plural(lockedCount, "object")} {lockedCount === 1 ? "is" : "are"} locked
              and cannot be deleted — {lockedCount === 1 ? "it moves" : "they move"} to
              the Master Collection either way.
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="secondary-button" onClick={() => onConfirm(false)}>
            Delete collection only
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={objectCount === 0}
            onClick={() => onConfirm(true)}
          >
            Delete with {plural(objectCount, "object")}
          </button>
        </div>
      </div>
    </div>
  );
}

function countTemplateMembers(node: CollectionTemplate["tree"]): number {
  let total = node.members.length;
  for (const child of node.children) total += countTemplateMembers(child);
  return total;
}

function countTemplateCollections(node: CollectionTemplate["tree"]): number {
  let total = 1;
  for (const child of node.children) total += countTemplateCollections(child);
  return total;
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
