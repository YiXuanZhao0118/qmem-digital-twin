"""Phase 9.11 (annotated 2026-05-27) — rotate ``bodyFramePositionMm``
by R_body⁻¹ for rows that have a body-frame rotation set.

⚠️ HISTORY NOTE — read before changing this migration:

The original docstring claimed this migration switched
``bodyFramePositionMm`` from CAD-frame to BODY-frame semantics. The
implementation does indeed apply ``R_body⁻¹`` to the stored value, but
the rest of the codebase **never followed through** — every consumer
(``utils/assetFrame.ts``, ``three/opticalBeams.ts``,
``components/Asset3DV3Editor.tsx``,
``backend/app/optical/db_scene_loader.py:_apply_body_frame_to_anchor``,
``frontend/src/utils/anchorAccess.ts``) treats ``bodyFramePositionMm``
as a vector added in **object-local / CAD axes** AFTER the body→CAD
rotation, i.e. Phase 9.10 semantics:

    object_local = R_body × anchor_body + bodyFramePositionMm
                                          ─────────────────────
                                          treated as CAD-axis vector

If this migration ran on a database where ``bodyFramePositionMm`` was
authored under the original Phase 9.10 intent (CAD axes), the upgrade
silently rotated each row's offset by R_body⁻¹ — meaning the value now
stored is **wrong by R_body⁻¹** relative to how the rest of the code
reads it.

Practical impact on a live DB:

* Rows with ``body_frame_rotation = NULL`` (or identity quaternion) —
  rotation is no-op, value unchanged. **Safe.**
* Rows with non-trivial ``body_frame_rotation`` — value rotated once
  by R_body⁻¹ at upgrade. Downgrade undoes it. Anywhere this
  migration sits in the alembic history, the data is offset from
  what the readers expect.

This migration is **kept in place** to preserve alembic linearity, but
the docstring no longer describes the actual semantics in use. See
``docs/frame-anchor-architecture.md §3`` for the canonical write-up
and §15.2 of the same doc for the audit / cleanup plan.

If you are touching this migration, also touch:
* docs/frame-anchor-architecture.md §3 (semantics statement)
* utils/assetFrame.ts (the helper math)
* utils/anchorAccess.ts (the public API)
* backend/app/optical/db_scene_loader.py:_apply_body_frame_to_anchor

Original formulation (for reference — both describe the same rigid
transform, only the parameterization differs):

    Phase 9.10:  display = R_body⁻¹ × (cad_point − origin_cad)
    Phase 9.11:  display = R_body⁻¹ × cad_point − origin_body
    relationship:  origin_body = R_body⁻¹ × origin_cad

Revision ID: 0091_body_frame_position_to_body_frame
Revises: 0090_drop_legacy_kind_columns
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0091_body_frame_position"
down_revision = "0090_drop_legacy_kind_columns"
branch_labels = None
depends_on = None


def _rotate_by_quat(qx: float, qy: float, qz: float, qw: float,
                    vx: float, vy: float, vz: float) -> tuple[float, float, float]:
    """Apply rotation described by quaternion (qx, qy, qz, qw) to vector
    (vx, vy, vz). Uses the standard cross-product formula:

        rotated = v + 2 × q_xyz × (q_xyz × v + q_w × v)
    """
    # First cross: q_xyz × v
    c1x = qy * vz - qz * vy
    c1y = qz * vx - qx * vz
    c1z = qx * vy - qy * vx
    # Add q_w × v
    tx = c1x + qw * vx
    ty = c1y + qw * vy
    tz = c1z + qw * vz
    # Second cross: q_xyz × (c1 + q_w·v)
    c2x = qy * tz - qz * ty
    c2y = qz * tx - qx * tz
    c2z = qx * ty - qy * tx
    # v + 2·c2
    return (vx + 2.0 * c2x, vy + 2.0 * c2y, vz + 2.0 * c2z)


def _transform(qx: float, qy: float, qz: float, qw: float,
               vx: float, vy: float, vz: float,
               *, invert: bool) -> tuple[float, float, float]:
    """If ``invert`` is True, apply R⁻¹ × v (use conjugate quaternion).
    Otherwise apply R × v."""
    if invert:
        return _rotate_by_quat(-qx, -qy, -qz, qw, vx, vy, vz)
    return _rotate_by_quat(qx, qy, qz, qw, vx, vy, vz)


def _migrate(*, invert: bool) -> None:
    """Walk every row with both a ``bodyFramePositionMm`` and a
    ``body_frame_rotation``, rotate the offset by R⁻¹ (upgrade) or R
    (downgrade), and write it back.
    """
    import json
    bind = op.get_bind()
    # `IS NOT NULL` alone doesn't exclude JSONB null (the literal 'null')
    # — only SQL NULL. Filter both so a {bodyFrameRotation: null} row
    # doesn't fall through and get hit with a degenerate quaternion.
    rows = bind.execute(
        sa.text(
            "SELECT id, properties, body_frame_rotation FROM assets_3d "
            "WHERE properties ? 'bodyFramePositionMm' "
            "AND body_frame_rotation IS NOT NULL "
            "AND body_frame_rotation::text != 'null'"
        )
    ).fetchall()
    for row in rows:
        props = dict(row.properties or {})
        bfp = props.get("bodyFramePositionMm") or {}
        rot = row.body_frame_rotation or {}
        try:
            vx = float(bfp.get("x") or 0.0)
            vy = float(bfp.get("y") or 0.0)
            vz = float(bfp.get("z") or 0.0)
            qx = float(rot.get("x") or 0.0)
            qy = float(rot.get("y") or 0.0)
            qz = float(rot.get("z") or 0.0)
            qw = float(rot.get("w") or 0.0)
        except (TypeError, ValueError):
            continue
        # Zero offset is a no-op under either direction.
        if vx == 0.0 and vy == 0.0 and vz == 0.0:
            continue
        nx, ny, nz = _transform(qx, qy, qz, qw, vx, vy, vz, invert=invert)
        props["bodyFramePositionMm"] = {"x": nx, "y": ny, "z": nz}
        bind.execute(
            sa.text("UPDATE assets_3d SET properties = CAST(:p AS JSONB) WHERE id = :id"),
            {"p": json.dumps(props), "id": row.id},
        )


def upgrade() -> None:
    _migrate(invert=True)


def downgrade() -> None:
    _migrate(invert=False)
