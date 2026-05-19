"""Layer 1 + organisation: SceneObject instances, Collections, SceneViews."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, JsonDict, JsonList


class SceneObject(Base):
    __tablename__ = "objects"
    __table_args__ = (UniqueConstraint("name", name="uq_objects_name"),)

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    component_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("components.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False, default="object", server_default="object")
    x_mm: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    y_mm: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    z_mm: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    rx_deg: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    ry_deg: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    rz_deg: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    visible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    locked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # Per-physical-unit serial. Migrated from components.serial_number in
    # alembic 0015 — two SceneObjects of the same Component model can have
    # different serials (or one with a serial, others NULL).
    serial_number: Mapped[str | None] = mapped_column(Text)
    properties: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    component: Mapped[Component] = relationship(back_populates="objects", foreign_keys=[component_id])
    physics_element: Mapped[PhysicsElement | None] = relationship(
        back_populates="object", cascade="all, delete-orphan",
        primaryjoin="SceneObject.id == PhysicsElement.object_id",
    )
    device_state: Mapped[DeviceState | None] = relationship(
        back_populates="object", cascade="all, delete-orphan"
    )
    object_bindings: Mapped[list[ObjectBinding]] = relationship(
        back_populates="object",
        cascade="all, delete-orphan",
        primaryjoin="SceneObject.id == ObjectBinding.object_id",
    )
    # TimingProgram is no longer per-object (alembic 0045) — consumers
    # reference programs by id via JSONB refs in ``properties``.


class ObjectBinding(Base):
    """Per-SceneObject override of a ComponentBinding's pose / asset.

    Catalog-shared baselines live on ``ComponentBinding`` (one per
    Component template); per-instance tweaks live here (one row per
    (SceneObject, ComponentBinding) pair). The renderer composes
    ``effective = component_binding.local* + object_binding.delta*``
    per axis at draw time.

    Why a table instead of ``SceneObject.properties.bindingOverrides``?
    See alembic 0076 — first-class entity gets FK cascade, indexes for
    "all overrides for binding X" queries, and WS event channels so
    other clients see live changes. The legacy properties-JSON shape
    was a prototype.

    Per-axis nullability: ``NULL`` means "no override for this axis",
    distinguishing it from "explicit 0 override". Sparse storage avoids
    row-bloat for the common case where only one axis is being tweaked.

    ``asset_3d_id_override`` optionally swaps which Asset3D the binding
    renders for this specific instance (covers the "damaged-housing
    variant" case). NULL means "use the binding's declared asset".

    Unique on (object_id, component_binding_id) — overrides compose
    rather than stack.
    """

    __tablename__ = "object_bindings"
    __table_args__ = (
        UniqueConstraint(
            "object_id",
            "component_binding_id",
            name="uq_object_bindings_object_binding",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    object_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("objects.id", ondelete="CASCADE"),
        nullable=False,
    )
    component_binding_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("component_bindings.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Per-axis delta overrides. Nullable so "no override" is
    # distinguishable from "explicit 0 override".
    local_x_mm_delta: Mapped[float | None] = mapped_column(Float)
    local_y_mm_delta: Mapped[float | None] = mapped_column(Float)
    local_z_mm_delta: Mapped[float | None] = mapped_column(Float)
    local_rx_deg_delta: Mapped[float | None] = mapped_column(Float)
    local_ry_deg_delta: Mapped[float | None] = mapped_column(Float)
    local_rz_deg_delta: Mapped[float | None] = mapped_column(Float)
    # Optional per-instance asset swap on the same binding.
    asset_3d_id_override: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("assets_3d.id", ondelete="RESTRICT"),
    )
    properties: Mapped[JsonDict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    object: Mapped[SceneObject] = relationship(
        back_populates="object_bindings", foreign_keys=[object_id]
    )
    component_binding: Mapped[ComponentBinding] = relationship(
        foreign_keys=[component_binding_id]
    )
    asset_override: Mapped[Asset3D | None] = relationship(foreign_keys=[asset_3d_id_override])


class SceneView(Base):
    __tablename__ = "scene_views"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    icon: Mapped[str | None] = mapped_column(Text)
    color: Mapped[str] = mapped_column(Text, nullable=False, default="#0f766e", server_default="#0f766e")
    filter_kind: Mapped[str] = mapped_column(Text, nullable=False, default="leaf", server_default="leaf")
    filter_expr: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    overlay_overrides: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    is_pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_by: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class Collection(Base):
    """Recursive Outliner node — purely organizational, never affects geometry.

    A NULL ``parent_id`` denotes the Master Collection (there is exactly one
    such row per project after the bootstrap in app startup).
    """

    __tablename__ = "collections"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("collections.id", ondelete="CASCADE"),
        nullable=True,
    )
    color: Mapped[str] = mapped_column(Text, nullable=False, default="#0f766e", server_default="#0f766e")
    visible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    # When true, every descendant SceneObject is treated as one rigid group: a
    # translate or rotate on any member applies the same rigid-body transform
    # to all the others (Blender-style "transform together"). Effective state
    # cascades — a collection inherits rigid_transform=true from any ancestor
    # with rigid_transform=true; computed at read time. Lock is per-OBJECT
    # (objects.locked) — there is no collection-level lock state, only a UI
    # bulk action over its descendants. See alembic 0035.
    rigid_transform: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    properties: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class CollectionMember(Base):
    """Single collection home for an object.

    No ``is_primary`` flag — every membership is equal, exactly like Blender's
    only, never as repeated linked rows.
    """

    __tablename__ = "collection_members"
    __table_args__ = (
        UniqueConstraint("object_id", name="uq_collection_members_object_home"),
    )

    collection_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("collections.id", ondelete="CASCADE"),
        primary_key=True,
    )
    object_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("objects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class SceneViewCollectionOverride(Base):
    """Sparse per-view override for collection visibility.

    Reserved for v2; v1 reads no rows from this table. ``visible=NULL`` means
    "inherit from collection". Only collections that differ from their default
    visible state in a given view need a row here. The exclude/holdout/
    indirect_only override columns were dropped in alembic 0035 along with
    their canonical counterparts on ``collections``.
    """

    __tablename__ = "scene_view_collection_overrides"

    scene_view_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("scene_views.id", ondelete="CASCADE"),
        primary_key=True,
    )
    collection_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("collections.id", ondelete="CASCADE"),
        primary_key=True,
    )
    visible: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class CollectionTemplate(Base):
    """Reusable snapshot of a Collection subtree — the "Collection Drift" feature.

    Saves the structure (sub-collection tree) plus every descendant SceneObject's
    pose relative to the subtree's geometric centroid. Cable connections,
    optical / RF links, and physics_element details are intentionally NOT
    snapshotted — instantiation produces clean, unconnected objects whose
    relative geometry exactly matches the saved configuration. See alembic 0053.

    ``tree`` schema (recursive)::

        {
          "name": "A",
          "color": "#0f766e",
          "visible": true,
          "rigidTransform": false,
          "sortOrder": 0,
          "properties": {},
          "members": [
            {
              "componentId": "<uuid>",
              "relativeXMm": float,   # offset from centroid at save time
              "relativeYMm": float,
              "relativeZMm": float,
              "rxDeg": float,         # world-frame Euler angles preserved as-is
              "ryDeg": float,
              "rzDeg": float,
              "visible": true,
              "properties": {},
              "sortOrder": 0
            }
          ],
          "children": [<nested node>, ...]
        }
    """

    __tablename__ = "collection_templates"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    tree: Mapped[JsonDict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


# TimingBlock removed in alembic 0045. The intervals it carried are now a
# JSONB array on TimingProgram.intervals; see that class for the new layout.

