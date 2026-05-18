"""Layer 4 Simulation: snapshots + solver runs + beam segment outputs."""

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

