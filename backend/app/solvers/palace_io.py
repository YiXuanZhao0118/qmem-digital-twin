"""Palace I/O helpers — Phase C.4.

Pure functions for the on-the-wire palace job format:

  - ``build_palace_config(em_problem, mesh_path)`` — turn an EmProblem
    row into the JSON config palace expects on its CLI input.
  - ``parse_palace_sparams(csv_text)`` — turn palace's S-parameter CSV
    output into the standard ``{freqHz, sParams}`` shape that matches
    Phase B.7 Touchstone parsing (so the frontend uses the same
    NetworkAnalysisChart for both).

These are kept dependency-free (no asyncssh, no SQLAlchemy) so they're
easy to unit-test against canned palace fixtures.
"""

from __future__ import annotations

import csv
import io
import re
from typing import Any


def build_palace_config(em_problem: Any, mesh_path: str) -> dict[str, Any]:
    """Build a palace JSON config from an EmProblem + mesh file path.

    The shape mirrors palace's documented "Driven" simulation type for
    a frequency-domain S-parameter sweep. Field probes are not added in
    Phase C.4 MVP — palace will dump fields to ParaView format anyway.

    See https://awslabs.github.io/palace/dev/config/ for the full
    schema. Phase C.4 covers a useful subset:
      - Model.Mesh = uploaded .msh
      - Domains: defaults (palace assumes vacuum if unset)
      - Boundaries.PEC: from boundary_conditions.pec_anchor_binding_ids
      - Boundaries.Absorbing: from
        boundary_conditions.absorbing_anchor_binding_ids
      - Boundaries.LumpedPort: one per ports[] entry
      - Solver.Driven: frequency sweep
    """
    sweep = em_problem.freq_range_ghz or {}
    start_ghz = float(sweep.get("startGhz") or sweep.get("start_ghz") or 1.0)
    stop_ghz = float(sweep.get("stopGhz") or sweep.get("stop_ghz") or 10.0)
    n_points = int(sweep.get("points") or 51)
    scale = sweep.get("scale", "linear")

    ports = list(em_problem.ports or [])
    bcs = em_problem.boundary_conditions or {}
    pec_ids = list(bcs.get("pecAnchorBindingIds") or bcs.get("pec_anchor_binding_ids") or [])
    abs_ids = list(
        bcs.get("absorbingAnchorBindingIds") or bcs.get("absorbing_anchor_binding_ids") or []
    )

    # palace's frequency in GHz directly. SaveStep + AdaptiveTol left at
    # palace defaults.
    driven: dict[str, Any] = {
        "MinFreq": start_ghz,
        "MaxFreq": stop_ghz,
        "FreqStep": (stop_ghz - start_ghz) / max(n_points - 1, 1),
        "SaveStep": 0,
    }
    if scale == "log":
        driven["FreqStep"] = 0  # palace uses geometric spacing if 0 + Adaptive
        driven["MinFreq"] = start_ghz
        driven["MaxFreq"] = stop_ghz

    lumped_ports = []
    for i, p in enumerate(ports):
        port_idx = i + 1
        z0 = float(p.get("impedanceOhm", 50.0))
        # palace lumped-port spec needs at least one Attribute (the
        # surface tag from the .msh). We don't have a reliable mapping
        # from anchorBindingId -> mesh attribute yet (Phase C.6+ Gmsh
        # wrap will set this); for now leave Attributes empty and let
        # palace bail with a clear error if user runs a non-mock job
        # without filling it in.
        lumped_ports.append(
            {
                "Index": port_idx,
                "Attributes": [],
                "Direction": "+X",
                "R": z0,
                "Excitation": (port_idx == 1),
            }
        )

    return {
        "Problem": {
            "Type": "Driven",
            "Verbose": 1,
            "Output": "postpro",
        },
        "Model": {
            "Mesh": mesh_path,
            "L0": 1.0e-3,  # mesh units in mm; palace expects metres
        },
        "Domains": {
            "Materials": [
                {
                    "Attributes": [],  # all volumes
                    "Permeability": 1.0,
                    "Permittivity": 1.0,
                    "LossTan": 0.0,
                }
            ]
        },
        "Boundaries": {
            "PEC": {"Attributes": _ids_to_int_list(pec_ids)},
            "Absorbing": {"Attributes": _ids_to_int_list(abs_ids)},
            "LumpedPort": lumped_ports,
        },
        "Solver": {
            "Order": 2,
            "Driven": driven,
            "Linear": {
                "Type": "Default",
                "Tol": 1.0e-8,
                "MaxIts": 200,
            },
        },
    }


def parse_palace_sparams(csv_text: str) -> dict[str, Any]:
    """Parse palace's port-S-parameter CSV.

    palace writes ``postpro/port-S.csv`` (one row per swept frequency)
    with columns like::

        f (GHz),|S[1][1]|,arg(S[1][1]) (deg),|S[2][1]|,arg(S[2][1]) (deg),...

    Returns ``{freqHz: [...], nPorts: N, sParams: {sNM: [[re, im], ...]}}``
    matching the shape Phase B.7's Touchstone parser produces.

    Raises ``ValueError`` on malformed input.
    """
    reader = csv.reader(io.StringIO(csv_text))
    try:
        header = next(reader)
    except StopIteration as exc:
        raise ValueError("empty palace CSV") from exc

    # Find the frequency column (must be first; palace convention).
    if not header or "f " not in header[0].lower() and "freq" not in header[0].lower():
        raise ValueError(f"unexpected header: {header[:3]!r}")

    # Pair up |S| and arg(S) columns. palace uses headers like
    # "|S[1][1]|" and "arg(S[1][1]) (deg)". Indices are 1-based.
    s_pattern = re.compile(r"\|S\[(\d+)\]\[(\d+)\]\|")
    arg_pattern = re.compile(r"arg\(S\[(\d+)\]\[(\d+)\]\)")
    mag_cols: dict[tuple[int, int], int] = {}
    arg_cols: dict[tuple[int, int], int] = {}

    for col_idx, col_name in enumerate(header):
        m = s_pattern.search(col_name)
        if m:
            mag_cols[(int(m.group(1)), int(m.group(2)))] = col_idx
            continue
        a = arg_pattern.search(col_name)
        if a:
            arg_cols[(int(a.group(1)), int(a.group(2)))] = col_idx

    if not mag_cols:
        raise ValueError(f"no S-parameter columns found in header: {header!r}")

    # Determine port count from highest index seen.
    n_ports = max(max(p[0], p[1]) for p in mag_cols.keys())

    freq_hz: list[float] = []
    s_params: dict[str, list[list[float]]] = {
        f"s{i}{j}": [] for i in range(1, n_ports + 1) for j in range(1, n_ports + 1)
    }

    # Header text says "f (GHz)" — convert to Hz.
    is_ghz = "ghz" in header[0].lower()

    for row in reader:
        if not row or all(not cell.strip() for cell in row):
            continue
        try:
            freq_val = float(row[0])
        except ValueError as exc:
            raise ValueError(f"non-numeric frequency: {row[0]!r}") from exc
        freq_hz.append(freq_val * 1.0e9 if is_ghz else freq_val)

        for (i, j), mc in mag_cols.items():
            ac = arg_cols.get((i, j))
            try:
                mag = float(row[mc])
            except (IndexError, ValueError):
                mag = 0.0
            if ac is not None:
                try:
                    deg = float(row[ac])
                except (IndexError, ValueError):
                    deg = 0.0
            else:
                deg = 0.0
            from math import cos, radians, sin

            re_part = mag * cos(radians(deg))
            im_part = mag * sin(radians(deg))
            s_params[f"s{i}{j}"].append([re_part, im_part])

    return {
        "freqHz": freq_hz,
        "nPorts": n_ports,
        "sParams": s_params,
    }


def _ids_to_int_list(ids: list[str]) -> list[int]:
    """Best-effort: turn anchor-binding ids into mesh attribute ints.

    Phase C.6+ will store an explicit ``mesh_attribute_id`` on each
    anchor binding; until then we naively try ``int(id)`` and skip
    non-numeric entries. Empty list = no boundary tagging, which palace
    treats as "all surfaces" for the relevant boundary kind.
    """
    out: list[int] = []
    for s in ids:
        try:
            out.append(int(s))
        except (TypeError, ValueError):
            continue
    return out
