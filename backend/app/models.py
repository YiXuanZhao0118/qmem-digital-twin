from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, Text, UniqueConstraint, func, text
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

    asset: Mapped[Asset3D | None] = relationship(back_populates="components")
    objects: Mapped[list[SceneObject]] = relationship(
        back_populates="component",
        cascade="all, delete-orphan",
        foreign_keys="SceneObject.component_id",
    )
    # DeviceState, TimingProgram, OpticalElement are all per-OBJECT now
    # (alembic 0014 + 0015). Reach them via SceneObject.{device_state,
    # timing_program, optical_element}. Component is purely a catalog row.


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
    optical_element: Mapped[OpticalElement | None] = relationship(
        back_populates="object", cascade="all, delete-orphan",
        primaryjoin="SceneObject.id == OpticalElement.object_id",
    )
    device_state: Mapped[DeviceState | None] = relationship(
        back_populates="object", cascade="all, delete-orphan"
    )
    timing_program: Mapped[TimingProgram | None] = relationship(
        back_populates="object", cascade="all, delete-orphan"
    )


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


class PulseBlasterChannel(Base):
    """One TTL output channel of the lab's SpinCore PulseBlaster.

    Each channel index (0..N-1; 24 on PB24/ESR, up to 32 on PRO) maps
    optionally to a Component — meaning "PulseBlaster channel N is the
    physical TTL line wired to that Component's gate / trigger input."

    The actual gating sequence ("at t=10us turn this device on") still
    lives in TimingProgram (per-Component). This table is just the
    component <-> physical wire binding that lets the dispatch layer
    know which TimingProgram block lives on which output channel.

    Phase F+ MVP single PulseBlaster, multi-PulseBlaster setups can
    add a parent ``pulse_blasters`` table later.
    """

    __tablename__ = "pulse_blaster_channels"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    channel_index: Mapped[int] = mapped_column(Integer, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    target_component_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("components.id", ondelete="SET NULL"),
        nullable=True,
    )
    invert: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
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


class OpticalElement(Base):
    __tablename__ = "optical_elements"

    # Optical participation is per-OBJECT (instance), not per-Component
    # (template). Two SceneObjects of the same Component (e.g. two BB1
    # mirrors) each get their own OpticalElement row with independent
    # kind_params, ports, and chain participation. See alembic 0014.
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
    # No direct OpticalElement.component relationship anymore — the row is
    # keyed by object, components are reachable via the object.
    object: Mapped[SceneObject] = relationship(back_populates="optical_element")


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
    """A per-OBJECT timed sequence program (alembic 0015).

    Owned by exactly one SceneObject (1:1). Two physical units of the same
    Component model each have their own program — they can run different
    sequences on different days. Only objects whose component has an
    appropriate physics capability are expected to have a TimingProgram
    (laser_source / tapered_amplifier always; AOM/EOM only when an RF
    driver is wired up). The DB enforces 1:1 — UI gates creation by the
    object's element kind / RF wiring.
    """

    __tablename__ = "timing_programs"

    object_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("objects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False, default="program", server_default="program")
    spin_core_start: Mapped[str] = mapped_column(
        Text, nullable=False, default="WAIT", server_default="WAIT"
    )  # "WAIT" | "CONTINUE"
    duration_ns: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0, server_default="0"
    )
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

    object: Mapped[SceneObject] = relationship(back_populates="timing_program")
    blocks: Mapped[list[TimingBlock]] = relationship(
        back_populates="program",
        cascade="all, delete-orphan",
        order_by="TimingBlock.t_start_ns",
    )


class TimingBlock(Base):
    """A single block on the component's timeline.

    Each block describes the component's action over `[t_start_ns, t_end_ns)`.
    `waveform_kind` chooses how `params` is interpreted:

    - "const":      params={"value": float}    (e.g. power=0.7)
    - "linear_ramp": params={"start": float, "end": float}
    - "arbitrary":  params={"samples": [float], "dt_ns": float}  (RF-bearing AOM/EOM only)
    - "gate_on":    params={}  (boolean ON for the duration; AOM/EOM no-RF)
    - "gate_off":   params={}  (boolean OFF — usually only emitted from solver merging)

    Times are float ns; the UI snaps inputs to 10 ns and the API validator
    rounds on write.
    """

    __tablename__ = "timing_blocks"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    program_object_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("timing_programs.object_id", ondelete="CASCADE"),
        nullable=False,
    )
    label: Mapped[str | None] = mapped_column(Text)
    t_start_ns: Mapped[float] = mapped_column(Float, nullable=False)
    t_end_ns: Mapped[float] = mapped_column(Float, nullable=False)
    waveform_kind: Mapped[str] = mapped_column(Text, nullable=False, default="const", server_default="const")
    params: Mapped[JsonDict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    program: Mapped[TimingProgram] = relationship(back_populates="blocks")
