"""Layer 3 Interaction: optical / RF links, cabling, mechanical relations, authored beam paths."""

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

