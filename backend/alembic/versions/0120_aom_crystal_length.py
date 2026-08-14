"""AOM crystalLengthMm: 25 -> 22.4 mm (MT80-A1.5-IR datasheet).

Decided 2026-08-14 with the user. The 25.0 was a rounded guess at the housing;
the AA MT80-A1.5-IR datasheet gives **Size 59.5 x 22.4 x 17.3 mm**, and 22.4 mm
is exactly the dimension the beam crosses -- it equals the live asset's
``intercept_in`` (y=-11.2) -> ``intercept_out`` (y=+11.2) separation. So the
slab propagation (L/n) and the optical path length now agree with the anchor
geometry instead of contradicting it.

The value matters more since the Bragg detune became order-aware (commit
d797cca): the external half-width to the first sinc^2 null is ``n*v/(f*L)``, so
L sets how sharply the cell selects +1 vs -1 --
  L = 22.4 mm -> +/-5.3 mrad, Klein-Cook Q ~ 18 (a proper Bragg cell)
  L =  1.6 mm -> +/-74  mrad, Q ~ 1.4 (near Raman-Nath; +/-1 indistinguishable)
The datasheet does NOT publish an acousto-optic interaction length, so 22.4 mm
(the only length it does give along the beam) is the defensible choice; see
``docs/aom-model.md``.

Touches both places the number is stored:
  - ``assets_3d.default_params`` for kind_id = 'aom' (what the live anchor
    tracer reads), and
  - ``physics_elements.kind_params`` for element_kind = 'aom' (legacy readers /
    panels), so the two can't disagree.
Only rows still carrying the old 25.0 are rewritten -- a hand-tuned value
survives.

Revision ID: 0120_aom_crystal_length
Revises: 0119_text_annotation_asset
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op


revision = "0120_aom_crystal_length"
down_revision = "0119_text_annotation_asset"
branch_labels = None
depends_on = None

_OLD_MM = 25.0
_NEW_MM = 22.4


def _rewrite(old: float, new: float) -> None:
    bind = op.get_bind()
    for table, col, kind_col, kind in (
        ("assets_3d", "default_params", "kind_id", "aom"),
        ("physics_elements", "kind_params", "element_kind", "aom"),
    ):
        bind.execute(
            sa.text(
                f"UPDATE {table} "
                f"SET {col} = jsonb_set("
                f"        {col}::jsonb, '{{crystalLengthMm}}',"
                f"        to_jsonb(CAST(:new AS double precision))"
                f"    ) "
                f"WHERE {kind_col} = '{kind}' "
                f"  AND jsonb_exists({col}::jsonb, 'crystalLengthMm') "
                f"  AND CAST({col}->>'crystalLengthMm' AS double precision) = :old"
            ),
            {"new": new, "old": old},
        )


def upgrade() -> None:
    _rewrite(_OLD_MM, _NEW_MM)


def downgrade() -> None:
    _rewrite(_NEW_MM, _OLD_MM)
