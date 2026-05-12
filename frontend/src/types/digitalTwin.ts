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

/** A point of interest on a 3D asset, in body-local Z-up frame.
 *  Phase 4 of the schema unification (2026-05-07): renamed
 *  `localPosition` → `positionMmBodyLocal` and `localDirection` →
 *  `directionBodyLocal` so the field names embed frame and unit
 *  inline. The legacy names are accepted on input by the backend
 *  Pydantic validator during the transition; once alembic 0018 has
 *  run, every stored row uses the new names. */
export type Anchor = {
  id: string;
  name?: string;
  type?: "center" | "face" | "edge" | "custom" | string;
  /** Static body-local position. For most anchor types this is the
   *  authoritative value. For fiber port anchors with `derivedFrom` set,
   *  this is the *fallback* when the spline isn't available (e.g.
   *  un-instantiated catalog entry). */
  positionMmBodyLocal: { x: number; y: number; z: number };
  directionBodyLocal?: { x: number; y: number; z: number };
  apertureMm?: number;
  /** Rectangular aperture, used by anchors whose active area is
   *  asymmetric (e.g. PBS / BS cube diagonal cement plane). Falls back
   *  to 2 × `apertureMm` per side when width / height are unset. */
  apertureWidthMm?: number;
  apertureHeightMm?: number;
  /** Dynamic-port marker for fiber kinds. When set, the anchor's
   *  position is re-derived at read time from the per-instance fiber
   *  spline (`SceneObject.properties.fiberNodes`, falling back to the
   *  catalog template). `fiberEndA` resolves to nodes[0].posMm offset
   *  outward by the ferrule tip length; `fiberEndB` to nodes[N-1].posMm.
   *  Direction follows the spline tangent at that endpoint. When this
   *  field is unset, the anchor is treated as a static body-local
   *  position. See `utils/fiberAnchorResolver.ts`. */
  derivedFromFiberEndpoint?: "A" | "B";
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
  // serialNumber moved to SceneObject in alembic 0015 (per-physical-unit).
  asset3dId?: string | null;
  properties: Record<string, unknown>;
  physicsCapabilities: PhysicsCapability[];
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type SceneObject = {
  id: string;
  name: string;
  componentId: string;
  xMm: number;
  yMm: number;
  zMm: number;
  rxDeg: number;
  ryDeg: number;
  rzDeg: number;
  visible: boolean;
  locked: boolean;
  serialNumber?: string | null;
  properties: {
    size?: { x: number; y: number; z: number };
    locked?: ObjectLock;
    anchors?: Anchor[];
    originOffsetMm?: { x: number; y: number; z: number };
    objectScale?: number;
    // V2 (alembic 0027 / docs/optical-schema-v2.md §3): per-instance
    // geometry-only bindings + per-instance emitted beams. Both default
    // to empty in Phase 1; populated kind-by-kind in Phase 2+.
    anchorBindings?: AnchorBindingV2[];
    opticalSources?: OpticalSourceV2[];
    /** Per-instance emission visualisation overrides, keyed by emission id:
     *  laser_source uses "main"; tapered_amplifier uses "forward" /
     *  "backward". Missing key → wavelength-derived colour, visible=true.
     *  See utils/emissionVisuals.ts. */
    emissionVisuals?: Partial<Record<"main" | "forward" | "backward", {
      colorHex?: string | null;
      visible?: boolean;
    }>>;
    [key: string]: unknown;
  };
  updatedAt?: string;
};

export type ConnectionItem = {
  id: string;
  connectionType: string;
  fromObjectId: string;
  fromPort?: string | null;
  toObjectId: string;
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
  sourceObjectId?: string | null;
  targetObjectId?: string | null;
  points: Vec3[];
  properties: Record<string, unknown>;
  visible: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type DeviceState = {
  objectId: string;
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

export type PortRole = "input" | "output" | "bidirectional";

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
  | "lens_biconvex"
  | "lens_plano_convex"
  | "lens_cylindrical"
  | "waveplate"
  | "polarizer"
  | "beam_splitter"
  | "dichroic_mirror"
  | "fiber_coupler"
  | "fiber"
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
  minInputPowerMw?: number | null;
  maxInputPowerMw?: number | null;
  inputAcceptanceRadiusMm?: number | null;
  ase: TaperedAmplifierAse;
  inputSpatialModeX?: GaussianMode | null;
  inputSpatialModeY?: GaussianMode | null;
  inputPolarization?: JonesVector | null;
  outputSpatialModeX: GaussianMode;
  outputSpatialModeY: GaussianMode;
  outputTransverseMode: TransverseMode;
  centerWavelengthNm?: number | null;
  driveCurrentMa?: number | null;
  driveCurrentMaxMa?: number | null;
  aseSamples?: Array<{
    driveCurrentMa: number;
    forwardPowerMw: number;
    backwardPowerMw: number;
  }>;
  gainSamples?: Array<{
    inputPowerMw: number;
    driveCurrentMa: number;
    forwardPowerMw: number;
    backwardPowerMw: number;
  }>;
  backwardSpatialModeX?: GaussianMode | null;
  backwardSpatialModeY?: GaussianMode | null;
};

export type MirrorParams = {
  reflectivity: number;
  surfaceQualityNm?: number | null;
  // V2 Phase 2 (alembic 0028): the reflective-surface normal moved to
  // `objects.properties.anchorBindings[opticalSurface].payload.normalBodyLocal`.
  // Use `getMirrorNormalBodyLocal()` from utils/v2Bindings.ts to read it.
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
  /** Phase 5: renamed from `fastAxisDeg`. Beam-local Jones-frame angle. */
  fastAxisDegBeamLocal: number;
  transmission: number;
};

export type PolarizerParams = {
  /** Phase 5: renamed from `transmissionAxisDeg`. Beam-local Jones-frame. */
  transmissionAxisDegBeamLocal: number;
  extinctionRatioDb: number;
  transmission: number;
};

export type BeamSplitterParams = {
  splitRatioTransmitted: number;
  polarizing: boolean;
  /** Phase 5: renamed from `transmissionAxisDeg`. Beam-local Jones-frame. */
  transmissionAxisDegBeamLocal: number;
  extinctionRatioDb: number;
  transmission: number;
  /** Phase 5: renamed from `coatingNormalLocal`. Body-local Z-up unit
   *  normal of the internal 45° coating. */
  coatingNormalBodyLocal?: number[];
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

// --- Fiber (full patch cable) ----------------------------------------------
//
// Distinct from `fiber_coupler` which models a single free-space ↔ fiber
// transition. A `fiber` element is a bidirectional, two-ended optical
// component with explicit Marcuse / mode-overlap coupling at each face,
// Fresnel facet losses, length attenuation, and Marcuse curvature loss
// integrated along the editable Bezier spline (geometry on
// SceneObject.properties.fiberNodes — same format as before).

export type FiberType = "multi_mode" | "single_mode" | "polarization_maintaining";
export type FiberConnectorType = "FC" | "SC" | "LC" | "ST" | "BARE";
export type FiberConnectorPolish = "PC" | "UPC" | "APC" | "AR";

export type FiberAttenuationPoint = {
  wavelengthNm: number;
  dbPerKm: number;
};

export type BendLossConstants = {
  vNumber: number;
  coreRadiusUm: number;
  nCore: number;
  nClad: number;
  /** Below this radius, Marcuse predicts >0.1 dB/m loss; UI warning
   *  threshold and soft floor in the loss integral. */
  criticalRadiusMm: number;
};

export type FiberEndSpec = {
  apertureDiameterMm: number;
  numericalAperture: number;
  /** SM/PM only; null on MM. */
  modeFieldDiameterUm?: number | null;
  coreDiameterUm: number;
  claddingDiameterUm: number;
  connectorType: FiberConnectorType;
  polish: FiberConnectorPolish;
  polishAngleDeg: number;
  /** Multiplier on the bare Fresnel reflectance R(θ): 1.0 = no AR,
   *  ~0.15 = typical AR coating, 0.0 = perfect AR. */
  fresnelResidual: number;
  glassIndexAtDesignLambda: number;
  /** PM only — slow-axis angle in connector body frame, 0° aligned to
   *  FC alignment key. Per-instance bodyRoll on SceneObject adds. */
  slowAxisDegInBodyFrame?: number | null;
  /** PM only — preferred unsigned slow-axis selector. +X and -X are
   *  the same optical axis, so UI should use x/y/z instead of signed
   *  direction buttons. Legacy angle is kept for old data. */
  slowAxisAxisBodyLocal?: "x" | "y" | "z" | null;
  /** Optical port face position in connector body-local mm. The connector
   *  is anchored at the spline endpoint with +Y outward; this offset rides
   *  along the connector's transform, so moving the spline node moves the
   *  port world position automatically. Null = ferrule tip (0, 36.28, 0)
   *  default. */
  facePositionMmBodyLocal?: { x: number; y: number; z: number } | null;
};

export type FiberParams = {
  fiberType: FiberType;
  endA: FiberEndSpec;
  endB: FiberEndSpec;
  cutoffWavelengthNm?: number | null;
  operatingWavelengthRangeNm: [number, number];
  designWavelengthNm: number;
  maxInputPowerMw: number;
  attenuationCurve: FiberAttenuationPoint[];
  bendLoss: BendLossConstants;
  minBendRadiusMm: number;
  birefringenceDeltaN?: number | null;
  pmdCoefficientPsPerSqrtKm?: number | null;
  /** PM only. */
  polarizationExtinctionRatioDb?: number | null;
  /** MM only. */
  bandwidthMhzKm?: number | null;
  randomJonesSeed?: number | null;
};

export type IsolatorParams = {
  forwardLossDb: number;
  isolationDb: number;
  /**
   * Faraday rotator angle in degrees. Typically 45° for a single-stage
   * isolator (a tandem isolator stacks two cells for 90° total). Combined
   * with the front_pbs / back_pbs anchor directions on the asset (each
   * PBS's coating-normal direction encodes its transmission axis), this
   * fully describes the polarization transfer of the device.
   */
  faradayRotationDeg: number;
  /**
   * Phase 5: renamed from `transmissionAxisDeg`. Beam-local Jones-frame.
   * Phase 8 (alembic 0034): transmission axis moved to a
   * polarizationReference binding on the SceneObject — read the binding
   * instead. Kept here for back-compat with pre-Phase-8 readers.
   * @deprecated
   */
  transmissionAxisDegBeamLocal: number;
};

export type AOMParams = {
  rfDriverComponentId?: string | null;
  baseEfficiency: number;
  deflectionPerMhzUrad: number;
  acousticVelocityMPerS: number;
  modulationBandwidthMhz: number;
  centerFreqMhz: number;
  refractiveIndex?: number | null;
  figureOfMeritM2?: number | null;
  crystalLengthMm?: number | null;
  acousticBeamWidthMm?: number | null;
  rfDrivePowerW?: number | null;
  rfPowerMaxW?: number | null;
  /** Phase 5: renamed from `acousticAxisLocal`. Body-local Z-up. */
  acousticAxisBodyLocal?: number[] | null;
  /** Phase 5: renamed from `rfPropagationDirectionLocal`. Body-local Z-up. */
  rfPropagationDirectionBodyLocal?: number[] | null;
  diffractionOrder?: -1 | 0 | 1;
  braggAngularAcceptanceMrad?: number | null;
  /** Phase 5: renamed from `braggTiltAxisAngleDeg`. Lab/scene Z-up frame. */
  braggTiltAxisDegLab?: number;
  /** Optional body-local pivot for the Bragg rotation. Defaults to the
   *  midpoint of the asset's `intercept_in` / `intercept_out` anchors —
   *  override only for asymmetric AOMs. Body-local Z-up mm. */
  braggInteractionPointMmBodyLocal?: number[] | null;
  maxDiffractionOrder?: number;
  sidebandVisibilityThreshold?: number;
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
  | { elementKind: "lens_biconvex"; kindParams: LensSphericalParams }
  | { elementKind: "lens_plano_convex"; kindParams: LensSphericalParams }
  | { elementKind: "lens_cylindrical"; kindParams: LensCylindricalParams }
  | { elementKind: "waveplate"; kindParams: WaveplateParams }
  | { elementKind: "polarizer"; kindParams: PolarizerParams }
  | { elementKind: "beam_splitter"; kindParams: BeamSplitterParams }
  | { elementKind: "dichroic_mirror"; kindParams: DichroicMirrorParams }
  | { elementKind: "fiber_coupler"; kindParams: FiberCouplerParams }
  | { elementKind: "fiber"; kindParams: FiberParams }
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
  /** Per-object PK (alembic 0014). Each scene object that has an optical
   *  role gets its own OpticalElement row keyed by `objectId`. */
  id: string;
  /** SceneObject this element belongs to. Two scene objects of the same
   *  Component (e.g. two BB1 mirrors) get DIFFERENT OpticalElement rows. */
  objectId: string;
  wavelengthRangeNm: [number, number];
  inputPorts: OpticalPort[];
  outputPorts: OpticalPort[];
  createdAt?: string;
  updatedAt?: string;
};

export type OpticalElement = OpticalElementCommon & OpticalElementKindParams;

export type OpticalLink = {
  id: string;
  fromObjectId: string;
  fromPort: string;
  toObjectId: string;
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

export type SpinCoreStartMode = "WAIT" | "CONTINUE";
export type WaveformKind = "const" | "linear_ramp" | "arbitrary" | "gate_on" | "gate_off";

export type TimingBlock = {
  id: string;
  programObjectId: string;
  label: string | null;
  tStartNs: number;
  tEndNs: number;
  waveformKind: WaveformKind;
  params: Record<string, unknown>;
  sortOrder: number;
  createdAt?: string;
  updatedAt?: string;
};

export type TimingProgram = {
  objectId: string;
  name: string;
  spinCoreStart: SpinCoreStartMode;
  durationNs: number;
  properties: Record<string, unknown>;
  blocks: TimingBlock[];
  createdAt?: string;
  updatedAt?: string;
};

export type TimingProgramUpsert = {
  name: string;
  spinCoreStart: SpinCoreStartMode;
  durationNs: number;
  properties?: Record<string, unknown>;
  blocks: Array<Omit<TimingBlock, "id" | "programObjectId" | "createdAt" | "updatedAt">>;
};

export type TransientTracePoint = {
  tNs: number;
  value: number;
  kind: string;
  label: string | null;
};

export type TransientObjectTrace = {
  objectId: string;
  points: TransientTracePoint[];
};

export type TransientRunRequest = {
  tStartNs: number;
  tEndNs: number;
  dtNs: number;
  persistSegments?: boolean;
};

export type TransientRunResponse = {
  runId: string;
  sampleCount: number;
  segmentCount: number;
  objectTraces: TransientObjectTrace[];
  errors: string[];
  warnings: string[];
};

export type SceneData = {
  assets: Asset3D[];
  components: ComponentItem[];
  objects: SceneObject[];
  connections: ConnectionItem[];
  assemblyRelations: AssemblyRelation[];
  beamPaths: BeamPath[];
  deviceStates: DeviceState[];
  opticalElements: OpticalElement[];
  opticalLinks: OpticalLink[];
  beamSegments: BeamSegment[];
  sceneViews?: import("./visibility").SceneView[];
  collections?: Collection[];
  collectionMembers?: CollectionMember[];
  timingPrograms?: TimingProgram[];
};

export type SceneEvent =
  | { type: "component.created"; payload: ComponentItem }
  | { type: "component.updated"; payload: ComponentItem }
  | { type: "component.deleted"; payload: { id?: string; componentId?: string } }
  | { type: "object.updated"; payload: SceneObject }
  | { type: "object.deleted"; payload: { id?: string; objectId?: string } }
  | { type: "assembly_relation.updated"; payload: AssemblyRelation & { deleted?: boolean } }
  | { type: "beam_path.updated"; payload: BeamPath & { deleted?: boolean } }
  | { type: "connection.updated"; payload: ConnectionItem & { deleted?: boolean } }
  | { type: "device_state.updated"; payload: DeviceState }
  | { type: "optical_element.updated"; payload: (Partial<OpticalElement> & { componentId?: string; deleted?: boolean }) | OpticalElement }
  | { type: "optical_link.updated"; payload: (Partial<OpticalLink> & { id?: string; deleted?: boolean }) | OpticalLink }
  | { type: "optical_simulation.completed"; payload: { runId: string; segmentCount: number; errors: string[]; warnings: string[] } }
  | { type: "simulation_run.status_changed"; payload: { id: string; module: SimulationModule; status: SimulationRunStatus; progress: number | null; errorMessage: string | null } }
  | { type: "scene_view.updated"; payload: (Partial<import("./visibility").SceneView> & { id?: string; deleted?: boolean }) | import("./visibility").SceneView }
  | { type: "collection.updated"; payload: (Partial<Collection> & { id?: string; deleted?: boolean }) | Collection }
  | { type: "collection_member.updated"; payload: Partial<CollectionMember> & { collectionId?: string; objectId?: string; deleted?: boolean; resetToMaster?: boolean } }
  | { type: "timing_program.updated"; payload: TimingProgram }
  | { type: "timing_program.deleted"; payload: { objectId: string } }
  | { type: "scene.reload"; payload: Record<string, unknown> }
  | { type: "scene.connected"; payload: Record<string, unknown> }
  | { type: "pong"; payload: Record<string, unknown> };

export type SceneObjectPatch = Partial<
  Pick<
    SceneObject,
    | "name"
    | "xMm"
    | "yMm"
    | "zMm"
    | "rxDeg"
    | "ryDeg"
    | "rzDeg"
    | "visible"
    | "locked"
    | "serialNumber"
    | "properties"
  >
>;

// =============================================================================
// Collection (Outliner) types
// =============================================================================

export type Collection = {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  visible: boolean;
  /** When true, every descendant SceneObject moves/rotates as one rigid group:
   *  applying a translate or rotate to any member applies the same rigid-body
   *  transform to all the others, so A↔B↔C relative pose stays fixed. Effective
   *  state cascades from any ancestor that has rigid_transform=true. Lock is
   *  per-OBJECT (SceneObject.locked); the outliner's per-collection lock icon
   *  is a bulk action over descendants and stores no collection-level state. */
  rigidTransform: boolean;
  sortOrder: number;
  properties: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

export type CollectionMember = {
  collectionId: string;
  objectId: string;
  sortOrder: number;
  addedAt?: string;
};

// =============================================================================
// V2 baseline types (alembic 0027, docs/optical-schema-v2.md §3)
// =============================================================================
//
// Mirror of backend/app/schemas.py V2* classes. These describe the V2 target
// data shape that lives inside JSONB sub-fields today — they are additive in
// Phase 1 and progressively enforced in Phase 2+ as each kind cuts over.

// ---- anchor bindings -------------------------------------------------------

export type AnchorBindingKind =
  | "emissionReference"
  | "opticalPortSurface"
  | "opticalSurface"
  | "detectorArea"
  | "interactionVolume"
  | "modeField"
  | "polarizationReference"
  | "rfDirection"
  | "crystalAxis"
  | "calibrationPoint";

export type BindingFrame = "anchorLocalXY" | "bodyLocal" | "lab";

export type V2ApertureCircle = { shape: "circle"; rMm: number };
export type V2ApertureEllipse = { shape: "ellipse"; xMm: number; yMm: number };
export type V2ApertureRectangle = { shape: "rectangle"; xMm: number; yMm: number };
export type V2Aperture = V2ApertureCircle | V2ApertureEllipse | V2ApertureRectangle;

export type AnchorBindingV2 = {
  id: string;
  name?: string;
  anchorId: string;
  kind: AnchorBindingKind;
  frame?: BindingFrame; // defaults to "anchorLocalXY"
  payload: Record<string, unknown>;
};

// ---- optical sources -------------------------------------------------------

export type V2Linewidth = {
  kind: "delta" | "lorentzian" | "gaussian" | "voigt" | "measured";
  fwhmHz?: number;
  gaussianFwhmHz?: number;
  lorentzianFwhmHz?: number;
};

export type V2Spectrum = {
  centerWavelengthNm: number;
  wavelengthReference?: "vacuum" | "air";
  linewidth: V2Linewidth;
};

export type V2Jones = { exRe: number; exIm: number; eyRe: number; eyIm: number };

export type V2Polarization = {
  basis: "beamLocalXY";
  normalization: "unit_jones";
  jones: V2Jones;
};

export type V2GaussianAxis = { waistRadiusUm: number };

export type V2GaussianProfile = {
  kind: "elliptical_gaussian";
  x: V2GaussianAxis;
  y: V2GaussianAxis;
  hardAperture?: Record<string, unknown> | null;
};

export type V2M2GaussianAxis = { waistZOffsetMm: number; mSquared: number };

export type V2M2GaussianPropagation = {
  model: "m2_gaussian";
  x: V2M2GaussianAxis;
  y: V2M2GaussianAxis;
};

export type V2SpatialEnvelope = {
  transverseProfile: V2GaussianProfile;
  propagation: V2M2GaussianPropagation;
};

export type V2TransverseMode = {
  family: "HG" | "LG" | "measured";
  m: number;
  n: number;
  label?: string;
};

export type V2BeamSource = {
  powerMw: number;
  spectrum: V2Spectrum;
  polarization: V2Polarization;
  spatialEnvelope: V2SpatialEnvelope;
  transverseMode: V2TransverseMode;
};

export type OpticalSourceV2 = {
  id: string;
  bindingId: string;
  enabled: boolean;
  beam: V2BeamSource;
};

// ---- optical ports ---------------------------------------------------------

// PortRole is defined above (line ~217) and reused here.
export type BranchKind =
  | "main"
  | "incident"
  | "reflected"
  | "transmitted"
  | "signal"
  | "seed"
  | "amplified"
  | "forward"
  | "generated"
  | "order"
  | "sideband";
export type PortSide =
  | "side_A"
  | "side_B"
  | "input_side"
  | "output_side"
  | "plane_side"
  | "convex_side"
  | "concave_surface";
export type PortFace = "face_1" | "face_2" | "face_3" | "face_4" | "face_5" | "face_6";

export type OpticalPortV2 = {
  id: string;
  name?: string;
  role: PortRole;
  branchKind?: BranchKind;
  side?: PortSide;
  face?: PortFace;
  bindingId: string;
};

// ---- beam state snapshot ---------------------------------------------------

export type V2SpatialAxisState = {
  qReal: number;
  qImag: number;
  wAtZUm?: number;
};

export type V2BeamState = {
  powerMw: number;
  spectrum: V2Spectrum;
  polarization: V2Polarization;
  spatialX: V2SpatialAxisState;
  spatialY: V2SpatialAxisState;
  transverseMode: V2TransverseMode;
};

// ---- simulation runs / revisions ------------------------------------------

// alembic 0036 (multiphysics) added 'queued' and 'cancelled' to the
// V2-Phase-1 set {completed, running, failed}.
export type SimulationRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

// Module discriminator (mirrors backend app.schemas.SimulationModule).
// "optics_seq" is the integrated Lab workspace (kept under the legacy
// id so existing simulation_runs rows round-trip). "optics_cavity" is
// the pure cavity calculator; optics_fdtd is reserved.
export type SimulationModule =
  | "optics_seq"
  | "optics_cavity"
  | "optics_fdtd"
  | "spice"
  | "em_fem"
  | "magnetics_dc";

// Where a SolverRunner dispatched this row (mirrors backend
// app.schemas.SolverRunnerKind). Phase A only ships "inproc".
export type SolverRunnerKind = "inproc" | "container" | "ssh_workstation";

export type SimulationRunV2 = {
  id: string;
  revisionId?: string | null;
  solverVersion: string;
  status: SimulationRunStatus;
  sceneHash?: string | null;
  settings: Record<string, unknown>;
  warnings: unknown[];
  startedAt: string;
  finishedAt?: string | null;
  // Multiphysics columns (alembic 0036). Backend backfills 'optics_seq' /
  // 'inproc' on legacy rows so these are always present.
  module: SimulationModule;
  runnerKind: SolverRunnerKind;
  params: Record<string, unknown>;
  progress: number | null;
  errorMessage: string | null;
  resultSummary: Record<string, unknown> | null;
  resultBlobPath: string | null;
};

export type SimulationRunCreatePayload = {
  module: SimulationModule;
  runnerKind?: SolverRunnerKind;
  params?: Record<string, unknown>;
};

// ---- Circuits (Phase B.1, alembic 0037) -----------------------------------

export type Circuit = {
  id: string;
  name: string;
  netlist: string;
  schematic: Record<string, unknown>;
  sceneObjectId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CircuitCreatePayload = {
  name: string;
  netlist?: string;
  schematic?: Record<string, unknown>;
  sceneObjectId?: string | null;
};

export type CircuitUpdatePayload = {
  name?: string;
  netlist?: string;
  schematic?: Record<string, unknown>;
  sceneObjectId?: string | null;
};

// ---- EM (Phase C, alembic 0038) --------------------------------------------

export type Mesh = {
  id: string;
  name: string;
  meshFormat: "gmsh" | "vtk";
  sourceAsset3dId: string | null;
  filePath: string;
  elementCount: number | null;
  maxSizeMm: number | null;
  fileSizeBytes: number;
  createdAt: string;
};

export type EmPort = {
  id: string;
  name: string;
  anchorBindingId: string | null;
  impedanceOhm: number;
  mode: "te" | "tm" | "tem";
};

export type EmFreqSweep = {
  startGhz: number;
  stopGhz: number;
  points: number;
  scale: "linear" | "log";
};

export type EmBoundaryConditions = {
  pecAnchorBindingIds: string[];
  absorbingAnchorBindingIds: string[];
};

/** Volumetric scalar field payload — Phase C.8.
 *  ``data`` is row-major flat array of dim[0]*dim[1]*dim[2] scalars.
 *  Mock palace produces a Gaussian blob; real palace will eventually
 *  pull down a .pvtu and stream it via a separate endpoint. */
export type EmFieldPayload =
  | {
      available: true;
      format: "scalar-grid";
      dim: [number, number, number];
      spacingMm: [number, number, number];
      originMm: [number, number, number];
      data: number[];
      label: string;
    }
  | {
      available: false;
      format: string;
      remoteHost?: string;
      remotePath?: string;
      note?: string;
    };

export type EmProblem = {
  id: string;
  name: string;
  sceneObjectId: string | null;
  meshId: string | null;
  ports: EmPort[];
  boundaryConditions: EmBoundaryConditions;
  freqRangeGhz: EmFreqSweep | null;
  createdAt: string;
  updatedAt: string;
};

export type EmProblemCreatePayload = {
  name: string;
  sceneObjectId?: string | null;
  meshId?: string | null;
  ports?: EmPort[];
  boundaryConditions?: EmBoundaryConditions;
  freqRangeGhz?: EmFreqSweep | null;
};

export type EmProblemUpdatePayload = Partial<EmProblemCreatePayload>;

// ---- Coils + Magnetics (Phase F+ Magnetics) -------------------------------

export type CoilShape = "circular_loop" | "solenoid" | "polyline";

export type Coil = {
  id: string;
  name: string;
  shape: CoilShape;
  /** shape-specific: {radiusMm, turns, lengthMm, axisBodyLocal,
   *  positionMm (when not bound to SceneObject), pointsMm} */
  params: Record<string, unknown>;
  currentA: number;
  sceneObjectId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CoilCreatePayload = {
  name: string;
  shape?: CoilShape;
  params?: Record<string, unknown>;
  currentA?: number;
  sceneObjectId?: string | null;
};

export type CoilUpdatePayload = Partial<CoilCreatePayload>;

export type MagneticsEvalRegion = {
  centerMm: [number, number, number];
  sizeMm: [number, number, number];
  gridDim: [number, number, number];
};

export type MagneticsProblem = {
  id: string;
  name: string;
  coilIds: string[];
  evalRegion: MagneticsEvalRegion;
  createdAt: string;
  updatedAt: string;
};

export type MagneticsProblemCreatePayload = {
  name: string;
  coilIds?: string[];
  evalRegion?: MagneticsEvalRegion;
};

export type MagneticsProblemUpdatePayload = Partial<MagneticsProblemCreatePayload>;

// ---- PulseBlaster channels (Phase F+ timing) -------------------------------

export type PulseBlasterChannel = {
  id: string;
  channelIndex: number;
  label: string;
  targetComponentId: string | null;
  invert: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PulseBlasterChannelCreatePayload = {
  channelIndex: number;
  label?: string;
  targetComponentId?: string | null;
  invert?: boolean;
  enabled?: boolean;
};

export type PulseBlasterChannelUpdatePayload = Partial<{
  label: string;
  targetComponentId: string | null;
  invert: boolean;
  enabled: boolean;
}>;

// ---- Touchstone (Phase B.7) -------------------------------------------------

export type TouchstoneNetwork = {
  filename: string;
  nPorts: number;
  z0: number;
  freqHz: number[];
  /** Keys are 'sNM' (1-indexed). Values are [re, im] pairs aligned with
   *  freqHz. */
  sParams: Record<string, [number, number][]>;
};

export type RevisionV2 = {
  id: string;
  label: string;
  description?: string | null;
  snapshot: Record<string, unknown>;
  sceneHash?: string | null;
  createdAt: string;
};
