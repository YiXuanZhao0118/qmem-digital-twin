"""Fix fiber SceneObject z_mm from 500 → 860 (optical table surface height)

Revision ID: 0026_fix_fiber_object_height
Revises: 0025_fiber_anchors_rs

Fiber SceneObjects were placed at z_mm = 500 by the asset-library drop
handler, but the Newport RS4000 optical table surface sits at z = 860 mm
in lab frame (TABLE_TOP_HEIGHT_MM = 860 in photoRoom.ts).

At z_mm = 500 the fiber tube renders at world z ≈ 550 mm (SceneObject
500 mm + default fiberNodes offset 50 mm), which falls inside the opaque
table body (403–860 mm).  The table completely occludes the fiber, making
it invisible in the 3D view.

Fix: set z_mm = 860 so the fiber wrapper sits on the table surface.
With the component-level fiberNodes defaulting to local z = 50 mm, the
tube appears 50 mm above the table top (z = 910 mm) — a reasonable
height for a patch cable routed across the table.

Guard: only touch rows whose z_mm is exactly 500 to avoid overwriting
fibers the user has already manually repositioned.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op


revision = "0026_fix_fiber_obj_h"
down_revision = "0025_fiber_anchors_rs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE objects AS o
            SET z_mm = 860
            FROM components AS c
            WHERE o.component_id = c.id
              AND c.component_type = 'fiber'
              AND o.z_mm = 500
            """
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE objects AS o
            SET z_mm = 500
            FROM components AS c
            WHERE o.component_id = c.id
              AND c.component_type = 'fiber'
              AND o.z_mm = 860
            """
        )
    )
