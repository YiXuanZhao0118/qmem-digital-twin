"""One-shot STEP→STL conversion for the AD9959-PCBZ evaluation board.

The board's STEP file (the official Analog Devices model, retrieved via
Digikey part 967016 — https://www.digikey.tw/en/models/967016?tab=mfr)
weighs ~232 MB and isn't directly renderable by three.js. This script
imports the STEP with OpenCascade (via gmsh), surface-meshes it at a
coarse target size suitable for a quick-glance scene preview, and emits a
binary STL into assets/uploads/ for the digital-twin frontend to load.

Run from anywhere — paths are anchored on the repo root so it works as a
plain `python backend/scripts/_convert_ad9959_stp_to_stl.py`.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import gmsh

REPO_ROOT = Path(__file__).resolve().parents[2]
SRC_STEP = Path.home() / "Downloads" / "AD9959-PCBZ.stp"
OUT_DIR = REPO_ROOT / "assets" / "uploads"
OUT_STL = OUT_DIR / "ad9959_pcbz.stl"

# Coarse mesh size in mm. The board is ~165 x 114 mm with components down to
# tiny 0402 SMDs, but we only need a viewer-quality mesh — 1 mm gives a usable
# silhouette and keeps the STL under ~30 MB; 2 mm halves that again.
MESH_SIZE_MM = 1.5


def main() -> int:
    if not SRC_STEP.exists():
        print(f"ERROR: source STEP not found at {SRC_STEP}", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[step→stl] importing {SRC_STEP} ({SRC_STEP.stat().st_size / 1e6:.1f} MB)")
    t0 = time.time()

    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 1)
        gmsh.option.setNumber("Mesh.CharacteristicLengthMin", MESH_SIZE_MM)
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", MESH_SIZE_MM)
        # 2 = Frontal-Delaunay surface mesher, faster than the default Netgen
        # 3D mesher and we don't need volume tetrahedra for a render mesh.
        gmsh.option.setNumber("Mesh.Algorithm", 2)
        # `Mesh.Binary` covers all binary mesh formats incl. STL in gmsh ≥4.10.
        gmsh.option.setNumber("Mesh.Binary", 1)

        gmsh.model.add("ad9959_pcbz")
        gmsh.model.occ.importShapes(str(SRC_STEP))
        gmsh.model.occ.synchronize()

        n_vol, n_surf = (
            len(gmsh.model.getEntities(3)),
            len(gmsh.model.getEntities(2)),
        )
        print(
            f"[step→stl] STEP loaded in {time.time() - t0:.1f}s — "
            f"{n_vol} solids, {n_surf} surfaces"
        )

        t_mesh = time.time()
        # Generate only surface mesh (dim=2); volume meshing would explode
        # for ~hundreds of solids and we just need triangles for the viewer.
        gmsh.model.mesh.generate(2)
        print(f"[step→stl] surface-meshed in {time.time() - t_mesh:.1f}s")

        gmsh.write(str(OUT_STL))
        print(
            f"[step→stl] wrote {OUT_STL} "
            f"({OUT_STL.stat().st_size / 1e6:.2f} MB) "
            f"total {time.time() - t0:.1f}s"
        )
    finally:
        gmsh.finalize()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
