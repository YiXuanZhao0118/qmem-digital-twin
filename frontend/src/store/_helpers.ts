/**
 * Sub-module of sceneStore — pure data helpers that have no
 * dependency on `set`/`get` and can be unit-tested in isolation.
 *
 * Imported by sceneStore.ts; not re-exported (consumers don't need
 * direct access).
 */
import type {
  Collection,
  CollectionMember,
  SceneData,
} from "../types/digitalTwin";

import { EMPTY_SESSION_VISIBILITY, type SessionVisibilityState } from "../utils/visibility";

/** Master collection has parentId === null. Returns the first such
 *  collection's id, or null if no collections exist yet. */
export function findMasterCollectionId(collections: Collection[] | undefined): string | null {
  if (!collections) return null;
  for (const collection of collections) {
    if (collection.parentId === null) return collection.id;
  }
  return null;
}

/** Walk the collection tree and assign each node its depth (root=0).
 *  Memoised + cycle-safe (sees-set caps recursion at any cycle). */
export function collectionDepths(collections: Collection[] | undefined): Map<string, number> {
  const byId = new Map((collections ?? []).map((collection) => [collection.id, collection]));
  const cache = new Map<string, number>();
  const depthOf = (collectionId: string, seen = new Set<string>()): number => {
    const cached = cache.get(collectionId);
    if (cached !== undefined) return cached;
    if (seen.has(collectionId)) return 0;
    const collection = byId.get(collectionId);
    if (!collection?.parentId) {
      cache.set(collectionId, 0);
      return 0;
    }
    const depth = depthOf(collection.parentId, new Set([...seen, collectionId])) + 1;
    cache.set(collectionId, depth);
    return depth;
  };
  for (const collection of collections ?? []) depthOf(collection.id);
  return cache;
}

/** Each SceneObject can appear in many collections, but the Outliner
 *  treats one as canonical (deepest collection > most-recently-added >
 *  highest sortOrder > collectionId lex). Strip duplicates so each
 *  object appears in exactly one collection downstream. */
export function normalizeCollectionMembers(
  collections: Collection[] | undefined,
  members: CollectionMember[] | undefined,
): CollectionMember[] {
  const depths = collectionDepths(collections);
  const collectionIds = new Set((collections ?? []).map((collection) => collection.id));
  const byObject = new Map<string, CollectionMember>();
  const score = (member: CollectionMember) => ({
    depth: depths.get(member.collectionId) ?? 0,
    addedAt: member.addedAt ? Date.parse(member.addedAt) || 0 : 0,
    sortOrder: member.sortOrder,
    collectionId: member.collectionId,
  });
  const isBetter = (candidate: CollectionMember, current: CollectionMember): boolean => {
    const a = score(candidate);
    const b = score(current);
    if (a.depth !== b.depth) return a.depth > b.depth;
    if (a.addedAt !== b.addedAt) return a.addedAt > b.addedAt;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder > b.sortOrder;
    return a.collectionId > b.collectionId;
  };

  for (const member of members ?? []) {
    if (!collectionIds.has(member.collectionId)) continue;
    const current = byObject.get(member.objectId);
    if (!current || isBetter(member, current)) {
      byObject.set(member.objectId, member);
    }
  }

  return Array.from(byObject.values()).sort((a, b) => {
    const collectionCompare = a.collectionId.localeCompare(b.collectionId);
    if (collectionCompare !== 0) return collectionCompare;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return (a.addedAt ?? "").localeCompare(b.addedAt ?? "");
  });
}

/** Re-emit SceneData with collectionMembers de-duped per the
 *  normalizeCollectionMembers rule. Called every time the store
 *  receives a fresh scene payload from the API. */
export function normalizeSceneData(scene: SceneData): SceneData {
  return {
    ...scene,
    collectionMembers: normalizeCollectionMembers(scene.collections, scene.collectionMembers),
  };
}

/** Deep-clone a SessionVisibilityState so a `set()` call gets a new
 *  reference (Zustand shallow-equality bails out without one). */
export function cloneSession(state: SessionVisibilityState): SessionVisibilityState {
  return {
    hiddenObjectIds: new Set(state.hiddenObjectIds),
    hiddenBeamPathIds: new Set(state.hiddenBeamPathIds),
    hiddenLinkIds: new Set(state.hiddenLinkIds),
    hiddenRelationIds: new Set(state.hiddenRelationIds),
    soloObjectIds: state.soloObjectIds ? new Set(state.soloObjectIds) : null,
    soloIncludeNeighbors: state.soloIncludeNeighbors,
    forceVisibleObjectIds: new Set(state.forceVisibleObjectIds ?? []),
    forceVisibleCollectionIds: new Set(state.forceVisibleCollectionIds ?? []),
  };
}

/** Empty visibility state used after destructive ops (e.g. clearing
 *  the scene, switching modules). */
export function freshSession(): SessionVisibilityState {
  return cloneSession(EMPTY_SESSION_VISIBILITY);
}
