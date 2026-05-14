"""Post-process the AD9959 STL: re-centre to body-local frame + detect SMAs.

gmsh emits the converted STL in a corner-anchored frame (X∈[0,165.1],
Y∈[0,114.3]). The project convention for STL assets is body-local mm
with the origin at the part's geometric centre (Z-up, so the PCB
surfaces straddle z≈0). This script shifts the mesh into that frame
and then probes the +Y / −Y / +X / −X edges for vertex clusters whose
local geometry matches an SMA bulkhead jack (5/16" hex flange + ~3 mm
coaxial barrel) so the upsert anchor table can pick connector positions
from real geometry rather than guesswork.
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import numpy as np
import trimesh

REPO_ROOT = Path(__file__).resolve().parents[2]
STL_PATH = REPO_ROOT / "assets" / "uploads" / "ad9959_pcbz.stl"


def detect_edge_features(mesh: trimesh.Trimesh, edge_label: str, normal: np.ndarray) -> None:
    """Print vertex Y-coordinate histogram along an edge to spot SMA hex flanges.

    `normal` selects the edge: e.g. [+1,0,0] → +X edge.  We grab the
    slice of vertices within ~5 mm of that edge and bin them along the
    perpendicular axis to surface clusters that correspond to connectors
    sticking out of the board.
    """
    axis = int(np.argmax(np.abs(normal)))
    sign = int(np.sign(normal[axis]))
    bbox = mesh.bounds
    edge_value = bbox[1 if sign > 0 else 0, axis]

    near_edge = mesh.vertices[
        np.abs(mesh.vertices[:, axis] - edge_value) < 4.0
    ]
    if near_edge.shape[0] == 0:
        print(f"[{edge_label}] no vertices within 4 mm of edge — skipping")
        return

    perp_axis = 1 if axis == 0 else 0  # if we're on ±X, look at Y; on ±Y, look at X
    coords = near_edge[:, perp_axis]
    z_coords = near_edge[:, 2]
    # Restrict to vertices above the PCB substrate where SMA jack bodies live.
    pcb_mask = z_coords > 1.0
    coords = coords[pcb_mask]
    if coords.size == 0:
        print(f"[{edge_label}] no above-PCB vertices on edge — skipping")
        return

    # Histogram with 2 mm bins along the perpendicular axis.
    perp_min, perp_max = coords.min(), coords.max()
    n_bins = int(np.ceil((perp_max - perp_min) / 2.0)) or 1
    hist, edges = np.histogram(coords, bins=n_bins, range=(perp_min, perp_max))

    # Find peaks (bins with > 200 vertices — SMA jack flange has many).
    peak_bin_centres = []
    for i, count in enumerate(hist):
        if count > 200:
            centre = (edges[i] + edges[i + 1]) / 2
            peak_bin_centres.append((round(centre, 1), int(count)))

    print(
        f"[{edge_label}] edge_value={edge_value:.2f} "
        f"perp_axis={'XYZ'[perp_axis]} "
        f"verts_in_slice={near_edge.shape[0]} "
        f"above_pcb={coords.size}"
    )
    if peak_bin_centres:
        print(f"[{edge_label}] vertex-density peaks: {peak_bin_centres}")


def main() -> int:
    if not STL_PATH.exists():
        print(f"ERROR: STL not found at {STL_PATH}", file=sys.stderr)
        return 1

    mesh = trimesh.load_mesh(STL_PATH)
    bb = mesh.bounds
    print(f"[centre] before: X[{bb[0][0]:.2f},{bb[1][0]:.2f}] Y[{bb[0][1]:.2f},{bb[1][1]:.2f}] Z[{bb[0][2]:.2f},{bb[1][2]:.2f}]")

    # Shift origin to PCB geometric centre in X and Y only — leave Z so the
    # PCB substrate keeps its natural relation to gmsh's frame (assets in
    # the project use Z-up body-local with the part's primary mass straddling
    # z=0; gmsh's corner frame had the PCB bottom slightly below 0).
    shift = np.array([
        -(bb[0][0] + bb[1][0]) / 2,
        -(bb[0][1] + bb[1][1]) / 2,
        0.0,
    ])
    mesh.apply_translation(shift)

    bb2 = mesh.bounds
    print(f"[centre] after:  X[{bb2[0][0]:.2f},{bb2[1][0]:.2f}] Y[{bb2[0][1]:.2f},{bb2[1][1]:.2f}] Z[{bb2[0][2]:.2f},{bb2[1][2]:.2f}]")

    # Detect SMA jack clusters along each PCB edge so the asset author can
    # pick real connector positions for the anchors table.
    for label, n in [
        ("+X edge", np.array([+1.0, 0, 0])),
        ("-X edge", np.array([-1.0, 0, 0])),
        ("+Y edge", np.array([0, +1.0, 0])),
        ("-Y edge", np.array([0, -1.0, 0])),
    ]:
        detect_edge_features(mesh, label, n)

    mesh.export(STL_PATH, file_type="stl")
    print(
        f"[centre] wrote {STL_PATH} ({STL_PATH.stat().st_size / 1e6:.2f} MB) "
        f"dims={bb2[1][0] - bb2[0][0]:.2f} x {bb2[1][1] - bb2[0][1]:.2f} x {bb2[1][2] - bb2[0][2]:.2f} mm"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
