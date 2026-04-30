import axios, { AxiosError } from "axios";

import type {
  AssemblyRelation,
  ComponentItem,
  ElementKind,
  GeometrySelector,
  OpticalElement,
  OpticalLink,
  OpticalPort,
  Placement,
  PlacementPatch,
  RelationType,
  SceneData,
} from "../types/digitalTwin";

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
  const objects = response.data.objects ?? response.data.placements ?? [];
  return {
    ...response.data,
    objects,
    placements: response.data.placements ?? objects,
    assemblyRelations: response.data.assemblyRelations ?? [],
  };
}

export async function updatePlacementApi(
  componentId: string,
  patch: PlacementPatch,
): Promise<Placement> {
  const response = await client.put<Placement>(`/api/placements/${componentId}`, patch);
  return response.data;
}

export async function createPlacementApi(payload: PlacementPatch & { componentId: string }): Promise<Placement> {
  const response = await client.post<Placement>("/api/placements", payload);
  return response.data;
}

export async function updatePlacementObjectApi(
  objectId: string,
  patch: PlacementPatch,
): Promise<Placement> {
  const response = await client.put<Placement>(`/api/placements/objects/${objectId}`, patch);
  return response.data;
}

export async function deleteObjectApi(objectId: string): Promise<void> {
  await client.delete(`/api/placements/objects/${objectId}`);
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
  componentId: string;
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
  componentId: string,
  patch: Partial<Omit<OpticalElementApiPayload, "componentId">>,
): Promise<OpticalElement> {
  try {
    const response = await client.put<OpticalElement>(
      `/api/optical-elements/${componentId}`,
      patch,
    );
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

export async function deleteOpticalElementApi(componentId: string): Promise<void> {
  await client.delete(`/api/optical-elements/${componentId}`);
}

export type OpticalLinkApiPayload = {
  fromComponentId: string;
  fromPort: string;
  toComponentId: string;
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
  patch: Partial<Pick<OpticalLinkApiPayload, "freeSpaceMm" | "properties">>,
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
