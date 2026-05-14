"""Decimate the freshly gmsh-meshed AD9959 STL down to a web-friendly size.

The raw STEP→STL conversion produces ~2.5M triangles / ~90 MB, which is
fine for off-line inspection but too heavy for the digital-twin scene
viewer (the largest existing project STL is ~16 MB). We use quadric
edge-collapse decimation (fast-simplification) at a 0.12 keep-ratio,
which preserves the silhouette + SMA jacks while bringing the file under
~15 MB. Also tightens the bounding box by re-checking dimensions, which
the upsert script will pick up.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np
import trimesh

REPO_ROOT = Path(__file__).resolve().parents[2]
SRC_STL = REPO_ROOT / "assets" / "uploads" / "ad9959_pcbz.stl"
OUT_STL = SRC_STL  # in-place rewrite — the 90 MB intermediate is throw-away

TARGET_RATIO = 0.12  # keep 12% of triangles (~300k → smooth silhouette + chips)


def main() -> int:
    if not SRC_STL.exists():
        print(f"ERROR: input STL not found at {SRC_STL}", file=sys.stderr)
        return 1

    t0 = time.time()
    print(f"[decimate] loading {SRC_STL} ({SRC_STL.stat().st_size / 1e6:.2f} MB)")
    mesh = trimesh.load_mesh(SRC_STL)
    print(
        f"[decimate] loaded in {time.time() - t0:.1f}s — "
        f"{len(mesh.vertices)} verts / {len(mesh.faces)} tris"
    )

    bb = mesh.bounds
    print(
        f"[decimate] bbox X[{bb[0][0]:.2f}..{bb[1][0]:.2f}] "
        f"Y[{bb[0][1]:.2f}..{bb[1][1]:.2f}] "
        f"Z[{bb[0][2]:.2f}..{bb[1][2]:.2f}]"
    )
    print(
        f"[decimate] dims (mm) = "
        f"{bb[1][0] - bb[0][0]:.2f} x {bb[1][1] - bb[0][1]:.2f} x {bb[1][2] - bb[0][2]:.2f}"
    )

    target_faces = int(len(mesh.faces) * TARGET_RATIO)
    t_dec = time.time()
    print(f"[decimate] simplifying to {target_faces} tris ({TARGET_RATIO * 100:.0f}%)")
    # trimesh's wrapper uses fast-simplification under the hood
    simplified = mesh.simplify_quadric_decimation(face_count=target_faces)
    print(
        f"[decimate] simplified in {time.time() - t_dec:.1f}s — "
        f"{len(simplified.vertices)} verts / {len(simplified.faces)} tris"
    )

    # Re-centre on PCB centroid so anchors in body-local mm match the asset's
    # natural origin (downstream upsert script uses centred body frame).
    # We DON'T re-centre — keep gmsh's origin so the bounding box I measured
    # (X∈[0,165], Y∈[0,114], Z∈[-5,17]) survives. The upsert script's
    # anchors will be expressed in that same frame.

    simplified.export(OUT_STL, file_type="stl")
    print(
        f"[decimate] wrote {OUT_STL} "
        f"({OUT_STL.stat().st_size / 1e6:.2f} MB) "
        f"total {time.time() - t0:.1f}s"
    )

    # Re-report bbox after decimation as a sanity check.
    bb2 = simplified.bounds
    print(
        f"[decimate] final dims = "
        f"{bb2[1][0] - bb2[0][0]:.3f} x {bb2[1][1] - bb2[0][1]:.3f} x {bb2[1][2] - bb2[0][2]:.3f} mm"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
