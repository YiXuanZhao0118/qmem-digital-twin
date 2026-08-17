"""V3 catalog API - list / fetch Asset3D / Component records with the
new physics fields. Mounted at `/api/v3/` to avoid colliding with
existing `/api/assets3d/`, `/api/components/` routes.

Endpoints:
  GET  /v3/assets3d                          - list
  GET  /v3/assets3d/{catalog_id}             - fetch one
  GET  /v3/components                        - list
  GET  /v3/components/{catalog_id}           - fetch one
"""

from __future__ import annotations

import hashlib
import json
import uuid as _uuid
from typing import Optional

from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.kinds_manifest import device_by_id
from app.lock_guard import assert_delete_allowed, assert_update_allowed
from app.services.device_seed import materialize_device_anchors
from app.models import (
    Asset3D, AssetLod, Component, ComponentBinding, ObjectBinding, SceneObject,
)
from app.schemas import CamelModel
from app.schemas_v3 import (
    Asset3DUsageOut, Asset3DV3Out, Asset3DV3Update,
    ComponentV3Out,
)
from app.config import settings
from app.routers.assets import safe_upload_name
from app.services.asset_converter import (
    CAD_SOURCE_EXTENSIONS,
    SUPPORTED_ASSET_EXTENSIONS,
    VIEWER_ASSET_EXTENSIONS,
    convert_cad_source_to_stl,
    subdir_for_ext,
    upload_rejection_message,
)


router = APIRouter(prefix="/v3", tags=["v3-catalog"])


async def _fetch_asset_by_key(session: AsyncSession, key: str) -> Optional[Asset3D]:
    """Resolve an Asset3D from its URL path segment, accepting either the
    catalog_id slug (the normal case for seeded rows) or the row UUID
    (used by the UI for legacy mechanical Asset3Ds whose catalog_id is
    still NULL). Tries catalog_id first; on miss, attempts a UUID parse
    and looks up by id. Returns None if neither matches."""
    row = (await session.execute(
        select(Asset3D).where(Asset3D.catalog_id == key)
    )).scalar_one_or_none()
    if row is not None:
        return row
    try:
        uid = _uuid.UUID(key)
    except (ValueError, AttributeError):
        return None
    return (await session.execute(
        select(Asset3D).where(Asset3D.id == uid)
    )).scalar_one_or_none()


def _viewer_hints_digest(properties: dict | None) -> str | None:
    """Stable digest of an asset's ``viewerHints``, or None when it has none.

    LOD tiers are baked from the POST-hint geometry, and viewerHints centroid
    keys are computed on the full-resolution mesh — decimation moves every
    centroid, so a hints edit silently invalidates the tiers. Storing this
    digest with each tier is what lets the asset PUT detect that.
    """
    hints = (properties or {}).get("viewerHints")
    if not hints:
        return None
    payload = json.dumps(hints, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


async def _drop_asset_lods(session: AsyncSession, row: Asset3D) -> int:
    """Delete every LOD tier of an asset and unlink its tier files.

    Called whenever the source mesh or the viewerHints it was baked from
    change: a tier that outlives its source renders geometry that no longer
    matches the asset. Level 0 is skipped for file removal — it points at
    ``Asset3D.file_path``, which the caller owns.
    """
    tiers = (await session.execute(
        select(AssetLod).where(AssetLod.asset_id == row.id)
    )).scalars().all()
    for tier in tiers:
        if tier.level > 0:
            (settings.asset_root / tier.file_path).unlink(missing_ok=True)
        await session.delete(tier)
    return len(tiers)


async def _asset_usage(session: AsyncSession, row: Asset3D) -> tuple[int, int]:
    """Count what depends on an Asset3D: (component_count, object_count).

    A Component resolves to the asset via the legacy direct FK
    (``Component.asset_3d_id``) or via a ``ComponentBinding`` row. A scene
    object counts as in-use when its component resolves to the asset, or
    when it carries an explicit per-object ``asset_3d_id_override``.
    """
    comp_ids = (
        select(Component.id)
        .where(Component.asset_3d_id == row.id, Component.archived_at.is_(None))
        .union(
            select(ComponentBinding.component_id)
            .where(ComponentBinding.asset_3d_id == row.id)
        )
        .subquery()
    )
    component_count = await session.scalar(
        select(func.count()).select_from(comp_ids)
    )
    object_count = await session.scalar(
        select(func.count(func.distinct(SceneObject.id))).where(
            or_(
                SceneObject.component_id.in_(select(comp_ids.c.id)),
                SceneObject.id.in_(
                    select(ObjectBinding.object_id).where(
                        ObjectBinding.asset_3d_id_override == row.id
                    )
                ),
            )
        )
    )
    return int(component_count or 0), int(object_count or 0)


# ---------------------------------------------------------------------------
# Asset3D
# ---------------------------------------------------------------------------

@router.get("/assets3d", response_model=list[Asset3DV3Out])
async def list_assets3d(
    kind_id: str | None = None,
    has_v3: bool = True,
    session: AsyncSession = Depends(get_session),
) -> list[Asset3D]:
    """List Asset3D rows. `has_v3=True` (default) filters to rows with a
    populated `catalog_id` (the v3-seeded subset). `kind_id` narrows by
    classification slug."""
    stmt = select(Asset3D)
    if has_v3:
        stmt = stmt.where(Asset3D.catalog_id.is_not(None))
    if kind_id:
        stmt = stmt.where(Asset3D.kind_id == kind_id)
    stmt = stmt.order_by(Asset3D.catalog_id)
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


@router.post(
    "/assets3d/upload",
    response_model=Asset3DV3Out,
    status_code=status.HTTP_201_CREATED,
)
async def upload_asset3d_v3(
    file: UploadFile = File(...),
    catalog_id: str = Form(...),
    name: str = Form(...),
    kind_id: str | None = Form(None),
    domain: str | None = Form(None),
    unit: str = Form("mm"),
    scale_factor: float = Form(1.0),
    precision_preset: str = Form("standard"),
    preserve_colors: bool = Form(True),
    session: AsyncSession = Depends(get_session),
) -> Asset3D:
    """Upload a viewer-ready or STEP geometry file and create a v3 Asset3D row.

    Viewer-ready formats (GLB/GLTF/OBJ/STL) render immediately. STEP/STP are
    tessellated to STL server-side via FreeCAD (``convert_cad_source_to_stl``)
    because WebGL can't render B-rep directly; colour is lost on that path.
    DXF (2D drawing) and SLDPRT (proprietary) are rejected up front — see
    ``upload_rejection_message``.

    Asset-layer M2: once the browser occt-import-js pipeline lands, STEP will
    arrive pre-converted to coloured GLB and this route will do no server-side
    CAD conversion. Until then the FreeCAD path above is live.
    """
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
    if domain is not None and domain not in {"optical", "rf", "mechanical"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Domain must be optical, rf, or mechanical.")
    if precision_preset not in {"preview", "standard", "high"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Precision must be preview, standard, or high.")

    subdir = subdir_for_ext(suffix)
    upload_dir = settings.asset_root / "files" / subdir
    upload_dir.mkdir(parents=True, exist_ok=True)
    filename = safe_upload_name(file.filename or f"{catalog_id}{suffix}")
    target = upload_dir / filename
    content = await file.read()
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is empty.")
    target.write_bytes(content)

    relative_path = f"files/{subdir}/{filename}"
    asset_type = suffix.lstrip(".")
    conversion = convert_cad_source_to_stl(
        relative_path,
        output_stem=catalog_id,
        precision_preset=precision_preset,
    ) if suffix in {".step", ".stp"} else None
    viewer_path = conversion.viewer_relative_path if conversion and conversion.ok else relative_path
    viewer_asset_type = conversion.viewer_asset_type if conversion and conversion.ok else asset_type
    viewer_ready = suffix in VIEWER_ASSET_EXTENSIONS or bool(conversion and conversion.ok)
    cad_source = suffix in CAD_SOURCE_EXTENSIONS
    properties: dict[str, object] = {
        "sourceFilename": file.filename,
        "uploadedAssetType": asset_type,
        "viewerReady": viewer_ready,
        "conversionStatus": "ready" if viewer_ready else "cad_source_only",
        "conversionMessage": conversion.message if conversion else None,
        "colorImportStatus": "from_file" if suffix in {".glb", ".gltf"} else ("pending_conversion" if cad_source else "not_available"),
        "cadImport": {
            "sourcePath": relative_path,
            "sourceFormat": asset_type,
            "viewerPath": viewer_path if viewer_ready else None,
            "targetFormat": "stl" if conversion and conversion.ok else "glb",
            "precisionPreset": precision_preset,
            "preserveColors": preserve_colors,
            "recommendedSolidWorksExport": "STEP AP242 with Export appearance enabled",
        },
    }
    # Domain is NOT stamped into properties — it derives from the asset's
    # kind (kind.domains). A stored properties.domains is a redundant copy
    # that drifts: a BUILD import defaults to kind="unclassified" (below), so
    # stamping a domain here would stick even after the user assigns
    # kind=mirror. The "unclassified" placeholder kind (migration 0110) is
    # all-domain + no-physics, so a kindless import surfaces under every rail.

    row = Asset3D(
        catalog_id=catalog_id,
        name=name,
        asset_type=viewer_asset_type,
        file_path=viewer_path,
        source="upload",
        unit=unit,
        scale_factor=scale_factor,
        anchors=[],
        kind_id=kind_id or "unclassified",
        default_params={},
        properties=properties,
    )
    session.add(row)
    try:
        await session.commit()
    except Exception as e:
        await session.rollback()
        target.unlink(missing_ok=True)
        if conversion and conversion.ok and conversion.viewer_relative_path:
            (settings.asset_root / conversion.viewer_relative_path).unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    await session.refresh(row)
    return row


@router.put("/assets3d/{catalog_id}/geometry", response_model=Asset3DV3Out)
async def replace_asset3d_geometry(
    catalog_id: str,
    file: UploadFile = File(...),
    name: str | None = Form(None),
    unit: str | None = Form(None),
    scale_factor: float | None = Form(None),
    precision_preset: str = Form("standard"),
    preserve_colors: bool = Form(True),
    session: AsyncSession = Depends(get_session),
) -> Asset3D:
    """Replace an EXISTING Asset3D's geometry file in place (Geometry Builder
    "edit existing asset").

    Keeps the row's anchors / kind_id / default_params / wavelength|frequency
    ranges; only swaps file_path + asset_type + unit/scale_factor and refreshes
    the geometry-related ``properties`` (cadImport, viewerReady, …). The builder
    bakes the placed/merged model into a coloured GLB in millimetres, so callers
    send unit=mm scale_factor=1 — that is why those are applied here rather than
    preserved. Allowed even when the asset is placed in scenes; the UI surfaces a
    usage warning first (anchors may need re-checking in the ASSET3D tab).
    """
    row = await _fetch_asset_by_key(session, catalog_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"asset3d key={catalog_id!r} not found",
        )

    suffix = Path(file.filename or "").suffix.lower()
    rejection = upload_rejection_message(suffix)
    if rejection:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=rejection)
    if suffix not in SUPPORTED_ASSET_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Upload a GLB, GLTF, OBJ, STL, STEP, or STP file.",
        )
    if unit is not None and unit not in {"mm", "m"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unit must be mm or m.")
    if precision_preset not in {"preview", "standard", "high"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Precision must be preview, standard, or high.")

    subdir = subdir_for_ext(suffix)
    upload_dir = settings.asset_root / "files" / subdir
    upload_dir.mkdir(parents=True, exist_ok=True)
    stem = row.catalog_id or catalog_id
    filename = safe_upload_name(file.filename or f"{stem}{suffix}")
    target = upload_dir / filename
    content = await file.read()
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is empty.")
    target.write_bytes(content)

    relative_path = f"files/{subdir}/{filename}"
    asset_type = suffix.lstrip(".")
    conversion = convert_cad_source_to_stl(
        relative_path,
        output_stem=stem,
        precision_preset=precision_preset,
    ) if suffix in {".step", ".stp"} else None
    viewer_path = conversion.viewer_relative_path if conversion and conversion.ok else relative_path
    viewer_asset_type = conversion.viewer_asset_type if conversion and conversion.ok else asset_type
    viewer_ready = suffix in VIEWER_ASSET_EXTENSIONS or bool(conversion and conversion.ok)
    cad_source = suffix in CAD_SOURCE_EXTENSIONS

    properties = dict(row.properties or {})
    properties.update({
        "sourceFilename": file.filename,
        "uploadedAssetType": asset_type,
        "viewerReady": viewer_ready,
        "conversionStatus": "ready" if viewer_ready else "cad_source_only",
        "conversionMessage": conversion.message if conversion else None,
        "colorImportStatus": "from_file" if suffix in {".glb", ".gltf"} else ("pending_conversion" if cad_source else "not_available"),
        "cadImport": {
            "sourcePath": relative_path,
            "sourceFormat": asset_type,
            "viewerPath": viewer_path if viewer_ready else None,
            "targetFormat": "stl" if conversion and conversion.ok else "glb",
            "precisionPreset": precision_preset,
            "preserveColors": preserve_colors,
        },
    })

    row.file_path = viewer_path
    row.asset_type = viewer_asset_type
    if name:
        row.name = name
    if unit is not None:
        row.unit = unit
    if scale_factor is not None:
        row.scale_factor = scale_factor
    row.properties = properties
    # The mesh just changed, so every LOD tier derived from the old one is
    # stale. Drop them; the builder re-POSTs the new tiers right after this
    # call returns. Never leave a tier pointing at geometry that no longer
    # matches the asset (objectives.md R-5).
    await _drop_asset_lods(session, row)
    try:
        await session.commit()
    except Exception as e:
        await session.rollback()
        target.unlink(missing_ok=True)
        if conversion and conversion.ok and conversion.viewer_relative_path:
            (settings.asset_root / conversion.viewer_relative_path).unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    await session.refresh(row)
    return row


@router.post(
    "/assets3d/{catalog_id}/lods",
    response_model=Asset3DV3Out,
    status_code=status.HTTP_201_CREATED,
)
async def upsert_asset3d_lod(
    catalog_id: str,
    level: int = Form(...),
    tri_count: int = Form(...),
    error_mm: float = Form(0.0),
    file: UploadFile | None = File(None),
    session: AsyncSession = Depends(get_session),
) -> Asset3D:
    """Record one LOD tier for an asset (alembic 0122; objectives.md R-4/R-5).

    One call per tier, called by BUILD right after the asset itself is saved:

      * **level 0** carries **metrics only, no file** — its ``file_path``
        mirrors ``Asset3D.file_path`` and its ``error_mm`` is 0 by definition
        (it *is* the reference the other tiers' error is measured against).
      * **level 1 / 2** upload the decimated GLB, stored beside the source as
        ``<stem>.lod<n>.glb``.

    ``tri_count`` and ``error_mm`` come from the client because only it has a
    mesh parser; ``error_mm`` is meshoptimizer's simplification error scaled
    to mm and is the renderer's switching input, so a caller that omits it
    leaves the tier unusable (it would compare as "zero error" and always win).

    **Deliberately not behind ``lock_guard``**: a LOD tier is a derived render
    artifact, not the asset's ground truth, so regenerating one on a locked
    asset must not require a human unlock. Nothing this route writes can reach
    the tracer — physics reads anchors only.

    Upsert semantics: re-POSTing a level replaces that tier's row and file.
    """
    row = await _fetch_asset_by_key(session, catalog_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"asset3d key={catalog_id!r} not found",
        )
    if level not in (0, 1, 2):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="level must be 0, 1, or 2.",
        )
    if tri_count <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="tri_count must be positive.",
        )
    if error_mm < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="error_mm must be >= 0.",
        )

    written: Path | None = None
    if level == 0:
        if file is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "level 0 is the asset's own mesh — send metrics only. "
                    "Upload geometry through /assets3d/upload or "
                    "/assets3d/{key}/geometry."
                ),
            )
        tier_path = row.file_path
        # Authoritative size from disk; the asset may predate its LOD rows.
        source = settings.asset_root / tier_path
        byte_size = source.stat().st_size if source.exists() else 0
        error_mm = 0.0
    else:
        if file is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"level {level} requires a geometry file.",
            )
        content = await file.read()
        if not content:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Uploaded file is empty.",
            )
        upload_dir = settings.asset_root / "files" / "glb"
        upload_dir.mkdir(parents=True, exist_ok=True)
        stem = row.catalog_id or str(row.id)
        filename = safe_upload_name(f"{stem}.lod{level}.glb")
        written = upload_dir / filename
        written.write_bytes(content)
        tier_path = f"files/glb/{filename}"
        byte_size = len(content)

    existing = (await session.execute(
        select(AssetLod).where(
            AssetLod.asset_id == row.id, AssetLod.level == level
        )
    )).scalar_one_or_none()
    if existing is not None:
        # Replacing a tier: unlink the file it owned, unless the new upload
        # landed on the very same path (same stem → same name).
        if existing.level > 0 and existing.file_path != tier_path:
            (settings.asset_root / existing.file_path).unlink(missing_ok=True)
        await session.delete(existing)
        await session.flush()

    session.add(AssetLod(
        asset_id=row.id,
        level=level,
        file_path=tier_path,
        tri_count=tri_count,
        byte_size=byte_size,
        error_mm=error_mm,
        hints_digest=_viewer_hints_digest(row.properties),
    ))
    try:
        await session.commit()
    except Exception as e:
        await session.rollback()
        if written is not None:
            written.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    await session.refresh(row)
    return row


@router.get("/assets3d/{catalog_id}", response_model=Asset3DV3Out)
async def get_asset3d_by_catalog_id(
    catalog_id: str,
    session: AsyncSession = Depends(get_session),
) -> Asset3D:
    row = await _fetch_asset_by_key(session, catalog_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"asset3d key={catalog_id!r} not found",
        )
    return row


@router.put("/assets3d/{catalog_id}", response_model=Asset3DV3Out)
async def update_asset3d_by_catalog_id(
    catalog_id: str,
    payload: Asset3DV3Update,
    session: AsyncSession = Depends(get_session),
) -> Asset3D:
    """Update editable v3 physics metadata for one Asset3D row. The path
    segment accepts either a catalog_id slug or a row UUID (the latter
    is required for legacy mechanical Asset3Ds without a slug)."""
    row = await _fetch_asset_by_key(session, catalog_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"asset3d key={catalog_id!r} not found",
        )

    fields = payload.model_fields_set
    assert_update_allowed(
        locked=row.locked, changed_fields=fields, label=f"Asset3D {row.name!r}"
    )
    if "locked" in fields and payload.locked is not None:
        row.locked = payload.locked
    if "name" in fields and payload.name is not None:
        row.name = payload.name
    if "kind_id" in fields:
        # kind_id is NOT NULL (0111); a null/empty edit falls back to the
        # "unclassified" placeholder rather than blanking the column.
        row.kind_id = payload.kind_id or "unclassified"
    if "device_id" in fields:
        # Device-driven seed (RF_ARCHITECTURE_PLAN §2.3): set the pointer,
        # then materialise anchors + write kind_id through from the device's
        # behavioralKind. Explicit anchors / kind_id in the SAME payload win
        # (the editor sends them when the user has fine-tuned coordinates).
        row.device_id = payload.device_id
        device = device_by_id(payload.device_id) if payload.device_id else None
        if device is not None:
            behavioral = device.get("behavioral_kind")
            if behavioral and "kind_id" not in fields:
                row.kind_id = behavioral
            if "anchors" not in fields:
                row.anchors = materialize_device_anchors(device)
            dev_defaults = device.get("default_params") or {}
            if dev_defaults:
                merged = dict(row.default_params or {})
                for k, v in dev_defaults.items():
                    merged.setdefault(k, v)
                row.default_params = merged
    if "anchors" in fields:
        # Phase 9.8: editor's primary write path. Replaces faces[]/
        # transitions[] over time. Pass-through-store as camelCase dicts
        # — the Phase 9.1 tracer reads positionMmBodyLocal / axisX/Y/Z.
        row.anchors = (
            [a.model_dump(by_alias=True, exclude_none=True) for a in payload.anchors]
            if payload.anchors is not None
            else []
        )
    if "default_params" in fields:
        row.default_params = payload.default_params
    if "tunable_params" in fields:
        # Whole-list overwrite — editor sends the full set of tunable keys.
        row.tunable_params = list(payload.tunable_params or [])
    if "wavelength_range_nm" in fields:
        row.wavelength_range_nm = payload.wavelength_range_nm
    if "frequency_range_mhz" in fields:
        row.frequency_range_mhz = payload.frequency_range_mhz
    if "properties" in fields:
        # Whole-dict overwrite (caller is expected to send the merged
        # state). Keep None as "no-op" rather than blanking the column.
        if payload.properties is not None:
            before = _viewer_hints_digest(row.properties)
            row.properties = payload.properties
            # viewerHints changed => the LOD tiers were baked from a
            # different filtered mesh and their centroid-keyed filtering no
            # longer applies. Drop them rather than serve geometry that
            # disagrees with LOD0.
            if _viewer_hints_digest(row.properties) != before:
                await _drop_asset_lods(session, row)

    await session.commit()
    await session.refresh(row)
    return row


@router.get("/assets3d/{catalog_id}/usage", response_model=Asset3DUsageOut)
async def get_asset3d_usage(
    catalog_id: str,
    session: AsyncSession = Depends(get_session),
) -> Asset3DUsageOut:
    """Reference counts for one Asset3D — how many catalog Components point
    at it and how many placed scene objects resolve to it. The PHY Editor
    reads this to lock connector_type editing + Delete on in-use assets."""
    row = await _fetch_asset_by_key(session, catalog_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"asset3d key={catalog_id!r} not found",
        )
    component_count, object_count = await _asset_usage(session, row)
    return Asset3DUsageOut(component_count=component_count, object_count=object_count)


@router.delete("/assets3d/{catalog_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_asset3d_by_catalog_id(
    catalog_id: str,
    session: AsyncSession = Depends(get_session),
) -> None:
    """Delete one Asset3D row + any ComponentBinding rows that reference
    it. The path segment accepts either a catalog_id slug or a row UUID.
    Used by PhyEditor's per-asset delete button. Idempotent: 404 if no
    such row, 204 on success. Refused with 409 if any placed scene object
    still resolves to this asset — deleting it would orphan them.
    """
    row = await _fetch_asset_by_key(session, catalog_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"asset3d key={catalog_id!r} not found",
        )
    assert_delete_allowed(locked=row.locked, label=f"Asset3D {row.name!r}")
    _, object_count = await _asset_usage(session, row)
    if object_count > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"asset3d key={catalog_id!r} is in use by {object_count} "
                "placed scene object(s); remove them before deleting."
            ),
        )
    # Cascade: drop bindings that reference this asset, then the asset itself.
    bindings = (await session.execute(
        select(ComponentBinding).where(ComponentBinding.asset_3d_id == row.id)
    )).scalars().all()
    for b in bindings:
        await session.delete(b)
    await session.delete(row)
    await session.commit()


# ---------------------------------------------------------------------------
# Component
# ---------------------------------------------------------------------------

@router.get("/components", response_model=list[ComponentV3Out])
async def list_components(
    has_v3: bool = True,
    session: AsyncSession = Depends(get_session),
) -> list[ComponentV3Out]:
    # Hide soft-deleted (archived) rows — the Components editor treats
    # DELETE as "remove from catalog view"; archived rows are gone from
    # the user's perspective even though the DB row persists for FK
    # safety on SceneObjects already created from them.
    stmt = select(Component).where(Component.archived_at.is_(None))
    if has_v3:
        stmt = stmt.where(Component.catalog_id.is_not(None))
    stmt = stmt.order_by(Component.catalog_id)
    components = (await session.execute(stmt)).scalars().all()
    # Attach binding summaries (Component.bindings -> ComponentBinding rows)
    results = []
    for c in components:
        binds = (await session.execute(
            select(ComponentBinding)
            .where(ComponentBinding.component_id == c.id)
            .order_by(ComponentBinding.sort_order)
        )).scalars().all()
        results.append(_component_to_out(c, binds))
    return results


@router.get("/components/{catalog_id}", response_model=ComponentV3Out)
async def get_component_by_catalog_id(
    catalog_id: str,
    session: AsyncSession = Depends(get_session),
) -> ComponentV3Out:
    c = (await session.execute(
        select(Component).where(Component.catalog_id == catalog_id)
    )).scalar_one_or_none()
    if c is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"component catalog_id={catalog_id!r} not found",
        )
    binds = (await session.execute(
        select(ComponentBinding)
        .where(ComponentBinding.component_id == c.id)
        .order_by(ComponentBinding.sort_order)
    )).scalars().all()
    return _component_to_out(c, binds)


def _component_to_out(c: Component, binds: list[ComponentBinding]) -> ComponentV3Out:
    return ComponentV3Out(
        id=c.id,
        catalog_id=c.catalog_id,
        name=c.name,
        kind_id=c.kind_id,
        brand=c.brand,
        model=c.model,
        exposed_faces=c.exposed_faces,
        properties=c.properties or {},
        bindings=[{
            "bindingId": (b.properties or {}).get("bindingId"),
            "assetId": str(b.asset_3d_id) if b.asset_3d_id else None,
            "localXMm": b.local_x_mm,
            "localYMm": b.local_y_mm,
            "localZMm": b.local_z_mm,
            "localRxDeg": b.local_rx_deg,
            "localRyDeg": b.local_ry_deg,
            "localRzDeg": b.local_rz_deg,
            "sortOrder": b.sort_order,
        } for b in binds],
    )
