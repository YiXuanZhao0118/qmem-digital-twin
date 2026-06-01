"""Regenerate the web-friendly AD9959 LOD mesh.

The `ad9959_pcbz_dds` asset's file_path points at
`assets/files/stl/ad9959_pcbz_lod1.stl`, but that decimated file was an
untracked artifact wiped by a `git clean`. Only the full ~448 MB / ~9 M-tri
`ad9959_pcbz.stl` survives on disk. This rebuilds the LOD in place from it
(quadric decimation to a fixed ~300 k faces — same target as the original
`_decimate_ad9959_stl.py`) so the DB pointer resolves again without a 448 MB
load in the viewer.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import trimesh

REPO_ROOT = Path(__file__).resolve().parents[2]
SRC = REPO_ROOT / "assets" / "files" / "stl" / "ad9959_pcbz.stl"
OUT = REPO_ROOT / "assets" / "files" / "stl" / "ad9959_pcbz_lod1.stl"

TARGET_FACES = 300_000  # ~15 MB, preserves silhouette + SMA jacks / chips


def main() -> int:
    if not SRC.exists():
        print(f"ERROR: source STL not found at {SRC}", file=sys.stderr)
        return 1
    t0 = time.time()
    print(f"[regen] loading {SRC} ({SRC.stat().st_size / 1e6:.1f} MB)")
    mesh = trimesh.load_mesh(SRC)
    print(f"[regen] loaded in {time.time() - t0:.1f}s — {len(mesh.faces)} tris")
    bb = mesh.bounds
    print(
        f"[regen] bbox (mm) = {bb[1][0]-bb[0][0]:.2f} x "
        f"{bb[1][1]-bb[0][1]:.2f} x {bb[1][2]-bb[0][2]:.2f}"
    )
    t = time.time()
    print(f"[regen] simplifying to {TARGET_FACES} tris")
    simplified = mesh.simplify_quadric_decimation(face_count=TARGET_FACES)
    print(
        f"[regen] simplified in {time.time()-t:.1f}s — "
        f"{len(simplified.vertices)} verts / {len(simplified.faces)} tris"
    )
    simplified.export(OUT, file_type="stl")
    print(
        f"[regen] wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB) "
        f"total {time.time()-t0:.1f}s"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
