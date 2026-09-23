"""The delete cascade is a fixpoint, and therefore order-independent.

``flows.plan_delete_objects`` used to run its three passes ONCE, cables
before attachments, in scene order. That is a single pass over a rule that
can feed itself, and it showed up as the two quirks
``docs/introduce/known-issues.md`` carried while the TypeScript copy existed:

  Q1. a PPG that is BOTH attached to a host and still wired by an rf_cable
      went with its host while the cable on it stayed behind, dangling — the
      cable pass had already run when the PPG joined the doomed set;
  Q2. a cable whose end names ANOTHER cable was caught only when the scene
      listed the target cable first, so the answer depended on the order the
      rows arrived in — which no client controls (this endpoint walks the
      database's order, the browser walked its snapshot's).

Both were kept for parity with the TypeScript and fixed here in wave 3b,
once it was deleted and this became the only implementation. The fixtures in
``fixtures/delete/`` were regenerated for the affected cases only; this file
states the two rules outright so a future regeneration cannot quietly undo
them, and adds the property the fix buys: **the doomed set does not depend
on scene order**.

Ordering is still deterministic (each pass walks the scene in order), which
``test_objects_delete_parity.py`` asserts case by case.
"""

from __future__ import annotations

import itertools
import random
from types import SimpleNamespace

import pytest

from app.optical.rf_cables.flows import plan_delete_objects
from app.optical.rf_cables.ports import RfScene

PPG = "programmable_pulse_generator"


def _scene(objects: list[tuple], elements: dict[str, str]) -> RfScene:
    """``[(id, properties), ...]`` in row order, plus ``{id: element_kind}``."""
    return RfScene(
        objects=[
            SimpleNamespace(id=oid, name=oid.upper(), component_id="c", locked=False, properties=props)
            for oid, props in objects
        ],
        components=[],
        bindings=[],
        assets=[],
        physics_elements=[
            SimpleNamespace(object_id=oid, element_kind=kind, kind_params={})
            for oid, kind in elements.items()
        ],
    )


def _link(target: str, anchor_id: str = "rf_in") -> dict:
    return {"targetObjectId": target, "targetAnchorId": anchor_id, "targetAnchorName": anchor_id}


def _cable(target_a: str | None = None, target_b: str | None = None) -> dict:
    eps: dict = {}
    if target_a is not None:
        eps["A"] = _link(target_a)
    if target_b is not None:
        eps["B"] = _link(target_b)
    return {"rfCableEndpoints": eps}


# ─── Q1: an attached PPG's own cable goes with it ───────────────────────────

def _attached_and_cabled(order: list[str]) -> RfScene:
    """A switch, a PPG plugged into it, and an rf_cable from that PPG's
    ``rf_out`` to an AOM's ``trigger_in`` — the legacy wiring left in place
    next to the modern attachment."""
    rows = {
        "host": {},
        "aom": {},
        "ppg": {"ppgAttachment": _link("host", "ttl_in")},
        "cableOnPpg": _cable("ppg", "aom"),
    }
    kinds = {"host": "rf_switch", "aom": "aom", "ppg": PPG, "cableOnPpg": "rf_cable"}
    return _scene([(oid, rows[oid]) for oid in order], kinds)


def test_an_attached_ppgs_own_cable_is_not_left_dangling():
    scene = _attached_and_cabled(["host", "aom", "ppg", "cableOnPpg"])
    doomed = plan_delete_objects(scene, ["host"])
    # The host, the PPG plugged into it, and the cable that PPG was still
    # wired through. Before the fix: ["host", "ppg"], with the cable left
    # pointing at a row that no longer exists.
    assert set(doomed) == {"host", "ppg", "cableOnPpg"}
    assert doomed[0] == "host"


@pytest.mark.parametrize("order", list(itertools.permutations(["host", "aom", "ppg", "cableOnPpg"])))
def test_q1_does_not_depend_on_row_order(order):
    assert set(plan_delete_objects(_attached_and_cabled(list(order)), ["host"])) == {
        "host", "ppg", "cableOnPpg",
    }


def test_the_cable_less_ppg_guard_still_holds():
    """The fixpoint must not resurrect the bug the guard exists for: a PPG
    with NO rf_cable reads as "all zero of its cables are doomed"."""
    scene = _scene(
        [
            ("host", {}),
            ("loose", {}),  # a PPG attached to nothing, wired to nothing
            ("other", {}),
            ("dds", {}),
            ("cable", _cable("dds", "other")),
        ],
        {"host": "rf_switch", "loose": PPG, "other": "rf_amplifier", "dds": "rf_source", "cable": "rf_cable"},
    )
    assert plan_delete_objects(scene, ["other"]) == ["other", "cable"]
    assert plan_delete_objects(scene, ["host"]) == ["host"]


# ─── Q2: a chain of cables is caught whichever way round it is listed ───────

def _cable_chain(order: list[str]) -> RfScene:
    """``dds`` ← first ← second ← third: each cable's end A names the cable
    before it, so deleting the dds should take the whole chain."""
    rows = {
        "dds": {},
        "aom": {},
        "first": _cable("dds", "aom"),
        "second": _cable("first"),
        "third": _cable("second"),
    }
    kinds = {"dds": "rf_source", "aom": "aom", "first": "rf_cable", "second": "rf_cable", "third": "rf_cable"}
    return _scene([(oid, rows[oid]) for oid in order], kinds)


@pytest.mark.parametrize(
    "order", list(itertools.permutations(["dds", "aom", "first", "second", "third"]))[::17],
)
def test_a_cable_to_cable_chain_is_caught_whatever_the_row_order(order):
    doomed = plan_delete_objects(_cable_chain(list(order)), ["dds"])
    # Before the fix this was order-dependent: listed backwards, only
    # ["dds", "first"] came out and `second` / `third` were left dangling.
    assert set(doomed) == {"dds", "first", "second", "third"}
    assert doomed[0] == "dds"


def test_a_cable_cycle_terminates():
    """Two cables naming each other: the loop must converge, not spin."""
    scene = _scene(
        [("dds", {}), ("a", _cable("dds", "b")), ("b", _cable("a"))],
        {"dds": "rf_source", "a": "rf_cable", "b": "rf_cable"},
    )
    assert set(plan_delete_objects(scene, ["dds"])) == {"dds", "a", "b"}
    # Nothing to start from: a cycle on its own is not deleted.
    assert plan_delete_objects(scene, []) == []


# ─── the property the fix buys ──────────────────────────────────────────────

def _random_scene(rng: random.Random) -> tuple[list[tuple], dict[str, str]]:
    ids = [f"o{i}" for i in range(rng.randint(2, 12))]
    kinds = {oid: rng.choice(["rf_cable", PPG, "rf_switch", "aom", "rf_source"]) for oid in ids}
    rows = []
    for oid in ids:
        props: dict = {}
        if kinds[oid] == "rf_cable" or rng.random() < 0.2:
            props.update(_cable(rng.choice(ids), rng.choice(ids) if rng.random() < 0.8 else None))
        if kinds[oid] == PPG and rng.random() < 0.7:
            props["ppgAttachment"] = _link(rng.choice(ids), "ttl_in")
        rows.append((oid, props))
    return rows, kinds


@pytest.mark.parametrize("seed", range(60))
def test_the_doomed_set_is_independent_of_row_order(seed):
    """The invariant the fixpoint is for. The endpoint hands the plan the
    rows in the database's order and a client cannot influence it, so an
    order-dependent answer is an answer nobody can predict."""
    rng = random.Random(seed)
    rows, kinds = _random_scene(rng)
    request = rng.sample([oid for oid, _ in rows], rng.randint(1, min(3, len(rows))))
    want = set(plan_delete_objects(_scene(rows, kinds), request))
    for _ in range(6):
        shuffled = rows[:]
        rng.shuffle(shuffled)
        assert set(plan_delete_objects(_scene(shuffled, kinds), request)) == want
