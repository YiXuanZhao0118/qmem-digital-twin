"""Split thorlabs_io_3_850_hp.stl into 3 binary STL slices.

The IO-3-850-HP isolator's full assembly STL is partitioned into front /
back housing pieces via box-select in IsolatorDevPage. Those selections
are saved as triangle-centroid key lists on the Component's
``properties.isolatorFrontPartCentroids`` /
``isolatorBackPartCentroids`` (alembic 0074 used the same keys via
viewerHints to materialise per-partition sub-Assets from the single
shared STL).

This script bakes the partition split into 3 physical STL files so the
new 5-binding catalog structure (hp_root + glan x2 + 2 pieces) gives
each Asset3D its own geometry file — no shared STL with viewerHint
filtering. Triangles whose centroid key is in:

  - front set  → io_3_850_hp_front_piece.stl
  - back set   → io_3_850_hp_back_piece.stl
  - otherwise  → thorlabs_io_3_850_hp_root.stl

The 0.5 mm grid centroid key matches
``frontend/src/three/loadAsset/viewerHints.ts::centroidKey``. JS
``Math.round`` rounds half toward +infinity, so Python uses
``math.floor(n + 0.5)`` to match exactly (not Python's banker's round).

Usage:
  python backend/scripts/split_io_3_hp_stl.py

Idempotent — overwrites output files. Requires the IO-3-850-HP Component
to be seeded first (``seed_v3_assets.py``) AND to have partition
centroids defined (via IsolatorDevPage's box-select).
"""

from __future__ import annotations

import asyncio
import math
import struct
import sys
from pathlib import Path

# Path bootstrap so ``app.*`` imports work when run directly.
sys.path.append(str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.db import AsyncSessionLocal, engine  # noqa: E402
from app.models import Component  # noqa: E402


REPO_ROOT = Path(__file__).resolve().parents[2]
STL_DIR = REPO_ROOT / "assets" / "files" / "stl"
INPUT_STL = STL_DIR / "thorlabs_io_3_850_hp.stl"
OUTPUTS = {
    "root":  STL_DIR / "thorlabs_io_3_850_hp_root.stl",
    "front": STL_DIR / "io_3_850_hp_front_piece.stl",
    "back":  STL_DIR / "io_3_850_hp_back_piece.stl",
}
TARGET_CATALOG_ID = "thorlabs_io_3_850_hp"


def _js_round(n: float) -> int:
    """JS Math.round: rounds half toward +infinity (NOT Python's banker's round)."""
    return math.floor(n + 0.5)


def centroid_key(cx: float, cy: float, cz: float) -> str:
    """0.5 mm-grid centroid key. Mirrors viewerHints.ts::centroidKey exactly."""
    def fmt(n: float) -> str:
        v = _js_round(n * 2) / 2
        if v == 0:
            v = 0.0  # normalise -0.0 → 0.0 so str() doesn't emit "-0"
        if v == int(v):
            return str(int(v))
        return repr(v)  # "0.5" / "-0.5" — only half-valued floats land here
    return f"{fmt(cx)},{fmt(cy)},{fmt(cz)}"


def read_binary_stl(path: Path) -> tuple[bytes, list[tuple[bytes, float, float, float]]]:
    """Returns (80-byte header, [(50-byte triangle record, cx, cy, cz), ...])."""
    data = path.read_bytes()
    if len(data) < 84:
        raise RuntimeError(f"{path.name}: too small to be a binary STL ({len(data)} bytes)")
    header = data[:80]
    (n_tri,) = struct.unpack_from("<I", data, 80)
    expected = 84 + n_tri * 50
    if len(data) != expected:
        raise RuntimeError(
            f"{path.name}: expected {expected} bytes for {n_tri} triangles, "
            f"got {len(data)} — not a binary STL (or ASCII STL)?"
        )
    triangles: list[tuple[bytes, float, float, float]] = []
    offset = 84
    for _ in range(n_tri):
        tri_bytes = data[offset:offset + 50]
        # Vertices start at offset+12 (after the 12-byte normal). Each
        # vertex is 3 floats (12 bytes); 3 vertices total.
        v0 = struct.unpack_from("<fff", tri_bytes, 12)
        v1 = struct.unpack_from("<fff", tri_bytes, 24)
        v2 = struct.unpack_from("<fff", tri_bytes, 36)
        cx = (v0[0] + v1[0] + v2[0]) / 3
        cy = (v0[1] + v1[1] + v2[1]) / 3
        cz = (v0[2] + v1[2] + v2[2]) / 3
        triangles.append((tri_bytes, cx, cy, cz))
        offset += 50
    return header, triangles


def write_binary_stl(path: Path, header: bytes, triangles: list[bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = bytearray(header)
    buf.extend(struct.pack("<I", len(triangles)))
    for tri in triangles:
        buf.extend(tri)
    path.write_bytes(buf)


async def fetch_partitions() -> tuple[set[str], set[str]]:
    async with AsyncSessionLocal() as session:
        comp = (await session.execute(
            select(Component).where(Component.catalog_id == TARGET_CATALOG_ID)
        )).scalar_one_or_none()
        if comp is None:
            raise RuntimeError(
                f"Component {TARGET_CATALOG_ID!r} not found in DB — "
                "seed catalog first with backend/scripts/seed_v3_assets.py"
            )
        props = comp.properties or {}
        front = set(props.get("isolatorFrontPartCentroids") or [])
        back = set(props.get("isolatorBackPartCentroids") or [])
    await engine.dispose()
    if not front and not back:
        raise RuntimeError(
            f"Component {TARGET_CATALOG_ID!r} has no partition centroids in "
            "properties.isolator{Front,Back}PartCentroids — define them via "
            "IsolatorDevPage's Ctrl/Alt + drag box-select first."
        )
    return front, back


def slice_triangles(
    triangles: list[tuple[bytes, float, float, float]],
    front: set[str],
    back: set[str],
) -> tuple[list[bytes], list[bytes], list[bytes]]:
    root_tris: list[bytes] = []
    front_tris: list[bytes] = []
    back_tris: list[bytes] = []
    for tri_bytes, cx, cy, cz in triangles:
        key = centroid_key(cx, cy, cz)
        if key in front:
            front_tris.append(tri_bytes)
        elif key in back:
            back_tris.append(tri_bytes)
        else:
            root_tris.append(tri_bytes)
    return root_tris, front_tris, back_tris


async def main() -> None:
    if not INPUT_STL.exists():
        print(f"ERROR: input STL not found at {INPUT_STL}", file=sys.stderr)
        sys.exit(1)

    print(f"Reading {INPUT_STL.name} ...")
    header, triangles = read_binary_stl(INPUT_STL)
    print(f"  {len(triangles)} triangles total")

    print(f"Fetching partition centroids from Component {TARGET_CATALOG_ID!r} ...")
    front, back = await fetch_partitions()
    print(f"  front: {len(front)} centroid keys")
    print(f"  back:  {len(back)} centroid keys")

    root_tris, front_tris, back_tris = slice_triangles(triangles, front, back)
    print(
        f"Slicing: root={len(root_tris)}  "
        f"front={len(front_tris)}  back={len(back_tris)}"
    )
    unmatched = len(front) + len(back) - len(front_tris) - len(back_tris)
    if unmatched > 0:
        print(
            f"  WARNING: {unmatched} centroid key(s) in DB did not match any "
            "triangle in the STL — partition data may be stale."
        )

    write_binary_stl(OUTPUTS["root"], header, root_tris)
    write_binary_stl(OUTPUTS["front"], header, front_tris)
    write_binary_stl(OUTPUTS["back"], header, back_tris)
    print("Wrote:")
    for label, path in OUTPUTS.items():
        print(f"  {label:5s}  {path.relative_to(REPO_ROOT)}  ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    asyncio.run(main())
