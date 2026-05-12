"""Unit tests for palace_io helpers (Phase C.4).

Hand-built fixtures so we don't need a palace install to verify the
config builder + S-parameter parser.
"""

from __future__ import annotations

import pytest

from app.solvers.palace_io import build_palace_config, parse_palace_sparams


class _FakeEm:
    """Plain object that mimics the EmProblem attribute surface used by
    build_palace_config (no SQLAlchemy, no DB)."""

    def __init__(self, **kwargs) -> None:
        self.freq_range_ghz = kwargs.get("freq_range_ghz", {})
        self.ports = kwargs.get("ports", [])
        self.boundary_conditions = kwargs.get("boundary_conditions", {})


class TestBuildPalaceConfig:
    def test_minimal_2port_linear_sweep(self) -> None:
        em = _FakeEm(
            freq_range_ghz={"startGhz": 1, "stopGhz": 10, "points": 19, "scale": "linear"},
            ports=[
                {"id": "p1", "name": "in", "impedanceOhm": 50, "mode": "tem"},
                {"id": "p2", "name": "out", "impedanceOhm": 75, "mode": "tem"},
            ],
        )
        cfg = build_palace_config(em, mesh_path="/work/mesh.msh")
        assert cfg["Problem"]["Type"] == "Driven"
        assert cfg["Model"]["Mesh"] == "/work/mesh.msh"
        assert cfg["Solver"]["Driven"]["MinFreq"] == 1.0
        assert cfg["Solver"]["Driven"]["MaxFreq"] == 10.0
        # FreqStep = (10-1)/(19-1) = 0.5
        assert cfg["Solver"]["Driven"]["FreqStep"] == pytest.approx(0.5)
        # 2 lumped ports, port 1 is the excited one.
        ports = cfg["Boundaries"]["LumpedPort"]
        assert len(ports) == 2
        assert ports[0]["Index"] == 1
        assert ports[0]["R"] == 50
        assert ports[0]["Excitation"] is True
        assert ports[1]["Index"] == 2
        assert ports[1]["R"] == 75
        assert ports[1]["Excitation"] is False

    def test_log_sweep_zero_step(self) -> None:
        em = _FakeEm(
            freq_range_ghz={"startGhz": 0.1, "stopGhz": 100, "points": 51, "scale": "log"},
            ports=[{"id": "p1", "name": "in", "impedanceOhm": 50, "mode": "tem"}],
        )
        cfg = build_palace_config(em, mesh_path="x.msh")
        assert cfg["Solver"]["Driven"]["FreqStep"] == 0


class TestParsePalaceSParams:
    def test_2port_basic_sweep(self) -> None:
        # palace's port-S.csv format: f (GHz) + alternating |S| / arg(S).
        csv_text = "\n".join(
            [
                "f (GHz),|S[1][1]|,arg(S[1][1]) (deg),|S[2][1]|,arg(S[2][1]) (deg),"
                "|S[1][2]|,arg(S[1][2]) (deg),|S[2][2]|,arg(S[2][2]) (deg)",
                "1.0,0.5,0,0.9,0,0.9,0,0.5,0",
                "5.0,0.4,10,0.8,20,0.8,-20,0.4,-10",
            ]
        ) + "\n"

        out = parse_palace_sparams(csv_text)
        assert out["nPorts"] == 2
        assert out["freqHz"] == pytest.approx([1.0e9, 5.0e9])
        assert set(out["sParams"].keys()) == {"s11", "s12", "s21", "s22"}
        # 0.5 ∠ 0deg = (0.5, 0)
        assert out["sParams"]["s11"][0] == pytest.approx([0.5, 0.0])
        # 0.8 ∠ 20deg = (0.752, 0.274)
        assert out["sParams"]["s21"][1] == pytest.approx([0.7517540, 0.2736161], rel=1e-4)

    def test_empty_input_raises(self) -> None:
        with pytest.raises(ValueError, match="empty"):
            parse_palace_sparams("")

    def test_missing_s_columns_raises(self) -> None:
        with pytest.raises(ValueError, match="no S-parameter"):
            parse_palace_sparams("f (GHz),other_col\n1.0,0.5\n")
