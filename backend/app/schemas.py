from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field, model_validator


def to_camel(value: str) -> str:
    parts = value.split("_")
    return parts[0] + "".join(part[:1].upper() + part[1:] for part in parts[1:])


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        from_attributes=True,
        populate_by_name=True,
    )


JsonDict = dict[str, Any]
Vec3 = tuple[float, float, float]


class Asset3DBase(CamelModel):
    name: str
    asset_type: str
    file_path: str
    source: str | None = None
    source_url: str | None = None
    unit: Literal["mm", "m"] = "mm"
    scale_factor: float = 1.0
    anchors: list[JsonDict] = Field(default_factory=list)


class Asset3DCreate(Asset3DBase):
    pass


class Asset3DUpdate(CamelModel):
    name: str | None = None
    asset_type: str | None = None
    file_path: str | None = None
    source: str | None = None
    source_url: str | None = None
    unit: Literal["mm", "m"] | None = None
    scale_factor: float | None = None
    anchors: list[JsonDict] | None = None


class LocalAssetImport(CamelModel):
    source_path: str
    name: str | None = None
    component_type: str = "custom_3d"
    brand: str | None = None
    model: str | None = None
    unit: Literal["mm", "m"] = "mm"
    scale_factor: float = 1.0


class Asset3DOut(Asset3DBase):
    id: uuid.UUID
    created_at: datetime


PhysicsCapability = Literal["stress", "optical", "rf", "em", "thermal", "fluid", "quantum"]


class ComponentBase(CamelModel):
    name: str
    component_type: str
    brand: str | None = None
    model: str | None = None
    serial_number: str | None = None
    asset_3d_id: uuid.UUID | None = None
    properties: JsonDict = Field(default_factory=dict)
    physics_capabilities: list[PhysicsCapability] = Field(default_factory=list)
    notes: str | None = None


class ComponentCreate(ComponentBase):
    pass


class ComponentUpdate(CamelModel):
    name: str | None = None
    component_type: str | None = None
    brand: str | None = None
    model: str | None = None
    serial_number: str | None = None
    asset_3d_id: uuid.UUID | None = None
    properties: JsonDict | None = None
    physics_capabilities: list[PhysicsCapability] | None = None
    notes: str | None = None


class ComponentOut(ComponentBase):
    id: uuid.UUID
    created_at: datetime
    updated_at: datetime

    @computed_field(alias="componentName")
    @property
    def component_name(self) -> str:
        return self.name


class PlacementBase(CamelModel):
    object_name: str | None = None
    parent_component_id: uuid.UUID | None = None
    x_mm: float = 0
    y_mm: float = 0
    z_mm: float = 0
    rx_deg: float = 0
    ry_deg: float = 0
    rz_deg: float = 0
    visible: bool = True
    locked: bool = False
    properties: JsonDict = Field(default_factory=dict)


class PlacementCreate(PlacementBase):
    component_id: uuid.UUID


class PlacementUpdate(CamelModel):
    object_name: str | None = None
    parent_component_id: uuid.UUID | None = None
    x_mm: float | None = None
    y_mm: float | None = None
    z_mm: float | None = None
    rx_deg: float | None = None
    ry_deg: float | None = None
    rz_deg: float | None = None
    visible: bool | None = None
    locked: bool | None = None
    properties: JsonDict | None = None


class PlacementOut(PlacementBase):
    id: uuid.UUID
    component_id: uuid.UUID
    object_name: str
    updated_at: datetime


SceneObjectCreate = PlacementCreate
SceneObjectUpdate = PlacementUpdate
SceneObjectOut = PlacementOut


class ConnectionBase(CamelModel):
    connection_type: str
    from_component_id: uuid.UUID
    from_port: str | None = None
    to_component_id: uuid.UUID
    to_port: str | None = None
    label: str | None = None
    properties: JsonDict = Field(default_factory=dict)


class ConnectionCreate(ConnectionBase):
    pass


class ConnectionOut(ConnectionBase):
    id: uuid.UUID
    created_at: datetime


RelationType = Literal[
    "same_position",
    "offset_position",
    "distance",
    "same_direction",
    "opposite_direction",
    "perpendicular_direction",
    "look_at",
    "face_touch",
    "face_parallel",
    "face_offset",
    "face_align_center",
    "face_distance",
    "coincident",
    "parallel",
    "perpendicular",
    "concentric",
    "tangent",
    "angle",
    "lock_transform",
    "align_axis",
]


def selector_normal(selector: JsonDict) -> tuple[float, float, float] | None:
    value = selector.get("normal") or selector.get("localDirection")
    if isinstance(value, dict):
        value = (value.get("x"), value.get("y"), value.get("z"))
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        return None
    if not all(isinstance(item, (int, float)) for item in value):
        return None
    vector = tuple(float(item) for item in value)
    length = sum(item * item for item in vector) ** 0.5
    if length == 0:
        return None
    return vector


def normals_dot(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    len_a = sum(item * item for item in a) ** 0.5
    len_b = sum(item * item for item in b) ** 0.5
    return sum(left * right for left, right in zip(a, b, strict=True)) / (len_a * len_b)


class AssemblyRelationBase(CamelModel):
    name: str
    relation_type: RelationType
    object_a_id: uuid.UUID
    object_b_id: uuid.UUID
    selector_a: JsonDict = Field(default_factory=dict)
    selector_b: JsonDict = Field(default_factory=dict)
    offset_mm: float | None = None
    angle_deg: float | None = None
    tolerance_mm: float = 0.01
    enabled: bool = True
    solved: bool = False
    properties: JsonDict = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_relation_geometry(self) -> "AssemblyRelationBase":
        if self.object_a_id == self.object_b_id:
            raise ValueError("A relation must reference two different objects.")
        normal_a = selector_normal(self.selector_a)
        normal_b = selector_normal(self.selector_b)
        relation_type = {
            "face_distance": "face_offset",
            "coincident": "face_touch",
            "parallel": "face_parallel",
            "perpendicular": "perpendicular_direction",
            "align_axis": "same_direction",
        }.get(self.relation_type, self.relation_type)
        if relation_type in {"same_direction", "face_parallel"}:
            if normal_a is None or normal_b is None:
                raise ValueError("Direction relations require selector normals.")
            if abs(normals_dot(normal_a, normal_b)) < 0.999:
                raise ValueError("Selected anchors must be parallel.")
        if relation_type == "opposite_direction":
            if normal_a is None or normal_b is None:
                raise ValueError("Opposite direction relations require selector normals.")
            if normals_dot(normal_a, normal_b) > -0.999:
                raise ValueError("Selected anchors must point in opposite directions.")
        if relation_type == "perpendicular_direction":
            if normal_a is None or normal_b is None:
                raise ValueError("Perpendicular direction relations require selector normals.")
            if abs(normals_dot(normal_a, normal_b)) > 0.001:
                raise ValueError("Selected anchors must be perpendicular.")
        if relation_type in {"offset_position", "face_offset"} and self.offset_mm is None:
            params = self.properties.get("params")
            has_vector_offset = isinstance(params, dict) and isinstance(params.get("offset"), dict)
            if not has_vector_offset:
                raise ValueError("Offset relations require offsetMm or params.offset.")
        if relation_type == "distance" and self.offset_mm is None:
            params = self.properties.get("params")
            has_distance = isinstance(params, dict) and isinstance(params.get("distance"), (int, float))
            if not has_distance:
                raise ValueError("Distance relations require offsetMm or params.distance.")
        return self


class AssemblyRelationCreate(AssemblyRelationBase):
    pass


class AssemblyRelationUpdate(CamelModel):
    name: str | None = None
    relation_type: RelationType | None = None
    object_a_id: uuid.UUID | None = None
    object_b_id: uuid.UUID | None = None
    selector_a: JsonDict | None = None
    selector_b: JsonDict | None = None
    offset_mm: float | None = None
    angle_deg: float | None = None
    tolerance_mm: float | None = None
    enabled: bool | None = None
    solved: bool | None = None
    properties: JsonDict | None = None


class AssemblyRelationOut(AssemblyRelationBase):
    id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class BeamPathBase(CamelModel):
    name: str
    wavelength_nm: float | None = None
    color: str = "#ff0000"
    source_component_id: uuid.UUID | None = None
    target_component_id: uuid.UUID | None = None
    points: list[Vec3] = Field(default_factory=list)
    properties: JsonDict = Field(default_factory=dict)
    visible: bool = True


class BeamPathCreate(BeamPathBase):
    pass


class BeamPathUpdate(CamelModel):
    name: str | None = None
    wavelength_nm: float | None = None
    color: str | None = None
    source_component_id: uuid.UUID | None = None
    target_component_id: uuid.UUID | None = None
    points: list[Vec3] | None = None
    properties: JsonDict | None = None
    visible: bool | None = None


class BeamPathOut(BeamPathBase):
    id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class DeviceStateUpdate(CamelModel):
    state: JsonDict = Field(default_factory=dict)


class DeviceStateOut(CamelModel):
    component_id: uuid.UUID
    state: JsonDict = Field(default_factory=dict)
    updated_at: datetime


# =============================================================================
# Optical domain schemas
# =============================================================================

# --- Reusable building blocks ------------------------------------------------


class JonesVector(CamelModel):
    """Polarization state: complex 2-vector [Ex, Ey]."""

    ex_re: float = 1.0
    ex_im: float = 0.0
    ey_re: float = 0.0
    ey_im: float = 0.0


class GaussianMode(CamelModel):
    """Astigmatic Gaussian beam parameters along one transverse axis (x or y)."""

    waist_um: float = Field(gt=0)
    waist_z_offset_mm: float = 0.0
    m_squared: float = Field(default=1.0, ge=1.0)


TransverseModeKind = Literal["TEM00", "TEM_mn", "LG_pl", "multimode"]


class TransverseMode(CamelModel):
    kind: TransverseModeKind = "TEM00"
    indices_m: int | None = None
    indices_n: int | None = None
    indices_p: int | None = None
    indices_l: int | None = None

    @model_validator(mode="after")
    def check_indices(self) -> "TransverseMode":
        if self.kind == "TEM_mn":
            if self.indices_m is None or self.indices_n is None:
                raise ValueError("TEM_mn requires indices m and n.")
        elif self.kind == "LG_pl":
            if self.indices_p is None or self.indices_l is None:
                raise ValueError("LG_pl requires indices p and l.")
        return self


SpectrumLineshape = Literal["gaussian", "lorentzian", "voigt", "delta"]
SpectrumComponentKind = Literal["main", "sideband", "ase", "custom"]


class SpectrumComponent(CamelModel):
    kind: SpectrumComponentKind = "main"
    lineshape: SpectrumLineshape
    offset_mhz: float = 0.0
    fwhm_mhz: float | None = None
    voigt_gaussian_fwhm_mhz: float | None = None
    voigt_lorentzian_fwhm_mhz: float | None = None
    amplitude: float = Field(default=1.0, ge=0.0)

    @model_validator(mode="after")
    def check_lineshape_params(self) -> "SpectrumComponent":
        if self.lineshape == "delta":
            if self.fwhm_mhz is not None and self.fwhm_mhz != 0:
                raise ValueError("delta lineshape must not specify fwhm_mhz.")
        elif self.lineshape in {"gaussian", "lorentzian"}:
            if self.fwhm_mhz is None or self.fwhm_mhz <= 0:
                raise ValueError(f"{self.lineshape} lineshape requires positive fwhm_mhz.")
        elif self.lineshape == "voigt":
            if self.voigt_gaussian_fwhm_mhz is None or self.voigt_lorentzian_fwhm_mhz is None:
                raise ValueError("voigt lineshape requires voigt_gaussian_fwhm_mhz and voigt_lorentzian_fwhm_mhz.")
            if self.voigt_gaussian_fwhm_mhz <= 0 or self.voigt_lorentzian_fwhm_mhz <= 0:
                raise ValueError("voigt fwhm components must be positive.")
        return self


class Spectrum(CamelModel):
    center_thz: float = Field(gt=0)
    components: list[SpectrumComponent] = Field(default_factory=list)


# --- Port declarations -------------------------------------------------------


PortRole = Literal["input", "output"]


class OpticalPort(CamelModel):
    port_id: str
    role: PortRole
    label: str | None = None
    kind: str | None = None  # "main", "reflected", "diffracted_plus", etc.


# --- Element kinds and their typed params ------------------------------------


ElementKind = Literal[
    "laser_source",
    "tapered_amplifier",
    "mirror",
    "lens_spherical",
    "lens_cylindrical",
    "waveplate",
    "polarizer",
    "beam_splitter",
    "dichroic_mirror",
    "fiber_coupler",
    "isolator",
    "aom",
    "eom",
    "nonlinear_crystal",
    "saturable_absorber",
    "detector",
    "camera",
    "spectrometer",
    "wavemeter",
    "beam_dump",
]


# Emitters ---------------------------------------------------------------------


class LaserSourceParams(CamelModel):
    center_wavelength_nm: float = Field(gt=0)
    spectrum: Spectrum
    spatial_mode_x: GaussianMode
    spatial_mode_y: GaussianMode
    transverse_mode: TransverseMode = Field(default_factory=lambda: TransverseMode())
    polarization: JonesVector = Field(default_factory=JonesVector)
    nominal_power_mw: float = Field(gt=0)
    rin_dbc_per_hz: float | None = None
    frequency_noise_hz_per_sqrt_hz: float | None = None


class TaperedAmplifierAse(CamelModel):
    power_mw: float = Field(ge=0)
    bandwidth_nm: float = Field(gt=0)
    center_offset_nm: float = 0.0


class TaperedAmplifierParams(CamelModel):
    small_signal_gain_db: float
    saturation_power_mw: float = Field(gt=0)
    max_input_power_mw: float | None = None
    ase: TaperedAmplifierAse
    output_spatial_mode_x: GaussianMode
    output_spatial_mode_y: GaussianMode
    output_transverse_mode: TransverseMode = Field(default_factory=lambda: TransverseMode())


# Passive ----------------------------------------------------------------------


class MirrorParams(CamelModel):
    reflectivity: float = Field(default=0.99, ge=0.0, le=1.0)
    surface_quality_nm: float | None = None
    normal_local: list[float] = Field(default_factory=lambda: [1.0, 0.0, 0.0])


class LensSphericalParams(CamelModel):
    focal_mm: float
    numerical_aperture: float | None = None
    transmission: float = Field(default=0.99, ge=0.0, le=1.0)


class LensCylindricalParams(CamelModel):
    focal_mm: float
    cylindrical_axis: Literal["x", "y"] = "x"
    transmission: float = Field(default=0.99, ge=0.0, le=1.0)


class WaveplateParams(CamelModel):
    retardance_lambda: float = Field(gt=0)  # 0.5 = HWP, 0.25 = QWP
    fast_axis_deg: float = 0.0
    transmission: float = Field(default=0.99, ge=0.0, le=1.0)


class PolarizerParams(CamelModel):
    transmission_axis_deg: float = 0.0
    extinction_ratio_db: float = Field(default=30.0, ge=0.0)
    transmission: float = Field(default=0.95, ge=0.0, le=1.0)


class BeamSplitterParams(CamelModel):
    split_ratio_transmitted: float = Field(default=0.5, ge=0.0, le=1.0)
    polarizing: bool = False
    transmission: float = Field(default=0.99, ge=0.0, le=1.0)


class DichroicMirrorParams(CamelModel):
    cutoff_wavelength_nm: float = Field(gt=0)
    pass_band: Literal["short", "long"] = "long"
    transmission: float = Field(default=0.95, ge=0.0, le=1.0)
    reflectivity: float = Field(default=0.95, ge=0.0, le=1.0)


class FiberCouplerParams(CamelModel):
    coupling_efficiency: float = Field(default=0.7, ge=0.0, le=1.0)
    mode_field_diameter_um: float = Field(gt=0)
    fiber_type: Literal["single_mode", "polarization_maintaining", "multi_mode"] = "single_mode"


class IsolatorParams(CamelModel):
    forward_loss_db: float = Field(default=0.5, ge=0.0)
    isolation_db: float = Field(default=40.0, ge=0.0)
    transmission_axis_deg: float = 0.0


# Active / Nonlinear -----------------------------------------------------------


class AOMParams(CamelModel):
    rf_driver_component_id: uuid.UUID | None = None
    base_efficiency: float = Field(default=0.85, ge=0.0, le=1.0)
    deflection_per_mhz_urad: float = Field(default=200.0, ge=0.0)
    acoustic_velocity_m_per_s: float = Field(default=4200.0, gt=0)
    modulation_bandwidth_mhz: float = Field(default=20.0, gt=0)
    center_freq_mhz: float = Field(default=80.0, gt=0)


class EOMParams(CamelModel):
    rf_driver_component_id: uuid.UUID | None = None
    v_pi_v: float = Field(gt=0)
    modulation_kind: Literal["phase", "amplitude"] = "phase"
    modulation_bandwidth_mhz: float = Field(default=100.0, gt=0)
    insertion_loss_db: float = Field(default=3.0, ge=0.0)


class NonlinearCrystalParams(CamelModel):
    process: Literal["SHG", "SFG", "DFG", "OPO"]
    chi2_pm_per_v: float = Field(gt=0)
    length_mm: float = Field(gt=0)
    phase_match_temp_c: float | None = None
    phase_match_angle_deg: float | None = None
    walk_off_urad: float = 0.0


class SaturableAbsorberParams(CamelModel):
    saturation_intensity_w_per_cm2: float = Field(gt=0)
    modulation_depth: float = Field(default=0.5, ge=0.0, le=1.0)
    non_saturable_loss: float = Field(default=0.05, ge=0.0, le=1.0)
    recovery_time_ps: float = Field(gt=0)


# Sinks ------------------------------------------------------------------------


class DetectorParams(CamelModel):
    responsivity_a_per_w: float = Field(gt=0)
    quantum_efficiency: float = Field(default=0.8, ge=0.0, le=1.0)
    bandwidth_mhz: float = Field(gt=0)
    saturation_power_mw: float = Field(gt=0)


class CameraParams(CamelModel):
    resolution_px: tuple[int, int] = (1024, 1024)
    pixel_size_um: float = Field(gt=0)
    quantum_efficiency: float = Field(default=0.5, ge=0.0, le=1.0)
    well_depth_e: int = Field(default=20000, gt=0)


class SpectrometerParams(CamelModel):
    resolution_pm: float = Field(gt=0)
    wavelength_range_nm: tuple[float, float] = (400.0, 1100.0)


class WavemeterParams(CamelModel):
    precision_mhz: float = Field(gt=0)


class BeamDumpParams(CamelModel):
    absorption: float = Field(default=0.999, ge=0.0, le=1.0)


# --- Per-kind validator registry --------------------------------------------


KIND_PARAMS_MODELS: dict[str, type[CamelModel]] = {
    "laser_source": LaserSourceParams,
    "tapered_amplifier": TaperedAmplifierParams,
    "mirror": MirrorParams,
    "lens_spherical": LensSphericalParams,
    "lens_cylindrical": LensCylindricalParams,
    "waveplate": WaveplateParams,
    "polarizer": PolarizerParams,
    "beam_splitter": BeamSplitterParams,
    "dichroic_mirror": DichroicMirrorParams,
    "fiber_coupler": FiberCouplerParams,
    "isolator": IsolatorParams,
    "aom": AOMParams,
    "eom": EOMParams,
    "nonlinear_crystal": NonlinearCrystalParams,
    "saturable_absorber": SaturableAbsorberParams,
    "detector": DetectorParams,
    "camera": CameraParams,
    "spectrometer": SpectrometerParams,
    "wavemeter": WavemeterParams,
    "beam_dump": BeamDumpParams,
}


def _port(port_id: str, role: PortRole, label: str, kind: str | None = None) -> dict[str, Any]:
    return OpticalPort(port_id=port_id, role=role, label=label, kind=kind).model_dump(by_alias=True)


DEFAULT_PORTS: dict[str, dict[str, list[dict[str, Any]]]] = {
    "laser_source": {
        "input": [],
        "output": [_port("out", "output", "Main", "main")],
    },
    "tapered_amplifier": {
        "input": [_port("seed", "input", "Seed", "seed")],
        "output": [_port("out", "output", "Amplified", "main")],
    },
    "mirror": {
        "input": [_port("in", "input", "In", "main")],
        "output": [_port("out", "output", "Reflected", "reflected")],
    },
    "lens_spherical": {
        "input": [_port("in", "input", "In", "main")],
        "output": [_port("out", "output", "Refracted", "refracted")],
    },
    "lens_cylindrical": {
        "input": [_port("in", "input", "In", "main")],
        "output": [_port("out", "output", "Refracted", "refracted")],
    },
    "waveplate": {
        "input": [_port("in", "input", "In", "main")],
        "output": [_port("out", "output", "Out", "transmitted")],
    },
    "polarizer": {
        "input": [_port("in", "input", "In", "main")],
        "output": [_port("out", "output", "Out", "transmitted")],
    },
    "beam_splitter": {
        "input": [_port("in_a", "input", "Face A", "main"), _port("in_b", "input", "Face B", "main")],
        "output": [_port("out_t", "output", "Transmitted", "transmitted"), _port("out_r", "output", "Reflected", "reflected")],
    },
    "dichroic_mirror": {
        "input": [_port("in", "input", "In", "main")],
        "output": [_port("out_pass", "output", "Pass", "transmitted"), _port("out_refl", "output", "Reflect", "reflected")],
    },
    "fiber_coupler": {
        "input": [_port("in", "input", "Free space", "main")],
        "output": [_port("out", "output", "Fiber", "fiber")],
    },
    "isolator": {
        "input": [_port("in", "input", "In", "main")],
        "output": [_port("out", "output", "Out", "transmitted")],
    },
    "aom": {
        "input": [_port("in", "input", "In", "main")],
        "output": [
            _port("0th", "output", "0th order", "undiffracted"),
            _port("+1st", "output", "+1st order", "diffracted_plus"),
            _port("-1st", "output", "-1st order", "diffracted_minus"),
        ],
    },
    "eom": {
        "input": [_port("in", "input", "In", "main")],
        "output": [_port("out", "output", "Modulated", "modulated")],
    },
    "nonlinear_crystal": {
        "input": [_port("signal", "input", "Signal", "main"), _port("pump", "input", "Pump", "pump")],
        "output": [_port("out", "output", "Converted", "converted"), _port("idler", "output", "Idler", "idler")],
    },
    "saturable_absorber": {
        "input": [_port("in", "input", "In", "main")],
        "output": [_port("out", "output", "Out", "transmitted")],
    },
    "detector": {
        "input": [_port("in", "input", "In", "main")],
        "output": [],
    },
    "camera": {
        "input": [_port("in", "input", "In", "main")],
        "output": [],
    },
    "spectrometer": {
        "input": [_port("in", "input", "In", "main")],
        "output": [],
    },
    "wavemeter": {
        "input": [_port("in", "input", "In", "main")],
        "output": [],
    },
    "beam_dump": {
        "input": [_port("in", "input", "In", "main")],
        "output": [],
    },
}

EMITTER_KINDS: set[str] = {"laser_source", "tapered_amplifier"}


# --- Top-level OpticalElement schemas ---------------------------------------


class OpticalElementBase(CamelModel):
    element_kind: ElementKind
    wavelength_range_nm: tuple[float, float] = (400.0, 1100.0)
    input_ports: list[OpticalPort] = Field(default_factory=list)
    output_ports: list[OpticalPort] = Field(default_factory=list)
    kind_params: JsonDict = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_and_normalize(self) -> "OpticalElementBase":
        validator = KIND_PARAMS_MODELS.get(self.element_kind)
        if validator is None:
            raise ValueError(f"Unknown element_kind: {self.element_kind}")
        validated = validator(**self.kind_params)
        self.kind_params = validated.model_dump(by_alias=True, exclude_none=True)

        if not self.input_ports and not self.output_ports:
            defaults = DEFAULT_PORTS.get(self.element_kind)
            if defaults is not None:
                self.input_ports = [OpticalPort(**p) for p in defaults["input"]]
                self.output_ports = [OpticalPort(**p) for p in defaults["output"]]

        low, high = self.wavelength_range_nm
        if low <= 0 or high <= low:
            raise ValueError("wavelength_range_nm must be (low > 0, high > low).")
        return self


class OpticalElementCreate(OpticalElementBase):
    component_id: uuid.UUID


class OpticalElementUpdate(CamelModel):
    element_kind: ElementKind | None = None
    wavelength_range_nm: tuple[float, float] | None = None
    input_ports: list[OpticalPort] | None = None
    output_ports: list[OpticalPort] | None = None
    kind_params: JsonDict | None = None


class OpticalElementOut(OpticalElementBase):
    component_id: uuid.UUID
    created_at: datetime
    updated_at: datetime


# --- OpticalLink schemas ----------------------------------------------------


class OpticalLinkBase(CamelModel):
    from_component_id: uuid.UUID
    from_port: str
    to_component_id: uuid.UUID
    to_port: str
    free_space_mm: float = Field(default=0.0, ge=0.0)
    properties: JsonDict = Field(default_factory=dict)


class OpticalLinkCreate(OpticalLinkBase):
    pass


class OpticalLinkUpdate(CamelModel):
    free_space_mm: float | None = None
    properties: JsonDict | None = None


class OpticalLinkOut(OpticalLinkBase):
    id: uuid.UUID
    created_at: datetime


# --- BeamSegment schemas (L3 simulation outputs) -----------------------------


class BeamSegmentOut(CamelModel):
    id: uuid.UUID
    simulation_run_id: uuid.UUID | None
    optical_link_id: uuid.UUID
    sequence_t_ms: float | None
    beam_index: int
    spectrum: JsonDict
    spatial_x: JsonDict
    spatial_y: JsonDict
    transverse_mode: JsonDict
    polarization_jones: JsonDict
    power_mw: float
    propagation_axis_local: list[float]
    created_at: datetime


class SceneOut(CamelModel):
    assets: list[Asset3DOut]
    components: list[ComponentOut]
    placements: list[PlacementOut]
    objects: list[SceneObjectOut]
    connections: list[ConnectionOut]
    assembly_relations: list[AssemblyRelationOut] = Field(default_factory=list)
    beam_paths: list[BeamPathOut]
    device_states: list[DeviceStateOut]
    optical_elements: list[OpticalElementOut] = Field(default_factory=list)
    optical_links: list[OpticalLinkOut] = Field(default_factory=list)
    beam_segments: list[BeamSegmentOut] = Field(default_factory=list)


class WebSocketEvent(CamelModel):
    type: str
    payload: JsonDict
