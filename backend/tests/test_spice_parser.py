"""Unit tests for the ngspice raw-file parser in app.solvers.spice.

These don't require an ngspice binary — they construct rawfile blobs in
memory using struct.pack and feed them through ``_parse_raw_file``.
Catches header-parsing regressions and binary-vs-complex layout bugs
without needing the full ngspice install.
"""

from __future__ import annotations

import struct

import pytest

from app.solvers.spice import SpiceError, _parse_raw_file


def _make_binary_rawfile(
    plotname: str,
    variables: list[str],
    points: list[list[float]],
    is_complex: bool = False,
) -> bytes:
    """Build a minimal ngspice binary rawfile.

    points = list of length n_points; each entry is a list of n_vars values.
    For complex flag each value should already be a 2-tuple (re, im).
    """
    n_vars = len(variables)
    n_points = len(points)
    flag = "complex" if is_complex else "real"

    header_lines = [
        "Title: test",
        "Date: 2026-05-12",
        f"Plotname: {plotname}",
        f"Flags: {flag}",
        f"No. Variables: {n_vars}",
        f"No. Points: {n_points}",
        "Variables:",
    ]
    for i, name in enumerate(variables):
        header_lines.append(f" {i} {name} voltage")
    header = ("\n".join(header_lines) + "\n").encode()
    body_separator = b"Binary:\n"

    flat: list[float] = []
    for row in points:
        assert len(row) == n_vars
        for value in row:
            if is_complex:
                re, im = value  # type: ignore[misc]
                flat.append(re)
                flat.append(im)
            else:
                flat.append(value)

    body = struct.pack(f"<{len(flat)}d", *flat)
    return header + body_separator + body


class TestParseRawFileReal:
    def test_transient_three_points_two_vars(self) -> None:
        blob = _make_binary_rawfile(
            plotname="Transient Analysis",
            variables=["time", "v(out)"],
            points=[[0.0, 0.0], [1e-6, 0.5], [2e-6, 1.0]],
        )
        out = _parse_raw_file(blob)
        assert out["plotname"] == "Transient Analysis"
        assert out["is_complex"] is False
        assert out["variables"] == ["time", "v(out)"]
        assert out["point_count"] == 3
        assert out["data"]["time"] == pytest.approx([0.0, 1e-6, 2e-6])
        assert out["data"]["v(out)"] == pytest.approx([0.0, 0.5, 1.0])


class TestParseRawFileComplex:
    def test_ac_two_points_complex_voltage(self) -> None:
        blob = _make_binary_rawfile(
            plotname="AC Analysis",
            variables=["frequency", "v(out)"],
            points=[
                [(100.0, 0.0), (0.7071, -0.7071)],
                [(1000.0, 0.0), (0.5, -0.866)],
            ],
            is_complex=True,
        )
        out = _parse_raw_file(blob)
        assert out["plotname"] == "AC Analysis"
        assert out["is_complex"] is True
        assert out["point_count"] == 2
        # Complex values come back as [re, im] lists.
        assert out["data"]["frequency"][0] == pytest.approx([100.0, 0.0])
        assert out["data"]["v(out)"][1] == pytest.approx([0.5, -0.866])


class TestParseRawFileErrors:
    def test_missing_separator_raises(self) -> None:
        blob = b"Title: nope\nNo. Variables: 1\nNo. Points: 1\n"
        with pytest.raises(SpiceError, match="separator"):
            _parse_raw_file(blob)

    def test_truncated_body_raises(self) -> None:
        # Header claims 2 variables * 3 points * 8 bytes = 48 bytes; give 16.
        header = (
            "Plotname: x\nFlags: real\nNo. Variables: 2\nNo. Points: 3\n"
            "Variables:\n 0 a voltage\n 1 b voltage\n"
        ).encode()
        body = b"\x00" * 16
        with pytest.raises(SpiceError, match="truncated"):
            _parse_raw_file(header + b"Binary:\n" + body)

    def test_missing_variable_names_raises(self) -> None:
        # Header says 2 variables but only declares 1.
        header = (
            "Plotname: x\nFlags: real\nNo. Variables: 2\nNo. Points: 1\n"
            "Variables:\n 0 a voltage\n"
        ).encode()
        body = struct.pack("<dd", 1.0, 2.0)
        with pytest.raises(SpiceError, match="malformed"):
            _parse_raw_file(header + b"Binary:\n" + body)


class TestParseRawFileAscii:
    def test_ascii_real_only(self) -> None:
        body_text = "0\t0.0\t0.0\n1\t1.0\t0.5\n"
        header = (
            "Plotname: ASCII test\nFlags: real\nNo. Variables: 2\n"
            "No. Points: 2\nVariables:\n 0 time\n 1 v(out)\n"
        ).encode()
        blob = header + b"Values:\n" + body_text.encode()
        out = _parse_raw_file(blob)
        assert out["data"]["time"] == [0.0, 1.0]
        assert out["data"]["v(out)"] == [0.0, 0.5]
