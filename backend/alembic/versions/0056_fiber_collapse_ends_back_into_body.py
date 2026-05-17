"""collapse fiber_end SceneObjects back into the fiber body

Revision ID: 0056_fiber_recombine_ends
Revises: 0055_wavelength_range

Reverses 0052. The 3-SceneObject split (body + 2 fiber_ends) is being
collapsed back into a single fiber SceneObject. End A / End B pose are
hoisted into the fiber body PE.kindParams (in body-LOCAL frame) so the
fiber owns its ends entirely: moving/rotating the fiber moves the ends
with it, while per-end Align A / Align B buttons can still adjust each
end independently.

User-facing shape after this migration::

    fiber SceneObject (single Outliner entry; selection covers everything)
      ├── tube (Bezier spline through fiberNodes — interior + endpoints)
      ├── ferrule A  (rendered as child, posed at kindParams.endA pose)
      └── ferrule B  (rendered as child, posed at kindParams.endB pose)

`fiber.kindParams` schema additions::

    endA: {
      posMm:    [x, y, z],    # body-local mm
      rotDeg:   [rx, ry, rz], # body-local Euler XYZ
      tensionHandleMm: [dx, dy, dz],  # in fiber_end body-local frame
      # plus existing physics fields kept from the old endA / endB:
      polish, connectorType, apertureDiameterMm, ...
    }
    endB: ...  # same shape

Upgrade
-------
For every fiber body PE with kindParams.endAObjectId or endBObjectId
set, look up the paired fiber_end SceneObject (+ its PE + properties).
Compute the fiber_end's body-LOCAL pose:

    bodyR = R_z(rz) @ R_y(ry) @ R_x(rx)
    posBody = bodyR.T @ (endLab - bodyLab)
    rotBody = bodyR.T @ endR   (then decomposed back to Euler XYZ)

Merge body-local pose + tensionHandleMm into fiber PE.kindParams.endA /
endB; drop the endAObjectId / endBObjectId pointers; delete the fiber_end
SceneObject (FK cascades drop PE + collection_member). Finally archive
the catalog Component `fiber_end_generic` if no fiber_end SceneObjects
remain across the DB.

Downgrade
---------
Replays the 0052 split logic inline: for every fiber body PE with
non-null endA.posMm / endB.posMm in kindParams, transform those body-
local poses back to lab, INSERT a fresh fiber_end SceneObject + PE +
collection_member pair at the lab pose, restore endAObjectId /
endBObjectId pointers, unarchive fiber_end_generic.
"""

from __future__ import annotations

import json
import math
import uuid

import numpy as np
import sqlalchemy as sa
from scipy.spatial.transform import Rotation

from alembic import op


revision = "0056_fiber_recombine_ends"
down_revision = "0055_wavelength_range"
branch_labels = None
depends_on = None


_FIBER_END_COMPONENT_NAME = "fiber_end_generic"


def _euler_xyz_to_matrix(rx_deg: float, ry_deg: float, rz_deg: float) -> np.ndarray:
    # Match the Euler XYZ convention used in
    # frontend/src/store/sceneStore.ts (createRfCableBetweenPorts.resolvePort)
    # and backend/app/routers/components.py (_body_to_lab_xyz):
    # R = R_z @ R_y @ R_x (intrinsic-order multiplication; applied via
    # right-multiplication onto a column vector → R_x runs first).
    rx = math.radians(rx_deg or 0.0)
    ry = math.radians(ry_deg or 0.0)
    rz = math.radians(rz_deg or 0.0)
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    rx_mat = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    ry_mat = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rz_mat = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return rz_mat @ ry_mat @ rx_mat


def _matrix_to_euler_xyz(mat: np.ndarray) -> tuple[float, float, float]:
    # Inverse of _euler_xyz_to_matrix. scipy.Rotation handles all the
    # gimbal-lock edge cases for us (returns rad → convert to deg).
    rot = Rotation.from_matrix(mat)
    # 'xyz' (lowercase) = intrinsic-order that matches our composition
    # convention (R_z @ R_y @ R_x as a fixed-frame product).
    rx, ry, rz = rot.as_euler("xyz", degrees=True)
    return float(rx), float(ry), float(rz)


def _lab_pose_to_body_local(
    end_lab_pos: tuple[float, float, float],
    end_lab_rot_deg: tuple[float, float, float],
    body_lab_pos: tuple[float, float, float],
    body_lab_rot_deg: tuple[float, float, float],
) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    body_r = _euler_xyz_to_matrix(*body_lab_rot_deg)
    body_r_inv = body_r.T  # rotation matrices are orthogonal
    delta_lab = np.array(end_lab_pos) - np.array(body_lab_pos)
    pos_body = body_r_inv @ delta_lab
    end_r = _euler_xyz_to_matrix(*end_lab_rot_deg)
    rot_body_mat = body_r_inv @ end_r
    rot_body_deg = _matrix_to_euler_xyz(rot_body_mat)
    return (
        (float(pos_body[0]), float(pos_body[1]), float(pos_body[2])),
        rot_body_deg,
    )


def _body_local_to_lab_pose(
    end_body_pos: tuple[float, float, float],
    end_body_rot_deg: tuple[float, float, float],
    body_lab_pos: tuple[float, float, float],
    body_lab_rot_deg: tuple[float, float, float],
) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    body_r = _euler_xyz_to_matrix(*body_lab_rot_deg)
    pos_lab = body_r @ np.array(end_body_pos) + np.array(body_lab_pos)
    end_body_r = _euler_xyz_to_matrix(*end_body_rot_deg)
    rot_lab_mat = body_r @ end_body_r
    rot_lab_deg = _matrix_to_euler_xyz(rot_lab_mat)
    return (
        (float(pos_lab[0]), float(pos_lab[1]), float(pos_lab[2])),
        rot_lab_deg,
    )


def upgrade() -> None:
    conn = op.get_bind()

    # Walk every fiber body PE that points at paired fiber_end objects.
    fibers = conn.execute(
        sa.text(
            """
            SELECT
              pe.id          AS pe_id,
              pe.object_id   AS body_obj_id,
              pe.kind_params AS kind_params,
              o.x_mm         AS body_x,
              o.y_mm         AS body_y,
              o.z_mm         AS body_z,
              o.rx_deg       AS body_rx,
              o.ry_deg       AS body_ry,
              o.rz_deg       AS body_rz
            FROM physics_elements pe
            JOIN objects o ON o.id = pe.object_id
            WHERE pe.element_kind = 'fiber'
            """
        )
    ).fetchall()

    deleted_end_ids: list[str] = []

    for fiber in fibers:
        kp = dict(fiber.kind_params or {})
        end_a_obj_id = kp.get("endAObjectId")
        end_b_obj_id = kp.get("endBObjectId")
        body_pose = (
            (float(fiber.body_x or 0.0), float(fiber.body_y or 0.0), float(fiber.body_z or 0.0)),
            (float(fiber.body_rx or 0.0), float(fiber.body_ry or 0.0), float(fiber.body_rz or 0.0)),
        )

        for end_role, end_obj_id_raw in (("A", end_a_obj_id), ("B", end_b_obj_id)):
            if not end_obj_id_raw:
                continue
            end_obj_id = str(end_obj_id_raw)
            end_row = conn.execute(
                sa.text(
                    """
                    SELECT
                      o.x_mm   AS x, o.y_mm AS y, o.z_mm AS z,
                      o.rx_deg AS rx, o.ry_deg AS ry, o.rz_deg AS rz,
                      o.properties AS props
                    FROM objects o
                    WHERE o.id = :oid
                    """
                ),
                {"oid": end_obj_id},
            ).fetchone()
            if end_row is None:
                # Pointer dangles — drop the field, nothing else to do.
                continue
            end_pe_row = conn.execute(
                sa.text(
                    """
                    SELECT kind_params
                    FROM physics_elements
                    WHERE object_id = :oid AND element_kind = 'fiber_end'
                    """
                ),
                {"oid": end_obj_id},
            ).fetchone()
            end_pe_kp = dict(end_pe_row.kind_params or {}) if end_pe_row else {}

            pos_body, rot_body = _lab_pose_to_body_local(
                (float(end_row.x or 0.0), float(end_row.y or 0.0), float(end_row.z or 0.0)),
                (float(end_row.rx or 0.0), float(end_row.ry or 0.0), float(end_row.rz or 0.0)),
                *body_pose,
            )

            end_props = end_row.props or {}
            tension_handle = end_props.get("tensionHandleMm")
            if not (isinstance(tension_handle, list) and len(tension_handle) == 3):
                tension_handle = [0.0, 30.0, 0.0]

            existing_end_spec = kp.get(f"end{end_role}")
            merged_end = dict(existing_end_spec) if isinstance(existing_end_spec, dict) else {}
            # Pull connector/polish/slowAxis values that may have been
            # adjusted on the fiber_end PE since 0052 — they win over the
            # legacy snapshot left on the fiber body before the split.
            for key in ("connectorType", "polish", "slowAxisDegInBodyFrame", "polishAngleDeg"):
                if end_pe_kp.get(key) is not None:
                    merged_end[key] = end_pe_kp[key]
            merged_end["posMm"] = [pos_body[0], pos_body[1], pos_body[2]]
            merged_end["rotDeg"] = [rot_body[0], rot_body[1], rot_body[2]]
            merged_end["tensionHandleMm"] = [
                float(tension_handle[0]),
                float(tension_handle[1]),
                float(tension_handle[2]),
            ]
            kp[f"end{end_role}"] = merged_end
            deleted_end_ids.append(end_obj_id)

        # Drop the now-obsolete object-id pointers.
        kp.pop("endAObjectId", None)
        kp.pop("endBObjectId", None)

        conn.execute(
            sa.text(
                """
                UPDATE physics_elements
                SET kind_params = CAST(:kp AS JSONB), updated_at = NOW()
                WHERE id = :pe_id
                """
            ),
            {"pe_id": str(fiber.pe_id), "kp": json.dumps(kp)},
        )

    # Delete the now-orphaned fiber_end SceneObjects. PhysicsElements
    # and collection_members cascade via FK ON DELETE CASCADE.
    if deleted_end_ids:
        conn.execute(
            sa.text("DELETE FROM objects WHERE id = ANY(CAST(:ids AS uuid[]))"),
            {"ids": deleted_end_ids},
        )

    # Catch any stray fiber_end SceneObjects that weren't reachable from
    # a fiber body PE (e.g. backfill ran against a fiber that was later
    # deleted, leaving an orphan).
    conn.execute(
        sa.text(
            """
            DELETE FROM objects
            WHERE component_id IN (
              SELECT id FROM components WHERE component_type = 'fiber_end'
            )
            """
        )
    )

    # Archive the generic fiber_end catalog Component — no SceneObject
    # can spawn from it anymore. Soft-archive (not hard-delete) so any
    # external reference (legacy seed scripts, manual scene exports)
    # still resolves to a row.
    conn.execute(
        sa.text(
            """
            UPDATE components
            SET archived_at = NOW(), updated_at = NOW()
            WHERE name = :n AND archived_at IS NULL
            """
        ),
        {"n": _FIBER_END_COMPONENT_NAME},
    )


def downgrade() -> None:
    # Replays the body→3-object split: for every fiber body PE that now
    # carries endA.posMm / endB.posMm in body-local frame, transform back
    # to lab and INSERT fresh fiber_end SceneObjects + PEs +
    # collection_members. Restores the legacy endAObjectId /
    # endBObjectId pointers on the fiber PE.
    conn = op.get_bind()

    # Unarchive (or create) the fiber_end_generic catalog Component.
    existing_comp = conn.execute(
        sa.text("SELECT id FROM components WHERE name = :n LIMIT 1"),
        {"n": _FIBER_END_COMPONENT_NAME},
    ).scalar()
    if existing_comp is not None:
        conn.execute(
            sa.text(
                "UPDATE components SET archived_at = NULL, updated_at = NOW() WHERE id = :id"
            ),
            {"id": str(existing_comp)},
        )
        fiber_end_comp_id = existing_comp
    else:
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

    fibers = conn.execute(
        sa.text(
            """
            SELECT
              pe.id          AS pe_id,
              pe.object_id   AS body_obj_id,
              pe.kind_params AS kind_params,
              o.name         AS body_name,
              o.x_mm         AS body_x,
              o.y_mm         AS body_y,
              o.z_mm         AS body_z,
              o.rx_deg       AS body_rx,
              o.ry_deg       AS body_ry,
              o.rz_deg       AS body_rz
            FROM physics_elements pe
            JOIN objects o ON o.id = pe.object_id
            WHERE pe.element_kind = 'fiber'
            """
        )
    ).fetchall()

    tip_port = {
        "portId": "tip",
        "role": "bidirectional",
        "label": "Ferrule tip",
        "kind": "main",
    }

    for fiber in fibers:
        kp = dict(fiber.kind_params or {})
        body_pose = (
            (float(fiber.body_x or 0.0), float(fiber.body_y or 0.0), float(fiber.body_z or 0.0)),
            (float(fiber.body_rx or 0.0), float(fiber.body_ry or 0.0), float(fiber.body_rz or 0.0)),
        )
        new_pointers: dict[str, str] = {}
        for end_role in ("A", "B"):
            end_spec = kp.get(f"end{end_role}")
            if not isinstance(end_spec, dict):
                continue
            pos_body = end_spec.get("posMm")
            rot_body = end_spec.get("rotDeg") or [0.0, 0.0, 0.0]
            if not (isinstance(pos_body, list) and len(pos_body) == 3):
                continue
            pos_lab, rot_lab = _body_local_to_lab_pose(
                (float(pos_body[0]), float(pos_body[1]), float(pos_body[2])),
                (float(rot_body[0]), float(rot_body[1]), float(rot_body[2])),
                *body_pose,
            )
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
                      :x, :y, :z, :rx, :ry, :rz,
                      true, false,
                      CAST(:props AS JSONB),
                      NOW()
                    )
                    """
                ),
                {
                    "id": str(new_obj_id),
                    "name": f"{fiber.body_name}_end_{end_role.lower()}",
                    "comp": str(fiber_end_comp_id),
                    "x": pos_lab[0], "y": pos_lab[1], "z": pos_lab[2],
                    "rx": rot_lab[0], "ry": rot_lab[1], "rz": rot_lab[2],
                    "props": json.dumps({
                        "tensionHandleMm": end_spec.get(
                            "tensionHandleMm", [0.0, 30.0, 0.0]
                        ),
                    }),
                },
            )
            end_pe_kp = {
                "connectorType": end_spec.get("connectorType"),
                "polish": end_spec.get("polish"),
                "slowAxisDegInBodyFrame": end_spec.get("slowAxisDegInBodyFrame"),
                "fiberBodyObjectId": str(fiber.body_obj_id),
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
                    "inputs": json.dumps([tip_port]),
                    "outputs": json.dumps([]),
                    "params": json.dumps(end_pe_kp),
                },
            )
            if master_collection_id is not None:
                conn.execute(
                    sa.text(
                        """
                        INSERT INTO collection_members (
                          collection_id, object_id, sort_order, added_at
                        ) VALUES (
                          :cid, :oid, 0, NOW()
                        )
                        """
                    ),
                    {"cid": str(master_collection_id), "oid": str(new_obj_id)},
                )
            new_pointers[f"end{end_role}ObjectId"] = str(new_obj_id)
            # Strip body-local pose/tension from the body PE — they
            # live on the fiber_end SceneObject again.
            end_spec.pop("posMm", None)
            end_spec.pop("rotDeg", None)
            end_spec.pop("tensionHandleMm", None)
            kp[f"end{end_role}"] = end_spec
        if new_pointers:
            kp.update(new_pointers)
            conn.execute(
                sa.text(
                    """
                    UPDATE physics_elements
                    SET kind_params = CAST(:kp AS JSONB), updated_at = NOW()
                    WHERE id = :pe_id
                    """
                ),
                {"pe_id": str(fiber.pe_id), "kp": json.dumps(kp)},
            )
