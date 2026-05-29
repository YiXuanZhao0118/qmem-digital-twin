"""Seed `assets/catalog/**/*.json` (Asset-Physics-Model v3) into Postgres.

Idempotent ??upserts by `catalog_id`. Run after `alembic upgrade head`
on the v3 migration (0082+).

  Asset3D JSON  ??assets_3d row (v3 columns: kind_id, faces,
                  transitions, default_params, wavelength_range_nm,
  Component JSON ??components row + ComponentBinding rows resolved from
                   asset catalog_id refs to UUID FKs

Mechanical-only assets (Asset3D.kind == null in JSON) seed with
kind_id=null + empty faces/transitions; only geometry + properties
are populated.

Usage:
  python backend/scripts/seed_v3_assets.py [--catalog-dir PATH]
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys

from sqlalchemy import select

# Path bootstrap so `app.*` imports work when run directly
sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db import AsyncSessionLocal, engine  # noqa: E402
from app.models import Asset3D, Component, ComponentBinding  # noqa: E402
from app.schemas_v3 import Asset3DV3In, ComponentV3In  # noqa: E402


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CATALOG_DIR = REPO_ROOT / "assets" / "catalog"


# ---------------------------------------------------------------------------
# Asset3D upsert
# ---------------------------------------------------------------------------

async def upsert_asset3d(session, payload: Asset3DV3In) -> Asset3D:
    """Insert or update an Asset3D row by catalog_id."""
    existing = (await session.execute(
        select(Asset3D).where(Asset3D.catalog_id == payload.id)
    )).scalar_one_or_none()

    # Convert pydantic-side data into raw dicts for JSONB storage.
    faces_json = [f.model_dump(by_alias=True, exclude_none=True) for f in payload.faces]
    transitions_json = [
        t.model_dump(by_alias=True, exclude_none=True) for t in payload.transitions
    ]
    mech_anchors_json = [
        a.model_dump(by_alias=True, exclude_none=True)
        for a in payload.mechanical_anchors
    ]

    # Asset-type taxonomy: optical assets have a physics kind; mechanical
    # use a coarse role label parsed from the JSON file's directory (see
    # main() ??passed in via `properties._role` upstream when known).
    asset_type = payload.kind or "mechanical"
    name = payload.display_name or payload.vendor_part or payload.id

    if existing is None:
        existing = Asset3D(
            catalog_id=payload.id,
            name=name,
            asset_type=asset_type,
            file_path=payload.geometry_ref or "",
            anchors=mech_anchors_json,
            kind_id=payload.kind,
            faces=faces_json,
            transitions=transitions_json,
            default_params=payload.default_params or {},
            wavelength_range_nm=payload.wavelength_range_nm,
            properties={
                "vendorPart": payload.vendor_part,
                "displayName": payload.display_name,
                "physicalDimensionsMm": payload.physical_dimensions_mm or {},
                "geometryRefGlb": payload.geometry_ref_glb,
                "notes": payload.notes or {},
            },
        )
        session.add(existing)
    else:
        existing.name = name
        existing.asset_type = asset_type
        existing.file_path = payload.geometry_ref or existing.file_path
        existing.anchors = mech_anchors_json
        existing.kind_id = payload.kind
        existing.faces = faces_json
        existing.transitions = transitions_json
        existing.default_params = payload.default_params or {}
        existing.wavelength_range_nm = payload.wavelength_range_nm
        # Preserve viewerHints (centroid filters, etc.) baked by alembic
        # migrations like 0074 ??re-seeding shouldn't wipe them.
        preserved_vh = (existing.properties or {}).get("viewerHints")
        new_properties = {
            "vendorPart": payload.vendor_part,
            "displayName": payload.display_name,
            "physicalDimensionsMm": payload.physical_dimensions_mm or {},
            "geometryRefGlb": payload.geometry_ref_glb,
            "notes": payload.notes or {},
        }
        if preserved_vh is not None:
            new_properties["viewerHints"] = preserved_vh
        existing.properties = new_properties

    return existing


# ---------------------------------------------------------------------------
# Component upsert
# ---------------------------------------------------------------------------

async def upsert_component(session, payload: ComponentV3In) -> Component:
    """Insert or update a Component row by catalog_id. Bindings handled
    in a second pass once all Assets are seeded."""
    existing = (await session.execute(
        select(Component).where(Component.catalog_id == payload.id)
    )).scalar_one_or_none()

    name = payload.display_name or payload.vendor_part or payload.id
    exposed_json = [e.model_dump(by_alias=True) for e in payload.exposed_faces]
    next_properties = {
        "displayName": payload.display_name,
        "wavelengthCenterNm": payload.wavelength_center_nm,
        "notes": payload.notes or {},
    }
    if isinstance(payload.notes, dict):
        for key in ("sourceUrl", "clearApertureMm", "waveplateKindParamsOverride"):
            if key in payload.notes:
                next_properties[key] = payload.notes[key]

    if existing is None:
        existing = Component(
            catalog_id=payload.id,
            name=name,
            kind_id=payload.kind_id,
            brand=None,
            model=payload.vendor_part,
            exposed_faces=exposed_json,
            properties=next_properties,
        )
        session.add(existing)
    else:
        existing.name = name
        existing.kind_id = payload.kind_id
        existing.model = payload.vendor_part
        existing.exposed_faces = exposed_json
        existing.properties = {**(existing.properties or {}), **next_properties}

    return existing


async def sync_component_bindings(
    session, component: Component, payload: ComponentV3In, assets_by_catalog_id: dict
) -> None:
    """Replace bindings on `component` to exactly match `payload.bindings`.
    Resolves asset catalog_id -> UUID via `assets_by_catalog_id`."""
    # Wipe old bindings for this component (cascade='all, delete-orphan'
    # on Component.bindings handles row removal).
    existing_bindings = (await session.execute(
        select(ComponentBinding).where(ComponentBinding.component_id == component.id)
    )).scalars().all()
    for b in existing_bindings:
        await session.delete(b)
    await session.flush()

    for idx, b in enumerate(payload.bindings):
        asset = assets_by_catalog_id.get(b.asset_id)
        if asset is None:
            print(f"  ! binding '{b.binding_id}' references unknown asset "
                  f"'{b.asset_id}' ??skipping")
            continue
        binding = ComponentBinding(
            component_id=component.id,
            target_kind="asset",
            asset_3d_id=asset.id,
            sub_component_id=None,
            local_x_mm=b.local_x_mm,
            local_y_mm=b.local_y_mm,
            local_z_mm=b.local_z_mm,
            local_rx_deg=b.local_rx_deg,
            local_ry_deg=b.local_ry_deg,
            local_rz_deg=b.local_rz_deg,
            sort_order=idx,
            properties={
                "bindingId": b.binding_id,
                "tunableAxes": b.tunable_axes,
            },
        )
        session.add(binding)

    # Legacy scene/rendering bridge: a single-asset v3 Component is still a
    # plain Component with asset_3d_id, so dragging it into the scene can use
    # the existing renderer while v3 binding-tree rendering matures.
    if len(payload.bindings) == 1:
        asset = assets_by_catalog_id.get(payload.bindings[0].asset_id)
        if asset is not None:
            component.asset_3d_id = asset.id


# ---------------------------------------------------------------------------
# Catalog walk
# ---------------------------------------------------------------------------

def _strip_underscore_keys(d: dict) -> dict:
    """Drop keys starting with '_' so pydantic doesn't complain about
    user-facing notes like _USER_TODO."""
    return {k: v for k, v in d.items() if not k.startswith("_")}


def _load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as fh:
        return _strip_underscore_keys(json.load(fh))


def find_asset_jsons(catalog_dir: Path) -> list[Path]:
    return sorted((catalog_dir / "assets3d").rglob("*.json"))


def find_component_jsons(catalog_dir: Path) -> list[Path]:
    return sorted((catalog_dir / "components").rglob("*.json"))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def seed_v3(catalog_dir: Path, components_only: bool = False) -> None:
    asset_paths = find_asset_jsons(catalog_dir)
    component_paths = find_component_jsons(catalog_dir)
    print(f"Found {len(asset_paths)} Asset3D JSON files, "
          f"{len(component_paths)} Component JSON files in {catalog_dir}")

    async with AsyncSessionLocal() as session:
        # Pass 1: resolve catalog_id -> Asset3D map.
        assets_by_catalog_id: dict[str, Asset3D] = {}
        if components_only:
            # Read existing assets WITHOUT upserting so editor-authored
            # anchors[] survive — upsert_asset3d would overwrite anchors with
            # the catalog's (empty for optical) mechanicalAnchors. Only the
            # component + binding passes run, rebuilding bindings from catalog.
            existing_assets = (
                await session.execute(select(Asset3D))
            ).scalars().all()
            for asset in existing_assets:
                if asset.catalog_id:
                    assets_by_catalog_id[asset.catalog_id] = asset
            print(f"  (components-only) loaded {len(assets_by_catalog_id)} "
                  f"existing assets from DB; anchors preserved")
        else:
            for path in asset_paths:
                try:
                    raw = _load_json(path)
                    payload = Asset3DV3In.model_validate(raw)
                except Exception as exc:
                    print(f"  FAIL {path.relative_to(catalog_dir)}: {exc}")
                    continue
                asset = await upsert_asset3d(session, payload)
                await session.flush()
                assets_by_catalog_id[payload.id] = asset
                print(f"  OK asset  {payload.id:50s}  kind={payload.kind or '(mechanical)'}")

        # Pass 2: upsert Component rows
        components_by_catalog_id: dict[str, Component] = {}
        for path in component_paths:
            try:
                raw = _load_json(path)
                payload = ComponentV3In.model_validate(raw)
            except Exception as exc:
                print(f"  FAIL {path.relative_to(catalog_dir)}: {exc}")
                continue
            component = await upsert_component(session, payload)
            await session.flush()
            components_by_catalog_id[payload.id] = (component, payload)
            print(f"  OK comp   {payload.id:50s}  bindings={len(payload.bindings)}")

        # Pass 3: rebuild ComponentBindings (needs Assets to be flushed)
        for catalog_id, (component, payload) in components_by_catalog_id.items():
            await sync_component_bindings(
                session, component, payload, assets_by_catalog_id
            )

        await session.commit()

    await engine.dispose()
    print(f"\nDone. {len(assets_by_catalog_id)} assets, "
          f"{len(components_by_catalog_id)} components seeded.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--catalog-dir", type=Path, default=DEFAULT_CATALOG_DIR,
        help="Path to assets/catalog/ root (default: repo's assets/catalog/)",
    )
    parser.add_argument(
        "--components-only", action="store_true",
        help="Rebuild Component rows + bindings from catalog without "
             "re-upserting Asset3D rows (preserves editor-authored anchors).",
    )
    args = parser.parse_args()
    asyncio.run(seed_v3(args.catalog_dir, components_only=args.components_only))


if __name__ == "__main__":
    main()
