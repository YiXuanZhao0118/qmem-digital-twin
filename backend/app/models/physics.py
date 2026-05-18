"""Layer 2 Physics-Role: per-SceneObject physics element + device state."""

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

