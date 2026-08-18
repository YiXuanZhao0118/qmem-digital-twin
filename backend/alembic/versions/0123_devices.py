"""Move the device registry out of TypeScript and into a ``devices`` table.

Until now a *device* — one concrete instrument (mesh + named-anchor layout +
default params, pinned to one behavioural kind) — was a file under
``frontend/src/devices/``, imported by ``_registry.ts``, exported into
``backend/data/kinds.json::devices[]`` by ``npm run export:kinds`` and read
back by ``app.kinds_manifest.device_by_id``. Adding the 40th instrument meant
editing two TS files, re-running the export script and restarting the backend,
so the PHY Editor could only ever *pick* a device, never create or correct one.

This migration makes the DB the source of truth: the table below is seeded
from the 39 records that were in the manifest, and ``/api/devices`` (see
``routers/devices.py``) is the only write path from here on.

Design notes:
  * The primary lookup key stays the device **slug** (``ad9959``,
    ``zhl_1_2w``, …) because that is exactly what ``assets_3d.device_id``
    already stores (alembic 0118). No asset row changes, and the FK stays
    logical rather than declared — an asset may reference a slug that a
    later migration renames, and we prefer the 404 over a cascade.
  * ``anchors`` keeps the manifest's snake_case shape
    (``position_mm_body_local`` / ``direction_body_local`` / …) so
    ``services/device_seed.materialize_device_anchors`` reads a DB row
    unchanged. The API layer speaks camelCase via pydantic aliases.
  * ``locked`` mirrors ``kinds.locked`` / ``assets_3d.locked`` (alembic 0112)
    and is enforced by the same ``lock_guard``. The seeded rows are left
    UNLOCKED: they came from code that nobody has reviewed as a DB row yet,
    and locking is a deliberate human action.
  * The seed lives in ``0123_devices_seed.json`` next to this file rather
    than being read from ``backend/data/kinds.json``, because that manifest
    loses its ``devices[]`` block in the same change — a migration must not
    depend on a file that later commits are free to rewrite.

Revision ID: 0123_devices
Revises: 0122_asset_lods
"""

from __future__ import annotations

import json
from pathlib import Path

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID

from alembic import op


revision = "0123_devices"
down_revision = "0122_asset_lods"
branch_labels = None
depends_on = None


_SEED_PATH = Path(__file__).resolve().parent / "0123_devices_seed.json"


def upgrade() -> None:
    devices = op.create_table(
        "devices",
        sa.Column(
            "id",
            PG_UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        # The value `assets_3d.device_id` stores. Stable, human-authored.
        sa.Column("slug", sa.Text(), nullable=False, unique=True),
        sa.Column("display_name", sa.Text(), nullable=False),
        # ElementKind this instrument dispatches as. NULL = pure mechanical /
        # render-only (no solver participation) — the render-only fixtures.
        sa.Column("behavioral_kind", sa.Text(), nullable=True),
        sa.Column("component_type", sa.Text(), nullable=False),
        sa.Column("mesh", sa.Text(), nullable=False),
        sa.Column(
            "anchors", JSONB(), nullable=False, server_default="[]"
        ),
        sa.Column(
            "default_params", JSONB(), nullable=False, server_default="{}"
        ),
        sa.Column(
            "locked", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_devices_slug", "devices", ["slug"])
    op.create_index(
        "ix_devices_behavioral_kind", "devices", ["behavioral_kind"]
    )

    seed = json.loads(_SEED_PATH.read_text(encoding="utf-8"))
    if seed:
        op.bulk_insert(
            devices,
            [
                {
                    "slug": d["id"],
                    "display_name": d["display_name"],
                    "behavioral_kind": d.get("behavioral_kind"),
                    "component_type": d["component_type"],
                    "mesh": d["mesh"],
                    "anchors": d.get("anchors") or [],
                    "default_params": d.get("default_params") or {},
                    "locked": False,
                }
                for d in seed
            ],
        )


def downgrade() -> None:
    op.drop_index("ix_devices_behavioral_kind", table_name="devices")
    op.drop_index("ix_devices_slug", table_name="devices")
    op.drop_table("devices")
