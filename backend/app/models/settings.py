"""Side: shared app-wide singleton settings."""

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

