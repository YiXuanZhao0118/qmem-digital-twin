"""The delete cascade still answers what the TypeScript ``deleteObjects`` did.

``backend/tests/fixtures/delete/{pinned,random}.json`` were written by the
REAL TypeScript (``frontend/src/store/__tests__/deleteParity.test.ts``). That
generator went in wave 3b, when the web app moved onto
``POST /api/v3/objects/delete`` and deleted its cascade, so the fixtures are
now **frozen goldens**: a change here that alters one has to be a deliberate
regeneration, explained in its commit. Each case is a scene, a request, the
DELETEs the web store issued (in order) and the TimingPrograms it dropped.

Here the scene is handed to ``object_delete.plan_delete`` in fixture order,
so the doomed set must match EXACTLY, order included; the programs match as
a set. The endpoint's own decisions are checked against the same run: the
requested ids the web skipped are exactly the locked or unknown ones, and a
request is a 409 iff the web would DELETE a locked row.
``test_objects_delete_endpoint.py`` replays the same cases through the
database.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.optical.rf_cables.ports import RfScene
from app.services.object_delete import LOCKED, plan_delete

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "delete"
FILES = ("pinned.json", "random.json")


def load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


DATA = {name: load(name) for name in FILES}


def scene_of(d: dict) -> RfScene:
    """The fixture scene as ORM-like rows, in fixture order — the shape
    ``rf_cables.service.load_rf_scene`` hands the plan. The cascade reads
    only objects and PhysicsElements."""
    return RfScene(
        objects=[
            SimpleNamespace(
                id=o["id"], name=o["name"], component_id="component", locked=o["locked"],
                properties=o["properties"],
            )
            for o in d["objects"]
        ],
        components=[],
        bindings=[],
        assets=[],
        physics_elements=[
            SimpleNamespace(object_id=p["objectId"], element_kind=p["elementKind"], kind_params=p["kindParams"])
            for p in d["physicsElements"]
        ],
    )


def _cases():
    for name in FILES:
        for i, case in enumerate(DATA[name]["cases"]):
            yield pytest.param(name, case, id=f"{name[:-5]}[{i}] {case['name']}")


@pytest.mark.parametrize(("file", "case"), list(_cases()))
def test_plan_matches_typescript(file, case):
    scene_json = DATA[file]["scenes"][case["scene"]]
    by_id = {o["id"]: o for o in scene_json["objects"]}
    plan = plan_delete(scene_of(scene_json), case["request"], {t["id"] for t in scene_json["timingPrograms"]})

    assert plan.object_ids == case["deleted"]
    assert sorted(plan.timing_program_ids) == sorted(case["deletedPrograms"])
    assert len(set(plan.timing_program_ids)) == len(plan.timing_program_ids)

    requested = list(dict.fromkeys(case["request"]))
    assert [(r.object_id, r.reason) for r in plan.refused] == [
        (i, LOCKED) for i in requested if i in by_id and by_id[i]["locked"]
    ]
    assert plan.already_gone == [i for i in requested if i not in by_id]
    # The web skipped a requested id only when it was locked or unknown.
    skipped = {i for i in requested if i not in case["deleted"]}
    assert skipped <= {r.object_id for r in plan.refused} | set(plan.already_gone)
    # A locked row among the web's DELETEs is what makes the endpoint a 409.
    assert plan.locked_in_cascade == [i for i in case["deleted"] if by_id[i]["locked"]]


def test_fixtures_still_cover_the_rules():
    """A regenerated fixture must still exercise what this port is about."""
    cases = [(DATA[f]["scenes"][c["scene"]], c) for f in FILES for c in DATA[f]["cases"]]

    def locked(s, i):
        return any(o["id"] == i and o["locked"] for o in s["objects"])

    assert sum(1 for s, c in cases if set(c["deleted"]) - set(c["request"])) > 100  # a cascade
    assert sum(1 for s, c in cases if c["deletedPrograms"]) > 50                   # a TimingProgram
    assert sum(1 for s, c in cases if any(locked(s, i) for i in c["deleted"])) > 10  # a 409
    assert sum(1 for s, c in cases if any(locked(s, i) for i in c["request"])) > 20  # a refusal
    # EVERY case is order-independent since the cascade became a fixpoint
    # (wave 3b, ``test_object_delete_cascade.py``), so every one of them is
    # replayed through a real database by ``test_objects_delete_endpoint.py``.
    # This used to require at least 3 order-DEPENDENT cases, because the
    # single-pass cable rule produced them; they were the quirk, not a
    # property worth keeping.
    assert all(c["orderIndependent"] for _, c in cases)
    assert len(cases) > 250
