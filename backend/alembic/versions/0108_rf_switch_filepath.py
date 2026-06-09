"""fix ZYSWA-2-50DR rf_switch asset file_path

The Mini-Circuits ZYSWA-2-50DR switch asset was stored with the malformed
file_path ``procedural:rf_switch`` (single colon, unregistered key). The
COMPONENT preview dispatches by kindId so it rendered fine, but the lab
viewer (Object Sense) routes purely on file_path in loadAssetObject: the
value isn't ``primitive://*``, isn't one of the two registered
``procedural://*`` builders, and has no viewer-ready extension, so it fell
through to the magenta wireframe-box placeholder.

Realign it with its sibling primitive RF device (primitive_rf_amplifier ->
``primitive://rf_amplifier``): ``primitive://rf_switch`` hits the
createPrimitive branch, which dispatches the kind's renderer by kindId
(createMinicircuitsZyswa250dr). The ``//`` key is not parsed, so any
``primitive://`` value works; we name it ``rf_switch`` for clarity.

Revision ID: 0108_rf_switch_filepath
Revises: 0107_rename_anchor_template
Create Date: 2026-06-09 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0108_rf_switch_filepath"
down_revision = "0107_rename_anchor_template"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "UPDATE assets_3d SET file_path = 'primitive://rf_switch' "
            "WHERE file_path = 'procedural:rf_switch'"
        )
    )


def downgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "UPDATE assets_3d SET file_path = 'procedural:rf_switch' "
            "WHERE name = 'minicircuits_zyswa_2_50dr_asset' "
            "AND file_path = 'primitive://rf_switch'"
        )
    )
