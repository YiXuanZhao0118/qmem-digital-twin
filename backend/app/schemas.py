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


class ComponentBase(CamelModel):
    name: str
    component_type: str
    brand: str | None = None
    model: str | None = None
    serial_number: str | None = None
    asset_3d_id: uuid.UUID | None = None
    properties: JsonDict = Field(default_factory=dict)
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


class SceneOut(CamelModel):
    assets: list[Asset3DOut]
    components: list[ComponentOut]
    placements: list[PlacementOut]
    objects: list[SceneObjectOut]
    connections: list[ConnectionOut]
    assembly_relations: list[AssemblyRelationOut] = Field(default_factory=list)
    beam_paths: list[BeamPathOut]
    device_states: list[DeviceStateOut]


class WebSocketEvent(CamelModel):
    type: str
    payload: JsonDict
