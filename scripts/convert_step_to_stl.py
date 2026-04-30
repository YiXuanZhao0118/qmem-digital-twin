from __future__ import annotations

import sys
from pathlib import Path

import FreeCAD
import Import
import Mesh
import MeshPart


def main() -> int:
    if len(sys.argv) == 1:
        repo_root = Path(__file__).resolve().parents[1]
        input_path = repo_root / "assets" / "uploads" / "603e2c4d-fe81-497d-9953-9440f722f102_cf175c_m-p5-step.step"
        output_path = repo_root / "assets" / "uploads" / "cf175c_m-p5.stl"
    elif len(sys.argv) == 3:
        input_path = Path(sys.argv[1]).resolve()
        output_path = Path(sys.argv[2]).resolve()
    else:
        print("Usage: convert_step_to_stl.py input.step output.stl")
        return 2
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not input_path.is_file():
        print(f"Input file not found: {input_path}")
        return 1

    doc = FreeCAD.newDocument("cad_import")
    Import.insert(str(input_path), doc.Name)
    doc.recompute()

    shape_objects = [
        obj
        for obj in doc.Objects
        if hasattr(obj, "Shape") and obj.Shape and not obj.Shape.isNull()
    ]
    if not shape_objects:
        print(f"No shape objects found in: {input_path}")
        return 1

    mesh = Mesh.Mesh()
    for obj in shape_objects:
        part_mesh = MeshPart.meshFromShape(
            Shape=obj.Shape,
            LinearDeflection=0.05,
            AngularDeflection=0.261799,
            Relative=False,
        )
        mesh.addMesh(part_mesh)

    mesh.write(str(output_path))
    print(f"Exported {len(shape_objects)} object(s) to {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
