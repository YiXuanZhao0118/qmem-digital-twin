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
    properties: dict[str, Any]
    # Human-confirmed "frozen" flag (alembic 0112). Read-only editor + the
    # PUT below rejects any field change but ``locked`` while it is true.
    locked: bool = False


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
