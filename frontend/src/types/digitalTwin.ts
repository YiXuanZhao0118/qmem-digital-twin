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
  anchors: Anchor[];
  createdAt?: string;
};

export type PhysicsCapability = "stress" | "optical" | "rf" | "em" | "thermal" | "fluid" | "quantum";

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
  physicsCapabilities: PhysicsCapability[];
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

// =============================================================================
// Optical domain
// =============================================================================

// --- Reusable building blocks ------------------------------------------------

export type JonesVector = {
  exRe: number;
  exIm: number;
  eyRe: number;
  eyIm: number;
};

export type GaussianMode = {
  waistUm: number;
  waistZOffsetMm: number;
  mSquared: number;
};

export type TransverseModeKind = "TEM00" | "TEM_mn" | "LG_pl" | "multimode";

export type TransverseMode = {
  kind: TransverseModeKind;
  indicesM?: number | null;
  indicesN?: number | null;
  indicesP?: number | null;
  indicesL?: number | null;
};

export type SpectrumLineshape = "gaussian" | "lorentzian" | "voigt" | "delta";
export type SpectrumComponentKind = "main" | "sideband" | "ase" | "custom";

export type SpectrumComponent = {
  kind: SpectrumComponentKind;
  lineshape: SpectrumLineshape;
  offsetMhz: number;
  fwhmMhz?: number | null;
  voigtGaussianFwhmMhz?: number | null;
  voigtLorentzianFwhmMhz?: number | null;
  amplitude: number;
};

export type Spectrum = {
  centerThz: number;
  components: SpectrumComponent[];
};

export type PortRole = "input" | "output";

export type OpticalPort = {
  portId: string;
  role: PortRole;
  label?: string | null;
  kind?: string | null;
};

// --- Element kinds ----------------------------------------------------------

export type ElementKind =
  | "laser_source"
  | "tapered_amplifier"
  | "mirror"
  | "lens_spherical"
  | "lens_cylindrical"
  | "waveplate"
  | "polarizer"
  | "beam_splitter"
  | "dichroic_mirror"
  | "fiber_coupler"
  | "isolator"
  | "aom"
  | "eom"
  | "nonlinear_crystal"
  | "saturable_absorber"
  | "detector"
  | "camera"
  | "spectrometer"
  | "wavemeter"
  | "beam_dump";

// --- Per-kind params (discriminated by element_kind) ------------------------

export type LaserSourceParams = {
  centerWavelengthNm: number;
  spectrum: Spectrum;
  spatialModeX: GaussianMode;
  spatialModeY: GaussianMode;
  transverseMode: TransverseMode;
  polarization: JonesVector;
  nominalPowerMw: number;
  rinDbcPerHz?: number | null;
  frequencyNoiseHzPerSqrtHz?: number | null;
};

export type TaperedAmplifierAse = {
  powerMw: number;
  bandwidthNm: number;
  centerOffsetNm: number;
};

export type TaperedAmplifierParams = {
  smallSignalGainDb: number;
  saturationPowerMw: number;
  maxInputPowerMw?: number | null;
  ase: TaperedAmplifierAse;
  outputSpatialModeX: GaussianMode;
  outputSpatialModeY: GaussianMode;
  outputTransverseMode: TransverseMode;
};

export type MirrorParams = {
  reflectivity: number;
  surfaceQualityNm?: number | null;
  normalLocal: number[];
};

export type LensSphericalParams = {
  focalMm: number;
  numericalAperture?: number | null;
  transmission: number;
};

export type LensCylindricalParams = {
  focalMm: number;
  cylindricalAxis: "x" | "y";
  transmission: number;
};

export type WaveplateParams = {
  retardanceLambda: number;
  fastAxisDeg: number;
  transmission: number;
};

export type PolarizerParams = {
  transmissionAxisDeg: number;
  extinctionRatioDb: number;
  transmission: number;
};

export type BeamSplitterParams = {
  splitRatioTransmitted: number;
  polarizing: boolean;
  transmission: number;
};

export type DichroicMirrorParams = {
  cutoffWavelengthNm: number;
  passBand: "short" | "long";
  transmission: number;
  reflectivity: number;
};

export type FiberCouplerParams = {
  couplingEfficiency: number;
  modeFieldDiameterUm: number;
  fiberType: "single_mode" | "polarization_maintaining" | "multi_mode";
};

export type IsolatorParams = {
  forwardLossDb: number;
  isolationDb: number;
  transmissionAxisDeg: number;
};

export type AOMParams = {
  rfDriverComponentId?: string | null;
  baseEfficiency: number;
  deflectionPerMhzUrad: number;
  acousticVelocityMPerS: number;
  modulationBandwidthMhz: number;
  centerFreqMhz: number;
};

export type EOMParams = {
  rfDriverComponentId?: string | null;
  vPiV: number;
  modulationKind: "phase" | "amplitude";
  modulationBandwidthMhz: number;
  insertionLossDb: number;
};

export type NonlinearCrystalParams = {
  process: "SHG" | "SFG" | "DFG" | "OPO";
  chi2PmPerV: number;
  lengthMm: number;
  phaseMatchTempC?: number | null;
  phaseMatchAngleDeg?: number | null;
  walkOffUrad: number;
};

export type SaturableAbsorberParams = {
  saturationIntensityWPerCm2: number;
  modulationDepth: number;
  nonSaturableLoss: number;
  recoveryTimePs: number;
};

export type DetectorParams = {
  responsivityAPerW: number;
  quantumEfficiency: number;
  bandwidthMhz: number;
  saturationPowerMw: number;
};

export type CameraParams = {
  resolutionPx: [number, number];
  pixelSizeUm: number;
  quantumEfficiency: number;
  wellDepthE: number;
};

export type SpectrometerParams = {
  resolutionPm: number;
  wavelengthRangeNm: [number, number];
};

export type WavemeterParams = {
  precisionMhz: number;
};

export type BeamDumpParams = {
  absorption: number;
};

// Tagged union: element_kind discriminates which params shape applies.
export type OpticalElementKindParams =
  | { elementKind: "laser_source"; kindParams: LaserSourceParams }
  | { elementKind: "tapered_amplifier"; kindParams: TaperedAmplifierParams }
  | { elementKind: "mirror"; kindParams: MirrorParams }
  | { elementKind: "lens_spherical"; kindParams: LensSphericalParams }
  | { elementKind: "lens_cylindrical"; kindParams: LensCylindricalParams }
  | { elementKind: "waveplate"; kindParams: WaveplateParams }
  | { elementKind: "polarizer"; kindParams: PolarizerParams }
  | { elementKind: "beam_splitter"; kindParams: BeamSplitterParams }
  | { elementKind: "dichroic_mirror"; kindParams: DichroicMirrorParams }
  | { elementKind: "fiber_coupler"; kindParams: FiberCouplerParams }
  | { elementKind: "isolator"; kindParams: IsolatorParams }
  | { elementKind: "aom"; kindParams: AOMParams }
  | { elementKind: "eom"; kindParams: EOMParams }
  | { elementKind: "nonlinear_crystal"; kindParams: NonlinearCrystalParams }
  | { elementKind: "saturable_absorber"; kindParams: SaturableAbsorberParams }
  | { elementKind: "detector"; kindParams: DetectorParams }
  | { elementKind: "camera"; kindParams: CameraParams }
  | { elementKind: "spectrometer"; kindParams: SpectrometerParams }
  | { elementKind: "wavemeter"; kindParams: WavemeterParams }
  | { elementKind: "beam_dump"; kindParams: BeamDumpParams };

export type OpticalElementCommon = {
  componentId: string;
  wavelengthRangeNm: [number, number];
  inputPorts: OpticalPort[];
  outputPorts: OpticalPort[];
  createdAt?: string;
  updatedAt?: string;
};

export type OpticalElement = OpticalElementCommon & OpticalElementKindParams;

export type OpticalLink = {
  id: string;
  fromComponentId: string;
  fromPort: string;
  toComponentId: string;
  toPort: string;
  freeSpaceMm: number;
  properties: Record<string, unknown>;
  createdAt?: string;
};

export type BeamSegment = {
  id: string;
  simulationRunId?: string | null;
  opticalLinkId: string;
  sequenceTMs?: number | null;
  beamIndex: number;
  spectrum: Record<string, unknown>;
  spatialX: Record<string, unknown>;
  spatialY: Record<string, unknown>;
  transverseMode: Record<string, unknown>;
  polarizationJones: Record<string, unknown>;
  powerMw: number;
  propagationAxisLocal: number[];
  createdAt?: string;
};

export const EMITTER_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>([
  "laser_source",
  "tapered_amplifier",
]);

export type SceneData = {
  assets: Asset3D[];
  components: ComponentItem[];
  placements: Placement[];
  objects: SceneObject[];
  connections: ConnectionItem[];
  assemblyRelations: AssemblyRelation[];
  beamPaths: BeamPath[];
  deviceStates: DeviceState[];
  opticalElements: OpticalElement[];
  opticalLinks: OpticalLink[];
  beamSegments: BeamSegment[];
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
  | { type: "optical_element.updated"; payload: (Partial<OpticalElement> & { componentId?: string; deleted?: boolean }) | OpticalElement }
  | { type: "optical_link.updated"; payload: (Partial<OpticalLink> & { id?: string; deleted?: boolean }) | OpticalLink }
  | { type: "optical_simulation.completed"; payload: { runId: string; segmentCount: number; errors: string[]; warnings: string[] } }
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
