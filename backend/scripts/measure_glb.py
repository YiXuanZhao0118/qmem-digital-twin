"""Print the AABB (in glTF native units) of every GLB given as argv.

Usage:
  python qmem-digital-twin/backend/scripts/measure_glb.py path/to/foo.glb [...]

GLB exported by Blender uses metres unless the operator overrides it. We
read the binary buffer directly (no extra deps) so this works on any
fresh Python install.
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path


def measure(path: Path) -> None:
    data = path.read_bytes()
    if data[:4] != b"glTF":
        raise SystemExit(f"{path}: not a binary glTF")
    version, length = struct.unpack_from("<II", data, 4)
    # Parse JSON chunk.
    chunk_len = struct.unpack_from("<I", data, 12)[0]
    chunk_type = data[16:20]
    if chunk_type != b"JSON":
        raise SystemExit(f"{path}: first chunk not JSON")
    js = json.loads(data[20:20 + chunk_len])

    accessors = js.get("accessors", [])
    pos_mins, pos_maxs = [], []
    for acc in accessors:
        # POSITION accessors carry min / max in native units.
        if acc.get("type") == "VEC3" and "min" in acc and "max" in acc:
            pos_mins.append(acc["min"])
            pos_maxs.append(acc["max"])

    if not pos_mins:
        print(f"{path.name}: no POSITION min/max found")
        return

    overall_min = [min(v[i] for v in pos_mins) for i in range(3)]
    overall_max = [max(v[i] for v in pos_maxs) for i in range(3)]
    extent = [overall_max[i] - overall_min[i] for i in range(3)]
    print(f"{path.name}:")
    print(f"  glTF asset version : {js.get('asset', {}).get('version')}")
    print(f"  generator          : {js.get('asset', {}).get('generator')}")
    print(f"  num meshes         : {len(js.get('meshes', []))}")
    print(f"  AABB min (native)  : {overall_min}")
    print(f"  AABB max (native)  : {overall_max}")
    print(f"  Extent  (native)   : {extent}")
    # If extent looks like ~0.02..0.5 it's metres; if ~20..500 it's mm.
    likely_unit = "m" if max(abs(v) for v in extent) < 5 else "mm"
    print(f"  Likely unit guess  : {likely_unit}")
    # In three-units (1 three-unit = 100 mm, scale_factor=1):
    if likely_unit == "m":
        three_extent = [v * 10 for v in extent]  # asset.unit='m' multiplies by 10
        print(f"  Loaded extent (three units, asset.unit='m'): {three_extent}")
        mm = [v * 1000 for v in extent]
        print(f"  Real-world (mm)    : {mm}")
    else:
        three_extent = [v / 100 for v in extent]
        print(f"  Loaded extent (three units, asset.unit='mm'): {three_extent}")
        print(f"  Real-world (mm)    : {extent}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: measure_glb.py path/to/foo.glb [...]")
    for arg in sys.argv[1:]:
        measure(Path(arg))
        print()
