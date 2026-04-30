"""Procedurally build a simple TOSA (Transmitter Optical Subassembly)
laser-diode model and write it to assets/uploads.

Geometry approximation (mm):
- Main body cuboid:   12 W (X) x 10 H (Y) x 10 D (Z), optical axis along +X
- Front face flange:  thin square plate on +X face (slightly larger than body)
- Window bezel:       short cylinder protruding from front face, ID/OD ring
- Glass window disk:  thin disk inside the bezel (rendered separately so it
                      colors differently if textured)
- Two side leads:     thin rectangular pins protruding from +Y/-Y midpoints
- Bottom mounting toe:thin tab below the body
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import trimesh


def main(out_path: Path) -> None:
    parts: list[trimesh.Trimesh] = []

    # Body cuboid: 12 (X, optical axis) x 10 (Y) x 10 (Z), centered at origin
    body = trimesh.creation.box(extents=(12.0, 10.0, 10.0))
    parts.append(body)

    # Front flange: thin plate slightly bigger than body, glued to +X face
    flange_thickness = 0.6
    flange = trimesh.creation.box(extents=(flange_thickness, 11.0, 11.0))
    flange.apply_translation((6.0 + flange_thickness / 2.0, 0.0, 0.0))
    parts.append(flange)

    # Window bezel: cylinder centered on flange, axis along X
    bezel_outer = 4.5
    bezel_inner = 3.5
    bezel_depth = 1.2
    # Outer wall
    bezel_outer_cyl = trimesh.creation.annulus(
        r_min=bezel_inner,
        r_max=bezel_outer,
        height=bezel_depth,
    )
    # annulus is along +Z by default; rotate so its axis is +X
    bezel_outer_cyl.apply_transform(
        trimesh.transformations.rotation_matrix(np.pi / 2.0, (0.0, 1.0, 0.0))
    )
    bezel_outer_cyl.apply_translation(
        (6.0 + flange_thickness + bezel_depth / 2.0, 0.0, 0.0)
    )
    parts.append(bezel_outer_cyl)

    # Glass window disk inside the bezel (slightly recessed)
    window = trimesh.creation.cylinder(radius=bezel_inner - 0.05, height=0.25, sections=64)
    window.apply_transform(
        trimesh.transformations.rotation_matrix(np.pi / 2.0, (0.0, 1.0, 0.0))
    )
    window.apply_translation((6.0 + flange_thickness + 0.15, 0.0, 0.0))
    parts.append(window)

    # Side leads: thin pins exiting +Y and -Y faces near the front of the body
    lead_length = 6.0
    lead_section = 0.6
    lead_y_extent = lead_length
    for sign in (1.0, -1.0):
        lead = trimesh.creation.box(extents=(lead_section, lead_y_extent, lead_section))
        lead.apply_translation((-2.0, sign * (5.0 + lead_y_extent / 2.0), 0.0))
        parts.append(lead)

    # Bottom mounting toe (small flange below the body)
    toe = trimesh.creation.box(extents=(8.0, 1.5, 12.0))
    toe.apply_translation((0.0, -5.0 - 0.75, 0.0))
    parts.append(toe)

    combined = trimesh.util.concatenate(parts)
    combined.merge_vertices()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    combined.export(out_path)
    print(f"Wrote {out_path} ({out_path.stat().st_size} bytes)")
    print(f"  triangles: {len(combined.faces)}")
    print(f"  bounding box: {combined.bounding_box.extents.tolist()} mm")


if __name__ == "__main__":
    target = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else Path(__file__).resolve().parents[1] / "assets" / "uploads" / "dbr_852_tosa.stl"
    )
    main(target)
