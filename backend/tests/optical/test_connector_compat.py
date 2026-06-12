"""Backend half of the connector-compat parity contract.

Loads the SAME fixture as the frontend
(``frontend/src/utils/__tests__/connector_compat_cases.json``) so
``connector_compat.py`` and ``connectorCompat.ts`` can never disagree on a
mating verdict. Mirrors the optical parity pattern
(``tests/optical/parity/test_parity.py`` reads frontend golden JSON).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.optical.connector_compat import (
    ConnectorDescriptor,
    connector_descriptor_from_params,
    evaluate_connector_mating,
)

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "frontend"
    / "src"
    / "utils"
    / "__tests__"
    / "connector_compat_cases.json"
)


def _descriptor(raw: dict) -> ConnectorDescriptor:
    return ConnectorDescriptor(
        domain=raw["domain"],
        family=raw.get("family"),
        gender=raw.get("gender"),
        polish=raw.get("polish"),
        fiber_type=raw.get("fiberType"),
        slow_axis_keyed=raw.get("slowAxisKeyed") is True,
    )


def _load_cases() -> list[dict]:
    data = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    return data["cases"]


@pytest.mark.parametrize("case", _load_cases(), ids=lambda c: c["name"])
def test_connector_compat_parity(case: dict) -> None:
    out = _descriptor(case["out"])
    inn = _descriptor(case["in"])
    key_angle = (case.get("opts") or {}).get("keyAngleDeg")
    verdict = evaluate_connector_mating(out, inn, key_angle_deg=key_angle)
    assert verdict.status == case["expected"]["status"], case["name"]
    assert sorted(verdict.codes) == sorted(case["expected"]["codes"]), case["name"]


def test_descriptor_from_params_rf() -> None:
    d = connector_descriptor_from_params(
        "rf_cable_connector", {"family": "sma", "gender": "male", "tipMm": 15.5}
    )
    assert d == ConnectorDescriptor(domain="rf", family="sma", gender="male")


def test_descriptor_from_params_fiber() -> None:
    d = connector_descriptor_from_params(
        "fiber_connector",
        {"polish": "APC", "fiberType": "polarization_maintaining", "slowAxisKeyed": True},
    )
    assert d == ConnectorDescriptor(
        domain="optical",
        polish="APC",
        fiber_type="polarization_maintaining",
        slow_axis_keyed=True,
    )
