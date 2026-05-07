"""normalize Component.properties frame-bearing field names

Revision ID: 0020_normalize_component_properties
Revises: 0019_normalize_kindparams

Phase 6 of the schema/frame/unit unification (vibe-coding-log 2026-05-07).

The Phase 6 audit found that `Component.properties` is genuinely
heterogeneous (~90 distinct keys, almost no overlap between component
types — only `geometry` and `dimensionsMm` appear on ≥80% of rows).
Promoting more keys to formal SQL columns would not yield meaningful
schema discipline because most fields are vendor-specific. Instead this
phase targets the only **frame-bearing** keys whose names hide their
frame:

    apertureForwardLocalMm  ->  apertureForwardMmBodyLocal
    apertureBackwardLocalMm ->  apertureBackwardMmBodyLocal

Both are `[x, y, z]` mm vectors in the SceneObject's body-local Z-up
frame (the GLB authored frame, which after alembic 0017 unit fix
matches lab Z-up). The legacy `Local` suffix did not say Z-up vs Y-up,
which became confusing once Phase 5 standardised body-local on Z-up.

Migration strategy
------------------
* Walk every `components` row, rebuild `properties` JSONB with renamed
  keys, write back via parameterised SQL.
* Idempotent — already-migrated rows are skipped.
* `downgrade()` reverses the rename for rollback safety.
* Frontend readers carry a one-release fallback chain
  (`apertureForwardMmBodyLocal ?? apertureForwardLocalMm`), so a deploy
  that lands code first / migration second (or vice versa) does not
  break alignment.

What this migration deliberately does NOT do
--------------------------------------------
* It does not promote `dimensionsMm` or `anchors[]` into formal SQL
  columns. The audit showed Component.properties is too heterogeneous
  for column promotion to pay off without per-component-type
  discrimination. A future "Phase 6b" could revisit if the team wants
  to enforce per-kind property schemas.
* It does not touch SceneObject.properties — the audit found those
  keys (`originOffsetMm`, `objectScale`, `anchors`, `placedRelativeTo`,
  `locked`) are already either frame-explicit or non-frame-bearing.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0020_norm_comp_props"
down_revision = "0019_normalize_kindparams"
branch_labels = None
depends_on = None


_RENAMES: tuple[tuple[str, str], ...] = (
    ("apertureForwardLocalMm", "apertureForwardMmBodyLocal"),
    ("apertureBackwardLocalMm", "apertureBackwardMmBodyLocal"),
)


def _apply(props: dict, renames: tuple[tuple[str, str], ...]) -> dict:
    out = dict(props)
    for old, new in renames:
        if old in out:
            if new not in out:
                out[new] = out.pop(old)
            else:
                out.pop(old, None)
    return out


def _reverse(props: dict, renames: tuple[tuple[str, str], ...]) -> dict:
    out = dict(props)
    for old, new in renames:
        if new in out:
            if old not in out:
                out[old] = out.pop(new)
            else:
                out.pop(new, None)
    return out


def _rewrite(transform) -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, properties FROM components WHERE properties IS NOT NULL")
    ).fetchall()
    for row in rows:
        props = row.properties
        if not isinstance(props, dict):
            continue
        new_props = transform(props, _RENAMES)
        if new_props == props:
            continue
        bind.execute(
            sa.text(
                "UPDATE components SET properties = CAST(:p AS JSONB) WHERE id = :cid"
            ),
            {"p": json.dumps(new_props), "cid": row.id},
        )


def upgrade() -> None:
    _rewrite(_apply)


def downgrade() -> None:
    _rewrite(_reverse)
