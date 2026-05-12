"""Meshes CRUD + upload router — Phase C.1.

Phase C MVP: user uploads a Gmsh `.msh` file, backend stashes the bytes
on disk under ``settings.mesh_storage_dir`` and creates a row. Phase C+
will wrap Gmsh CLI to auto-generate from a SceneObject's STEP/STL.

Upload cap = ``settings.mesh_max_bytes`` (default 100 MB).
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_session
from app.models import Mesh
from app.schemas import MeshOut


router = APIRouter()


@router.get("", response_model=list[MeshOut])
async def list_meshes(
    session: AsyncSession = Depends(get_session),
    limit: int = 200,
) -> list[Mesh]:
    stmt = select(Mesh).order_by(Mesh.created_at.desc()).limit(limit)
    return list((await session.scalars(stmt)).all())


@router.get("/{mesh_id}", response_model=MeshOut)
async def get_mesh(
    mesh_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> Mesh:
    mesh = await session.get(Mesh, mesh_id)
    if mesh is None:
        raise HTTPException(status_code=404, detail="Mesh not found")
    return mesh


@router.post("", response_model=MeshOut, status_code=status.HTTP_201_CREATED)
async def upload_mesh(
    file: UploadFile = File(...),
    name: str | None = Form(default=None),
    source_asset_3d_id: str | None = Form(default=None),
    session: AsyncSession = Depends(get_session),
) -> Mesh:
    """Multipart upload of a Gmsh `.msh` file.

    Caps the read at ``settings.mesh_max_bytes + 1`` so we can detect
    over-cap uploads without holding the whole oversize blob in RAM.
    """
    if not file.filename or not file.filename.lower().endswith(".msh"):
        raise HTTPException(
            status_code=400,
            detail="filename required and must end in .msh (Gmsh format)",
        )

    cap = settings.mesh_max_bytes
    content = await file.read(cap + 1)
    if len(content) > cap:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"mesh exceeds {cap} bytes",
        )

    storage_dir = settings.mesh_storage_dir
    storage_dir.mkdir(parents=True, exist_ok=True)
    safe_name = re.sub(r"[^\w.-]", "_", Path(file.filename).name)
    mesh_uuid = uuid.uuid4()
    on_disk = storage_dir / f"{mesh_uuid}__{safe_name}"
    on_disk.write_bytes(content)

    asset_uuid: uuid.UUID | None = None
    if source_asset_3d_id:
        try:
            asset_uuid = uuid.UUID(source_asset_3d_id)
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail=f"invalid source_asset_3d_id: {exc}"
            ) from exc

    element_count, max_size_mm = _try_parse_msh_metadata(content)

    mesh = Mesh(
        id=mesh_uuid,
        name=name or safe_name,
        mesh_format="gmsh",
        file_path=str(on_disk),
        source_asset_3d_id=asset_uuid,
        element_count=element_count,
        max_size_mm=max_size_mm,
        file_size_bytes=len(content),
    )
    session.add(mesh)
    await session.commit()
    await session.refresh(mesh)
    return mesh


@router.delete("/{mesh_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_mesh(
    mesh_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> None:
    mesh = await session.get(Mesh, mesh_id)
    if mesh is None:
        raise HTTPException(status_code=404, detail="Mesh not found")
    # Best-effort delete file; row is removed regardless.
    try:
        Path(mesh.file_path).unlink(missing_ok=True)
    except OSError:
        pass
    await session.delete(mesh)
    await session.commit()


def _try_parse_msh_metadata(content: bytes) -> tuple[int | None, float | None]:
    """Best-effort: extract element count from a Gmsh ASCII .msh header.

    Returns ``(element_count, max_size_mm)``. ``max_size_mm`` is left
    None for now — computing it from raw nodes is overkill for Phase C.1
    (Gmsh CLI ingest in Phase C.6 can fill it in).
    """
    try:
        text_head = content[: min(len(content), 64 * 1024)].decode(
            "utf-8", errors="replace"
        )
    except Exception:
        return (None, None)

    # Gmsh v2 / v4 ASCII format: "$Elements\n<count>\n..."
    m = re.search(r"\$Elements\s*\n\s*(\d+)", text_head)
    if m:
        try:
            return (int(m.group(1)), None)
        except ValueError:
            pass
    return (None, None)
