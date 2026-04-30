import { create } from "zustand";

import {
  createAssemblyRelationApi,
  createOpticalElementApi,
  createOpticalLinkApi,
  createPlacementApi,
  createComponentApi,
  deleteAssemblyRelationApi,
  deleteComponentApi,
  deleteObjectApi,
  deleteOpticalElementApi,
  deleteOpticalLinkApi,
  fetchScene,
  importLocalComponentAssetApi,
  runOpticalSimulationApi,
  updateAssemblyRelationApi,
  updateComponentApi,
  updateOpticalElementApi,
  updateOpticalLinkApi,
  updatePlacementObjectApi,
  uploadComponentAssetApi,
} from "../api/client";
import type {
  OpticalElementApiPayload,
  OpticalLinkApiPayload,
  OpticalRunResponse,
} from "../api/client";
import type {
  BeamPath,
  AssemblyRelation,
  ComponentItem,
  GeometrySelector,
  ConnectionItem,
  DeviceState,
  ElementKind,
  OpticalElement,
  OpticalLink,
  PhysicsCapability,
  PlacementPatch,
  RelationType,
  SceneData,
  SceneEvent,
  SceneObject,
} from "../types/digitalTwin";

type RelationDraftTarget = {
  objectAId: string;
  objectBId: string;
  anchorAId: string;
  anchorBId: string;
} | null;

type LoadStatus = "idle" | "loading" | "ready" | "error";
type SocketStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";

const emptyScene: SceneData = {
  assets: [],
  components: [],
  placements: [],
  objects: [],
  connections: [],
  assemblyRelations: [],
  beamPaths: [],
  deviceStates: [],
  opticalElements: [],
  opticalLinks: [],
};

type SceneStore = {
  scene: SceneData;
  previewObjectTransforms: Record<string, Partial<Pick<SceneObject, "xMm" | "yMm" | "zMm" | "rxDeg" | "ryDeg" | "rzDeg">>>;
  relationDraftTarget: RelationDraftTarget;
  loadStatus: LoadStatus;
  socketStatus: SocketStatus;
  error?: string;
  selectedComponentId: string | null;
  selectedObjectId: string | null;
  selectedRelationId: string | null;
  loadScene: () => Promise<void>;
  createComponent: (name: string, componentType: string) => Promise<ComponentItem>;
  uploadComponentAsset: (payload: {
    file: File;
    name: string;
    componentType: string;
    brand?: string;
    model?: string;
    unit?: "mm" | "m";
    scaleFactor?: number;
  }) => Promise<ComponentItem>;
  importLocalComponentAsset: (payload: {
    sourcePath: string;
    name?: string;
    componentType: string;
    brand?: string;
    model?: string;
    unit?: "mm" | "m";
    scaleFactor?: number;
  }) => Promise<ComponentItem>;
  ensureObjectForComponent: (componentId: string) => Promise<void>;
  updateComponent: (componentId: string, patch: Partial<Pick<ComponentItem, "name" | "properties">>) => Promise<void>;
  deleteComponent: (componentId: string) => Promise<void>;
  createAssemblyRelation: (payload: {
    name: string;
    relationType: RelationType;
    objectAId: string;
    objectBId: string;
    selectorA?: GeometrySelector;
    selectorB?: GeometrySelector;
    offsetMm?: number | null;
    angleDeg?: number | null;
    properties?: Record<string, unknown>;
  }) => Promise<AssemblyRelation>;
  updateAssemblyRelation: (
    relationId: string,
    patch: Partial<Omit<AssemblyRelation, "id" | "createdAt" | "updatedAt">>,
  ) => Promise<AssemblyRelation>;
  deleteAssemblyRelation: (relationId: string) => Promise<void>;
  updateObjectPlacement: (objectId: string, patch: PlacementPatch) => Promise<void>;
  deleteObject: (objectId: string) => Promise<void>;
  setComponentCapabilities: (
    componentId: string,
    capabilities: PhysicsCapability[],
  ) => Promise<void>;
  upsertOpticalElement: (payload: OpticalElementApiPayload) => Promise<OpticalElement>;
  deleteOpticalElement: (componentId: string) => Promise<void>;
  createOpticalLink: (payload: OpticalLinkApiPayload) => Promise<OpticalLink>;
  updateOpticalLink: (
    linkId: string,
    patch: Partial<Pick<OpticalLinkApiPayload, "freeSpaceMm" | "properties">>,
  ) => Promise<OpticalLink>;
  deleteOpticalLink: (linkId: string) => Promise<void>;
  runOpticalSimulation: () => Promise<OpticalRunResponse>;
  selectComponent: (componentId: string | null) => void;
  selectObject: (objectId: string | null) => void;
  selectRelation: (relationId: string | null) => void;
  previewObjectTransform: (
    objectId: string,
    transform: Partial<Pick<SceneObject, "xMm" | "yMm" | "zMm" | "rxDeg" | "ryDeg" | "rzDeg">>,
  ) => void;
  clearPreviewObjectTransform: (objectId?: string) => void;
  setRelationDraftTarget: (target: RelationDraftTarget) => void;
  applyEvent: (event: SceneEvent) => void;
  setSocketStatus: (status: SocketStatus) => void;
};

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  return items.map((item) => (item.id === next.id ? next : item));
}

function upsertObject(items: SceneObject[], next: SceneObject): SceneObject[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}

function upsertDeviceState(items: DeviceState[], next: DeviceState): DeviceState[] {
  const index = items.findIndex((item) => item.componentId === next.componentId);
  if (index === -1) return [...items, next];
  return items.map((item) => (item.componentId === next.componentId ? next : item));
}

function withoutRelationsForObjects(relations: AssemblyRelation[], objectIds: Set<string>): AssemblyRelation[] {
  return relations.filter(
    (relation) => !objectIds.has(relation.objectAId) && !objectIds.has(relation.objectBId),
  );
}

function nextPlacementOffset(count: number): PlacementPatch {
  return {
    xMm: -700 + ((count * 140) % 1400),
    yMm: -420 + Math.floor(count / 10) * 140,
    zMm: 70,
    rzDeg: 0,
    visible: true,
    locked: false,
  };
}

function isComponentLocked(component?: ComponentItem): boolean {
  return component?.properties?.locked === true;
}

export const useSceneStore = create<SceneStore>((set, get) => ({
  scene: emptyScene,
  previewObjectTransforms: {},
  relationDraftTarget: null,
  loadStatus: "idle",
  socketStatus: "idle",
  selectedComponentId: null,
  selectedObjectId: null,
  selectedRelationId: null,

  async loadScene() {
    set({ loadStatus: "loading", error: undefined });
    try {
      const scene = await fetchScene();
      const currentObjectId = get().selectedObjectId;
      const currentComponentId = get().selectedComponentId;
      const selectedObjectCandidate = currentObjectId
        ? scene.objects.find((object) => object.id === currentObjectId)
        : undefined;
      const selectedObject = selectedObjectCandidate;
      const selectedComponentCandidate = currentComponentId
        ? scene.components.find((component) => component.id === currentComponentId)
        : undefined;
      const selectedComponent = selectedComponentCandidate;
      const fallbackObject = selectedComponent ? undefined : selectedObject ?? scene.objects[0];

      set({
        scene,
        loadStatus: "ready",
        selectedObjectId: fallbackObject?.id ?? null,
        selectedComponentId: selectedComponent?.id ?? null,
      });
    } catch (error) {
      set({
        loadStatus: "error",
        error: error instanceof Error ? error.message : "Failed to load scene",
      });
    }
  },

  async createComponent(name, componentType) {
    const component = await createComponentApi({
      name,
      componentType,
      properties: { geometry: componentType },
    });
    const placement = await createPlacementApi({
      componentId: component.id,
      ...nextPlacementOffset(get().scene.components.length),
    });
    await get().loadScene();
    set({ selectedComponentId: component.id, selectedObjectId: null });
    return component;
  },

  async importLocalComponentAsset(payload) {
    const component = await importLocalComponentAssetApi(payload);
    const placement = await createPlacementApi({
      componentId: component.id,
      ...nextPlacementOffset(get().scene.objects.length),
      visible: true,
      locked: false,
    });
    await get().loadScene();
    set({ selectedComponentId: component.id, selectedObjectId: null });
    return component;
  },

  async uploadComponentAsset(payload) {
    const component = await uploadComponentAssetApi(payload);
    const placement = await createPlacementApi({
      componentId: component.id,
      ...nextPlacementOffset(get().scene.objects.length),
      visible: true,
      locked: false,
    });
    await get().loadScene();
    set({ selectedComponentId: component.id, selectedObjectId: null });
    return component;
  },

  async ensureObjectForComponent(componentId) {
    const scene = get().scene;
    const placement = await createPlacementApi({
      componentId,
      ...nextPlacementOffset(scene.objects.length),
      visible: true,
      locked: false,
    });
    set((state) => ({
      selectedComponentId: null,
      selectedObjectId: placement.id ?? null,
      scene: {
        ...state.scene,
        objects: upsertObject(state.scene.objects, placement),
        placements: upsertObject(state.scene.placements, placement),
      },
    }));
  },

  async updateComponent(componentId, patch) {
    const component = await updateComponentApi(componentId, patch);
    set((state) => ({
      selectedComponentId: component.id,
      scene: {
        ...state.scene,
        components: upsertById(state.scene.components, component),
      },
    }));
  },

  async deleteComponent(componentId) {
    const component = get().scene.components.find((item) => item.id === componentId);
    if (isComponentLocked(component)) return;
    await deleteComponentApi(componentId);
    set((state) => {
      const nextComponents = state.scene.components.filter((component) => component.id !== componentId);
      const removedObjectIds = new Set(
        state.scene.objects.filter((object) => object.componentId === componentId).map((object) => object.id),
      );
      const nextObjects = state.scene.objects.filter((object) => object.componentId !== componentId);
      const fallbackObject = nextObjects[0];
      const fallbackComponent =
        nextComponents.find((component) => component.id === fallbackObject?.componentId) ?? nextComponents[0];
      return {
        selectedObjectId:
          state.selectedObjectId && state.scene.objects.some((object) => object.id === state.selectedObjectId && object.componentId === componentId)
            ? fallbackObject?.id ?? null
            : state.selectedObjectId,
        selectedComponentId:
          state.selectedComponentId === componentId ? fallbackComponent?.id ?? null : state.selectedComponentId,
        scene: {
          ...state.scene,
          components: nextComponents,
          placements: state.scene.placements.filter((object) => object.componentId !== componentId),
          objects: nextObjects,
          beamPaths: state.scene.beamPaths.filter(
            (beamPath) =>
              beamPath.sourceComponentId !== componentId && beamPath.targetComponentId !== componentId,
          ),
          connections: state.scene.connections.filter(
            (connection) =>
              connection.fromComponentId !== componentId && connection.toComponentId !== componentId,
          ),
          assemblyRelations: withoutRelationsForObjects(state.scene.assemblyRelations, removedObjectIds),
          deviceStates: state.scene.deviceStates.filter((item) => item.componentId !== componentId),
        },
      };
    });
  },

  async createAssemblyRelation(payload) {
    const relation = await createAssemblyRelationApi(payload);
    const scene = await fetchScene();

    set({
      selectedRelationId: relation.id,
      scene: {
        ...scene,
        assemblyRelations: upsertById(scene.assemblyRelations, relation),
      },
    });

    return relation;
  },

  async updateAssemblyRelation(relationId, patch) {
    const relation = await updateAssemblyRelationApi(relationId, patch);
    const scene = await fetchScene();
    set({
      scene: {
        ...scene,
        assemblyRelations: upsertById(scene.assemblyRelations, relation),
      },
    });
    return relation;
  },

  async deleteAssemblyRelation(relationId) {
    await deleteAssemblyRelationApi(relationId);
    set((state) => ({
      selectedRelationId: state.selectedRelationId === relationId ? null : state.selectedRelationId,
      scene: {
        ...state.scene,
        assemblyRelations: state.scene.assemblyRelations.filter((relation) => relation.id !== relationId),
      },
    }));
  },

  async updateObjectPlacement(objectId, patch) {
    const placement = await updatePlacementObjectApi(objectId, patch);
    set((state) => ({
      selectedObjectId: placement.id ?? objectId,
      selectedComponentId: null,
      scene: {
        ...state.scene,
        objects: upsertObject(state.scene.objects, placement),
        placements: upsertObject(state.scene.placements, placement),
      },
    }));
  },

  async deleteObject(objectId) {
    await deleteObjectApi(objectId);
    set((state) => {
      const nextObjects = state.scene.objects.filter((object) => object.id !== objectId);
      const fallback = nextObjects[0];
      return {
        selectedObjectId: state.selectedObjectId === objectId ? fallback?.id ?? null : state.selectedObjectId,
        selectedComponentId:
          state.selectedObjectId === objectId ? fallback?.componentId ?? null : state.selectedComponentId,
        scene: {
          ...state.scene,
          objects: nextObjects,
          placements: state.scene.placements.filter((object) => object.id !== objectId),
          assemblyRelations: state.scene.assemblyRelations.filter(
            (relation) => relation.objectAId !== objectId && relation.objectBId !== objectId,
          ),
        },
      };
    });
  },

  async setComponentCapabilities(componentId, capabilities) {
    const updated = await updateComponentApi(componentId, { physicsCapabilities: capabilities } as Partial<ComponentItem>);
    set((state) => ({
      scene: { ...state.scene, components: upsertById(state.scene.components, updated) },
    }));
  },

  async upsertOpticalElement(payload) {
    const existing = get().scene.opticalElements.find((item) => item.componentId === payload.componentId);
    let element: OpticalElement;
    if (existing) {
      const { componentId, ...patch } = payload;
      element = await updateOpticalElementApi(componentId, patch);
    } else {
      element = await createOpticalElementApi(payload);
    }
    set((state) => {
      const others = state.scene.opticalElements.filter(
        (item) => item.componentId !== element.componentId,
      );
      return {
        scene: { ...state.scene, opticalElements: [...others, element] },
      };
    });
    return element;
  },

  async deleteOpticalElement(componentId) {
    await deleteOpticalElementApi(componentId);
    set((state) => ({
      scene: {
        ...state.scene,
        opticalElements: state.scene.opticalElements.filter(
          (item) => item.componentId !== componentId,
        ),
        opticalLinks: state.scene.opticalLinks.filter(
          (link) => link.fromComponentId !== componentId && link.toComponentId !== componentId,
        ),
      },
    }));
  },

  async createOpticalLink(payload) {
    const link = await createOpticalLinkApi(payload);
    set((state) => ({
      scene: { ...state.scene, opticalLinks: [...state.scene.opticalLinks, link] },
    }));
    return link;
  },

  async updateOpticalLink(linkId, patch) {
    const link = await updateOpticalLinkApi(linkId, patch);
    set((state) => ({
      scene: { ...state.scene, opticalLinks: upsertById(state.scene.opticalLinks, link) },
    }));
    return link;
  },

  async deleteOpticalLink(linkId) {
    await deleteOpticalLinkApi(linkId);
    set((state) => ({
      scene: {
        ...state.scene,
        opticalLinks: state.scene.opticalLinks.filter((link) => link.id !== linkId),
      },
    }));
  },

  async runOpticalSimulation() {
    return await runOpticalSimulationApi();
  },

  selectComponent(componentId) {
    set({
      selectedComponentId: componentId,
      selectedObjectId: null,
      selectedRelationId: null,
    });
  },

  selectObject(objectId) {
    set({
      selectedObjectId: objectId,
      selectedComponentId: null,
      selectedRelationId: null,
    });
  },

  selectRelation(relationId) {
    set({ selectedRelationId: relationId });
  },

  previewObjectTransform(objectId, transform) {
    set((state) => ({
      previewObjectTransforms: {
        ...state.previewObjectTransforms,
        [objectId]: transform,
      },
    }));
  },

  clearPreviewObjectTransform(objectId) {
    set((state) => {
      if (!objectId) return { previewObjectTransforms: {} };
      const next = { ...state.previewObjectTransforms };
      delete next[objectId];
      return { previewObjectTransforms: next };
    });
  },

  setRelationDraftTarget(relationDraftTarget) {
    set({ relationDraftTarget });
  },

  applyEvent(event) {
    if (event.type === "scene.reload") {
      void get().loadScene();
      return;
    }
    if (event.type === "scene.connected" || event.type === "pong") return;

    set((state) => {
      const scene = state.scene;
      switch (event.type) {
        case "component.created":
        case "component.updated":
          return {
            scene: {
              ...scene,
              components: upsertById(scene.components, event.payload),
            },
          };
        case "component.deleted": {
          const componentId = event.payload.componentId ?? event.payload.id;
          const removedObjectIds = new Set(
            scene.objects.filter((item) => item.componentId === componentId).map((item) => item.id),
          );
          return {
            selectedComponentId:
              state.selectedComponentId === componentId ? null : state.selectedComponentId,
            selectedObjectId: scene.objects.some(
              (item) => item.id === state.selectedObjectId && item.componentId === componentId,
            )
              ? null
              : state.selectedObjectId,
            scene: {
              ...scene,
              components: scene.components.filter((item) => item.id !== componentId),
              placements: scene.placements.filter((item) => item.componentId !== componentId),
              objects: scene.objects.filter((item) => item.componentId !== componentId),
              beamPaths: scene.beamPaths.filter(
                (item) => item.sourceComponentId !== componentId && item.targetComponentId !== componentId,
              ),
              connections: scene.connections.filter(
                (item) => item.fromComponentId !== componentId && item.toComponentId !== componentId,
              ),
              assemblyRelations: withoutRelationsForObjects(scene.assemblyRelations, removedObjectIds),
              deviceStates: scene.deviceStates.filter((item) => item.componentId !== componentId),
            },
          };
        }
        case "placement.updated":
        case "object.updated":
          return {
            selectedObjectId:
              state.selectedComponentId === event.payload.componentId && !state.selectedObjectId
                ? event.payload.id ?? null
                : state.selectedObjectId,
            scene: {
              ...scene,
              objects: upsertObject(scene.objects, event.payload),
              placements: upsertObject(scene.placements, event.payload),
            },
          };
        case "object.deleted": {
          const objectId = event.payload.objectId ?? event.payload.id;
          const nextObjects = scene.objects.filter((item) => item.id !== objectId);
          const fallback = nextObjects[0];
          return {
            selectedObjectId: state.selectedObjectId === objectId ? fallback?.id ?? null : state.selectedObjectId,
            selectedComponentId:
              state.selectedObjectId === objectId ? fallback?.componentId ?? null : state.selectedComponentId,
            scene: {
              ...scene,
              objects: nextObjects,
              placements: scene.placements.filter((item) => item.id !== objectId),
              assemblyRelations: scene.assemblyRelations.filter(
                (relation) => relation.objectAId !== objectId && relation.objectBId !== objectId,
              ),
            },
          };
        }
        case "assembly_relation.updated":
          return {
            scene: {
              ...scene,
              assemblyRelations: event.payload.deleted
                ? scene.assemblyRelations.filter((item) => item.id !== event.payload.id)
                : upsertById(scene.assemblyRelations, event.payload as AssemblyRelation),
            },
          };
        case "beam_path.updated":
          return {
            scene: {
              ...scene,
              beamPaths: event.payload.deleted
                ? scene.beamPaths.filter((item) => item.id !== event.payload.id)
                : upsertById(scene.beamPaths, event.payload as BeamPath),
            },
          };
        case "connection.updated":
          return {
            scene: {
              ...scene,
              connections: event.payload.deleted
                ? scene.connections.filter((item) => item.id !== event.payload.id)
                : upsertById(scene.connections, event.payload as ConnectionItem),
            },
          };
        case "device_state.updated":
          return {
            scene: {
              ...scene,
              deviceStates: upsertDeviceState(scene.deviceStates, event.payload),
            },
          };
        case "optical_element.updated": {
          const payload = event.payload as Partial<OpticalElement> & { deleted?: boolean; componentId?: string };
          const componentId = payload.componentId;
          if (!componentId) return state;
          if (payload.deleted) {
            return {
              scene: {
                ...scene,
                opticalElements: scene.opticalElements.filter((item) => item.componentId !== componentId),
                opticalLinks: scene.opticalLinks.filter(
                  (link) => link.fromComponentId !== componentId && link.toComponentId !== componentId,
                ),
              },
            };
          }
          const others = scene.opticalElements.filter((item) => item.componentId !== componentId);
          return {
            scene: { ...scene, opticalElements: [...others, payload as OpticalElement] },
          };
        }
        case "optical_link.updated": {
          const payload = event.payload as Partial<OpticalLink> & { deleted?: boolean; id?: string };
          if (payload.deleted && payload.id) {
            return {
              scene: {
                ...scene,
                opticalLinks: scene.opticalLinks.filter((item) => item.id !== payload.id),
              },
            };
          }
          if (!payload.id) return state;
          return {
            scene: { ...scene, opticalLinks: upsertById(scene.opticalLinks, payload as OpticalLink) },
          };
        }
        case "optical_simulation.completed":
          // Currently advisory only; UI listens via runOpticalSimulation return value.
          return state;
        default:
          return state;
      }
    });
  },

  setSocketStatus(socketStatus) {
    set({ socketStatus });
  },
}));
