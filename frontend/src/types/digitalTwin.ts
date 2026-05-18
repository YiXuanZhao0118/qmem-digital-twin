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
  /** Explicit aperture geometry. R3 (PHY Editor authority, 2026-05-17):
   *  "circle" uses `apertureMm` as radius; "ellipse" uses
   *  `apertureWidthMm` / `apertureHeightMm` as semi-major / semi-minor
   *  axis lengths; "rectangle" uses them as full width / full height.
   *  When unset, legacy rows infer from which fields are populated:
   *  W+H present → rectangle (back-compat); apertureMm only → circle. */
  apertureShape?: "circle" | "ellipse" | "rectangle";
  /** Dynamic-port marker for fiber kinds. When set, the anchor's
   *  position is re-derived at read time from the per-instance fiber
   *  spline (`SceneObject.properties.fiberNodes`, falling back to the
   *  catalog template). `fiberEndA` resolves to nodes[0].posMm offset
   *  outward by the ferrule tip length; `fiberEndB` to nodes[N-1].posMm.
   *  Direction follows the spline tangent at that endpoint. When this
   *  field is unset, the anchor is treated as a static body-local
   *  position. See `utils/fiberAnchorResolver.ts`. */
  derivedFromFiberEndpoint?: "A" | "B";
  /** Same as `derivedFromFiberEndpoint` but for the rf_cable kind:
   *  resolves rf_in / rf_out to the live spline endpoints stored in
   *  `SceneObject.properties.rfCableNodes`. See
   *  `utils/rfCableAnchorResolver.ts`. */
  derivedFromRfCableEndpoint?: "A" | "B";
  /** Physical coaxial connector at this anchor — gender + family.
   *  Only meaningful for RF / TTL anchors (rf_in / rf_out / ttl_in);
   *  left undefined on optical anchors. Edited per-anchor in the
   *  PHY Editor RF / Components view. */
  connectorType?: "sma_male" | "sma_female" | "bnc_male" | "bnc_female";
  /** Fast-axis angle (degrees) of a waveplate's crystal cut, measured
   *  in body-local beam coordinates at the anchor. Asset-level fixed
   *  (PHY Editor → Optical → Components). The per-instance rotation
   *  around the beam axis lives on SceneObject.transform; effective
   *  beam-frame angle = this + transform-projection. Only meaningful
   *  for anchors flagged via plugin `needsFastAxis`. */
  fastAxisDegBodyLocal?: number;
};

/** Per-instance rf_cable endpoint link record. Persisted under
 *  `SceneObject.properties.rfCableEndpoints[A|B]` whenever the user runs
 *  Align RF on a cable end. The renderer resolves the linked endpoint's
 *  spline node body-local position FROM the target anchor's live lab
 *  pose (target SceneObject.xMm/yMm/zMm + asset anchor body-local), so
 *  when the user moves the target component the cable's End A / End B
 *  physically follows without a re-align. The link is cleared the moment
 *  the user drags that endpoint's anchor in node-edit mode (manual
 *  override beats link). */
export type RfCableEndpointLink = {
  targetObjectId: string;
  /** `rf_in` or `rf_out` — anchor.id on the target asset. */
  targetAnchorId: string;
  /** Asset anchor `name` field (e.g. "CH0"). Some targets (AD9959) have
   *  4 anchors all with id=`rf_out` distinguished by name, so name must
   *  pair with id to pinpoint which one. */
  targetAnchorName: string;
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
  archivedAt?: string | null;
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
  | "fiber_end"
  | "isolator"
  | "aom"
  | "eom"
  | "nonlinear_crystal"
  | "saturable_absorber"
  | "detector"
  | "camera"
  | "spectrometer"
  | "wavemeter"
  | "beam_dump"
  | "rf_source"
  | "rf_amplifier"
  | "horn_antenna"
  | "programmable_pulse_generator"
  | "rf_cable"
  | "rf_switch";

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
  wavelengthRangeNm: [number, number];
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
  /** Phase fiber-split: each end is now its own `fiber_end` SceneObject
   *  whose lab pose drives the spline endpoint. Null on legacy data
   *  pending the Phase B alembic backfill. */
  endAObjectId?: string | null;
  endBObjectId?: string | null;
};

/** Phase fiber-split — per-end ferrule SceneObject. Each `fiber_end`
 *  owns its lab pose, lock, rigid-group membership, and align flow;
 *  shared fiber params (length, fiberType, etc.) live on the paired
 *  `fiber` body wrapper referenced via `fiberBodyObjectId`. */
export type FiberEndParams = {
  /** e.g. "FC/PC", "FC/APC", "LC/PC". Null = catalog default. */
  connectorType?: string | null;
  polish?: "PC" | "APC" | "UPC" | null;
  /** PM only — slow-axis angle in body frame (deg). */
  slowAxisDegInBodyFrame?: number | null;
  /** Back-reference to the paired fiber body SceneObject (the hidden
   *  spline wrapper carrying shared params). */
  fiberBodyObjectId?: string | null;
  /** Which end of the body this object represents. Aligns with
   *  FiberParams.endAObjectId / endBObjectId. */
  endRole: "A" | "B";
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
  // Phase B (RF link single-source-of-truth): centerFreqMhz / rfDrivePowerW
  // are no longer stored on the AOM. They are resolved at solve time from
  // the upstream rf_source channel via the AOM's rf_in `rfCableEndpoints`
  // link (backend `hydrate_aom_rf_drive`). Frontend resolves the same way
  // for ray-trace / Bragg-angle UI readouts via
  // `resolveAomRfDriveFromScene` in `utils/aomRfDrive.ts`.
  refractiveIndex?: number | null;
  figureOfMeritM2?: number | null;
  crystalLengthMm?: number | null;
  acousticBeamWidthMm?: number | null;
  /** Safety upper bound for the resolved drive power. Clamps the live
   *  upstream value; not a setpoint. */
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

export type DdsSweepTarget = "frequency" | "phase" | "amplitude";

export type DdsSweepConfig = {
  target: DdsSweepTarget;
  start: number;
  end: number;
  // Rising / falling slope rates in target-unit per second
  // (MHz/s for frequency, deg/s for phase, 1/s for amplitude).
  rampUpRate: number;
  rampDownRate: number;
  noDwellLow: boolean;
  noDwellHigh: boolean;
};

export type DdsChannelMode = "single_tone" | "sweep" | "fm" | "pm" | "am";
export type DdsModulationLevels = 2 | 4 | 8 | 16;

export type DdsProfile = {
  // Field meaning depends on parent channel's mode:
  //   fm → frequencyMhz, pm → phaseDeg, am → amplitudeScale.
  // Other fields are ignored at runtime; null = not set.
  frequencyMhz: number | null;
  phaseDeg: number | null;
  amplitudeScale: number | null;
};

export type DdsChannel = {
  channelIndex: number;
  anchorName: string | null;
  mode: DdsChannelMode;
  channelEnabled: boolean;
  frequencyMhz: number;
  phaseDeg: number;
  amplitudeScale: number;
  sweep: DdsSweepConfig | null;
  modulationLevels: DdsModulationLevels;
  profiles: DdsProfile[] | null;
};

export type DdsSyncRole = "master" | "slave" | "standalone";
export type DdsSerialPortMode = "1wire" | "2wire" | "4wire";

export type RfSourceParams = {
  frequencyMhz: number;
  powerDbm: number;
  phaseDeg: number;
  modulation: "none" | "am" | "fm" | "iq";
  channels: DdsChannel[] | null;
  referenceClockMhz: number | null;
  sysClockMhz: number | null;
  pllMultiplier: number;
  pllBypass: boolean;
  serialInterface: "spi" | "parallel" | "none" | null;
  syncRole: DdsSyncRole;
  serialPortMode: DdsSerialPortMode;
};

export type HornAntennaParams = {
  frequencyGhz: number;
  gainDbi: number;
  beamwidth3dbDeg: number;
  polarAxisBodyLocal: number[] | null;
  cosineExponent: number;
};

export type ProgrammablePulseGeneratorParams = {
  connectorType: "sma" | "bnc";
  timingProgramId: string | null;
  /** PPG emits a single "RFout" HIGH/LOW gate. Previously split into
   *  "ttl" / "trigger" sub-domains driven by TimingProgram.kind, but
   *  alembic 0051 collapsed that into one signal type — downstream
   *  consumer ports (switch.ttl_in / AOM.trigger_in) carry any semantic
   *  difference. Field kept as a literal for schema stability. */
  outputDomain: "rfout";
  highVoltageV: number;
  /** Resting / default level OUTSIDE any HIGH interval. Symmetric:
   *  result = inInterval XOR (restState === "HIGH"). Defaults to "LOW"
   *  (omitted on un-migrated rows is treated as "LOW" so existing-scene
   *  behaviour is preserved). When the user sets "HIGH" the program's
   *  intervals become LOW pulses (negative-logic). Also the steady-state
   *  level seen by downstream switches when scrub is stopped. */
  restState?: "HIGH" | "LOW";
};

/** RF amplifier (e.g. Mini-Circuits ZHL-1-2W+ — 5..500 MHz, +30 dBm output,
 *  +24 V supply, SMA female on each end). Unidirectional gain block with
 *  one rf_in port and one rf_out port. Flat-gain passband between
 *  `frequencyRangeMhz[0]` and `frequencyRangeMhz[1]`; outside that range
 *  the solver treats the path as -inf dB. Soft compression near rated
 *  output is approximated by clamping at `outputPowerMaxDbm` once the
 *  linear-gain extrapolation would exceed it; the 1 dB compression
 *  point lives in `outputPowerP1dbDbm` for downstream linearity checks. */
export type RfAmplifierParams = {
  gainDb: number;
  frequencyRangeMhz: [number, number];
  outputPowerP1dbDbm: number;
  outputPowerMaxDbm: number;
  inputPowerMaxDbm: number;
  noiseFigureDb: number;
  supplyVoltageV: number;
  supplyCurrentA: number;
  inputReturnLossDb: number;
  outputReturnLossDb: number;
  connectorType: "sma" | "bnc" | "n" | "smp";
};

export type RfSwitchType = "SPST" | "SP2T" | "SP3T" | "SP4T";
export type RfSwitchControlLogic = "TTL" | "CMOS_3V3" | "CMOS_5V" | "OPEN_COLLECTOR";
export type RfSwitchAbsorptionType = "absorptive" | "reflective";

/** RF switch (e.g. Mini-Circuits ZYSWA-2-50DR — SP2T, DC..5 GHz, ±5 V supply,
 *  TTL control). Topology: one common RF port (rf_in, the "RFIN" on the
 *  datasheet) routed to one of N throw ports (rf_out × N, the "RF1"/"RF2"/…
 *  on the datasheet) under TTL control. Reciprocal in the small-signal
 *  regime — a 1-in/N-out switch is also a N-in/1-out multiplexer; the
 *  digital twin treats both directions of each port as bidirectional, and
 *  the active path is determined by the TTL state (DeviceState.state.ttlGate
 *  / .activeThrow at runtime). */
export type RfSwitchParams = {
  /** Pole/throw topology. ZYSWA-2-50DR is "SP2T". */
  switchType: RfSwitchType;
  /** Number of throw ports (= number of rf_out anchors). 2 for SP2T,
   *  3 for SP3T, etc. Derived from switchType but stored explicitly so a
   *  custom switch with non-standard topology can override. */
  throwCount: number;
  frequencyMinGhz: number;
  frequencyMaxGhz: number;
  /** Insertion loss on the active (selected) path, dB. Datasheet "typ"
   *  at the high end of the band. */
  insertionLossDb: number;
  /** Isolation between RFIN and the unselected throw port(s), dB.
   *  Datasheet "typ" at the high end of the band. */
  isolationDb: number;
  /** Time from TTL edge to RF output settled to 50 % of final amplitude,
   *  nanoseconds. */
  switchingTimeNs: number;
  /** Absorptive (50-Ω terminated unselected throw) vs reflective (open). */
  absorptionType: RfSwitchAbsorptionType;
  /** Logic family of the control input (TTL = 0/+5 V). */
  controlLogic: RfSwitchControlLogic;
  /** Logic-high voltage on the TTL pin, volts. */
  controlVoltageHighV: number;
  /** Positive supply rail, volts (e.g. +5 V). */
  supplyPositiveV: number;
  /** Negative supply rail, volts (e.g. -5 V). null = single-supply switch. */
  supplyNegativeV: number | null;
  /** Typical total current draw at the rated supply, mA. */
  supplyCurrentMa: number;
  /** Max RF input power without compression / damage, dBm. */
  maxInputPowerDbm: number;
  /** RF connector family on the SMA ports. */
  connectorType: RfCableConnectorType;
  /** Manufacturer + model strings for the datasheet link in the inspector. */
  manufacturer: string | null;
  model: string | null;
  datasheetUrl: string | null;
};

export type RfCableConnectorType = "sma" | "bnc" | "n" | "smp";

export type RfCableParams = {
  lengthMm: number;
  impedanceOhm: number;
  maxFrequencyGhz: number;
  connectorType: RfCableConnectorType;
  cableType: string | null;
  jacketOuterDiameterMm: number;
  jacketColor: string;
  workingVoltageVRms: number | null;
  dielectricVoltageVRms: number | null;
  minBendRadiusMm: number | null;
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
  | { elementKind: "fiber_end"; kindParams: FiberEndParams }
  | { elementKind: "isolator"; kindParams: IsolatorParams }
  | { elementKind: "aom"; kindParams: AOMParams }
  | { elementKind: "eom"; kindParams: EOMParams }
  | { elementKind: "nonlinear_crystal"; kindParams: NonlinearCrystalParams }
  | { elementKind: "saturable_absorber"; kindParams: SaturableAbsorberParams }
  | { elementKind: "detector"; kindParams: DetectorParams }
  | { elementKind: "camera"; kindParams: CameraParams }
  | { elementKind: "spectrometer"; kindParams: SpectrometerParams }
  | { elementKind: "wavemeter"; kindParams: WavemeterParams }
  | { elementKind: "beam_dump"; kindParams: BeamDumpParams }
  | { elementKind: "rf_source"; kindParams: RfSourceParams }
  | { elementKind: "rf_amplifier"; kindParams: RfAmplifierParams }
  | { elementKind: "horn_antenna"; kindParams: HornAntennaParams }
  | {
      elementKind: "programmable_pulse_generator";
      kindParams: ProgrammablePulseGeneratorParams;
    }
  | { elementKind: "rf_cable"; kindParams: RfCableParams }
  | { elementKind: "rf_switch"; kindParams: RfSwitchParams };

export type OpticalElementCommon = {
  /** Per-object PK (alembic 0014). Each scene object that has an optical
   *  role gets its own PhysicsElement row keyed by `objectId`. */
  id: string;
  /** SceneObject this element belongs to. Two scene objects of the same
   *  Component (e.g. two BB1 mirrors) get DIFFERENT PhysicsElement rows. */
  objectId: string;
  wavelengthRangeNm: [number, number];
  inputPorts: OpticalPort[];
  outputPorts: OpticalPort[];
  createdAt?: string;
  updatedAt?: string;
};

export type PhysicsElement = OpticalElementCommon & OpticalElementKindParams;

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

// =============================================================================
// TimingProgram (alembic 0045/0046 — reusable HIGH-interval schedules)
// =============================================================================

export type TimingInterval = {
  spinCoreStartNs: number;
  spinCoreEndNs: number;
};

/** Slimmed-down by alembic 0051: kind / channelIndex / invert are gone.
 *  Every PPG emits the same RFout HIGH/LOW gate; channel ordering is
 *  positional from the PPG list at solve time. */
export type TimingProgram = {
  id: string;
  name: string | null;
  intervals: TimingInterval[];
  createdAt?: string;
  updatedAt?: string;
};

export type TimingProgramCreatePayload = {
  name?: string | null;
  intervals?: TimingInterval[];
};

export type TimingProgramUpdatePayload = Partial<TimingProgramCreatePayload>;

export type CompiledPbInstruction = {
  index: number;
  outputState: number;
  opcode: string;
  data: number;
  lengthNs: number;
  label: string | null;
};

export type TimingProgramCompile = {
  instructions: CompiledPbInstruction[];
  pythonSource: string;
  boundProgramCount: number;
  totalDurationNs: number;
};

// =============================================================================
// Kind capabilities (drives UI affordance: power switch / TTL gate / Trigger picker)
// =============================================================================
// Defaults; per-template Component.properties.hasTriggerInput / hasTtlGateInput
// can override (e.g. an rf_source variant that does have a trigger input).

export const POWER_KINDS: ReadonlySet<string> = new Set([
  "laser_source",
  "tapered_amplifier",
  "rf_source",
  // Phase RF.amp (2026-05-14): coaxial RF gain blocks (Mini-Circuits ZHL
  // series) take +24 V DC bias on the feed-through posts. Membership
  // here makes the InstrumentPowerPanel auto-attach a power toggle to
  // each rf_amplifier object; the supply voltage / current spec lives
  // in RfAmplifierParams (supplyVoltageV / supplyCurrentA).
  "rf_amplifier",
  "function_generator",
  "rf_switch",
  "detector",
  "camera",
  "spectrometer",
  "wavemeter",
]);

export const TTL_GATE_KINDS: ReadonlySet<string> = new Set([
  "rf_switch",
]);

export const TRIGGER_KINDS: ReadonlySet<string> = new Set([
  "function_generator",
  "camera",
  "spectrometer",
  "detector",
]);

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
  physicsElements: PhysicsElement[];
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
  | { type: "physics_element.updated"; payload: (Partial<PhysicsElement> & { componentId?: string; deleted?: boolean }) | PhysicsElement }
  | { type: "optical_link.updated"; payload: (Partial<OpticalLink> & { id?: string; deleted?: boolean }) | OpticalLink }
  | { type: "optical_simulation.completed"; payload: { runId: string; segmentCount: number; errors: string[]; warnings: string[] } }
  | { type: "simulation_run.status_changed"; payload: { id: string; module: SimulationModule; status: SimulationRunStatus; progress: number | null; errorMessage: string | null } }
  | { type: "scene_view.updated"; payload: (Partial<import("./visibility").SceneView> & { id?: string; deleted?: boolean }) | import("./visibility").SceneView }
  | { type: "collection.updated"; payload: (Partial<Collection> & { id?: string; deleted?: boolean }) | Collection }
  | { type: "collection_member.updated"; payload: Partial<CollectionMember> & { collectionId?: string; objectId?: string; deleted?: boolean; resetToMaster?: boolean } }
  | { type: "timing_program.updated"; payload: TimingProgram }
  | { type: "timing_program.deleted"; payload: { id: string } }
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

/** Collection Drift template — see backend/app/models.py CollectionTemplate
 *  + alembic 0053. Each member's pose is stored relative to the centroid
 *  of every descendant SceneObject across the saved subtree, so dropping
 *  the template back into the scene at a target point places the new
 *  bundle as one rigid block at that point. Cable connections and
 *  optical / RF links are intentionally NOT included in the snapshot. */
export type CollectionTemplateMember = {
  componentId: string;
  relativeXMm: number;
  relativeYMm: number;
  relativeZMm: number;
  rxDeg: number;
  ryDeg: number;
  rzDeg: number;
  visible: boolean;
  properties: Record<string, unknown>;
  sortOrder: number;
};

export type CollectionTemplateNode = {
  name: string;
  color: string;
  visible: boolean;
  rigidTransform: boolean;
  sortOrder: number;
  properties: Record<string, unknown>;
  members: CollectionTemplateMember[];
  children: CollectionTemplateNode[];
};

export type CollectionTemplate = {
  id: string;
  name: string;
  description: string | null;
  tree: CollectionTemplateNode;
  createdAt: string;
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
  | "optics_crystal"
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

// PulseBlasterChannel types removed in alembic 0046: channel_index + invert
// are now inline on TimingProgram (see TimingProgram type above).

// ---- RF chain nodes (Phase RF.2) ------------------------------------------

export type RfNodeKind =
  | "dds"
  | "synthesizer"
  | "amplifier"
  | "attenuator"
  | "filter_bandpass"
  | "filter_lowpass"
  | "filter_highpass"
  | "splitter"
  | "combiner"
  | "mixer"
  | "switch"
  | "isolator"
  | "circulator"
  | "coax"
  | "device";

export type RfChainNode = {
  id: string;
  terminalSceneObjectId: string;
  positionInChain: number;
  nodeKind: RfNodeKind;
  label: string;
  gainDb: number;
  kindParams: Record<string, unknown>;
  linkedCircuitId: string | null;
  linkedEmProblemId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RfChainNodeCreatePayload = {
  terminalSceneObjectId: string;
  positionInChain: number;
  nodeKind: RfNodeKind;
  label?: string;
  gainDb?: number;
  kindParams?: Record<string, unknown>;
  linkedCircuitId?: string | null;
  linkedEmProblemId?: string | null;
};

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


// =============================================================================
// AI binding agent (alembic 0057 + backend/app/routers/agent_sessions.py).
// The panel that drives these types lives behind VITE_ENABLE_AI_PANEL and
// is not user-facing in v1.
// =============================================================================

export type AgentSessionStatus =
  | "running"
  | "committed"
  | "cancelled"
  | "abandoned";

export type AgentSession = {
  id: string;
  instruction: string;
  status: AgentSessionStatus;
  lastHeartbeatAt: string;
  heartbeatTimeoutSec: number;
  committedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
};

export type SessionMutationOp = "create" | "update" | "delete";
export type SessionMutationEntityType = "asset_3d" | "component";

export type SessionMutation = {
  id: string;
  op: SessionMutationOp;
  entityType: SessionMutationEntityType;
  entityId: string;
  /** Post-mutation snapshot — minimal identifying fields (id + name +
   *  type-specific FK). Use this to render review rows without an
   *  extra fetch. */
  after: Record<string, unknown> | null;
  /** ISO timestamp; non-null = user clicked "undo last step". The row
   *  stays in the audit log so the review UI can show struck-through
   *  history. */
  undoneAt: string | null;
  createdAt: string;
};

export type AgentSessionState = {
  session: AgentSession;
  mutations: SessionMutation[];
};

export type CommitResult = {
  sessionId: string;
  approvedAssets: string[];
  approvedComponents: string[];
};

export type CancelResult = {
  sessionId: string;
  rolledBackCount: number;
  reason: string;
};

export type AgentAttachmentKind = "asset_file" | "image";

export type AgentUpload = {
  fileId: string;
  filename: string;
  storedName: string;
  filePath: string;
  kind: AgentAttachmentKind;
  mediaType: string | null;
  sizeBytes: number;
};

/** Subset of AgentUpload that the panel echoes back to POST /messages
 *  as `attachments[]`. The backend re-derives file_path from
 *  stored_name to prevent path-traversal. */
export type AgentAttachmentRef = {
  storedName: string;
  filename: string;
  filePath: string;
  kind: AgentAttachmentKind;
  mediaType: string | null;
};
