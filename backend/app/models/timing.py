"""Side: PPG timing programs (HIGH-interval schedules)."""

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

