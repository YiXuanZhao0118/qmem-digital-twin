"""GET /api/kinds/roles — the kinds manifest's port contract, served.

A second client (the qmem-blender add-on's RF graph) used to copy
``backend/data/kinds.json`` into its own table and pin the copy with a test.
This route serves the same data, so the only copy is the manifest itself.
Pinned here: every physics plugin is listed in registration order, each field
is the manifest's, and the literal path is not swallowed by ``/{kind_id}``.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.db import get_session
from app.kinds_manifest import element_kinds, load_manifest
from app.main import app


@pytest.fixture
def roles() -> list[dict]:
    async def _no_db():
        yield object()

    app.dependency_overrides[get_session] = _no_db
    try:
        res = TestClient(app).get("/api/kinds/roles")
    finally:
        app.dependency_overrides.pop(get_session, None)
    assert res.status_code == 200, res.text
    return res.json()


def test_lists_every_physics_kind_in_manifest_order(roles) -> None:
    assert [r["kind"] for r in roles] == element_kinds()
    passive = {p["id"] for p in load_manifest()["passive_plugins"]}
    assert not passive & {r["kind"] for r in roles}


def test_every_field_is_the_manifests(roles) -> None:
    by_kind = {r["kind"]: r for r in roles}
    for plugin in load_manifest()["physics_plugins"]:
        physics = plugin["physics"]
        got = by_kind[physics["element_kind"]]
        assert got["primaryDomain"] == physics["primary_domain"]
        assert got["defaultPhysics"] == physics["default_physics"]
        assert got["requiredAnchors"] == physics["anchors"]["required"]
        assert got["optionalAnchors"] == physics["anchors"]["optional"]
        assert got["portDomains"] == physics["port_domains"]
        manifest_roles = physics.get("roles")
        if manifest_roles is None:
            assert got["roles"] is None
            continue
        assert set(got["roles"]) == set(manifest_roles)
        for role, spec in manifest_roles.items():
            assert got["roles"][role] == {
                "min": spec["min"],
                "max": spec["max"],
                "domain": spec["domain"],
                # The manifest omits a false flag; the route spells it out.
                "direction": spec.get("direction", False),
                "aperture": spec.get("aperture", False),
                "fastAxis": spec.get("fast_axis", False),
            }


def test_rf_switch_contract(roles) -> None:
    """One concrete kind end to end, so a reader sees the shape."""
    sw = next(r for r in roles if r["kind"] == "rf_switch")
    assert sw == {
        "kind": "rf_switch",
        "primaryDomain": "rf",
        "defaultPhysics": ["rf"],
        "requiredAnchors": ["rf_in", "rf_out", "ttl_in"],
        "optionalAnchors": [],
        "portDomains": {"rf_in": "rf", "rf_out": "rf", "ttl_in": "ttl"},
        "roles": {
            "rf_in": {"min": 1, "max": 1, "domain": "rf", "direction": True, "aperture": False, "fastAxis": False},
            # max null = an unbounded multiport (RF1, RF2, ...).
            "rf_out": {"min": 1, "max": None, "domain": "rf", "direction": True, "aperture": False, "fastAxis": False},
            "ttl_in": {"min": 1, "max": 1, "domain": "ttl", "direction": True, "aperture": False, "fastAxis": False},
        },
    }
    ppg = next(r for r in roles if r["kind"] == "programmable_pulse_generator")
    assert ppg["portDomains"] == {"rf_out": "ttl"}
