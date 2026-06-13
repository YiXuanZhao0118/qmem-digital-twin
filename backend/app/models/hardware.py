"""Layer 1 Hardware: 3D asset catalog + Component composition tree."""

from __future__ import annotations

import uuid
from datetime import datetime

import sqlalchemy as sa
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

    # Asset-Physics-Model v3 (alembic 0082). Nullable while v2 anchors-based
    # data coexists. See docs/asset-physics-model.md for schema.
    catalog_id: Mapped[str | None] = mapped_column(Text, unique=False)
    # Classification slug (alembic 0089/0090). Pointer into the Kind
    # registry. NOT NULL since 0111 — every asset has at least the
    # all-domain, no-physics "unclassified" placeholder (0110). A kindless
    # Asset3D is no longer a representable state.
    kind_id: Mapped[str] = mapped_column(
        Text, nullable=False, default="unclassified", server_default="unclassified"
    )
    # Device-registry pointer (RF_ARCHITECTURE_PLAN §2.3, alembic 0118).
    # References a device slug in the frontend `devices/` registry (mirrored
    # to the manifest's `devices` block). When set, the asset's anchors are a
    # materialised view of that device's template (one-click seed/refresh in
    # the PHY Editor) and `kind_id` is written through from the device's
    # behavioralKind. Nullable: legacy assets without a device keep authoring
    # kind_id + anchors by hand. The tracer still reads `anchors` directly, so
    # the read path is unchanged.
    device_id: Mapped[str | None] = mapped_column(Text)
    default_params: Mapped[JsonDict | None] = mapped_column(JSONB)
    wavelength_range_nm: Mapped[list[float] | None] = mapped_column(
        sa.ARRAY(sa.Float())
    )
    # RF passband [min, max] in MHz (alembic 0105). Symmetric with
    # wavelength_range_nm: optical kinds carry a wavelength range, RF kinds a
    # frequency range, both meaning "the component's working band".
    frequency_range_mhz: Mapped[list[float] | None] = mapped_column(
        sa.ARRAY(sa.Float())
    )
    # Phase 9.1 anchor-centric schema (alembic 0087). Replaces faces[] +
    # transitions[] as the primary physics anchor structure. Each anchor
    # carries position + explicit local axes (X = propagation/normal,
    # Y = transverse reference like fast axis / s-polarization basis,
    # Z = X × Y). The tracer reads this column once Phase 9.2 lands;
    # faces[] / transitions[] are retired in Phase 9.8.
    anchors: Mapped[JsonList] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    # Per-instance-tunable param keys (alembic 0113). The asset author marks
    # which default_params keys instances may override at runtime; the
    # SceneObject editor exposes only these, and their values live in
    # SceneObject.dynamic_sources. Replaces the retired per-binding
    # param_overrides (which let instances override ANY intrinsic coefficient).
    tunable_params: Mapped[JsonList] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    # Human-confirmed "frozen" flag (alembic 0112). True = reviewed +
    # complete; the PHY Editor renders the row read-only and the API rejects
    # any write that changes a field other than ``locked``. Also signals
    # automated agents not to modify the row (see CLAUDE.md "locked" rule).
    locked: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=sa.false()
    )

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
    # Classification slug (alembic 0089/0090). Pointer into the Kind registry.
    kind_id: Mapped[str | None] = mapped_column(Text)
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

    # Asset-Physics-Model v3 (alembic 0082). Component carries no kind in v3 —
    # physics lives on Asset3D — but exposes named ports for outer rays.
    catalog_id: Mapped[str | None] = mapped_column(Text)
    exposed_faces: Mapped[JsonList | None] = mapped_column(JSONB)

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


class Kind(Base):
    """Kind metadata catalog (alembic 0086).

    Moves per-kind metadata (defaultParams template, faceTemplate, etc.)
    from the code-only registry into a DB row that the UI can CRUD. The
    actual PhysicsOp implementations stay in code (see
    ``app.optical.registry`` / frontend ``src/optical/registry.ts``) and
    each Kind row references one of those by ``op_set_name``. New rows
    created via the UI reuse an existing op set — to introduce truly new
    physics behavior you still need a code change.

    See docs/asset-physics-model.md §6.
    """

    __tablename__ = "kinds"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    # Lookup key referenced by ``Asset3D.kind_id``. Unique. e.g.
    # "lens", "my_custom_lens".
    name: Mapped[str] = mapped_column(Text, nullable=False, unique=True, index=True)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    # Domains this kind participates in, e.g. ["optical", "rf"] for an AOM
    # (optical beam path + RF drive port). Non-empty; each element is one
    # of optical/rf/mechanical (CHECK-constrained). Replaces the old
    # single ``domain`` column (alembic 0092) so a part that is both
    # optical and RF surfaces under every matching PHY Editor filter.
    domains: Mapped[list[str]] = mapped_column(
        sa.ARRAY(Text), nullable=False, default=list, server_default="{}"
    )
    # Name of the code-side op set this kind dispatches through. For
    # built-in kinds, equal to ``name`` (e.g. "lens" → "lens"). For
    # user-created variants, points to an existing entry (e.g.
    # "my_custom_lens" → op_set_name = "lens" so it reuses the lens ops).
    op_set_name: Mapped[str] = mapped_column(Text, nullable=False)
    # Template defaults used when an Asset3D of this kind is created. The
    # Asset3D row stores its own copy in ``default_params`` so editing
    # this template later doesn't retroactively change existing assets.
    default_params: Mapped[JsonDict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    # Face template (anchors / required / optional). Same as
    # frontend physics-plugin "anchors" block. Pure metadata used by
    # the Asset3D editor's "create new asset" form.
    anchor_template: Mapped[JsonDict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    needs_aperture: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=sa.false()
    )
    wavelength_range_nm: Mapped[list[float] | None] = mapped_column(
        sa.ARRAY(sa.Float())
    )
    # RF passband [min, max] in MHz (alembic 0105). Symmetric with
    # wavelength_range_nm — the RF working band for rf-domain kinds.
    frequency_range_mhz: Mapped[list[float] | None] = mapped_column(
        sa.ARRAY(sa.Float())
    )
    description: Mapped[str | None] = mapped_column(Text)
    # Human-confirmed "frozen" flag (alembic 0112). See Asset3D.locked —
    # same semantics for a kind row (read-only editor + write-reject API).
    locked: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=sa.false()
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

    __table_args__ = (
        CheckConstraint(
            "domains <@ ARRAY['optical', 'rf', 'mechanical']::text[]",
            name="kind_domains_subset_check",
        ),
        CheckConstraint(
            "cardinality(domains) >= 1",
            name="kind_domains_nonempty_check",
        ),
    )


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

