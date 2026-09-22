"""POST /api/v3/solver/mode-match — the route around ``run_mode_match``.

The optimizer takes seconds. It used to run synchronously inside the
``async`` handler, so for the whole solve the event loop served nothing
else: other requests and ``/ws/scene`` stalled. The solve now runs on a
worker thread; the DB reads stay on the loop, before it.

The test drives the app on ONE event loop (httpx ``ASGITransport``, no
TestClient portal per request), with a fake solve that blocks its thread
until the test releases it. A second request must be answered while the
solve is still blocked. On the old code the fake would block the loop
itself, the second request could not even be dispatched, and the release
would never come from the test (the fake times out instead).
"""

from __future__ import annotations

import asyncio
import threading

import httpx
import pytest

from app.db import get_session
from app.main import app
from app.optical import db_scene_loader, mode_match_service
from app.optical import solver as solver_module
from app.optical.anchor_tracer import V3AnchorScene


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _FakeSession:
    """Answers the route's one SELECT; anything else would be a bug."""

    async def execute(self, _stmt):
        return _Rows([])


BODY = {"seedEmitterId": "seed", "taObjectId": "ta", "movableIds": ["lens"], "startId": "bs"}


@pytest.fixture
def fakes(monkeypatch):
    started = threading.Event()
    release = threading.Event()
    seen: dict = {}

    async def _fake_loader(_session, _overrides=None, scrub_time_ns=None):
        return V3AnchorScene(slots=[])

    def _fake_solve(scene, *_args, **_kw):
        seen["solve_thread"] = threading.get_ident()
        return object()

    def _slow_mode_match(scene, forward, **kw):
        seen["mode_match_thread"] = threading.get_ident()
        seen["names"] = kw["object_names"]
        started.set()
        return {"released": release.wait(timeout=3.0)}

    async def _session():
        yield _FakeSession()

    monkeypatch.setattr(db_scene_loader, "load_anchor_scene_from_db", _fake_loader)
    monkeypatch.setattr(solver_module, "solve_anchor_scene", _fake_solve)
    monkeypatch.setattr(mode_match_service, "run_mode_match", _slow_mode_match)
    app.dependency_overrides[get_session] = _session
    try:
        yield started, release, seen
    finally:
        app.dependency_overrides.pop(get_session, None)


async def test_other_requests_are_served_while_a_solve_runs(fakes) -> None:
    started, release, seen = fakes
    loop_thread = threading.get_ident()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        solve = asyncio.create_task(client.post("/api/v3/solver/mode-match", json=BODY))
        for _ in range(300):
            if started.is_set():
                break
            await asyncio.sleep(0.01)
        assert started.is_set(), "the fake solve never started"

        # The solve is blocked right now. The loop must still answer this.
        health = await asyncio.wait_for(client.get("/api/health"), timeout=2.0)
        assert health.status_code == 200
        release.set()

        res = await asyncio.wait_for(solve, timeout=5.0)
    assert res.status_code == 200, res.text
    assert res.json() == {"released": True}
    # Both the forward trace and the optimizer ran off the loop's thread.
    assert seen["solve_thread"] != loop_thread
    assert seen["mode_match_thread"] != loop_thread


async def test_a_solver_error_is_still_a_400(fakes, monkeypatch) -> None:
    def _bad(scene, forward, **kw):
        raise ValueError("Pick a Start and/or Endpoint element on the beam path.")

    monkeypatch.setattr(mode_match_service, "run_mode_match", _bad)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/api/v3/solver/mode-match", json=BODY)
    assert res.status_code == 400
    assert "Pick a Start" in res.json()["detail"]


async def test_the_length_knobs_reach_the_service(fakes, monkeypatch) -> None:
    """``endpointLocked`` / ``axialMm`` / ``lMaxMm`` are passed through (their
    semantics: ``test_mode_match_service.py``); absent, the service gets its
    defaults — a frozen End, 20 mm, no cap — which is what the web sends."""
    got: list[dict] = []

    def _record(scene, forward, **kw):
        got.append({k: kw[k] for k in ("endpoint_locked", "axial_mm", "l_max_mm")})
        return {}

    monkeypatch.setattr(mode_match_service, "run_mode_match", _record)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.post("/api/v3/solver/mode-match", json=BODY)).status_code == 200
        knobs = {**BODY, "endpointLocked": False, "axialMm": 7.5, "lMaxMm": 95.0}
        assert (await client.post("/api/v3/solver/mode-match", json=knobs)).status_code == 200
        for bad in ({"axialMm": -1.0}, {"lMaxMm": 0.0}):
            res = await client.post("/api/v3/solver/mode-match", json={**BODY, **bad})
            assert res.status_code == 422, bad
    assert got == [
        {"endpoint_locked": True, "axial_mm": 20.0, "l_max_mm": None},
        {"endpoint_locked": False, "axial_mm": 7.5, "l_max_mm": 95.0},
    ]
