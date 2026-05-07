"""normalize Asset3D.anchors[] field names to the unified frame/unit convention

Revision ID: 0018_normalize_asset_anchors
Revises: 0017_fix_aom_glb_unit

Phase 4 of the schema/frame/unit unification (vibe-coding-log 2026-05-07).

Rewrites every anchor entry inside `assets_3d.anchors` JSONB so that the
field names embed frame and unit. After this migration the canonical
shape is:

    {
        "id": "intercept_in",                          # Literal whitelist
        "positionMmBodyLocal": {"x": 0, "y": 0, "z": 0},  # was localPosition
        "directionBodyLocal":  {"x": 1, "y": 0, "z": 0},  # was localDirection
                                                          # (omitted if absent)
        "apertureMm": 12.5,
        "name":  "...",
        "type":  "..."
    }

Migration strategy
------------------
* Pure SQL UPDATE per row using a Python-rebuild step — there are very
  few asset rows in dev/prod (≤ 2 digits) and JSONB rewrites are
  guaranteed not to lose nested structure.
* Idempotent: skips entries that already use the new field names.
* Preserves any extra metadata fields that are not renamed
  (`name`, `type`, `apertureMm`, anything custom).
* The Pydantic AssetAnchor schema accepts BOTH old and new field names on
  input, so even if a client still posts legacy names after this
  migration, validation will succeed (and Pydantic will emit the new
  names on response).

Note on safety
--------------
* No anchor reader/writer in the backend depends on the legacy names
  AT RUNTIME — assembly_solver reads `localPosition` directly today, but
  the Phase 4 frontend update + this migration land together so by the
  time assembly_solver's next read happens, the column has the new
  names. The Pydantic model has a `model_validator` that accepts both,
  preserving inbound API compat during deploys.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0018_normalize_asset_anchors"
down_revision = "0017_fix_aom_glb_unit"
branch_labels = None
depends_on = None


def _normalize_anchor_dict(entry: dict) -> dict:
    """Rewrite a single anchor entry to the new field naming.

    * `localPosition`  → `positionMmBodyLocal`
    * `localDirection` → `directionBodyLocal`

    Already-migrated entries are returned unchanged. Non-dict entries are
    skipped (returned as-is) — Pydantic will reject them on the next read.
    """
    if not isinstance(entry, dict):
        return entry
    result = dict(entry)
    if "localPosition" in result and "positionMmBodyLocal" not in result:
        result["positionMmBodyLocal"] = result.pop("localPosition")
    else:
        # If both keys exist or new key alone, drop the legacy one if any
        result.pop("localPosition", None)
    if "localDirection" in result and "directionBodyLocal" not in result:
        result["directionBodyLocal"] = result.pop("localDirection")
    else:
        result.pop("localDirection", None)
    return result


def _denormalize_anchor_dict(entry: dict) -> dict:
    """Reverse of `_normalize_anchor_dict` — used by `downgrade()`.
    Restores legacy `localPosition` / `localDirection` so older code
    paths can read them again."""
    if not isinstance(entry, dict):
        return entry
    result = dict(entry)
    if "positionMmBodyLocal" in result and "localPosition" not in result:
        result["localPosition"] = result.pop("positionMmBodyLocal")
    if "directionBodyLocal" in result and "localDirection" not in result:
        result["localDirection"] = result.pop("directionBodyLocal")
    return result


def _rewrite_anchors(transform) -> None:
    """Iterate every assets_3d row, transform the anchors list, write back."""
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, anchors FROM assets_3d")).fetchall()
    for row in rows:
        anchors = row.anchors or []
        if not isinstance(anchors, list):
            # Defensive: malformed JSONB — leave it alone, surface via
            # next Pydantic read.
            continue
        new_anchors = [transform(a) for a in anchors]
        bind.execute(
            sa.text(
                "UPDATE assets_3d SET anchors = CAST(:new AS JSONB) WHERE id = :id"
            ),
            {"new": json.dumps(new_anchors), "id": row.id},
        )


def upgrade() -> None:
    _rewrite_anchors(_normalize_anchor_dict)


def downgrade() -> None:
    _rewrite_anchors(_denormalize_anchor_dict)
