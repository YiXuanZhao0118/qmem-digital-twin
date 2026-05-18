"""drop per-object aperture overrides

Revision ID: 0059_drop_per_object_aperture
Revises: 0058_agent_messages_json

V2 (alembic 0014) introduced per-instance aperture overrides stored in
``objects.properties`` so users could tune individual optical mounts.
Per 2026-05-18 design reversion (request: "all optical components'
aperture fixed in PHY Editor"), aperture is now strictly asset-level:
edit on Asset3D.anchors[].apertureMm via PHY Editor → Optical →
Components, all SceneObjects sharing the asset share the value.

This migration drains the per-instance override storage from every
SceneObject:

  1. Removes any flat key matching ``<anchorId>_apertureMm`` from
     ``properties`` (e.g. ``intercept_in_apertureMm``).
  2. Removes the ``perAnchorApertures`` map entirely.
  3. Strips ``aperture`` from every ``anchorBindings[].payload``
     (other binding payload fields are preserved).

Idempotent — rerunning is a no-op once the data is clean.

Downgrade
---------
Aperture override data is lost (clean cut, no archival). The downgrade
is a no-op stub; restoring overrides would require a database backup.
"""

from __future__ import annotations

import json
import re

import sqlalchemy as sa

from alembic import op


revision = "0059_drop_per_object_aperture"
down_revision = "0058_agent_messages_json"
branch_labels = None
depends_on = None


_FLAT_APERTURE_KEY = re.compile(r"^.+_apertureMm$")


def upgrade() -> None:
    bind = op.get_bind()

    rows = bind.execute(
        sa.text("SELECT id, properties FROM objects WHERE properties IS NOT NULL")
    ).fetchall()

    for object_id, properties in rows:
        if isinstance(properties, str):
            properties = json.loads(properties)
        if not isinstance(properties, dict):
            continue

        next_props = dict(properties)
        changed = False

        # (1) flat scalar keys: <anchorId>_apertureMm
        for key in list(next_props.keys()):
            if _FLAT_APERTURE_KEY.match(key):
                next_props.pop(key)
                changed = True

        # (2) legacy transitional map
        if "perAnchorApertures" in next_props:
            next_props.pop("perAnchorApertures")
            changed = True

        # (3) aperture inside anchorBindings[].payload
        bindings = next_props.get("anchorBindings")
        if isinstance(bindings, list):
            new_bindings = []
            for b in bindings:
                if not isinstance(b, dict):
                    new_bindings.append(b)
                    continue
                payload = b.get("payload")
                if isinstance(payload, dict) and "aperture" in payload:
                    new_payload = {k: v for k, v in payload.items() if k != "aperture"}
                    new_bindings.append({**b, "payload": new_payload})
                    changed = True
                else:
                    new_bindings.append(b)
            if changed:
                next_props["anchorBindings"] = new_bindings

        if changed:
            bind.execute(
                sa.text(
                    "UPDATE objects SET properties = CAST(:p AS JSONB) WHERE id = :id"
                ),
                {"p": json.dumps(next_props), "id": object_id},
            )


def downgrade() -> None:
    # Clean cut — overrides are not preserved.
    pass
