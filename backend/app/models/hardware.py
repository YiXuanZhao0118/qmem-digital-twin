"""Layer 1 Hardware: 3D asset catalog + Component composition tree."""

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


class Asset3D(Base):
    __tablename__ = "assets_3d"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    asset_type: Mapped[str] = mapped_column(Text, nullable=False)
    file_path: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str | None] = mapped_column(Text)
    source_url: Mapped[str | None] = mapped_column(Text)
    unit: Mapped[str] = mapped_column(Text, nullable=False, default="mm", server_default="mm")
    scale_factor: Mapped[float] = mapped_column(Float, nullable=False, default=1.0, server_default="1")
    anchors: Mapped[JsonList] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    # Asset-level metadata (alembic 0064). First consumer is
    # ``viewerHints`` — instructions the generic asset loader honours
    # regardless of consuming componentType:
    #   * deletedCentroids: list of "x,y,z" centroid keys to drop from
    #     STL geometry (replaces the bespoke isolator deletion path);
    #   * axisRadiusFilterMm: hide triangles within R mm of the
    #     longest-bbox axis (hides internal baffles);
    #   * material: { type: "translucent_housing", opacity: ... }.
    properties: Mapped[JsonDict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    # Agent binding lifecycle (alembic 0057). 'draft' rows are invisible to
    # the normal REST list endpoints (they filter status='active'); only the
    # owning agent session sees them. 'active' is the default for every
    # non-agent flow. ai_approved_at non-null = the AI tool layer treats this
    # row as read-only (manual UI ignores the field entirely).
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="active", server_default="active"
    )
    created_by_session_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("agent_sessions.id", ondelete="SET NULL")
    )
    ai_approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    components: Mapped[list[Component]] = relationship(back_populates="asset")


class Component(Base):
    __tablename__ = "components"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    component_type: Mapped[str] = mapped_column(Text, nullable=False)
    brand: Mapped[str | None] = mapped_column(Text)
    model: Mapped[str | None] = mapped_column(Text)
    # serial_number lives on SceneObject now (alembic 0015) — a serial
    # uniquely identifies a physical unit, which maps to one instance.
    asset_3d_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("assets_3d.id")
    )
    properties: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    physics_capabilities: Mapped[JsonList] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Agent binding lifecycle (alembic 0057). See Asset3D for semantics.
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="active", server_default="active"
    )
    created_by_session_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("agent_sessions.id", ondelete="SET NULL")
    )
    ai_approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    asset: Mapped[Asset3D | None] = relationship(back_populates="components")
    objects: Mapped[list[SceneObject]] = relationship(
        back_populates="component",
        cascade="all, delete-orphan",
        foreign_keys="SceneObject.component_id",
    )
    bindings: Mapped[list[ComponentBinding]] = relationship(
        back_populates="component",
        cascade="all, delete-orphan",
        foreign_keys="ComponentBinding.component_id",
        order_by="ComponentBinding.sort_order",
    )
    # DeviceState, TimingProgram, PhysicsElement are all per-OBJECT now
    # (alembic 0014 + 0015). Reach them via SceneObject.{device_state,
    # timing_program, physics_element}. Component is purely a catalog row.


class ComponentBinding(Base):
    """How a Component is composed from Asset3Ds and/or sub-Components.

    Generalises the legacy ``Component.asset_3d_id`` (single FK) into a
    tree of bindings where each node holds EITHER raw geometry
    (``target_kind='asset'`` → ``asset_3d_id``) OR another Component
    (``target_kind='subcomponent'`` → ``sub_component_id``), positioned
    by a local transform relative to its parent binding (or to the
    Component's origin when ``parent_binding_id`` is NULL).

    ``tunable_axes`` declares which Euler axes a SceneObject instance can
    override per-instance, in which frame, with what bounds. The actual
    per-instance values live on ``SceneObject.properties.bindingOverrides``
    keyed by binding id — see alembic 0062 for the rationale.

    Cycle prevention: ``sub_component_id != component_id`` is enforced at
    DB level; transitive cycles (A → B → A) are checked in the CRUD
    layer on create/update.

    Example shape (Isolator with 2 PBS sub-components and 2 tunable end
    caps)::

        root binding (faraday_body.stl, role=body, identity)
        ├── end cap 1 (end_cap.stl, role=mount, tunable rz)
        │     └── PBS sub-Component (target_kind=subcomponent)
        └── end cap 2 (end_cap.stl, role=mount, tunable rz)
              └── PBS sub-Component (target_kind=subcomponent)
    """

    __tablename__ = "component_bindings"
    __table_args__ = (
        # Three valid shapes (alembic 0066): asset / subcomponent /
        # empty (transform-only — the user's "PBS Mount" node case).
        CheckConstraint(
            "(target_kind = 'asset' AND asset_3d_id IS NOT NULL AND sub_component_id IS NULL)"
            " OR (target_kind = 'subcomponent' AND asset_3d_id IS NULL AND sub_component_id IS NOT NULL)"
            " OR (target_kind = 'empty' AND asset_3d_id IS NULL AND sub_component_id IS NULL)",
            name="ck_component_bindings_target_shape",
        ),
        CheckConstraint(
            "sub_component_id IS NULL OR sub_component_id <> component_id",
            name="ck_component_bindings_no_self_subref",
        ),
    )

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
    parent_binding_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("component_bindings.id", ondelete="CASCADE"),
    )
    target_kind: Mapped[str] = mapped_column(Text, nullable=False)
    asset_3d_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("assets_3d.id", ondelete="RESTRICT"),
    )
    sub_component_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("components.id", ondelete="RESTRICT"),
    )
    role: Mapped[str] = mapped_column(
        Text, nullable=False, default="body", server_default="body"
    )
    local_x_mm: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    local_y_mm: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    local_z_mm: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    local_rx_deg: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    local_ry_deg: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    local_rz_deg: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    tunable_axes: Mapped[JsonDict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
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

    component: Mapped[Component] = relationship(
        back_populates="bindings", foreign_keys=[component_id]
    )
    parent: Mapped[ComponentBinding | None] = relationship(
        remote_side="ComponentBinding.id",
        foreign_keys=[parent_binding_id],
        back_populates="children",
    )
    children: Mapped[list[ComponentBinding]] = relationship(
        back_populates="parent",
        foreign_keys=[parent_binding_id],
        cascade="all, delete-orphan",
        order_by="ComponentBinding.sort_order",
    )
    asset: Mapped[Asset3D | None] = relationship(foreign_keys=[asset_3d_id])
    sub_component: Mapped[Component | None] = relationship(foreign_keys=[sub_component_id])

