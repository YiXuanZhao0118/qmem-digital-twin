"""normalize OpticalElement.kind_params field names to the unified frame/unit convention

Revision ID: 0019_normalize_kindparams
Revises: 0018_normalize_asset_anchors

Phase 5 of the schema/frame/unit unification (vibe-coding-log 2026-05-07).

Renames 9 kindParams field names across 6 ElementKinds so each name
embeds the frame it lives in:

  Mirror:
    normalLocal                    -> surfaceNormalBodyLocal
  Waveplate:
    fastAxisDeg                    -> fastAxisDegBeamLocal
  Polarizer:
    transmissionAxisDeg            -> transmissionAxisDegBeamLocal
  BeamSplitter:
    transmissionAxisDeg            -> transmissionAxisDegBeamLocal
    coatingNormalLocal             -> coatingNormalBodyLocal
  Isolator:
    transmissionAxisDeg            -> transmissionAxisDegBeamLocal
  AOM:
    acousticAxisLocal              -> acousticAxisBodyLocal
    rfPropagationDirectionLocal    -> rfPropagationDirectionBodyLocal
    braggTiltAxisAngleDeg          -> braggTiltAxisDegLab

Migration strategy
------------------
* Walk every `optical_elements` row, rebuild `kind_params` as a Python
  dict with renamed keys, write back via parameterised SQL.
* Idempotent: skips entries that already use the new names.
* Per-kind: only attempts a rename when the row's `element_kind` matches
  the class that owns that field. Avoids accidentally renaming a key
  with the same legacy name on an unrelated kind.

Backward compat
---------------
The Pydantic kind-params classes carry `model_validator(mode="before")`
hooks that translate legacy field names → new on input. So even if a
deploy lands the code change before the migration (or if a third-party
client posts the old names), API validation still succeeds. This
migration removes the legacy names from at-rest storage so direct DB
readers (optical_solver, ray-tracer SQL queries) see the canonical
shape.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0019_normalize_kindparams"
down_revision = "0018_normalize_asset_anchors"
branch_labels = None
depends_on = None


# Per-kind rename mapping, keyed by element_kind. Each value is a tuple
# of (old_camel_key, new_camel_key) pairs.
_RENAMES: dict[str, tuple[tuple[str, str], ...]] = {
    "mirror": (
        ("normalLocal", "surfaceNormalBodyLocal"),
    ),
    "waveplate": (
        ("fastAxisDeg", "fastAxisDegBeamLocal"),
    ),
    "polarizer": (
        ("transmissionAxisDeg", "transmissionAxisDegBeamLocal"),
    ),
    "beam_splitter": (
        ("transmissionAxisDeg", "transmissionAxisDegBeamLocal"),
        ("coatingNormalLocal", "coatingNormalBodyLocal"),
    ),
    "isolator": (
        ("transmissionAxisDeg", "transmissionAxisDegBeamLocal"),
    ),
    "aom": (
        ("acousticAxisLocal", "acousticAxisBodyLocal"),
        ("rfPropagationDirectionLocal", "rfPropagationDirectionBodyLocal"),
        ("braggTiltAxisAngleDeg", "braggTiltAxisDegLab"),
    ),
}


def _apply_rename(params: dict, renames: tuple[tuple[str, str], ...]) -> dict:
    out = dict(params)
    for old, new in renames:
        if old in out:
            if new not in out:
                out[new] = out.pop(old)
            else:
                out.pop(old, None)
    return out


def _reverse_rename(params: dict, renames: tuple[tuple[str, str], ...]) -> dict:
    """Inverse of `_apply_rename` for `downgrade()`."""
    out = dict(params)
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
        sa.text("SELECT object_id, element_kind, kind_params FROM optical_elements")
    ).fetchall()
    for row in rows:
        renames = _RENAMES.get(row.element_kind)
        if not renames:
            continue
        params = row.kind_params or {}
        if not isinstance(params, dict):
            continue
        new_params = transform(params, renames)
        if new_params == params:
            continue  # nothing to do
        bind.execute(
            sa.text(
                "UPDATE optical_elements SET kind_params = CAST(:p AS JSONB) WHERE object_id = :oid"
            ),
            {"p": json.dumps(new_params), "oid": row.object_id},
        )


def upgrade() -> None:
    _rewrite(_apply_rename)


def downgrade() -> None:
    _rewrite(_reverse_rename)
