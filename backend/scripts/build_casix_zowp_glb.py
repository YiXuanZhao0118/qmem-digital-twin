"""Build the GLB for a CASIX cemented zero-order waveplate (Ø25.4 mm).

No CAD source exists for these plates, so the mesh is generated: a plain
disc of quartz, body +Z = optical axis, centred on the origin (so the
``intercept_in`` anchor sits mid-plate). The flat faces and the ground rim
get different colours so the plate reads as an optic edge-on.

    backend/.venv/Scripts/python.exe scripts/build_casix_zowp_glb.py out.glb
"""
from __future__ import annotations

import json
import struct
import sys

import numpy as np
import trimesh

DIAMETER_MM = 25.4
THICKNESS_MM = 2.1   # cemented zero-order: two quartz plates, total thickness
SEGMENTS = 128

# COLOR_0 is linear RGB (same convention as the TEC-400 / optical-table GLBs).
FACE_RGB = (0.571, 0.729, 0.828)   # pale blue AR-coated face
RIM_RGB = (0.470, 0.530, 0.560)    # ground edge


def build() -> trimesh.Trimesh:
    mesh = trimesh.creation.cylinder(
        radius=DIAMETER_MM / 2.0, height=THICKNESS_MM, sections=SEGMENTS
    )
    # Cylinder axis is +Z already; trimesh centres it on the origin.
    normals = mesh.face_normals
    is_cap = np.abs(normals[:, 2]) > 0.5
    colors = np.empty((len(mesh.faces), 4), dtype=np.uint8)
    colors[:, 3] = 255
    colors[is_cap, :3] = np.round(np.array(FACE_RGB) * 255).astype(np.uint8)
    colors[~is_cap, :3] = np.round(np.array(RIM_RGB) * 255).astype(np.uint8)
    mesh.visual.face_colors = colors
    return mesh


def set_material(path: str, metallic: float = 0.0, roughness: float = 0.12) -> None:
    """trimesh writes no material, so the viewer falls back to the glTF
    default (metallic 1.0 / rough 1.0) and the plate renders dark."""
    blob = open(path, "rb").read()
    j_len = struct.unpack("<I", blob[12:16])[0]
    doc = json.loads(blob[20:20 + j_len])
    rest = blob[20 + j_len:]
    doc["materials"] = [{"name": "quartz",
                         "pbrMetallicRoughness": {"metallicFactor": metallic,
                                                  "roughnessFactor": roughness}}]
    for m in doc["meshes"]:
        for prim in m["primitives"]:
            prim["material"] = 0
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    out = b"glTF" + struct.pack("<II", 2, 12 + 8 + len(js) + len(rest))
    out += struct.pack("<I", len(js)) + b"JSON" + js + rest
    open(path, "wb").write(out)


if __name__ == "__main__":
    dst = sys.argv[1]
    mesh = build()
    trimesh.Scene(mesh).export(dst)
    set_material(dst)
    lo, hi = mesh.bounds
    print(f"{dst}: tris={len(mesh.faces)} bbox={np.round(hi - lo, 4).tolist()} mm "
          f"centre={np.round((hi + lo) / 2, 4).tolist()}")
