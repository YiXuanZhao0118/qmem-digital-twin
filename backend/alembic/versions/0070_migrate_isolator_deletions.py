"""migrate isolator deletedCentroids from Component → Asset3D.viewerHints

Revision ID: 0070_migrate_isolator_deletions
Revises: 0069_fix_viewer_hints_bundled

Stage A''.10 (data-only sub-step) — moves the STL triangle deletion
data from ``Component.properties.isolatorDeletedCentroids`` to
``Asset3D.properties.viewerHints.deletedCentroids`` so the generic
loader's ``applyViewerHintsToGeometry`` path (A''.2) handles it
instead of the bespoke ``applyIsolatorDeletionFilter`` inside
pbsOverlay. The deletion list is conceptually a property of the
STL geometry, not of any particular Component that uses it — moving
to the asset means re-pointing any other Component at the same STL
inherits the deletion automatically.

Note on the IOT rotation ring (the other half of A''.10's scope):
``Component.properties.isolatorLinkedRotationGroup`` is NOT
populated for any IOT model in the dev catalogue today (verified
pre-migration). When the user authors a rotation ring via the
IsolatorDevPage UI it'll need a separate migration to express it as
a ``viewerHints.includeOnlyCentroids`` split + binding tree Mount
with tunable.rotation_deg — deferred until there's real data to
migrate.

Idempotent — skips Components whose isolatorDeletedCentroids is
empty/null, and merges into existing viewerHints rather than
overwriting (so A''.9's bundledOverlay=false survives).
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0070_migrate_isolator_deletions"
down_revision = "0069_fix_viewer_hints_bundled"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            """
            SELECT c.id AS cid, c.asset_3d_id,
                   c.properties->'isolatorDeletedCentroids' AS centroids
              FROM components c
             WHERE c.component_type = 'isolator'
               AND c.asset_3d_id IS NOT NULL
               AND jsonb_array_length(
                     COALESCE(c.properties->'isolatorDeletedCentroids', '[]'::jsonb)
                   ) > 0
            """
        )
    ).fetchall()

    for row in rows:
        centroids_json = json.dumps(list(row.centroids))
        # Merge into Asset3D.properties.viewerHints, preserving the
        # bundledOverlay flag (and any future viewerHints siblings).
        bind.execute(
            sa.text(
                """
                UPDATE assets_3d
                   SET properties = jsonb_set(
                         jsonb_set(
                           COALESCE(properties, '{}'::jsonb),
                           '{viewerHints}',
                           COALESCE(properties->'viewerHints', '{}'::jsonb),
                           true
                         ),
                         '{viewerHints,deletedCentroids}',
                         CAST(:centroids AS jsonb),
                         true
                       )
                 WHERE id = :aid
                """
            ),
            {"centroids": centroids_json, "aid": row.asset_3d_id},
        )
        # Clear the Component-side copy so the generic loader is the
        # sole reader (matches the "single source of truth" principle).
        bind.execute(
            sa.text(
                """
                UPDATE components
                   SET properties = properties - 'isolatorDeletedCentroids'
                 WHERE id = :cid
                """
            ),
            {"cid": row.cid},
        )


def downgrade() -> None:
    bind = op.get_bind()
    # Move asset-level deletedCentroids back to the consuming Component
    # (the first one we find, if multiple Components share an asset).
    rows = bind.execute(
        sa.text(
            """
            SELECT a.id AS aid,
                   a.properties#>'{viewerHints,deletedCentroids}' AS centroids
              FROM assets_3d a
             WHERE a.properties #> '{viewerHints,deletedCentroids}' IS NOT NULL
            """
        )
    ).fetchall()
    for row in rows:
        bind.execute(
            sa.text(
                """
                UPDATE components
                   SET properties = jsonb_set(
                         COALESCE(properties, '{}'::jsonb),
                         '{isolatorDeletedCentroids}',
                         CAST(:c AS jsonb),
                         true
                       )
                 WHERE asset_3d_id = :aid
                """
            ),
            {"c": json.dumps(list(row.centroids)), "aid": row.aid},
        )
        bind.execute(
            sa.text(
                """
                UPDATE assets_3d
                   SET properties = properties #- '{viewerHints,deletedCentroids}'
                 WHERE id = :aid
                """
            ),
            {"aid": row.aid},
        )
