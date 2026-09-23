"""Recompute ``backend/tests/fixtures/delete/{pinned,random}.json`` from the
CURRENT cascade.

The fixtures were written by the web app's `deleteObjects`
(`frontend/src/store/__tests__/deleteParity.test.ts`) and are frozen goldens
since wave 3b deleted it. This is the tool for the only legitimate reason to
move one: a deliberate change to `flows.plan_delete_objects`, which then has
to be explained case by case in the commit that regenerates them.

    python scripts/regen_delete_fixtures.py            # report what would change
    python scripts/regen_delete_fixtures.py --apply    # write it

`orderIndependent` is recomputed the way the TypeScript did — the same answer
(as sets) on the reversed scene and on four shuffles — because
`test_objects_delete_endpoint.py` replays only those cases through a real
database, which hands rows back in its own order.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.optical.rf_cables.ports import RfScene  # noqa: E402
from app.services.object_delete import plan_delete  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures" / "delete"
FILES = ("pinned.json", "random.json")


def scene_of(d: dict) -> RfScene:
    """The fixture scene as ORM-like rows, in fixture order (the shape
    ``rf_cables.service.load_rf_scene`` hands the plan)."""
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


def outcome(scene_json: dict, request: list[str]) -> tuple[list[str], list[str]]:
    plan = plan_delete(
        scene_of(scene_json), request, {t["id"] for t in scene_json["timingPrograms"]},
    )
    return plan.object_ids, plan.timing_program_ids


def order_independent(scene_json: dict, request: list[str], base: tuple[list[str], list[str]], seed: int) -> bool:
    want = (sorted(base[0]), sorted(base[1]))
    rng = random.Random(seed)
    variants = [{
        **scene_json,
        "objects": list(reversed(scene_json["objects"])),
        "physicsElements": list(reversed(scene_json["physicsElements"])),
    }]
    for _ in range(4):
        objects = scene_json["objects"][:]
        elements = scene_json["physicsElements"][:]
        rng.shuffle(objects)
        rng.shuffle(elements)
        variants.append({**scene_json, "objects": objects, "physicsElements": elements})
    for v in variants:
        got = outcome(v, request)
        if (sorted(got[0]), sorted(got[1])) != want:
            return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write the files (default: report only)")
    args = ap.parse_args()

    changed_total = 0
    for name in FILES:
        path = FIXTURES / name
        data = json.loads(path.read_text(encoding="utf-8"))
        changed = []
        for i, case in enumerate(data["cases"]):
            scene_json = data["scenes"][case["scene"]]
            deleted, programs = outcome(scene_json, case["request"])
            independent = order_independent(scene_json, case["request"], (deleted, programs), 1000 + i)
            before = (case["deleted"], sorted(case["deletedPrograms"]), case["orderIndependent"])
            after = (deleted, sorted(programs), independent)
            if before == after:
                continue
            names = {o["id"]: o["name"] for o in scene_json["objects"]}
            changed.append(
                f"  [{i}] {case['name']}\n"
                f"      request : {[names.get(r, '<gone>') for r in case['request']]}\n"
                f"      was     : {[names.get(x, x) for x in case['deleted']]} "
                f"programs={len(case['deletedPrograms'])} orderIndependent={case['orderIndependent']}\n"
                f"      now     : {[names.get(x, x) for x in deleted]} "
                f"programs={len(programs)} orderIndependent={independent}",
            )
            case["deleted"] = deleted
            case["deletedPrograms"] = programs
            case["orderIndependent"] = independent
        print(f"{name}: {len(changed)} of {len(data['cases'])} cases change")
        print("\n".join(changed))
        changed_total += len(changed)
        if args.apply and changed:
            # The same bytes the TypeScript wrote: JSON.stringify(data, null, 1),
            # a trailing newline, and LF endings on every platform.
            with path.open("w", encoding="utf-8", newline="\n") as fh:
                fh.write(f"{json.dumps(data, indent=1)}\n")
            print(f"  written -> {path}")
    if not args.apply and changed_total:
        print("\n(report only; pass --apply to write)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
