import axios, { AxiosError } from "axios";

import type {
  Anchor,
  AssemblyRelation,
  Asset3D,
  Circuit,
  CircuitCreatePayload,
  CircuitUpdatePayload,
  EmProblem,
  EmProblemCreatePayload,
  EmProblemUpdatePayload,
  Mesh,
  Collection,
  CollectionMember,
  ComponentItem,
  ElementKind,
  GeometrySelector,
  OpticalElement,
  OpticalLink,
  OpticalPort,
  RelationType,
  SceneData,
  SceneObject,
  SceneObjectPatch,
  SimulationModule,
  SimulationRunCreatePayload,
  SimulationRunV2,
  TimingProgram,
  TouchstoneNetwork,
  TimingProgramUpsert,
  TransientRunRequest,
  TransientRunResponse,
} from "../types/digitalTwin";
import type {
  SceneView,
  SceneViewCreatePayload,
  SceneViewUpdatePayload,
} from "../types/visibility";

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:8010";

export const WS_URL =
  import.meta.env.VITE_WS_URL ?? `${API_BASE_URL.replace(/^http/, "ws")}/ws/scene`;

export const client = axios.create({
  baseURL: API_BASE_URL,
  timeout: 12000,
});

function apiErrorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    const detail = error.response?.data?.detail;
    if (Array.isArray(detail)) {
      return detail
        .map((item) => item?.msg ?? JSON.stringify(item))
        .join("\n");
    }

    if (typeof detail === "string") {
      return detail;
    }

    if (error.response) {
      return `API ${error.response.status}: ${JSON.stringify(error.response.data)}`;
    }

    if (error.request) {
      return `Network Error: cannot reach backend at ${API_BASE_URL}. 請確認後端 uvicorn 是否正在執行，以及 port 是否為 8010。`;
    }

    return error.message;
  }

  return error instanceof Error ? error.message : String(error);
}

export async function fetchScene(): Promise<SceneData> {
  const response = await client.get<SceneData>("/api/scene");
  return {
    ...response.data,
    objects: response.data.objects ?? [],
    assemblyRelations: response.data.assemblyRelations ?? [],
    sceneViews: response.data.sceneViews ?? [],
    collections: response.data.collections ?? [],
    collectionMembers: response.data.collectionMembers ?? [],
  };
}

export async function upsertObjectForComponentApi(
  componentId: string,
  patch: SceneObjectPatch,
): Promise<SceneObject> {
  const response = await client.put<SceneObject>(`/api/objects/by-component/${componentId}`, patch);
  return response.data;
}

export async function createObjectApi(
  payload: SceneObjectPatch & { componentId: string; collectionId?: string | null },
): Promise<SceneObject> {
  const response = await client.post<SceneObject>("/api/objects", payload);
  return response.data;
}

export async function updateObjectApi(
  objectId: string,
  patch: SceneObjectPatch,
): Promise<SceneObject> {
  const response = await client.put<SceneObject>(`/api/objects/${objectId}`, patch);
  return response.data;
}

export async function deleteObjectApi(objectId: string): Promise<void> {
  await client.delete(`/api/objects/${objectId}`);
}

export async function createComponentApi(payload: {
  name: string;
  componentType: string;
  brand?: string;
  model?: string;
  properties?: Record<string, unknown>;
}): Promise<ComponentItem> {
  const response = await client.post<ComponentItem>("/api/components", {
    properties: {},
    ...payload,
  });
  return response.data;
}

export async function updateComponentApi(
  componentId: string,
  patch: Partial<Pick<ComponentItem, "name" | "componentType" | "brand" | "model" | "properties" | "notes">>,
): Promise<ComponentItem> {
  const response = await client.put<ComponentItem>(`/api/components/${componentId}`, patch);
  return response.data;
}

export async function deleteComponentApi(componentId: string): Promise<void> {
  await client.delete(`/api/components/${componentId}`);
}

export type AssetUpdatePayload = {
  name?: string;
  assetType?: string;
  filePath?: string;
  source?: string;
  sourceUrl?: string;
  unit?: "mm" | "m";
  scaleFactor?: number;
  anchors?: Anchor[];
};

export async function updateAssetApi(
  assetId: string,
  patch: AssetUpdatePayload,
): Promise<Asset3D> {
  // Backend Asset3DUpdate uses snake_case via CamelModel alias_generator,
  // but populate_by_name=true so the camelCase JSON we send maps cleanly.
  const response = await client.put<Asset3D>(`/api/assets/${assetId}`, patch);
  return response.data;
}

type AssemblyRelationApiPayload = {
  name: string;
  relationType: string;
  objectAId: string;
  objectBId: string;
  selectorA?: GeometrySelector | Record<string, unknown> | null;
  selectorB?: GeometrySelector | Record<string, unknown> | null;
  offsetMm?: number | null;
  angleDeg?: number | null;
  toleranceMm?: number | null;
  enabled?: boolean;
  solved?: boolean;
  properties?: Record<string, unknown>;
};

function toAssemblyRelationApiBody(payload: Partial<AssemblyRelationApiPayload>) {
  return {
    ...(payload.name !== undefined ? { name: payload.name } : {}),
    ...(payload.relationType !== undefined ? { relation_type: payload.relationType } : {}),
    ...(payload.objectAId !== undefined ? { object_a_id: payload.objectAId } : {}),
    ...(payload.objectBId !== undefined ? { object_b_id: payload.objectBId } : {}),
    ...(payload.selectorA !== undefined ? { selector_a: payload.selectorA ?? {} } : {}),
    ...(payload.selectorB !== undefined ? { selector_b: payload.selectorB ?? {} } : {}),
    ...(payload.offsetMm !== undefined ? { offset_mm: payload.offsetMm } : {}),
    ...(payload.angleDeg !== undefined ? { angle_deg: payload.angleDeg } : {}),
    ...(payload.toleranceMm !== undefined ? { tolerance_mm: payload.toleranceMm } : {}),
    ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
    ...(payload.solved !== undefined ? { solved: payload.solved } : {}),
    ...(payload.properties !== undefined ? { properties: payload.properties } : {}),
  };
}

export async function createAssemblyRelationApi(
  payload: AssemblyRelationApiPayload,
): Promise<AssemblyRelation> {
  try {
    const response = await client.post<AssemblyRelation>(
      "/api/assembly-relations",
      toAssemblyRelationApiBody({
        toleranceMm: 0.01,
        enabled: true,
        properties: {},
        ...payload,
      }),
    );

    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function updateAssemblyRelationApi(
  relationId: string,
  patch: Partial<Omit<AssemblyRelation, "id" | "createdAt" | "updatedAt">>,
): Promise<AssemblyRelation> {
  try {
    const response = await client.put<AssemblyRelation>(
      `/api/assembly-relations/${relationId}`,
      toAssemblyRelationApiBody(patch as Partial<AssemblyRelationApiPayload>),
    );

    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function deleteAssemblyRelationApi(relationId: string): Promise<void> {
  await client.delete(`/api/assembly-relations/${relationId}`);
}

export async function applyRelationOnceApi(relationId: string): Promise<SceneObject | null> {
  try {
    const response = await client.post<SceneObject | null>(
      `/api/assembly-relations/${relationId}/apply-once`,
    );
    return response.data ?? null;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function uploadComponentAssetApi(payload: {
  file: File;
  name: string;
  componentType: string;
  brand?: string;
  model?: string;
  unit?: "mm" | "m";
  scaleFactor?: number;
}): Promise<ComponentItem> {
  const form = new FormData();
  form.append("file", payload.file);
  form.append("name", payload.name);
  form.append("component_type", payload.componentType);
  if (payload.brand) form.append("brand", payload.brand);
  if (payload.model) form.append("model", payload.model);
  form.append("unit", payload.unit ?? "mm");
  form.append("scale_factor", String(payload.scaleFactor ?? 1));

  const response = await client.post<ComponentItem>("/api/assets/upload-component", form, { timeout: 60000 });
  return response.data;
}

export async function importLocalComponentAssetApi(payload: {
  sourcePath: string;
  name?: string;
  componentType: string;
  brand?: string;
  model?: string;
  unit?: "mm" | "m";
  scaleFactor?: number;
}): Promise<ComponentItem> {
  const response = await client.post<ComponentItem>(
    "/api/assets/import-local-component",
    {
      unit: "mm",
      scaleFactor: 1,
      ...payload,
    },
    { timeout: 60000 },
  );
  return response.data;
}

// =============================================================================
// Optical domain
// =============================================================================

export type OpticalElementApiPayload = {
  /** Per-OBJECT optical participation (alembic 0014). */
  objectId: string;
  elementKind: ElementKind;
  wavelengthRangeNm?: [number, number];
  inputPorts?: OpticalPort[];
  outputPorts?: OpticalPort[];
  kindParams: Record<string, unknown>;
};

export async function createOpticalElementApi(
  payload: OpticalElementApiPayload,
): Promise<OpticalElement> {
  try {
    const response = await client.post<OpticalElement>("/api/optical-elements", payload);
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function updateOpticalElementApi(
  objectId: string,
  patch: Partial<Omit<OpticalElementApiPayload, "objectId">>,
): Promise<OpticalElement> {
  try {
    const response = await client.put<OpticalElement>(
      `/api/optical-elements/${objectId}`,
      patch,
    );
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function deleteOpticalElementApi(objectId: string): Promise<void> {
  await client.delete(`/api/optical-elements/${objectId}`);
}

export async function autoRegisterOpticalApi(
  componentId: string,
): Promise<OpticalElement[]> {
  try {
    // Auto-register endpoint now creates one OpticalElement per scene
    // object of this component (was: 1 per component). Returns the list
    // of newly-created rows (empty if all objects already had OEs).
    const response = await client.post<OpticalElement[]>(
      `/api/components/${componentId}/auto-register-optical`,
    );
    return response.data ?? [];
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export type AutoRegisterAllResponse = {
  createdCount: number;
  scanned: number;
  elements: OpticalElement[];
};

export async function autoRegisterOpticalAllApi(): Promise<AutoRegisterAllResponse> {
  try {
    const response = await client.post<AutoRegisterAllResponse>(
      "/api/components/auto-register-optical/all",
    );
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export type OpticalLinkApiPayload = {
  /** Per-OBJECT chain participation (alembic 0014). */
  fromObjectId: string;
  fromPort: string;
  toObjectId: string;
  toPort: string;
  freeSpaceMm?: number;
  properties?: Record<string, unknown>;
};

export async function createOpticalLinkApi(
  payload: OpticalLinkApiPayload,
): Promise<OpticalLink> {
  try {
    const response = await client.post<OpticalLink>("/api/optical-links", payload);
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function updateOpticalLinkApi(
  linkId: string,
  patch: Partial<
    Pick<OpticalLinkApiPayload, "fromObjectId" | "fromPort" | "toObjectId" | "toPort" | "freeSpaceMm" | "properties">
  >,
): Promise<OpticalLink> {
  try {
    const response = await client.put<OpticalLink>(`/api/optical-links/${linkId}`, patch);
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function deleteOpticalLinkApi(linkId: string): Promise<void> {
  await client.delete(`/api/optical-links/${linkId}`);
}

export type OpticalRunResponse = {
  runId: string;
  segmentCount: number;
  errors: string[];
  warnings: string[];
};

export async function runOpticalSimulationApi(): Promise<OpticalRunResponse> {
  try {
    const response = await client.post<OpticalRunResponse>("/api/simulations/optical/run");
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function runOpticalTransientApi(
  payload: TransientRunRequest,
): Promise<TransientRunResponse> {
  try {
    const response = await client.post<TransientRunResponse>(
      "/api/simulations/optical/transient/run",
      payload,
    );
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

// =============================================================================
// Scene Views (visibility L3)
// =============================================================================

export async function listSceneViewsApi(): Promise<SceneView[]> {
  try {
    const response = await client.get<SceneView[]>("/api/scene-views");
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function createSceneViewApi(payload: SceneViewCreatePayload): Promise<SceneView> {
  try {
    const response = await client.post<SceneView>("/api/scene-views", payload);
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function updateSceneViewApi(
  viewId: string,
  patch: SceneViewUpdatePayload,
): Promise<SceneView> {
  try {
    const response = await client.put<SceneView>(`/api/scene-views/${viewId}`, patch);
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function deleteSceneViewApi(viewId: string): Promise<void> {
  try {
    await client.delete(`/api/scene-views/${viewId}`);
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function duplicateSceneViewApi(viewId: string): Promise<SceneView> {
  try {
    const response = await client.post<SceneView>(`/api/scene-views/${viewId}/duplicate`);
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function moveSceneViewApi(viewId: string, sortOrder: number): Promise<SceneView> {
  try {
    const response = await client.put<SceneView>(`/api/scene-views/${viewId}/move`, { sortOrder });
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

// =============================================================================
// Collections (Outliner)
// =============================================================================

export type CollectionCreatePayload = {
  name: string;
  parentId?: string | null;
  color?: string;
  visible?: boolean;
  rigidTransform?: boolean;
  sortOrder?: number;
  properties?: Record<string, unknown>;
};

export type CollectionUpdatePayload = Partial<CollectionCreatePayload>;

export async function listCollectionsApi(): Promise<Collection[]> {
  try {
    const response = await client.get<Collection[]>("/api/collections");
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function listAllCollectionMembersApi(): Promise<CollectionMember[]> {
  try {
    const response = await client.get<CollectionMember[]>("/api/collections/members");
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function createCollectionApi(payload: CollectionCreatePayload): Promise<Collection> {
  try {
    const response = await client.post<Collection>("/api/collections", payload);
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function updateCollectionApi(
  collectionId: string,
  patch: CollectionUpdatePayload,
): Promise<Collection> {
  try {
    const response = await client.put<Collection>(`/api/collections/${collectionId}`, patch);
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function moveCollectionApi(
  collectionId: string,
  payload: { parentId: string | null; sortOrder?: number | null },
): Promise<Collection> {
  try {
    const response = await client.put<Collection>(
      `/api/collections/${collectionId}/move`,
      payload,
    );
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function deleteCollectionApi(collectionId: string): Promise<void> {
  try {
    await client.delete(`/api/collections/${collectionId}`);
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function moveObjectToCollectionApi(
  collectionId: string,
  objectId: string,
  sortOrder?: number,
): Promise<CollectionMember> {
  try {
    const response = await client.post<CollectionMember>(
      `/api/collections/${collectionId}/objects/${objectId}`,
      sortOrder !== undefined ? { sortOrder } : {},
    );
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function unlinkObjectFromCollectionApi(
  collectionId: string,
  objectId: string,
): Promise<void> {
  try {
    await client.delete(`/api/collections/${collectionId}/objects/${objectId}`);
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

// =============================================================================
// Timing programs
// =============================================================================

export async function fetchTimingProgramApi(objectId: string): Promise<TimingProgram | null> {
  try {
    const response = await client.get<TimingProgram>(`/api/timing-programs/${objectId}`);
    return response.data;
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 404) {
      return null;
    }
    throw new Error(apiErrorMessage(error));
  }
}

export async function upsertTimingProgramApi(
  objectId: string,
  payload: TimingProgramUpsert,
): Promise<TimingProgram> {
  try {
    const response = await client.put<TimingProgram>(
      `/api/timing-programs/${objectId}`,
      payload,
    );
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function deleteTimingProgramApi(objectId: string): Promise<void> {
  try {
    await client.delete(`/api/timing-programs/${objectId}`);
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export function resolveAssetUrl(filePath: string): string {
  if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
    return filePath;
  }
  if (filePath.startsWith("/assets/")) {
    return `${API_BASE_URL}${filePath}`;
  }
  if (filePath.startsWith("assets/")) {
    return `${API_BASE_URL}/${filePath}`;
  }
  return `${API_BASE_URL}/assets/${filePath.replace(/^\/+/, "")}`;
}

// ---- Multiphysics simulation runs (Phase A) -------------------------------

export async function fetchSimulationRunsApi(
  module?: SimulationModule,
  limit = 20,
): Promise<SimulationRunV2[]> {
  const params: Record<string, string | number> = { limit };
  if (module) params.module = module;
  const response = await client.get<SimulationRunV2[]>("/api/simulation-runs", {
    params,
  });
  return response.data;
}

export async function fetchSimulationRunApi(id: string): Promise<SimulationRunV2> {
  const response = await client.get<SimulationRunV2>(`/api/simulation-runs/${id}`);
  return response.data;
}

export async function createSimulationRunApi(
  payload: SimulationRunCreatePayload,
): Promise<SimulationRunV2> {
  const response = await client.post<SimulationRunV2>("/api/simulation-runs", payload);
  return response.data;
}

// ---- Circuits (Phase B.1, alembic 0037) -----------------------------------

export async function fetchCircuitsApi(limit = 100): Promise<Circuit[]> {
  const response = await client.get<Circuit[]>("/api/circuits", { params: { limit } });
  return response.data;
}

export async function fetchCircuitApi(id: string): Promise<Circuit> {
  const response = await client.get<Circuit>(`/api/circuits/${id}`);
  return response.data;
}

export async function createCircuitApi(payload: CircuitCreatePayload): Promise<Circuit> {
  const response = await client.post<Circuit>("/api/circuits", payload);
  return response.data;
}

export async function updateCircuitApi(
  id: string,
  patch: CircuitUpdatePayload,
): Promise<Circuit> {
  const response = await client.patch<Circuit>(`/api/circuits/${id}`, patch);
  return response.data;
}

export async function deleteCircuitApi(id: string): Promise<void> {
  await client.delete(`/api/circuits/${id}`);
}

// ---- Touchstone (Phase B.7) -------------------------------------------------

// ---- EM (Phase C) -----------------------------------------------------------

export async function fetchEmProblemsApi(limit = 100): Promise<EmProblem[]> {
  const response = await client.get<EmProblem[]>("/api/em-problems", { params: { limit } });
  return response.data;
}

export async function createEmProblemApi(
  payload: EmProblemCreatePayload,
): Promise<EmProblem> {
  const response = await client.post<EmProblem>("/api/em-problems", payload);
  return response.data;
}

export async function updateEmProblemApi(
  id: string,
  patch: EmProblemUpdatePayload,
): Promise<EmProblem> {
  const response = await client.patch<EmProblem>(`/api/em-problems/${id}`, patch);
  return response.data;
}

export async function deleteEmProblemApi(id: string): Promise<void> {
  await client.delete(`/api/em-problems/${id}`);
}

export async function fetchMeshesApi(limit = 100): Promise<Mesh[]> {
  const response = await client.get<Mesh[]>("/api/meshes", { params: { limit } });
  return response.data;
}

export async function uploadMeshApi(file: File, name?: string): Promise<Mesh> {
  const form = new FormData();
  form.append("file", file, file.name);
  if (name) form.append("name", name);
  const response = await client.post<Mesh>("/api/meshes", form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return response.data;
}

export async function deleteMeshApi(id: string): Promise<void> {
  await client.delete(`/api/meshes/${id}`);
}

export async function parseTouchstoneApi(file: File): Promise<TouchstoneNetwork> {
  const form = new FormData();
  form.append("file", file, file.name);
  const response = await client.post<TouchstoneNetwork>(
    "/api/touchstone/parse",
    form,
    { headers: { "Content-Type": "multipart/form-data" } },
  );
  return response.data;
}
