"""Asset-Physics-Model v3 Pydantic schemas (Phase 2).

Additive ??does NOT modify the existing `schemas.py`. v2 callers continue
to use Asset3DOut / ComponentOut from schemas.py; v3 callers use these.

See docs/asset-physics-model.md 禮3-5 for the full design.
"""

from __future__ import annotations

import uuid
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.schemas import CamelModel


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

    physical_dimensions_mm: Optional[dict[str, Any]] = None

    faces: list[FaceV3] = Field(default_factory=list)
    transitions: list[TransitionV3] = Field(default_factory=list)
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
    kind_id: Optional[str] = None
    faces: Optional[list[FaceV3]] = None
    transitions: Optional[list[TransitionV3]] = None
    anchors: Optional[list[dict[str, Any]]] = None
    default_params: Optional[dict[str, Any]] = None
    wavelength_range_nm: Optional[list[float]] = None
    properties: dict[str, Any]


class Asset3DV3Update(CamelModel):
    """Editable v3 fields for the Asset3D catalog editor."""
    kind_id: Optional[str] = None
    faces: Optional[list[FaceV3]] = None
    transitions: Optional[list[TransitionV3]] = None
    # Phase 9.8: PHY Editor's primary write target ??replaces faces[] +
    # transitions[] over time. Anchors use the Phase 9.1 tri-axis schema
    # (axisX/Y/Z) consumed by the anchor tracer. Editor sends the full
    # merged list on every save.
    anchors: Optional[list[AnchorV3]] = None
    default_params: Optional[dict[str, Any]] = None
    wavelength_range_nm: Optional[list[float]] = None
    # Callers should send the full merged dict; partial keys would`r`n    # clobber unrelated entries.
    properties: Optional[dict[str, Any]] = None


class Asset3DV3Create(CamelModel):
    """Payload for ``POST /api/v3/assets3d`` ??creates a new Asset3D row.

    Two creation modes:
      ??Blank: caller supplies ``catalog_id`` + ``name`` (+ optional
        ``file_path`` / ``asset_type``). All other fields default empty.
      ??Fork: caller supplies ``source_catalog_id`` to copy file_path,
        faces, default_params, anchors, and the properties bag from an`r`n        existing asset. Editor's
        "+ New Asset3D" workflow uses this to spawn an editable variant
        of an existing catalog entry without touching the original.
    """
    catalog_id: str
    name: str
    source_catalog_id: Optional[str] = None
    asset_type: Optional[str] = None
    file_path: Optional[str] = None
    kind_id: Optional[str] = None


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
    param_overrides: Optional[dict[str, dict[str, Any]]] = None
    dynamic_sources: Optional[dict[str, Any]] = None
