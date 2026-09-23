"""Asset-Physics-Model v3 Pydantic schemas (Phase 2).

Additive ??does NOT modify the existing `schemas.py`. v2 callers continue
to use Asset3DOut / ComponentOut from schemas.py; v3 callers use these.

See docs/asset-physics-model.md 禮3-5 for the full design.
"""

from __future__ import annotations

import uuid
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, computed_field, model_validator

from app.schemas import AssetLodOut, CamelModel, asset_file_version


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------

class Vec3V3(CamelModel):
    x: float
    y: float
    z: float


class QuaternionV3(CamelModel):
    x: float
    y: float
    z: float
    w: float


class FaceV3(CamelModel):
    """Port on an Asset3D. See asset-physics-model.md 禮3.

    ``domain`` decides which tracer the face participates in:
      - ``"optical"`` (default for back-compat): 禮7 ray tracer
      - ``"rf"``:                                禮7.5 RF tracer
      - ``"ttl"``:                               禮7.5 RF tracer pre-pass
                                                 (switch control state)
    Rows written before the field existed are treated as ``"optical"``.
    """
    id: str
    position_mm_body_local: Vec3V3
    normal_body_local: Optional[Vec3V3] = None
    aperture_mm: float
    aperture_shape: Literal["rectangle", "ellipse", "circle"] = "rectangle"
    aperture_width_mm: Optional[float] = None
    aperture_height_mm: Optional[float] = None
    domain: Optional[Literal["optical", "rf", "ttl"]] = None


class TransferMatrixV3(CamelModel):
    """One of: abcd 2?2, abcdXY (separate x/y), or matrix5x5 (augmented).
    Exactly one form is populated; the consuming PhysicsOp picks."""
    abcd: Optional[list[list[float]]] = None
    abcd_x: Optional[list[list[float]]] = None
    abcd_y: Optional[list[list[float]]] = None
    matrix5x5: Optional[list[list[float]]] = None


class TransitionV3(CamelModel):
    """Allowed beam-path through an Asset3D: face_in ??face_out + op.

    For multi-hop reflective elements (PBS / BS / Glan-Laser / dichroic)
    the path is ``[in, *via, out]`` ??see asset-physics-model.md 禮3.3.
    Tracer applies mirror reflection at B*-prefixed faces and Snell at
    A*-prefixed external faces. ``via`` is omitted for 2-port slabs.
    """
    in_face: str = Field(alias="in")
    via: Optional[list[str]] = None
    out_face: str | list[str] = Field(alias="out")
    op: str
    params: Optional[dict[str, Any]] = None
    matrix5x5: Optional[list[list[float]]] = None
    abcd: Optional[list[list[float]]] = None


class MechanicalAnchorV3(CamelModel):
    id: str
    position_mm_body_local: Vec3V3
    normal_body_local: Optional[Vec3V3] = None


class AnchorV3(CamelModel):
    """Phase 9.1 anchor schema (alembic 0087). Each anchor has a position
    + three orthogonal body-local axes (X = propagation/normal,
    Y = transverse reference, Z = X ? Y). The PHY Editor edits only
    axisX directly; Y/Z are derived on save. See
    docs/asset-physics-model.md 禮3.x.
    """
    id: str
    position_mm_body_local: Vec3V3
    axis_x_body_local: Vec3V3
    axis_y_body_local: Vec3V3
    axis_z_body_local: Vec3V3
    aperture_mm: Optional[float] = None
    aperture_shape: Optional[Literal["rectangle", "ellipse", "circle"]] = None
    aperture_width_mm: Optional[float] = None
    aperture_height_mm: Optional[float] = None
    # Coax connector on RF / TTL ports (rf_in / rf_out / ttl_in / ...).
    # Read by the RF Link panel to render the connector family and gate
    # cable connections. Null on optical anchors. Kept as a free string
    # (not a Literal) so legacy bare "sma" / "bnc" values round-trip
    # alongside the editor's "sma_female" / "bnc_male" vocabulary.
    connector_type: Optional[str] = None
    # Display name distinguishing multiple anchors that share the same id
    # (rf_switch RF1/RF2, AD9959 CH0..CH3). The RF Link panel + solver key
    # throws/channels by name; a save that dropped this field silently
    # broke those multi-port assets. Null on single-port anchors, which
    # fall back to id.
    name: Optional[str] = None


# ---------------------------------------------------------------------------
# Surface model (alembic 0141) — docs/surface-optics.md
# ---------------------------------------------------------------------------

# Media ids every surface model may use without declaring them: the ambient
# (n = 1) and an absorber (a ray transmitted into it is dropped).
RESERVED_MEDIA = ("air", "opaque")
_AXIS_TOL = 1e-4


def _norm(v: Vec3V3) -> float:
    return (v.x * v.x + v.y * v.y + v.z * v.z) ** 0.5


class SurfaceShapeV3(CamelModel):
    """``radius_mm > 0`` puts the centre of curvature on the +axisX side.
    ``cylinder`` is curved along the surface's axisY only."""
    type: Literal["plane", "sphere", "cylinder", "conic"]
    radius_mm: Optional[float] = None
    conic: Optional[float] = None
    aspheric_coeffs: Optional[list[float]] = None

    @model_validator(mode="after")
    def _check(self) -> "SurfaceShapeV3":
        if self.type == "plane":
            if self.radius_mm is not None:
                raise ValueError("a plane has no radiusMm")
        elif not self.radius_mm:
            raise ValueError(f"a {self.type} needs a non-zero radiusMm")
        if self.type != "conic" and (
            self.conic is not None or self.aspheric_coeffs is not None
        ):
            raise ValueError("conic / asphericCoeffs belong to a conic surface")
        return self


class SurfaceApertureV3(CamelModel):
    """Measured in the surface's tangent plane. ``radius_mm`` is a radius;
    ``width_mm`` (along axisY) / ``height_mm`` (along axisZ) are full sizes."""
    shape: Literal["circle", "rectangle", "ellipse"]
    radius_mm: Optional[float] = None
    width_mm: Optional[float] = None
    height_mm: Optional[float] = None

    @model_validator(mode="after")
    def _check(self) -> "SurfaceApertureV3":
        if self.shape == "circle":
            if not self.radius_mm or self.radius_mm <= 0:
                raise ValueError("a circle aperture needs radiusMm > 0")
        elif not (
            self.width_mm and self.width_mm > 0
            and self.height_mm and self.height_mm > 0
        ):
            raise ValueError(f"a {self.shape} aperture needs widthMm and heightMm > 0")
        return self


class SurfaceCoatingV3(CamelModel):
    type: Literal["uncoated", "ar", "hr", "partial", "polarizing"] = "uncoated"
    reflectance: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    # Same names and meaning as the PBS op's params (anchor_ops/pbs.py).
    extinction_ratio_pp_db: Optional[float] = None
    extinction_ratio_sp_db: Optional[float] = None

    @model_validator(mode="after")
    def _check(self) -> "SurfaceCoatingV3":
        if self.type in ("ar", "hr", "partial") and self.reflectance is None:
            raise ValueError(f"an {self.type} coating needs a reflectance")
        if self.type in ("uncoated", "polarizing") and self.reflectance is not None:
            raise ValueError(f"an {self.type} coating takes no reflectance")
        if self.type != "polarizing" and (
            self.extinction_ratio_pp_db is not None
            or self.extinction_ratio_sp_db is not None
        ):
            raise ValueError("extinction ratios belong to a polarizing coating")
        return self


class MediumV3(CamelModel):
    """Exactly one of: ``n``, ``material`` (a name in
    ``app.optical.surfaces.materials``), or the uniaxial ``n_o`` + ``n_e``.
    A uniaxial medium — constant or a uniaxial material — needs
    ``optic_axis``; an isotropic one must not have it.

    Faraday rotation (an isotropic medium only): ``faraday_rotation_deg_per_mm``
    along ``magnetic_axis`` — a ray travelling ``t`` along ``k`` has its Jones
    vector re-expressed by ``rotate_jones(−ρ·t·(k·b̂))``, the faraday op's
    handedness, so the rotation is non-reciprocal."""
    n: Optional[float] = Field(default=None, gt=0.0)
    material: Optional[str] = None
    n_o: Optional[float] = Field(default=None, gt=0.0)
    n_e: Optional[float] = Field(default=None, gt=0.0)
    optic_axis: Optional[Vec3V3] = None
    faraday_rotation_deg_per_mm: Optional[float] = None
    magnetic_axis: Optional[Vec3V3] = None

    @model_validator(mode="after")
    def _check(self) -> "MediumV3":
        from app.optical.surfaces.materials import MATERIALS, UNIAXIAL

        if (self.faraday_rotation_deg_per_mm is None) != (self.magnetic_axis is None):
            raise ValueError("faradayRotationDegPerMm and magneticAxis go together")
        if self.magnetic_axis is not None and _norm(self.magnetic_axis) < 1e-9:
            raise ValueError("magneticAxis must be non-zero")
        constant_uniaxial = self.n_o is not None or self.n_e is not None
        if self.magnetic_axis is not None and (constant_uniaxial or self.material in UNIAXIAL):
            raise ValueError("Faraday rotation is supported in an isotropic medium only")
        if sum([self.n is not None, self.material is not None, constant_uniaxial]) != 1:
            raise ValueError("a medium needs exactly one of n, material, or nO + nE")
        if self.material is not None and self.material not in MATERIALS:
            raise ValueError(
                f"unknown material {self.material!r}; known: {sorted(MATERIALS)}"
            )
        if constant_uniaxial and (self.n_o is None or self.n_e is None):
            raise ValueError("a uniaxial medium needs both nO and nE")
        if constant_uniaxial or self.material in UNIAXIAL:
            if self.optic_axis is None or _norm(self.optic_axis) < 1e-9:
                raise ValueError("a uniaxial medium needs a non-zero opticAxis")
        elif self.optic_axis is not None:
            raise ValueError("opticAxis belongs to a uniaxial medium")
        return self


class SurfaceV3(CamelModel):
    """One optical surface. ``front`` is the medium on the +axisX side,
    ``back`` the one on the −axisX side; axisZ = axisX × axisY."""
    id: str
    position_mm_body_local: Vec3V3
    axis_x_body_local: Vec3V3
    axis_y_body_local: Vec3V3
    shape: SurfaceShapeV3
    aperture: SurfaceApertureV3
    front: str
    back: str
    coating: SurfaceCoatingV3 = Field(default_factory=SurfaceCoatingV3)

    @model_validator(mode="after")
    def _check(self) -> "SurfaceV3":
        x, y = self.axis_x_body_local, self.axis_y_body_local
        if abs(_norm(x) - 1.0) > _AXIS_TOL or abs(_norm(y) - 1.0) > _AXIS_TOL:
            raise ValueError(f"surface {self.id!r}: axisX and axisY must be unit vectors")
        if abs(x.x * y.x + x.y * y.y + x.z * y.z) > _AXIS_TOL:
            raise ValueError(f"surface {self.id!r}: axisX and axisY must be orthogonal")
        if self.front == self.back:
            raise ValueError(f"surface {self.id!r}: front and back are the same medium")
        return self


class SurfaceModelV3(CamelModel):
    """A part as real surfaces with media between them. See
    docs/surface-optics.md; nothing in the tracer reads this yet."""
    media: dict[str, MediumV3] = Field(default_factory=dict)
    surfaces: list[SurfaceV3]

    @model_validator(mode="after")
    def _check(self) -> "SurfaceModelV3":
        if not self.surfaces:
            raise ValueError("a surface model needs at least one surface")
        reserved = set(RESERVED_MEDIA) & set(self.media)
        if reserved:
            raise ValueError(f"reserved media ids cannot be declared: {sorted(reserved)}")
        ids = [s.id for s in self.surfaces]
        dupes = {i for i in ids if ids.count(i) > 1}
        if dupes:
            raise ValueError(f"duplicate surface ids: {sorted(dupes)}")
        known = set(self.media) | set(RESERVED_MEDIA)
        used: set[str] = set()
        for s in self.surfaces:
            for side in (s.front, s.back):
                if side not in known:
                    raise ValueError(f"surface {s.id!r}: unknown medium {side!r}")
                used.add(side)
        unused = set(self.media) - used
        if unused:
            raise ValueError(f"media not used by any surface: {sorted(unused)}")
        if "air" not in used:
            raise ValueError("no surface touches air, so light can never enter")
        return self


# ---------------------------------------------------------------------------
# Asset3D v3
# ---------------------------------------------------------------------------

class Asset3DV3In(CamelModel):
    """Shape of a JSON in assets/catalog/assets3d/**/*.json. Seed-script
    reads this; field names match the JSON convention (camelCase via
    `CamelModel.alias_generator`)."""

    id: str                                # catalog_id (string slug)
    vendor_part: Optional[str] = None
    display_name: Optional[str] = None
    geometry_ref: Optional[str] = None
    geometry_ref_glb: Optional[str] = None
    kind: Optional[str] = None             # null for mechanical-only assets
    wavelength_range_nm: Optional[list[float]] = None
    frequency_range_mhz: Optional[list[float]] = None

    physical_dimensions_mm: Optional[dict[str, Any]] = None

    default_params: dict[str, Any] = Field(default_factory=dict)
    mechanical_anchors: list[MechanicalAnchorV3] = Field(default_factory=list)

    notes: Optional[dict[str, Any]] = None


class Asset3DV3Out(CamelModel):
    """API response: includes DB-side UUID + v3 catalog fields."""
    id: uuid.UUID
    catalog_id: Optional[str] = None
    name: str
    asset_type: str
    file_path: str
    unit: str = "mm"
    scale_factor: float = 1.0
    # NOT NULL since alembic 0111 — always carries at least "unclassified".
    kind_id: str
    # Device-registry pointer (alembic 0118). When set, anchors are a
    # materialised view of the device template and kind_id is written through
    # from the device's behavioralKind.
    device_id: Optional[str] = None
    anchors: Optional[list[dict[str, Any]]] = None
    default_params: Optional[dict[str, Any]] = None
    # Per-instance-tunable param keys (alembic 0113). Default_params keys the
    # asset author marked editable per-instance; only these reach the
    # SceneObject dynamic-sources editor.
    tunable_params: Optional[list[str]] = None
    wavelength_range_nm: Optional[list[float]] = None
    frequency_range_mhz: Optional[list[float]] = None
    # Surface model (alembic 0141), returned raw like ``anchors`` so a row
    # written outside the API can never 500 the catalog list. NULL = none.
    surface_model: Optional[dict[str, Any]] = None
    properties: dict[str, Any]
    # Human-confirmed "frozen" flag (alembic 0112). Read-only editor + the
    # PUT below rejects any field change but ``locked`` while it is true.
    locked: bool = False
    # LOD tier manifest (alembic 0122), ordered by level. Empty until the
    # asset's tiers have been generated. Eager-loaded by the list route so a
    # single catalog fetch carries the whole manifest.
    lods: list[AssetLodOut] = []

    @computed_field(alias="fileVersion")
    @property
    def file_version(self) -> int | None:
        return asset_file_version(self.file_path)


class Asset3DV3Update(CamelModel):
    """Editable v3 fields for the Asset3D catalog editor."""
    name: Optional[str] = None
    kind_id: Optional[str] = None
    # Device-registry pointer (alembic 0118). Setting this seeds anchors from
    # the device template + writes kind_id through from the device's
    # behavioralKind (unless the same payload also sends explicit anchors /
    # kind_id, which then win).
    device_id: Optional[str] = None
    # Phase 9.8: PHY Editor's primary write target ??replaces faces[] +
    # transitions[] over time. Anchors use the Phase 9.1 tri-axis schema
    # (axisX/Y/Z) consumed by the anchor tracer. Editor sends the full
    # merged list on every save.
    anchors: Optional[list[AnchorV3]] = None
    default_params: Optional[dict[str, Any]] = None
    tunable_params: Optional[list[str]] = None
    wavelength_range_nm: Optional[list[float]] = None
    frequency_range_mhz: Optional[list[float]] = None
    # Surface model (alembic 0141): whole-object overwrite; null clears it.
    surface_model: Optional[SurfaceModelV3] = None
    # Callers should send the full merged dict; partial keys would`r`n    # clobber unrelated entries.
    properties: Optional[dict[str, Any]] = None
    locked: Optional[bool] = None


class Asset3DUsageOut(CamelModel):
    """Reference counts for an Asset3D. ``component_count`` is how many
    catalog Components point at this asset (direct FK or via a binding);
    ``object_count`` is how many placed scene objects resolve to it. The
    PHY Editor reads this to lock Delete on an in-use asset (a deletion would
    orphan placed instances). connector_type stays editable — freezing a row
    entirely is the separate ``locked`` flag, not in-use."""
    component_count: int
    object_count: int


# ---------------------------------------------------------------------------
# Component v3
# ---------------------------------------------------------------------------

class ComponentBindingV3In(CamelModel):
    binding_id: str
    asset_id: str                          # catalog_id of an Asset3D
    local_x_mm: float = 0
    local_y_mm: float = 0
    local_z_mm: float = 0
    local_rx_deg: float = 0
    local_ry_deg: float = 0
    local_rz_deg: float = 0
    tunable_axes: list[str] = Field(default_factory=list)


class ExposedFaceV3(CamelModel):
    component_face_id: str
    asset_binding_id: str
    asset_face_id: str


class ComponentV3In(CamelModel):
    """Shape of a JSON in assets/catalog/components/**/*.json."""
    id: str
    vendor_part: Optional[str] = None
    display_name: Optional[str] = None
    kind_id: str = "none"
    wavelength_center_nm: Optional[float] = None
    bindings: list[ComponentBindingV3In] = Field(default_factory=list)
    exposed_faces: list[ExposedFaceV3] = Field(default_factory=list)
    notes: Optional[dict[str, Any]] = None


class ComponentV3Out(CamelModel):
    id: uuid.UUID
    catalog_id: Optional[str] = None
    name: str
    kind_id: Optional[str] = None
    brand: Optional[str] = None
    model: Optional[str] = None
    exposed_faces: Optional[list[ExposedFaceV3]] = None
    properties: dict[str, Any]
    bindings: list[dict[str, Any]] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# SceneObject v3 deltas
# ---------------------------------------------------------------------------

class SceneObjectV3Patch(CamelModel):
    """PATCH payload for assigning v3 fields to a SceneObject."""
    dynamic_sources: Optional[dict[str, Any]] = None
