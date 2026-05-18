"""Magnetics module: coils + Biot-Savart problem definitions."""

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

