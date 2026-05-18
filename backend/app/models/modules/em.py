"""EM module: mesh + Palace problem definitions."""

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

