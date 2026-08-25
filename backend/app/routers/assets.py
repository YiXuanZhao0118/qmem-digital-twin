from __future__ import annotations

import uuid
from pathlib import Path
from shutil import copy2

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.config import settings
from app.db import get_session
from app.lock_guard import assert_delete_allowed, assert_update_allowed
from app.models import Asset3D, Component
from app.services.asset_converter import (
    SUPPORTED_ASSET_EXTENSIONS,
    VIEWER_ASSET_EXTENSIONS,
    convert_cad_source_to_stl,
    subdir_for_ext,
    upload_rejection_message,
)


router = APIRouter()


def safe_upload_name(filename: str) -> str:
    stem = Path(filename).stem.strip().lower()
    suffix = Path(filename).suffix.lower()
    safe_stem = "".join(char if char.isalnum() or char in {"-", "_"} else "_" for char in stem)
    return f"{uuid.uuid4()}_{safe_stem or 'asset'}{suffix}"


def asset_component_properties(source_filename: str | None, suffix: str) -> dict[str, object]:
    asset_type = suffix.lstrip(".")
    viewer_ready = suffix in VIEWER_ASSET_EXTENSIONS
    return {
        "geometry": "uploaded_asset" if viewer_ready else "uploaded_cad_asset",
        "sourceFilename": source_filename,
        "uploadedAssetType": asset_type,
        "viewerReady": viewer_ready,
        "conversionStatus": "ready" if viewer_ready else "cad_source_only",
    }


async def create_component_from_asset(
    session: AsyncSession,
    *,
    name: str,
    kind_id: str,
    brand: str | None,
    model: str | None,
    asset_type: str,
    file_path: str,
    source: str,
    source_filename: str | None,
    unit: str,
    scale_factor: float,
) -> Component:
    asset = Asset3D(
        name=f"{name}_asset",
        asset_type=asset_type,
        file_path=file_path,
        source=source,
        source_url=None,
        unit=unit,
        scale_factor=scale_factor,
    )
    session.add(asset)
    await session.flush()

    component = Component(
        name=name,
        kind_id=kind_id,
        brand=brand,
        model=model,
        asset_3d_id=asset.id,
        properties=asset_component_properties(source_filename, f".{asset_type}"),
    )
    session.add(component)
    await session.commit()
    await session.refresh(component)
    return component


@router.get("", response_model=list[schemas.Asset3DOut])
async def list_assets(session: AsyncSession = Depends(get_session)) -> list[Asset3D]:
    # Hide AI-binding-session drafts (alembic 0057). Only the owning agent
    # session sees its drafts; everything else only sees 'active'.
    result = await session.scalars(
        select(Asset3D).where(Asset3D.status == "active")
    )
    return list(result.all())


def _anchors_camel(anchors: list[schemas.AssetAnchor]) -> list[dict]:
    """Serialise typed anchors with their camelCase aliases.

    ``model_dump()`` (no ``by_alias``) emits the snake_case field names, but
    the anchor ray tracer's scene loader reads the raw ``anchors`` JSON column
    and only recognises the camelCase aliases (``axisXBodyLocal`` /
    ``positionMmBodyLocal`` / …) — a snake_case blob makes it return None and
    the asset silently drops out of the trace. See
    ``db_scene_loader.anchor_asset_to_snapshot``.
    """
    return [a.model_dump(by_alias=True) for a in anchors]


@router.post("", response_model=schemas.Asset3DOut, status_code=status.HTTP_201_CREATED)
async def create_asset(
    payload: schemas.Asset3DCreate, session: AsyncSession = Depends(get_session)
) -> Asset3D:
    # `file_version` is a COMPUTED field on Asset3DBase (mtime of file_path),
    # and pydantic v2 emits computed fields from `model_dump()` — but it is
    # derived, not a column, so `Asset3D(**data)` raised
    # "'file_version' is an invalid keyword argument". Every call to this
    # route 500'd; drop it here rather than moving the property, since the
    # OUT schema legitimately serves it to clients.
    data = payload.model_dump(exclude={"file_version"})
    data["anchors"] = _anchors_camel(payload.anchors)
    asset = Asset3D(**data)
    session.add(asset)
    await session.commit()
    await session.refresh(asset)
    return asset


@router.post("/upload-component", response_model=schemas.ComponentOut, status_code=status.HTTP_201_CREATED)
async def upload_component_asset(
    file: UploadFile = File(...),
    name: str = Form(...),
    kind_id: str = Form("custom_3d"),
    brand: str | None = Form(None),
    model: str | None = Form(None),
    unit: str = Form("mm"),
    scale_factor: float = Form(1.0),
    session: AsyncSession = Depends(get_session),
) -> Component:
    suffix = Path(file.filename or "").suffix.lower()
    rejection = upload_rejection_message(suffix)
    if rejection:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=rejection)
    if suffix not in SUPPORTED_ASSET_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Upload a GLB, GLTF, OBJ, STL, STEP, or STP file.",
        )
    if unit not in {"mm", "m"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unit must be mm or m.")

    # alembic 0063 layout: viewer-ready exts dropped under
    # files/<ext>/, CAD sources (STEP/STP/SLDPRT/DXF) under
    # files/cad_sources/. See asset_converter.subdir_for_ext.
    subdir = subdir_for_ext(suffix)
    upload_dir = settings.asset_root / "files" / subdir
    upload_dir.mkdir(parents=True, exist_ok=True)
    filename = safe_upload_name(file.filename or f"{name}{suffix}")
    target = upload_dir / filename
    content = await file.read()
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is empty.")
    target.write_bytes(content)

    source_path = f"files/{subdir}/{filename}"
    conversion = convert_cad_source_to_stl(
        source_path,
        output_stem=name,
    ) if suffix in {".step", ".stp"} else None
    viewer_path = conversion.viewer_relative_path if conversion and conversion.ok else source_path
    viewer_type = conversion.viewer_asset_type if conversion and conversion.ok else suffix.lstrip(".")

    return await create_component_from_asset(
        session,
        name=name,
        kind_id=kind_id,
        brand=brand,
        model=model,
        asset_type=viewer_type,
        file_path=viewer_path,
        source="upload",
        unit=unit,
        scale_factor=scale_factor,
        source_filename=file.filename,
    )


@router.post("/import-local-component", response_model=schemas.ComponentOut, status_code=status.HTTP_201_CREATED)
async def import_local_component_asset(
    payload: schemas.LocalAssetImport,
    session: AsyncSession = Depends(get_session),
) -> Component:
    source_path = Path(payload.source_path).expanduser()
    if not source_path.is_file():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Local file does not exist.")

    suffix = source_path.suffix.lower()
    rejection = upload_rejection_message(suffix)
    if rejection:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=rejection)
    if suffix not in SUPPORTED_ASSET_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Import a GLB, GLTF, OBJ, STL, STEP, or STP file.",
        )

    subdir = subdir_for_ext(suffix)
    upload_dir = settings.asset_root / "files" / subdir
    upload_dir.mkdir(parents=True, exist_ok=True)
    filename = safe_upload_name(source_path.name)
    target = upload_dir / filename
    copy2(source_path, target)

    name = payload.name or source_path.stem
    return await create_component_from_asset(
        session,
        name=name,
        kind_id=payload.kind_id,
        brand=payload.brand,
        model=payload.model,
        asset_type=suffix.lstrip("."),
        file_path=f"files/{subdir}/{filename}",
        source="local_path",
        unit=payload.unit,
        scale_factor=payload.scale_factor,
        source_filename=str(source_path),
    )


@router.get("/{asset_id}", response_model=schemas.Asset3DOut)
async def get_asset(asset_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> Asset3D:
    return await crud.get_or_404(session, Asset3D, asset_id)


@router.put("/{asset_id}", response_model=schemas.Asset3DOut)
async def update_asset(
    asset_id: uuid.UUID,
    payload: schemas.Asset3DUpdate,
    session: AsyncSession = Depends(get_session),
) -> Asset3D:
    asset = await crud.get_or_404(session, Asset3D, asset_id)
    updates = payload.model_dump(exclude_unset=True)
    assert_update_allowed(
        locked=asset.locked, changed_fields=updates.keys(), label=f"Asset3D {asset.name!r}"
    )
    if "anchors" in updates and payload.anchors is not None:
        updates["anchors"] = _anchors_camel(payload.anchors)
    crud.apply_updates(asset, updates)
    await session.commit()
    await session.refresh(asset)
    return asset


@router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_asset(asset_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> Response:
    asset = await crud.get_or_404(session, Asset3D, asset_id)
    assert_delete_allowed(locked=asset.locked, label=f"Asset3D {asset.name!r}")
    await session.delete(asset)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
