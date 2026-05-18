from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, CheckConstraint, DateTime, Float, ForeignKey, Integer, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


JsonDict = dict[str, Any]
JsonList = list[Any]


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
        CheckConstraint(
            "(asset_3d_id IS NULL) != (sub_component_id IS NULL)",
            name="ck_component_bindings_one_target",
        ),
        CheckConstraint(
            "(target_kind = 'asset' AND asset_3d_id IS NOT NULL AND sub_component_id IS NULL) OR "
            "(target_kind = 'subcomponent' AND sub_component_id IS NOT NULL AND asset_3d_id IS NULL)",
            name="ck_component_bindings_target_kind_matches",
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
    # TimingProgram is no longer per-object (alembic 0045) — consumers
    # reference programs by id via JSONB refs in ``properties``.


class Connection(Base):
    __tablename__ = "connections"

    # Per-OBJECT cabling (alembic 0015) — two physical units of the same
    # component model each have their own RF / USB / coax connections.
    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    connection_type: Mapped[str] = mapped_column(Text, nullable=False)
    from_object_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("objects.id", ondelete="CASCADE"),
        nullable=False,
    )
    from_port: Mapped[str | None] = mapped_column(Text)
    to_object_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("objects.id", ondelete="CASCADE"),
        nullable=False,
    )
    to_port: Mapped[str | None] = mapped_column(Text)
    label: Mapped[str | None] = mapped_column(Text)
    properties: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class AssemblyRelation(Base):
    __tablename__ = "assembly_relations"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    relation_type: Mapped[str] = mapped_column(Text, nullable=False)
    object_a_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("objects.id", ondelete="CASCADE"), nullable=False
    )
    object_b_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("objects.id", ondelete="CASCADE"), nullable=False
    )
    selector_a: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    selector_b: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    offset_mm: Mapped[float | None] = mapped_column(Float)
    angle_deg: Mapped[float | None] = mapped_column(Float)
    tolerance_mm: Mapped[float] = mapped_column(Float, nullable=False, default=0.01, server_default="0.01")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    solved: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
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


class BeamPath(Base):
    __tablename__ = "beam_paths"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    wavelength_nm: Mapped[float | None] = mapped_column(Float)
    color: Mapped[str] = mapped_column(Text, nullable=False, default="#ff0000", server_default="#ff0000")
    # Per-OBJECT endpoints (alembic 0015). Nullable: a beam path may be
    # authored before either endpoint instance exists, and surviving an
    # endpoint deletion is more useful than cascading a path away.
    source_object_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("objects.id", ondelete="SET NULL")
    )
    target_object_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("objects.id", ondelete="SET NULL")
    )
    points: Mapped[JsonList] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    properties: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    visible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class DeviceState(Base):
    __tablename__ = "device_states"

    # Per-OBJECT runtime state (alembic 0015). Two physical units of the
    # same component model each have their own state — independent
    # power-on, lock state, temperature, etc.
    object_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("objects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    state: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    object: Mapped[SceneObject] = relationship(back_populates="device_state")


class Revision(Base):
    __tablename__ = "revisions"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    label: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    snapshot: Mapped[JsonDict] = mapped_column(JSONB, nullable=False)
    # V2 (alembic 0027): hash of canonical scene input. Lets us reuse a
    # previous SimulationRun's beam_segments when the current scene matches
    # this revision's hash. Nullable for legacy rows created pre-V2.
    scene_hash: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class SimulationRun(Base):
    """One solver execution. V2 (alembic 0027).

    Promotes the previously phantom ``beam_segments.simulation_run_id`` to
    a real referent. A run captures *which* solver computed *which* scene
    state at *what* time; the per-segment beam states live on
    ``BeamSegment`` rows pointing back here.

    See docs/optical-schema-v2.md §3 (V2 finalized).
    """

    __tablename__ = "simulation_runs"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    revision_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("revisions.id", ondelete="SET NULL"),
        nullable=True,
    )
    solver_version: Mapped[str] = mapped_column(
        Text, nullable=False, default="optical-solver-v1", server_default="optical-solver-v1"
    )
    # status ∈ {"queued","running","completed","failed","cancelled"}. The
    # original V2 set was {completed,running,failed}; alembic 0036 added
    # 'queued' and 'cancelled' for the multiphysics runner abstraction.
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="completed", server_default="completed"
    )
    # Hash of the canonical source-truth at the moment of solve. Indexed in
    # alembic 0027 so "is the current scene still the one this run computed?"
    # is one lookup.
    scene_hash: Mapped[str | None] = mapped_column(Text)
    settings: Mapped[JsonDict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    warnings: Mapped[JsonList] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Multi-physics extension (alembic 0036). See docs/MULTIPHYSICS_PLAN.md.
    # module: which solver kind ran this row. Phase A only implements
    # 'optics_seq'; the other three values are reserved for B/C/D.
    module: Mapped[str] = mapped_column(
        Text, nullable=False, default="optics_seq", server_default="optics_seq"
    )
    # runner_kind: where the solver ran. 'inproc' = inside the FastAPI
    # worker (Phase A/B), 'container' = backend Docker subprocess
    # (later Phase B), 'ssh_workstation' = lab workstation over SSH (Phase C).
    runner_kind: Mapped[str] = mapped_column(
        Text, nullable=False, default="inproc", server_default="inproc"
    )
    params: Mapped[JsonDict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    progress: Mapped[float | None] = mapped_column(Float)
    error_message: Mapped[str | None] = mapped_column(Text)
    # Small, UI-friendly summary (segment_count, key metrics). Big outputs
    # (full meshes, FDTD field dumps) go to result_blob_path.
    result_summary: Mapped[JsonDict | None] = mapped_column(JSONB)
    result_blob_path: Mapped[str | None] = mapped_column(Text)


class Circuit(Base):
    """Phase B (alembic 0037). One SPICE netlist + (Phase E) optional
    visual schematic graph. Optionally bound to a SceneObject when the
    user models a chassis/PCB in 3D and attaches its electrical schematic;
    most Phase B circuits are free-floating.

    The ``netlist`` text column is the source of truth for Phase B; the
    ``schematic`` JSONB column is a stub for Phase E (visual editor that
    compiles to the same netlist).
    """

    __tablename__ = "circuits"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    scene_object_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("objects.id", ondelete="SET NULL"),
        nullable=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    netlist: Mapped[str] = mapped_column(
        Text, nullable=False, default="", server_default=""
    )
    schematic: Mapped[JsonDict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Coil(Base):
    """Phase F+ Magnetics. One conductive coil contributing to a B-field.

    Pose semantics:
      - if ``scene_object_id`` is set, the coil's center + axis come from
        the linked SceneObject's xyz_mm + Euler rotation (axisBodyLocal
        rotated through the SceneObject's quaternion);
      - otherwise ``params.positionMm`` (default origin) places the coil
        directly in lab frame.

    Shape-specific geometry lives in ``params`` JSONB:
      circular_loop: {radiusMm, turns, axisBodyLocal: [x,y,z]}
      solenoid:      {radiusMm, lengthMm, turns, axisBodyLocal}
      polyline:      {pointsMm: [[x,y,z], ...]}
    """

    __tablename__ = "coils"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    scene_object_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("objects.id", ondelete="SET NULL"),
        nullable=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    shape: Mapped[str] = mapped_column(
        Text, nullable=False, default="circular_loop", server_default="circular_loop"
    )
    params: Mapped[JsonDict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    current_a: Mapped[float] = mapped_column(
        Float, nullable=False, default=1.0, server_default="1.0"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class MagneticsProblem(Base):
    """Phase F+ Magnetics. List of coils + eval region. Solver computes
    net B-field on the eval grid via magpylib (Biot-Savart) and writes
    the volume into SimulationRun.result_summary.field for the
    FieldViewer to render.
    """

    __tablename__ = "magnetics_problems"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    coil_ids: Mapped[JsonList] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    eval_region: Mapped[JsonDict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


# PulseBlasterChannel removed in alembic 0046. The (channel_index, invert)
# binding it carried is now stored inline on TimingProgram.


class RfChainNode(Base):
    """One element of an RF driver chain feeding an AOM/EOM (Phase RF.2).

    The chain is ordered by `position_in_chain` and terminates at
    `terminal_scene_object_id` — the lab device (AOM/EOM/rf_source) whose
    RF input this chain feeds. `gain_db` is the static knob used for the
    chain-summation UI (final dBm = source_dbm + Σ gain_db). Each node
    may optionally link to a SPICE Circuit or an EmProblem for detailed
    modelling — that's the same Linked schematics pattern as Phase F.1.
    """

    __tablename__ = "rf_chain_nodes"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    terminal_scene_object_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("objects.id", ondelete="CASCADE"),
        nullable=False,
    )
    position_in_chain: Mapped[int] = mapped_column(Integer, nullable=False)
    node_kind: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    gain_db: Mapped[float] = mapped_column(Float, nullable=False, default=0.0, server_default="0")
    kind_params: Mapped[JsonDict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    linked_circuit_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("circuits.id", ondelete="SET NULL"),
        nullable=True,
    )
    linked_em_problem_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("em_problems.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Mesh(Base):
    """Phase C (alembic 0038). One Gmsh mesh (.msh) for the EM module.

    Phase C MVP accepts user uploads only; Phase C+ wraps Gmsh CLI to
    auto-generate meshes from a SceneObject's STEP/STL.

    The actual mesh bytes live on disk at ``file_path`` — DB row only
    stores metadata. 100 MB cap enforced at the upload endpoint.
    """

    __tablename__ = "meshes"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    source_asset_3d_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("assets_3d.id", ondelete="SET NULL"),
        nullable=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    mesh_format: Mapped[str] = mapped_column(
        Text, nullable=False, default="gmsh", server_default="gmsh"
    )
    file_path: Mapped[str] = mapped_column(Text, nullable=False)
    element_count: Mapped[int | None] = mapped_column(Integer)
    max_size_mm: Mapped[float | None] = mapped_column(Float)
    file_size_bytes: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class EmProblem(Base):
    """Phase C (alembic 0038). One EM analysis problem definition.

    Bound to a SceneObject (the 3D thing being analyzed) and a Mesh
    (the discretization). ``ports`` lists the EM ports (each references
    an anchorBinding id + impedance + mode). The actual computed
    S-parameters / fields live on the matching SimulationRun row's
    result_summary (or result_blob_path for big field data).
    """

    __tablename__ = "em_problems"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    scene_object_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("objects.id", ondelete="SET NULL"),
        nullable=True,
    )
    mesh_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("meshes.id", ondelete="SET NULL"),
        nullable=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    ports: Mapped[JsonList] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    boundary_conditions: Mapped[JsonDict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    freq_range_ghz: Mapped[JsonDict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class PhysicsElement(Base):
    __tablename__ = "physics_elements"

    # Physics participation is per-OBJECT (instance), not per-Component
    # (template). Two SceneObjects of the same Component (e.g. two BB1
    # mirrors) each get their own PhysicsElement row with independent
    # kind_params, ports, and chain participation. See alembic 0014.
    # Renamed from OpticalElement in alembic 0042 once the KIND_REGISTRY
    # grew to cover RF (rf_source, horn_antenna) and other non-optical
    # physics domains; the table holds whatever PHY kind the object plays.
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
        unique=True,
    )
    element_kind: Mapped[str] = mapped_column(Text, nullable=False)
    wavelength_range_nm: Mapped[JsonList] = mapped_column(
        JSONB, nullable=False, default=lambda: [400.0, 1100.0], server_default="[400, 1100]"
    )
    input_ports: Mapped[JsonList] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    output_ports: Mapped[JsonList] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    kind_params: Mapped[JsonDict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    # Phase 4 (alembic 0049): three-layer storage split. `kind_params` stays
    # as the merged source-of-truth until Phase 5 retires it; new code should
    # read intrinsic + state columns directly. The CRUD layer keeps all
    # three in sync on write (see ``app.crud.set_physics_element_params``).
    #
    # `intrinsic_params` carries spec-sheet values (acoustic velocity,
    # refractive index, amplifier gain, …) — rendered read-only in the UI.
    # `state_params` carries operating-state knobs (Bragg tilt angle,
    # diffraction order, AD9959 freq/amp, …) — user-editable.
    intrinsic_params: Mapped[JsonDict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    state_params: Mapped[JsonDict] = mapped_column(
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

    # Note: relationship to Component goes via the SceneObject (object → component).
    # No direct PhysicsElement.component relationship anymore — the row is
    # keyed by object, components are reachable via the object.
    object: Mapped[SceneObject] = relationship(back_populates="physics_element")


class OpticalLink(Base):
    __tablename__ = "optical_links"
    __table_args__ = (
        UniqueConstraint(
            "from_object_id",
            "from_port",
            "to_object_id",
            "to_port",
            name="uq_optical_link_object_endpoints",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    from_object_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("objects.id", ondelete="CASCADE"),
        nullable=False,
    )
    from_port: Mapped[str] = mapped_column(Text, nullable=False)
    to_object_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("objects.id", ondelete="CASCADE"),
        nullable=False,
    )
    to_port: Mapped[str] = mapped_column(Text, nullable=False)
    free_space_mm: Mapped[float] = mapped_column(Float, nullable=False, default=0.0, server_default="0")
    properties: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class RfLink(Base):
    """RF signal graph edge between two SceneObject ports (alembic 0044).

    Parallels ``OpticalLink`` so RF networks containing switches,
    splitters, combiners, directional couplers and mixers can be
    modelled as a proper directed graph rather than the linear
    ``rf_chain_nodes`` chain. ``rf_chain_nodes`` is being demoted to a
    derived readout cache in a later phase.

    ``electrical_length_mm`` replaces ``OpticalLink.free_space_mm``:
    it is the signal path length through the wired connection (0 for
    a direct connector mating, cable length for a patch cable).
    Frequency-domain edge state (impedanceOhm, lossDb, delayNs,
    cableObjectId, etc.) lives on ``properties`` until formalised.
    """

    __tablename__ = "rf_links"
    __table_args__ = (
        UniqueConstraint(
            "from_object_id",
            "from_port",
            "to_object_id",
            "to_port",
            name="uq_rf_link_object_endpoints",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    from_object_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("objects.id", ondelete="CASCADE"),
        nullable=False,
    )
    from_port: Mapped[str] = mapped_column(Text, nullable=False)
    to_object_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("objects.id", ondelete="CASCADE"),
        nullable=False,
    )
    to_port: Mapped[str] = mapped_column(Text, nullable=False)
    electrical_length_mm: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0, server_default="0"
    )
    properties: Mapped[JsonDict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


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


class BeamSegment(Base):
    __tablename__ = "beam_segments"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    # V2 (alembic 0027): FK to SimulationRun. Pre-V2 this column existed but
    # held in-memory uuid4()s with no referent; the migration NULLs them and
    # adds the constraint.
    simulation_run_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("simulation_runs.id", ondelete="SET NULL"),
        nullable=True,
    )
    optical_link_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("optical_links.id", ondelete="CASCADE"),
        nullable=False,
    )
    sequence_t_ms: Mapped[float | None] = mapped_column(Float)
    beam_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    spectrum: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    spatial_x: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    spatial_y: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    transverse_mode: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    polarization_jones: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    power_mw: Mapped[float] = mapped_column(Float, nullable=False, default=0.0, server_default="0")
    propagation_axis_local: Mapped[JsonList] = mapped_column(
        JSONB, nullable=False, default=lambda: [0.0, 0.0, 1.0], server_default="[0, 0, 1]"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class TimingProgram(Base):
    """A reusable schedule of HIGH intervals (alembic 0045, slimmed by 0051).

    Identified by its own ``id``. Each PPG SceneObject owns exactly one
    TimingProgram via ``physics_elements.kind_params.timingProgramId``
    (1:1, cascade-deleted with the PPG). ``intervals`` is a JSONB list of
    ``{spinCoreStartNs, spinCoreEndNs}`` HIGH windows; the rest of the
    timeline is implicit LOW.

    History note: this used to also carry ``kind`` (TTL / Trigger),
    ``channel_index`` (PB hardware binding 0..23) and ``invert`` (active-
    low gate). Alembic 0051 dropped all three — the new model is "every
    PPG emits the same RFout HIGH/LOW gate; channel ordering is
    positional from the PPG list at solve time; there is no 24-channel
    cap because the channel index is no longer stored".
    """

    __tablename__ = "timing_programs"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    name: Mapped[str | None] = mapped_column(Text)
    intervals: Mapped[JsonList] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
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


class AppSetting(Base):
    """Shared app-wide singleton settings, keyed by string.

    Lab-global, not per-user — every browser session reads the same row.
    First key is ``room_dimensions`` (Initial Setup), stored as a JSONB
    object ``{"widthMm": ..., "depthMm": ..., "heightMm": ...}``. New keys
    can be added without a migration. See alembic 0043.
    """

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[JsonDict] = mapped_column(JSONB, nullable=False)
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


class AgentSession(Base):
    """One AI binding conversation (alembic 0057).

    State machine::

        running ──(commit)──▶ committed
                ──(cancel)──▶ cancelled
                ──(timeout)─▶ abandoned

    Terminal states are immutable. Sweeper task picks up rows with
    status='running' AND last_heartbeat_at older than
    heartbeat_timeout_sec and transitions them to 'abandoned' +
    reverse-replays session_mutations to roll back any drafts.
    """

    __tablename__ = "agent_sessions"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    instruction: Mapped[str] = mapped_column(
        Text, nullable=False, default="", server_default=""
    )
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="running", server_default="running"
    )
    last_heartbeat_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    heartbeat_timeout_sec: Mapped[int] = mapped_column(
        Integer, nullable=False, default=300, server_default="300"
    )
    committed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancellation_reason: Mapped[str | None] = mapped_column(Text)
    # Anthropic SDK messages[] persisted across turns (alembic 0058).
    # NULL means "no turns yet". Loaded by agent_orchestrator on every
    # turn so a restart / browser refresh resumes mid-conversation.
    messages_json: Mapped[JsonList | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    mutations: Mapped[list[SessionMutation]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )


class SessionMutation(Base):
    """One write the agent made via its tool layer (alembic 0057).

    v1 only logs op='create' (Q3 invariant: agent can't update or
    delete). The before/after columns are shaped for future
    update/delete support without another migration.

    ``undone_at`` is set when the user clicks "undo last step" in the
    UI — the row is preserved (not deleted) so the audit trail shows
    every attempt the user made before settling on the final shape.
    Undone mutations are skipped at commit time and at rollback time.
    """

    __tablename__ = "session_mutations"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    session_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("agent_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    op: Mapped[str] = mapped_column(Text, nullable=False)
    entity_type: Mapped[str] = mapped_column(Text, nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    before: Mapped[JsonDict | None] = mapped_column(JSONB)
    after: Mapped[JsonDict | None] = mapped_column(JSONB)
    undone_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    session: Mapped[AgentSession] = relationship(back_populates="mutations")


class ApprovalEvent(Base):
    """Append-only audit log (alembic 0057).

    Records every approve, unlock, modify_blocked attempt, and session
    rollback. Never UPDATEd or DELETEd — the audit trail is the only
    source of truth for "what did the AI agent try to do, and what got
    approved by a human".

    Note: the Python attribute is ``event_metadata`` because
    ``DeclarativeBase.metadata`` is reserved; the underlying SQL column
    is still named ``metadata``.
    """

    __tablename__ = "approval_events"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    entity_type: Mapped[str | None] = mapped_column(Text)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(PG_UUID(as_uuid=True))
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("agent_sessions.id", ondelete="SET NULL"),
    )
    event_metadata: Mapped[JsonDict] = mapped_column(
        "metadata", JSONB, nullable=False, default=dict, server_default="{}"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
