export type Vec3 = [number, number, number];

export type AxisLock = {
  x: boolean;
  y: boolean;
  z: boolean;
};

export type ObjectLock = {
  position: AxisLock;
  rotation: AxisLock;
};

export type Anchor = {
  id: string;
  name: string;
  type: "center" | "face" | "edge" | "custom" | string;
  localPosition: { x: number; y: number; z: number };
  localDirection?: { x: number; y: number; z: number };
};

export type Asset3D = {
  id: string;
  name: string;
  assetType: string;
  filePath: string;
  source?: string | null;
  sourceUrl?: string | null;
  unit: "mm" | "m";
  scaleFactor: number;
  createdAt?: string;
};

export type ComponentItem = {
  id: string;
  name: string;
  componentName?: string;
  componentType: string;
  brand?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  asset3dId?: string | null;
  properties: Record<string, unknown>;
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type SceneObject = {
  id: string;
  objectName: string;
  componentId: string;
  parentComponentId?: string | null;
  xMm: number;
  yMm: number;
  zMm: number;
  rxDeg: number;
  ryDeg: number;
  rzDeg: number;
  visible: boolean;
  locked: boolean;
  properties: {
    size?: { x: number; y: number; z: number };
    locked?: ObjectLock;
    anchors?: Anchor[];
    [key: string]: unknown;
  };
  updatedAt?: string;
};

export type Placement = SceneObject;

export type ConnectionItem = {
  id: string;
  connectionType: string;
  fromComponentId: string;
  fromPort?: string | null;
  toComponentId: string;
  toPort?: string | null;
  label?: string | null;
  properties: Record<string, unknown>;
  createdAt?: string;
};

export type RelationType =
  | "same_position"
  | "offset_position"
  | "distance"
  | "same_direction"
  | "opposite_direction"
  | "perpendicular_direction"
  | "look_at"
  | "face_touch"
  | "face_parallel"
  | "face_offset"
  | "face_align_center";

export type GeometrySelector = {
  kind?: "face" | "edge" | "axis" | "point" | string;
  name?: string;
  anchorId?: string;
  normal?: Vec3;
  localDirection?: { x: number; y: number; z: number };
  localPosition?: { x: number; y: number; z: number };
  axis?: Vec3;
  point?: Vec3;
  [key: string]: unknown;
};

export type AssemblyRelation = {
  id: string;
  name: string;
  relationType: RelationType;
  objectAId: string;
  objectBId: string;
  selectorA: GeometrySelector;
  selectorB: GeometrySelector;
  offsetMm?: number | null;
  angleDeg?: number | null;
  toleranceMm: number;
  enabled: boolean;
  solved: boolean;
  properties: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

export type BeamPath = {
  id: string;
  name: string;
  wavelengthNm?: number | null;
  color: string;
  sourceComponentId?: string | null;
  targetComponentId?: string | null;
  points: Vec3[];
  properties: Record<string, unknown>;
  visible: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type DeviceState = {
  componentId: string;
  state: Record<string, unknown>;
  updatedAt: string;
};

export type SceneData = {
  assets: Asset3D[];
  components: ComponentItem[];
  placements: Placement[];
  objects: SceneObject[];
  connections: ConnectionItem[];
  assemblyRelations: AssemblyRelation[];
  beamPaths: BeamPath[];
  deviceStates: DeviceState[];
};

export type SceneEvent =
  | { type: "component.created"; payload: ComponentItem }
  | { type: "component.updated"; payload: ComponentItem }
  | { type: "component.deleted"; payload: { id?: string; componentId?: string } }
  | { type: "placement.updated"; payload: Placement }
  | { type: "object.updated"; payload: SceneObject }
  | { type: "object.deleted"; payload: { id?: string; objectId?: string } }
  | { type: "assembly_relation.updated"; payload: AssemblyRelation & { deleted?: boolean } }
  | { type: "beam_path.updated"; payload: BeamPath & { deleted?: boolean } }
  | { type: "connection.updated"; payload: ConnectionItem & { deleted?: boolean } }
  | { type: "device_state.updated"; payload: DeviceState }
  | { type: "scene.reload"; payload: Record<string, unknown> }
  | { type: "scene.connected"; payload: Record<string, unknown> }
  | { type: "pong"; payload: Record<string, unknown> };

export type PlacementPatch = Partial<
  Pick<
    Placement,
    | "objectName"
    | "parentComponentId"
    | "xMm"
    | "yMm"
    | "zMm"
    | "rxDeg"
    | "ryDeg"
    | "rzDeg"
    | "visible"
    | "locked"
    | "properties"
  >
>;
