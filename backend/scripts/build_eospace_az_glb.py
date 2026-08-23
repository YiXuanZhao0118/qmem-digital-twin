"""Build the GLB for the EOSpace AZ-0S5-20-PFA-PFA-850/900 modulator.

EOSpace publish no CAD, so the mesh is generated the same way the CASIX
waveplates are (``build_casix_zowp_glb.py``): primitives in real mm with
linear COLOR_0 per face group, one PBR material stamped on afterwards
because trimesh writes none.

    backend/.venv/Scripts/python.exe scripts/build_eospace_az_glb.py out.glb

Body frame — **the origin is the INPUT pigtail tip**, the beam runs along
body +X, and the part is symmetric about y = z = 0:

      x=0            x=15                        x=115      x=130
       |  input boot  |       gold housing        | out boot  |
       ●──────────────┼───────────────────────────┼──────────●
   intercept_in                                        intercept_out

so the two optical anchors are exactly (0,0,0) and (130,0,0) with no
offset to remember — the same "origin on the input port" convention the
Sacher TEC-400 asset uses.

⚠ EVERY DIMENSION HERE IS NOMINAL, not measured and not from a drawing.
The photographed unit (S/N 279635) was not on hand when this was authored;
what IS from the part are the label's electro-optic numbers, which live on
the device row, not here. Re-measure the housing and re-run before trusting
a clearance or a mount design against it.
"""
from __future__ import annotations

import json
import struct
import sys

import numpy as np
import trimesh

# ── Nominal geometry (mm) ──────────────────────────────────────────────────
BOOT_MM = 15.0            # fibre strain-relief boot, each end
HOUSING_MM = 100.0        # gold-plated brass body
HOUSING_W = 9.0          # square y-z cross-section: width == height
HOUSING_H = 9.0
TOTAL_MM = 2 * BOOT_MM + HOUSING_MM

BOOT_D_ROOT = 5.0         # boot diameter where it meets the housing
BOOT_D_TIP = 1.6          # ... and at the tip, where the pigtail leaves

SMA_X = 40.0              # RF IN jack centre, from the input tip
SMA_D = 6.35
SMA_H = 9.0

PIN_X = 87.0              # DC bias header (1 case GND / 2 bias / 3-4 NC)
PIN_D = 0.64
PIN_H = 6.0
PIN_PITCH = 2.54

SEGMENTS = 48

# COLOR_0 is LINEAR RGB (the optical-table / TEC-400 / CASIX convention —
# do not convert to sRGB).
GOLD = (0.656, 0.434, 0.040)
BOOT = (0.030, 0.030, 0.035)
SMA_METAL = (0.550, 0.560, 0.580)


def _painted(mesh: trimesh.Trimesh, rgb) -> trimesh.Trimesh:
    colors = np.empty((len(mesh.faces), 4), dtype=np.uint8)
    colors[:, 3] = 255
    colors[:, :3] = np.round(np.array(rgb) * 255).astype(np.uint8)
    mesh.visual.face_colors = colors
    return mesh


def _at(mesh: trimesh.Trimesh, xyz) -> trimesh.Trimesh:
    mesh.apply_translation(xyz)
    return mesh


def _x_cylinder(diameter: float, length: float, x_start: float) -> trimesh.Trimesh:
    """A cylinder along +X, its base at x_start (trimesh builds along +Z)."""
    mesh = trimesh.creation.cylinder(
        radius=diameter / 2.0, height=length, sections=SEGMENTS
    )
    mesh.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [0, 1, 0]))
    return _at(mesh, [x_start + length / 2.0, 0.0, 0.0])


def _boot(x_root: float, sign: float) -> trimesh.Trimesh:
    """Tapered strain relief. `sign` is the direction the tip points in."""
    # A frustum, not a cone: the tip has to be the pigtail's width, not a
    # point. trimesh has no frustum primitive, so taper a cylinder.
    mesh = trimesh.creation.cylinder(radius=BOOT_D_ROOT / 2.0, height=BOOT_MM,
                                     sections=SEGMENTS)
    verts = mesh.vertices.copy()
    z0, z1 = verts[:, 2].min(), verts[:, 2].max()
    t = (verts[:, 2] - z0) / (z1 - z0)                    # 0 at root, 1 at tip
    scale = 1.0 + t * (BOOT_D_TIP / BOOT_D_ROOT - 1.0)
    verts[:, 0] *= scale
    verts[:, 1] *= scale
    mesh.vertices = verts
    # Built along +Z with the root at the bottom: stand it along ±X.
    angle = np.pi / 2 if sign > 0 else -np.pi / 2
    mesh.apply_transform(trimesh.transformations.rotation_matrix(angle, [0, 1, 0]))
    return _at(mesh, [x_root + sign * BOOT_MM / 2.0, 0.0, 0.0])


def build() -> trimesh.Trimesh:
    parts: list[trimesh.Trimesh] = []

    housing = trimesh.creation.box(extents=[HOUSING_MM, HOUSING_W, HOUSING_H])
    parts.append(_painted(_at(housing, [BOOT_MM + HOUSING_MM / 2.0, 0.0, 0.0]), GOLD))

    parts.append(_painted(_boot(BOOT_MM, -1.0), BOOT))                  # input
    parts.append(_painted(_boot(BOOT_MM + HOUSING_MM, +1.0), BOOT))     # output

    sma = trimesh.creation.cylinder(radius=SMA_D / 2.0, height=SMA_H, sections=SEGMENTS)
    parts.append(_painted(_at(sma, [SMA_X, 0.0, HOUSING_H / 2.0 + SMA_H / 2.0]),
                          SMA_METAL))

    for i in range(4):
        pin = trimesh.creation.cylinder(radius=PIN_D / 2.0, height=PIN_H,
                                        sections=12)
        x = PIN_X + (i - 1.5) * PIN_PITCH        # header runs along the body, not across it
        parts.append(_painted(_at(pin, [x, 0.0, HOUSING_H / 2.0 + PIN_H / 2.0]),
                              GOLD))

    return trimesh.util.concatenate(parts)


def set_material(path: str, metallic: float = 0.85, roughness: float = 0.30) -> None:
    """trimesh writes no material, so the viewer falls back to the glTF
    default (metallic 1.0 / rough 1.0) and the part renders dark and dull —
    the same gotcha the TEC-400 and CASIX exports hit.

    One material for the whole file, like those two: the rubber boots
    therefore read as slightly shiny. Cosmetic only.
    """
    blob = open(path, "rb").read()
    j_len = struct.unpack("<I", blob[12:16])[0]
    doc = json.loads(blob[20:20 + j_len])
    rest = blob[20 + j_len:]
    doc["materials"] = [{"name": "eospace_az_housing",
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


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    out = sys.argv[1]
    mesh = build()
    mesh.export(out)
    set_material(out)
    lo, hi = mesh.bounds
    print(f"wrote {out}: {len(mesh.faces)} tris, "
          f"bbox {lo.round(3).tolist()} .. {hi.round(3).tolist()}")


if __name__ == "__main__":
    main()
