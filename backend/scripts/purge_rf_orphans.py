"""Audit / purge dangling RF cables and PPGs on the live scene.

A coax either joins two ports or does not exist (docs/introduce/rf.md §7),
and an attached PPG lives by its attachment. So an ``rf_cable`` whose end, or
a ``programmable_pulse_generator`` whose ``ppgAttachment``, names a
SceneObject that is GONE is garbage: nothing draws it on a port, the RF BFS
never reaches it, and the RF Link panel lists it forever.

Such rows only arise when a host is deleted WITHOUT the cascade
(``POST /api/v3/objects/delete``) - a raw DELETE of the rows. The one known
source: ``backend/tests/optical/test_rf_cables_endpoints.py`` and
``test_rf_ports_binding_chain.py`` run on the dev database (conftest
defaults ``DATABASE_URL`` to :55432), and until 2026-09-24 their teardown
swept only the objects on the bench's own Components while the endpoints
had picked the catalog's ``RF cable SMA`` / ``PPG BNC MALE`` (first match
in scene order): every run leaked 9 cables + 5 PPGs, 69 + 38 by the time it
was noticed. The teardown is keyed by link now; this script is the audit,
and the one-off purge.

What it never touches: a cable with NO link on an end (a loose cable is a
real bench state; listed, left alone), a PPG with no ``ppgAttachment`` at
all (legacy, wired through cables), and anything a dry run of the delete
would take along beyond the dangling rows themselves (the run aborts
instead). ``locked`` dangling rows - the endpoint test locks one cable per
run - are unlocked first with ``--apply``, and each one is printed.

Usage (backend up on :8010):
    python backend/scripts/purge_rf_orphans.py            # audit + dry run
    python backend/scripts/purge_rf_orphans.py --apply    # unlock, delete
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

BASE = "http://localhost:8010"
CABLE = "rf_cable"
PPG = "programmable_pulse_generator"


def _request(method: str, path: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body, ensure_ascii=True).encode("ascii")
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        raise SystemExit(f"{method} {path} -> {err.code}: {err.read().decode('utf-8', 'replace')}") from err
    except (TimeoutError, OSError) as err:
        raise SystemExit(f"{method} {path} -> {err!r} (is the backend up on {BASE}?)") from err


def _short(oid: str | None) -> str:
    return (oid or "-")[:8]


def main(argv: list[str]) -> int:
    apply = "--apply" in argv
    scene = _request("GET", "/api/scene")
    objects = {o["id"]: o for o in scene["objects"]}
    comp_kind = {c["id"]: c.get("kindId") for c in scene["components"]}
    pe_kind = {p["objectId"]: p["elementKind"] for p in scene["physicsElements"]}

    def kind_of(o: dict) -> str | None:
        return pe_kind.get(o["id"]) or comp_kind.get(o.get("componentId"))

    dangling: list[dict] = []
    loose: list[str] = []
    for o in scene["objects"]:
        props = o.get("properties") or {}
        k = kind_of(o)
        if k == CABLE:
            ends = props.get("rfCableEndpoints") or {}
            targets = [(ends.get(e) or {}).get("targetObjectId") for e in ("A", "B")]
            if any(t and t not in objects for t in targets):
                dangling.append(o)
            elif not all(targets):
                loose.append(f"{o['name']} ({_short(o['id'])}): end(s) unlinked")
        elif k == PPG:
            att = props.get("ppgAttachment")
            if att is None:
                loose.append(f"{o['name']} ({_short(o['id'])}): legacy PPG, no attachment")
            elif att.get("targetObjectId") not in objects:
                dangling.append(o)

    print(f"scene: {len(objects)} objects; dangling: "
          f"{sum(1 for o in dangling if kind_of(o) == CABLE)} cables, "
          f"{sum(1 for o in dangling if kind_of(o) == PPG)} PPGs; left alone: {len(loose)}")
    for line in loose:
        print(f"  leave  {line}")
    for o in dangling:
        props = o.get("properties") or {}
        if kind_of(o) == CABLE:
            ends = props.get("rfCableEndpoints") or {}
            link = " ".join(f"{e}={(ends.get(e) or {}).get('targetAnchorName')}@{_short((ends.get(e) or {}).get('targetObjectId'))}"
                            for e in ("A", "B"))
        else:
            att = props.get("ppgAttachment") or {}
            link = f"-> {att.get('targetAnchorName')}@{_short(att.get('targetObjectId'))}"
        print(f"  {'LOCKED ' if o.get('locked') else 'purge  '}{o['name']:12s} {_short(o['id'])}  {link}")
    if not dangling:
        print("nothing to do")
        return 0

    ids = [o["id"] for o in dangling]
    locked = [o for o in dangling if o.get("locked")]
    if apply and locked:
        for o in locked:
            _request("PUT", f"/api/objects/{o['id']}", {"locked": False})
            print(f"unlocked {o['name']} ({_short(o['id'])})")
    # A locked object is only *refused* when requested, never cascaded into,
    # so the dry run below answers the same plan with or without the unlock.
    plan = _request("POST", "/api/v3/objects/delete", {"objectIds": ids, "dryRun": True})
    extra = sorted(set(plan["deletedObjectIds"]) - set(ids))
    if extra:
        print(f"ABORT: the cascade would also delete {len(extra)} object(s) that are not dangling: "
              + ", ".join(objects[i]["name"] for i in extra if i in objects))
        return 2
    refused = plan["refused"]
    print(f"dry run: delete {len(plan['deletedObjectIds'])} objects + "
          f"{len(plan['deletedTimingProgramIds'])} timing programs; refused (locked): {len(refused)}")
    if not apply:
        print("(dry run only; pass --apply to unlock the locked ones and delete)")
        return 0
    if refused:
        print("ABORT: still refused after unlock: " + ", ".join(r["objectId"] for r in refused))
        return 2
    done = _request("POST", "/api/v3/objects/delete", {"objectIds": ids, "dryRun": False})
    print(f"deleted {len(done['deletedObjectIds'])} objects + "
          f"{len(done['deletedTimingProgramIds'])} timing programs")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
