"""split each fiber into a body + two paired fiber_end SceneObjects

Revision ID: 0052_fiber_split_to_paired_ends
Revises: 0051_timing_program_slim

Per Phase fiber-split (spec 2026-05-16):

A `fiber` SceneObject is no longer the user-facing handle for either end.
Instead, every fiber becomes three SceneObjects::

    fiber_end_a   (new)  ── PE.kind = "fiber_end", lab pose = first node
    fiber        (existing, repurposed as body wrapper, hidden from
                  Outliner via capability profile)
    fiber_end_b   (new)  ── PE.kind = "fiber_end", lab pose = last node

Each fiber_end is a first-class SceneObject (own pose, lock, collection /
rigid-group membership, align flow). The body wrapper's two spline
endpoints re-derive at draw time from the two end objects' lab poses
(mirror of rf_cable).

Upgrade
-------
1. Ensure the catalog has a generic `fiber_end_generic` Component
   (componentType=fiber_end). Created with asset_3d_id=NULL; rendering
   uses a procedural ferrule mesh (Phase C).
2. For every existing fiber PhysicsElement:

   a. Read the host SceneObject's pose + `properties.fiberNodes`.
   b. First / last fiberNode = body-local position for end_a / end_b.
   c. Transform body-local → lab via the fiber's Euler XYZ pose. The
      formula matches `createRfCableBetweenPorts.resolvePort` in the
      frontend (see kept-in-sync helper at top of this file).
   d. INSERT two SceneObjects (`<fiber.name>_end_a`, `_end_b`) at the
      lab positions, identity rotation, visible=true, locked=false.
   e. INSERT two PhysicsElements (element_kind=fiber_end) with
      kindParams carrying the per-end values lifted off
      FiberParams.endA / endB (connectorType, polish, slowAxis) plus
      `fiberBodyObjectId = <fiber.object_id>` and `endRole = "A" / "B"`.
   f. INSERT two CollectionMembers tying the ends to whichever
      collection the fiber currently belongs to.
   g. UPDATE the fiber PhysicsElement's kindParams to set
      `endAObjectId` / `endBObjectId` pointing to the new SceneObjects.

Downgrade
---------
Reverses by deleting every fiber_end PhysicsElement + its SceneObject +
CollectionMember rows, clearing endAObjectId / endBObjectId on the
fiber kindParams, and (if no fiber_end SceneObjects remain) archiving
the generic catalog Component. The per-end values stay in fiber's
endA / endB sub-objects so a downgrade preserves the old in-fiber
state.
"""

from __future__ import annotations

import json
import math
import uuid

import sqlalchemy as sa

from alembic import op


revision = "0052_fiber_split_to_paired_ends"
down_revision = "0051_timing_program_slim"
branch_labels = None
depends_on = None


# Body-local → lab transform. Matches the Euler XYZ composition used in
# `frontend/src/store/sceneStore.ts` (`createRfCableBetweenPorts.resolvePort`
# `apply()` helper) so the new fiber_end lab positions exactly coincide
# with the original spline endpoints at the moment of migration.
def _body_to_lab(
    p: tuple[float, float, float],
    x: float,
    y: float,
    z: float,
    rx_deg: float,
    ry_deg: float,
    rz_deg: float,
) -> tuple[float, float, float]:
    rx = math.radians(rx_deg or 0.0)
    ry = math.radians(ry_deg or 0.0)
    rz = math.radians(rz_deg or 0.0)
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    px, py, pz = p
    x1 = cy * px + sy * pz
    y1 = py
    z1 = -sy * px + cy * pz
    y2 = cx * y1 - sx * z1
    z2 = sx * y1 + cx * z1
    return (
        (x or 0.0) + cz * x1 - sz * y2,
        (y or 0.0) + sz * x1 + cz * y2,
        (z or 0.0) + z2,
    )


# Default tip port — must match DEFAULT_PORTS["fiber_end"] in schemas.py.
_TIP_PORT = {
    "portId": "tip",
    "role": "bidirectional",
    "label": "Ferrule tip",
    "kind": "main",
}


_FIBER_END_COMPONENT_NAME = "fiber_end_generic"


def upgrade() -> None:
    conn = op.get_bind()

    # 1. Ensure the catalog has a generic fiber_end Component. If a row
    #    already exists (idempotent re-run), reuse it. The Component has
    #    no Asset3D — Phase C renders procedurally from the SceneObject's
    #    lab pose, like fiber itself.
    existing_comp = conn.execute(
        sa.text(
            "SELECT id FROM components WHERE name = :n AND archived_at IS NULL LIMIT 1"
        ),
        {"n": _FIBER_END_COMPONENT_NAME},
    ).scalar()
    if existing_comp is None:
        fiber_end_comp_id = uuid.uuid4()
        conn.execute(
            sa.text(
                """
                INSERT INTO components (
                  id, name, component_type, brand, model,
                  asset_3d_id, physics_capabilities, properties,
                  created_at, updated_at
                ) VALUES (
                  :id, :name, 'fiber_end', :brand, :model,
                  NULL,
                  CAST(:phys AS JSONB),
                  CAST(:props AS JSONB),
                  NOW(), NOW()
                )
                """
            ),
            {
                "id": str(fiber_end_comp_id),
                "name": _FIBER_END_COMPONENT_NAME,
                "brand": "Generic",
                "model": "Fiber End (procedural ferrule)",
                "phys": json.dumps(["optical"]),
                "props": json.dumps({}),
            },
        )
    else:
        fiber_end_comp_id = existing_comp

    # 2. Resolve the master collection (singleton with parent_id IS NULL,
    #    oldest by created_at — same heuristic as get_master_collection).
    master_collection_id = conn.execute(
        sa.text(
            """
            SELECT id FROM collections
            WHERE parent_id IS NULL
            ORDER BY created_at ASC
            LIMIT 1
            """
        )
    ).scalar()

    # 3. Walk every fiber PhysicsElement.
    fiber_rows = conn.execute(
        sa.text(
            """
            SELECT
              pe.id AS pe_id,
              pe.object_id AS fiber_obj_id,
              pe.kind_params AS kind_params,
              o.name AS fiber_name,
              o.x_mm AS x_mm,
              o.y_mm AS y_mm,
              o.z_mm AS z_mm,
              o.rx_deg AS rx_deg,
              o.ry_deg AS ry_deg,
              o.rz_deg AS rz_deg,
              o.properties AS obj_props
            FROM physics_elements pe
            JOIN objects o ON o.id = pe.object_id
            WHERE pe.element_kind = 'fiber'
            """
        )
    ).fetchall()

    for row in fiber_rows:
        obj_props = row.obj_props or {}
        nodes = obj_props.get("fiberNodes") if isinstance(obj_props, dict) else None
        if not isinstance(nodes, list) or len(nodes) < 2:
            # Degenerate fiber (no spline yet) — skip; user can re-anchor
            # both ends manually after migration.
            continue
        first_pos = nodes[0].get("posMm") if isinstance(nodes[0], dict) else None
        last_pos = nodes[-1].get("posMm") if isinstance(nodes[-1], dict) else None
        if not (
            isinstance(first_pos, list)
            and isinstance(last_pos, list)
            and len(first_pos) == 3
            and len(last_pos) == 3
        ):
            continue

        kind_params = row.kind_params or {}
        # Pull per-end specs off the legacy inline endA / endB. Anything
        # missing falls through as None in the fiber_end's kindParams so
        # the auto-create defaults take over on next round-trip.
        end_a_spec = (
            kind_params.get("endA") if isinstance(kind_params.get("endA"), dict) else {}
        )
        end_b_spec = (
            kind_params.get("endB") if isinstance(kind_params.get("endB"), dict) else {}
        )

        end_a_lab = _body_to_lab(
            (float(first_pos[0]), float(first_pos[1]), float(first_pos[2])),
            float(row.x_mm or 0.0),
            float(row.y_mm or 0.0),
            float(row.z_mm or 0.0),
            float(row.rx_deg or 0.0),
            float(row.ry_deg or 0.0),
            float(row.rz_deg or 0.0),
        )
        end_b_lab = _body_to_lab(
            (float(last_pos[0]), float(last_pos[1]), float(last_pos[2])),
            float(row.x_mm or 0.0),
            float(row.y_mm or 0.0),
            float(row.z_mm or 0.0),
            float(row.rx_deg or 0.0),
            float(row.ry_deg or 0.0),
            float(row.rz_deg or 0.0),
        )

        # Find the collection the fiber currently sits in (any membership
        # — fall back to master if none, defensive).
        fiber_collection = conn.execute(
            sa.text(
                "SELECT collection_id FROM collection_members WHERE object_id = :o LIMIT 1"
            ),
            {"o": str(row.fiber_obj_id)},
        ).scalar() or master_collection_id

        for end_role, end_lab, end_spec, end_suffix in (
            ("A", end_a_lab, end_a_spec, "_end_a"),
            ("B", end_b_lab, end_b_spec, "_end_b"),
        ):
            new_obj_id = uuid.uuid4()
            conn.execute(
                sa.text(
                    """
                    INSERT INTO objects (
                      id, name, component_id,
                      x_mm, y_mm, z_mm, rx_deg, ry_deg, rz_deg,
                      visible, locked, properties, updated_at
                    ) VALUES (
                      :id, :name, :comp,
                      :x, :y, :z, 0, 0, 0,
                      true, false,
                      CAST(:props AS JSONB),
                      NOW()
                    )
                    """
                ),
                {
                    "id": str(new_obj_id),
                    "name": f"{row.fiber_name}{end_suffix}",
                    "comp": str(fiber_end_comp_id),
                    "x": end_lab[0],
                    "y": end_lab[1],
                    "z": end_lab[2],
                    "props": json.dumps({}),
                },
            )

            fiber_end_kp = {
                "connectorType": end_spec.get("connectorType"),
                "polish": end_spec.get("polish"),
                "slowAxisDegInBodyFrame": end_spec.get("slowAxisDegInBodyFrame"),
                "fiberBodyObjectId": str(row.fiber_obj_id),
                "endRole": end_role,
            }
            conn.execute(
                sa.text(
                    """
                    INSERT INTO physics_elements (
                      id, object_id, element_kind,
                      wavelength_range_nm, input_ports, output_ports, kind_params,
                      created_at, updated_at
                    ) VALUES (
                      gen_random_uuid(), :oid, 'fiber_end',
                      CAST(:wave AS JSONB),
                      CAST(:inputs AS JSONB),
                      CAST(:outputs AS JSONB),
                      CAST(:params AS JSONB),
                      NOW(), NOW()
                    )
                    """
                ),
                {
                    "oid": str(new_obj_id),
                    "wave": json.dumps([400.0, 1100.0]),
                    "inputs": json.dumps([_TIP_PORT]),
                    "outputs": json.dumps([]),
                    "params": json.dumps(fiber_end_kp),
                },
            )

            conn.execute(
                sa.text(
                    """
                    INSERT INTO collection_members (
                      collection_id, object_id, sort_order, added_at
                    ) VALUES (
                      :c, :o, 0, NOW()
                    )
                    """
                ),
                {"c": str(fiber_collection), "o": str(new_obj_id)},
            )

            if end_role == "A":
                end_a_obj_id = new_obj_id
            else:
                end_b_obj_id = new_obj_id

        # 4. Update the fiber's kindParams: link to the two new
        #    SceneObjects. The legacy endA / endB sub-dicts are kept
        #    in place so a downgrade can re-read them; cleanup is
        #    deferred to a later phase.
        next_kp = dict(kind_params)
        next_kp["endAObjectId"] = str(end_a_obj_id)
        next_kp["endBObjectId"] = str(end_b_obj_id)
        conn.execute(
            sa.text(
                "UPDATE physics_elements SET kind_params = CAST(:p AS JSONB), updated_at = NOW() WHERE id = :id"
            ),
            {"p": json.dumps(next_kp), "id": str(row.pe_id)},
        )


def downgrade() -> None:
    conn = op.get_bind()

    # Capture every fiber_end SceneObject + its PhysicsElement before we
    # delete (so we can also strip the back-references on the paired
    # fiber row in a single pass).
    fiber_end_rows = conn.execute(
        sa.text(
            """
            SELECT
              pe.id AS pe_id,
              pe.object_id AS obj_id,
              pe.kind_params AS kind_params
            FROM physics_elements pe
            WHERE pe.element_kind = 'fiber_end'
            """
        )
    ).fetchall()

    affected_fiber_ids: set[str] = set()
    end_object_ids: list[str] = []
    for r in fiber_end_rows:
        kp = r.kind_params or {}
        fiber_id = kp.get("fiberBodyObjectId") if isinstance(kp, dict) else None
        if fiber_id:
            affected_fiber_ids.add(str(fiber_id))
        end_object_ids.append(str(r.obj_id))

    if end_object_ids:
        # Delete the fiber_end PhysicsElements first to avoid the FK
        # cascade dragging children unexpectedly.
        conn.execute(
            sa.text(
                "DELETE FROM physics_elements WHERE element_kind = 'fiber_end'"
            )
        )
        conn.execute(
            sa.text(
                "DELETE FROM collection_members WHERE object_id = ANY(CAST(:ids AS UUID[]))"
            ),
            {"ids": "{" + ",".join(end_object_ids) + "}"},
        )
        conn.execute(
            sa.text(
                "DELETE FROM objects WHERE id = ANY(CAST(:ids AS UUID[]))"
            ),
            {"ids": "{" + ",".join(end_object_ids) + "}"},
        )

    # Strip endAObjectId / endBObjectId off the paired fiber rows so the
    # legacy single-fiber code path is consistent again.
    for fiber_obj_id in affected_fiber_ids:
        row = conn.execute(
            sa.text(
                "SELECT id, kind_params FROM physics_elements WHERE object_id = :o AND element_kind = 'fiber'"
            ),
            {"o": fiber_obj_id},
        ).fetchone()
        if row is None:
            continue
        kp = dict(row.kind_params or {})
        kp.pop("endAObjectId", None)
        kp.pop("endBObjectId", None)
        conn.execute(
            sa.text(
                "UPDATE physics_elements SET kind_params = CAST(:p AS JSONB), updated_at = NOW() WHERE id = :id"
            ),
            {"p": json.dumps(kp), "id": str(row.id)},
        )

    # Archive the catalog Component if it has no live SceneObjects left.
    # Hard-delete only if nothing references it (keeps history clean).
    remaining = conn.execute(
        sa.text(
            """
            SELECT COUNT(*) FROM objects o
            JOIN components c ON c.id = o.component_id
            WHERE c.name = :n
            """
        ),
        {"n": _FIBER_END_COMPONENT_NAME},
    ).scalar() or 0
    if remaining == 0:
        conn.execute(
            sa.text(
                """
                UPDATE components
                SET archived_at = NOW()
                WHERE name = :n AND archived_at IS NULL
                """
            ),
            {"n": _FIBER_END_COMPONENT_NAME},
        )
