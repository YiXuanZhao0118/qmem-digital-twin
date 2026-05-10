"""V2 Phase 2: mirror cutover — schema + binding helper tests.

Phase 2 moves the mirror reflective-surface normal from
``optical_elements.kind_params.surfaceNormalBodyLocal`` to
``objects.properties.anchorBindings[opticalSurface].payload.normalBodyLocal``.

These tests verify:
1. ``MirrorParams`` silently drops the legacy field on input (hard cutover —
   the value is not authoritative anymore, but old V1 client uploads still
   parse).
2. The default ``MirrorParams.dict()`` no longer carries the field.
3. The V2 ``v2_bindings`` helpers (anchor picker, payload constructor,
   getter) honour the documented precedence and shape.
4. Building a binding from a synthetic mirror SceneObject + reading it back
   round-trips the normal vector exactly.

A separate end-to-end DB migration test for alembic 0028 lives in
``test_aom_anchor_migration.py`` style if/when needed; this file stays
DB-free to keep the unit suite fast.
"""

from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.schemas import MirrorParams
from app.v2_bindings import (
    OPTICAL_ANCHOR_ID,
    OPTICAL_SURFACE_BINDING_KIND,
    append_binding,
    find_binding,
    get_mirror_normal_body_local,
    make_optical_surface_binding,
    pick_optical_surface_anchor_id,
)


# ---- MirrorParams: hard cutover -------------------------------------------


def test_mirror_params_drops_legacy_normal_field_silently():
    """V1 client may still upload `surfaceNormalBodyLocal`; we accept the
    payload but the field is gone from the model output."""
    inst = MirrorParams.model_validate({"reflectivity": 0.97, "surfaceNormalBodyLocal": [0, 1, 0]})
    dumped = inst.model_dump(by_alias=True)
    assert "surfaceNormalBodyLocal" not in dumped
    assert "surface_normal_body_local" not in dumped
    assert dumped["reflectivity"] == 0.97


def test_mirror_params_drops_pre_phase5_alias_too():
    inst = MirrorParams.model_validate({"reflectivity": 0.5, "normalLocal": [1, 0, 0]})
    assert "normalLocal" not in inst.model_dump(by_alias=True)


def test_mirror_params_default_has_no_normal_field():
    inst = MirrorParams()
    fields = set(inst.model_dump(by_alias=True).keys())
    # normal is gone; reflectivity and other transfer-physics fields stay.
    assert "surfaceNormalBodyLocal" not in fields
    assert "reflectivity" in fields


# ---- pick_optical_surface_anchor_id ---------------------------------------


def test_pick_anchor_prefers_optical_anchor():
    anchors = [
        {"id": "+x", "name": "+X face"},
        {"id": OPTICAL_ANCHOR_ID, "name": "Optical face"},
        {"id": "intercept_in", "name": "Intercept in"},
    ]
    assert pick_optical_surface_anchor_id(anchors) == OPTICAL_ANCHOR_ID


def test_pick_anchor_falls_back_to_intercept_face_then_intercept_in():
    assert (
        pick_optical_surface_anchor_id([{"id": "intercept_face"}, {"id": "intercept_in"}])
        == "intercept_face"
    )
    assert (
        pick_optical_surface_anchor_id([{"id": "intercept_in"}, {"id": "+x"}])
        == "intercept_in"
    )


def test_pick_anchor_matches_name_hint_when_no_id_match():
    anchors = [{"id": "anchor_a", "name": "Optical reference face"}]
    assert pick_optical_surface_anchor_id(anchors) == "anchor_a"


def test_pick_anchor_falls_back_to_first_anchor_with_id():
    assert pick_optical_surface_anchor_id([{"id": "weird_id"}]) == "weird_id"


def test_pick_anchor_returns_none_for_empty_or_invalid():
    assert pick_optical_surface_anchor_id([]) is None
    assert pick_optical_surface_anchor_id(None) is None
    assert pick_optical_surface_anchor_id([{"name": "anonymous"}]) is None


# ---- make_optical_surface_binding -----------------------------------------


def test_make_binding_produces_v2_shape():
    b = make_optical_surface_binding(
        anchor_id="optical_anchor",
        normal_body_local=[1.0, 0.0, 0.0],
    )
    assert b["anchorId"] == "optical_anchor"
    assert b["kind"] == OPTICAL_SURFACE_BINDING_KIND
    assert b["frame"] == "anchorLocalXY"
    assert b["payload"]["normalBodyLocal"] == [1.0, 0.0, 0.0]
    # id is a UUIDv7 string with version 7 nibble at the canonical spot.
    parts = b["id"].split("-")
    assert parts[2].startswith("7")


def test_make_binding_does_not_alias_the_input_list():
    src = [0.0, 1.0, 0.0]
    b = make_optical_surface_binding(anchor_id="x", normal_body_local=src)
    src[0] = 99.9  # mutate caller's list
    assert b["payload"]["normalBodyLocal"] == [0.0, 1.0, 0.0]


# ---- append + find -------------------------------------------------------


def test_append_binding_initialises_list_and_preserves_other_props():
    properties = {"size": {"x": 1, "y": 1, "z": 1}}
    b = make_optical_surface_binding(anchor_id="a", normal_body_local=[1, 0, 0])
    out = append_binding(properties, b)
    # Original is not mutated.
    assert "anchorBindings" not in properties
    assert out["size"] == {"x": 1, "y": 1, "z": 1}
    assert out["anchorBindings"] == [b]


def test_append_binding_handles_missing_or_wrong_type_gracefully():
    out1 = append_binding(None, make_optical_surface_binding(anchor_id="a", normal_body_local=[1, 0, 0]))
    assert isinstance(out1["anchorBindings"], list) and len(out1["anchorBindings"]) == 1

    out2 = append_binding({"anchorBindings": "garbage"}, make_optical_surface_binding(anchor_id="a", normal_body_local=[1, 0, 0]))
    assert isinstance(out2["anchorBindings"], list) and len(out2["anchorBindings"]) == 1


def test_find_binding_matches_first_of_kind():
    properties = {"anchorBindings": []}
    b1 = make_optical_surface_binding(anchor_id="a1", normal_body_local=[1, 0, 0])
    b2 = make_optical_surface_binding(anchor_id="a2", normal_body_local=[0, 1, 0])
    properties["anchorBindings"] = [b1, b2]

    fake_obj = SimpleNamespace(properties=properties)
    found = find_binding(fake_obj, kind=OPTICAL_SURFACE_BINDING_KIND)
    assert found is b1


def test_find_binding_accepts_dict_object_shape():
    bindings = [make_optical_surface_binding(anchor_id="a", normal_body_local=[1, 0, 0])]
    found = find_binding({"properties": {"anchorBindings": bindings}}, kind=OPTICAL_SURFACE_BINDING_KIND)
    assert found is bindings[0]


def test_find_binding_returns_none_when_absent():
    assert find_binding(SimpleNamespace(properties={}), kind=OPTICAL_SURFACE_BINDING_KIND) is None
    assert find_binding(None, kind=OPTICAL_SURFACE_BINDING_KIND) is None


# ---- get_mirror_normal_body_local ----------------------------------------


def test_get_mirror_normal_returns_payload_normal():
    b = make_optical_surface_binding(anchor_id="a", normal_body_local=[0.5, -0.1, 0.86])
    obj = SimpleNamespace(properties={"anchorBindings": [b]})
    assert get_mirror_normal_body_local(obj) == [0.5, -0.1, 0.86]


def test_get_mirror_normal_returns_none_when_no_binding():
    obj = SimpleNamespace(properties={"anchorBindings": []})
    assert get_mirror_normal_body_local(obj) is None


def test_get_mirror_normal_returns_none_for_malformed_payload():
    obj = SimpleNamespace(properties={
        "anchorBindings": [
            {"id": str(uuid4()), "kind": "opticalSurface", "payload": {"normalBodyLocal": "not a list"}}
        ]
    })
    assert get_mirror_normal_body_local(obj) is None

    obj2 = SimpleNamespace(properties={
        "anchorBindings": [
            {"id": str(uuid4()), "kind": "opticalSurface", "payload": {"normalBodyLocal": [1, 2]}}
        ]
    })
    assert get_mirror_normal_body_local(obj2) is None


# ---- end-to-end round-trip ------------------------------------------------


def test_backfill_pattern_round_trip_preserves_normal():
    """Same shape the migration writes — make sure the post-migration read
    path returns the original normal."""
    asset_anchors = [
        {"id": "+x"},
        {"id": OPTICAL_ANCHOR_ID, "name": "Reflective face"},
    ]
    legacy_normal = [0.7071, 0.0, 0.7071]

    # Migration path: pick anchor, build binding, append.
    chosen = pick_optical_surface_anchor_id(asset_anchors)
    assert chosen == OPTICAL_ANCHOR_ID
    binding = make_optical_surface_binding(anchor_id=chosen, normal_body_local=legacy_normal)
    properties = append_binding({"size": None}, binding)

    # Read path: helper recovers the same vector.
    obj = SimpleNamespace(properties=properties)
    assert get_mirror_normal_body_local(obj) == legacy_normal


# ---- ensure existing optical schema test for mirror still passes ----------


def test_default_mirror_kind_params_routing_has_no_normal():
    """The default kindParams returned by /api/components creation flow
    must no longer include surfaceNormalBodyLocal."""
    from app.routers.components import DEFAULT_KIND_PARAMS

    assert "surfaceNormalBodyLocal" not in DEFAULT_KIND_PARAMS["mirror"]
    assert "surface_normal_body_local" not in DEFAULT_KIND_PARAMS["mirror"]
