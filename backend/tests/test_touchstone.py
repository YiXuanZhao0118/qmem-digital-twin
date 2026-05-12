"""Unit tests for the Touchstone parser (Phase B.7)."""

from __future__ import annotations

import pytest

from app.services.touchstone import TouchstoneError, parse_touchstone, to_dict


# Minimal hand-written Touchstone v1 file. Format documented in
# https://www.eda.org/ibis/connector/Touchstone_v1.1.pdf
S2P_BODY = """\
! Test 2-port
# HZ S MA R 50
1.0e9   0.5  0    0.9  0     0.9  0     0.5  0
2.0e9   0.4  10   0.8  20    0.8  -20   0.4  -10
3.0e9   0.3  20   0.7  40    0.7  -40   0.3  -20
"""


class TestTouchstoneParse:
    def test_2port_basic(self) -> None:
        result = parse_touchstone("test.s2p", S2P_BODY.encode())
        d = to_dict(result)
        assert d["nPorts"] == 2
        assert d["z0"] == pytest.approx(50.0)
        assert d["freqHz"] == pytest.approx([1.0e9, 2.0e9, 3.0e9])
        # Magnitude/angle 0.5 / 0deg -> 0.5 + 0j.
        assert d["sParams"]["s11"][0] == pytest.approx([0.5, 0.0])
        # 4 ports total in a 2-port: s11, s12, s21, s22.
        assert set(d["sParams"].keys()) == {"s11", "s12", "s21", "s22"}
        # Each list aligned with freqHz length.
        for arr in d["sParams"].values():
            assert len(arr) == 3

    def test_bad_extension_rejected(self) -> None:
        with pytest.raises(TouchstoneError, match="extension"):
            parse_touchstone("garbage.txt", b"")

    def test_garbage_content_rejected(self) -> None:
        with pytest.raises(TouchstoneError, match="parse"):
            parse_touchstone("garbage.s2p", b"not a touchstone file at all")
