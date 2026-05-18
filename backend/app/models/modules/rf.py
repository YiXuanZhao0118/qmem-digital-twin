"""RF module: RF chain nodes feeding AOMs / EOMs."""

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

