"""add connectorType field to every Asset3D anchor

Revision ID: 0050_anchor_connector_type
Revises: 0049_split_kind_params

Adds an explicit `connectorType` slot (initialised to null) on every
anchor inside `assets_3d.anchors` JSONB. The values are populated
per-anchor through the PHY Editor RF / Components UI:

    "connectorType": "sma_male" | "sma_female" | "bnc_male" | "bnc_female" | null

Only meaningful for RF / TTL anchors. Optical anchors (mirror face,
lens face, fiber endpoints, etc.) keep `connectorType: null` since they
don't sit on a coaxial connector.

Migration strategy
------------------
* Iterate every assets_3d row, inject the key with null default on any
  anchor dict that doesn't already have it.
* Idempotent — rows that already carry `connectorType` keep their value.
* Downgrade strips the key.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0050_anchor_connector_type"
down_revision = "0049_split_kind_params"
branch_labels = None
depends_on = None


def _add_connector_type_key(entry: dict) -> dict:
    if not isinstance(entry, dict):
        return entry
    if "connectorType" in entry:
        return entry
    result = dict(entry)
    result["connectorType"] = None
    return result


def _strip_connector_type_key(entry: dict) -> dict:
    if not isinstance(entry, dict):
        return entry
    result = dict(entry)
    result.pop("connectorType", None)
    return result


def _rewrite_anchors(transform) -> None:
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, anchors FROM assets_3d")).fetchall()
    for row in rows:
        anchors = row.anchors or []
        if not isinstance(anchors, list):
            continue
        new_anchors = [transform(a) for a in anchors]
        bind.execute(
            sa.text(
                "UPDATE assets_3d SET anchors = CAST(:new AS JSONB) WHERE id = :id"
            ),
            {"new": json.dumps(new_anchors), "id": row.id},
        )


def upgrade() -> None:
    _rewrite_anchors(_add_connector_type_key)


def downgrade() -> None:
    _rewrite_anchors(_strip_connector_type_key)
