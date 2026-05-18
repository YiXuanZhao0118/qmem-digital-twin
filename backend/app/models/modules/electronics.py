"""Electronics module: SPICE circuits + Touchstone networks."""

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

