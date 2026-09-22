"""TimingProgram interval validation — create AND update (PUT).

``POST /api/timing-programs`` has always rejected an unordered / overlapping
interval list (``TimingProgramBase``). ``PUT`` did not: ``TimingProgramUpdate``
carried no validator, so the bad list was committed — and because
``TimingProgramOut`` re-runs the create rule when it serialises, that same PUT
then answered 500, and so did every later read of the program (including
``GET /api/scene``, which embeds every program). Both paths now share
``schemas._assert_ordered_non_overlapping``.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import schemas
from app.db import AsyncSessionLocal, get_session
from app.main import app
from app.models import TimingProgram
from app.routers.timing_programs import create_program, delete_program, update_program


def _iv(start: float, end: float) -> dict:
    return {"spinCoreStartNs": start, "spinCoreEndNs": end}


OVERLAPPING = [_iv(0, 100), _iv(50, 150)]
UNORDERED = [_iv(200, 300), _iv(0, 100)]
TOUCHING = [_iv(0, 100), _iv(100, 200)]


# ─── the schema rule ───────────────────────────────────────────────────────

@pytest.mark.parametrize("bad", [OVERLAPPING, UNORDERED], ids=["overlapping", "unordered"])
def test_update_rejects_what_create_rejects(bad) -> None:
    with pytest.raises(ValidationError):
        schemas.TimingProgramCreate.model_validate({"intervals": bad})
    with pytest.raises(ValidationError) as exc:
        schemas.TimingProgramUpdate.model_validate({"intervals": bad})
    assert "ordered and non-overlapping" in str(exc.value)


def test_update_accepts_touching_empty_and_absent_intervals() -> None:
    assert len(schemas.TimingProgramUpdate.model_validate({"intervals": TOUCHING}).intervals) == 2
    assert schemas.TimingProgramUpdate.model_validate({"intervals": []}).intervals == []
    # A rename alone never trips the interval rule.
    upd = schemas.TimingProgramUpdate.model_validate({"name": "CH0"})
    assert upd.intervals is None and upd.name == "CH0"


def test_update_snaps_to_the_grid_before_checking() -> None:
    """Intervals snap to 10 ns first, so the rule sees what gets stored:
    [0, 104] and [96, 200] both land on 100 and merely touch."""
    upd = schemas.TimingProgramUpdate.model_validate({"intervals": [_iv(0, 104), _iv(96, 200)]})
    assert [(iv.spin_core_start_ns, iv.spin_core_end_ns) for iv in upd.intervals] == [
        (0.0, 100.0), (100.0, 200.0),
    ]


def test_a_stored_overlapping_list_cannot_be_read_back() -> None:
    """Why the PUT gap mattered: the read-back model applies the create rule,
    so a row holding an overlapping list is unserialisable (a 500 on every
    read). The fix keeps such a row from ever being written."""
    row = SimpleNamespace(
        id=uuid.uuid4(), name="x", intervals=OVERLAPPING,
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    )
    with pytest.raises(ValidationError):
        schemas.TimingProgramOut.model_validate(row)


# ─── the route ─────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    """Request validation answers before the handler runs, so a dummy session
    is enough to prove the 422 (and that nothing reaches the DB)."""

    async def _no_db():
        yield object()

    app.dependency_overrides[get_session] = _no_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_session, None)


@pytest.mark.parametrize("bad", [OVERLAPPING, UNORDERED], ids=["overlapping", "unordered"])
def test_put_answers_422(client, bad) -> None:
    res = client.put(f"/api/timing-programs/{uuid.uuid4()}", json={"intervals": bad})
    assert res.status_code == 422, res.text
    assert "ordered and non-overlapping" in res.text


@pytest.fixture(autouse=False)
async def _fresh_pool():
    from app.db import engine

    await engine.dispose()
    yield


async def test_update_persists_a_valid_list(_fresh_pool) -> None:
    """The happy path still writes (DB-backed; the row is removed after)."""
    async with AsyncSessionLocal() as db:
        created: TimingProgram = await create_program(
            schemas.TimingProgramCreate.model_validate({"name": "t", "intervals": [_iv(0, 100)]}), db,
        )
        try:
            updated = await update_program(
                created.id, schemas.TimingProgramUpdate.model_validate({"intervals": TOUCHING}), db,
            )
            assert [(iv["spinCoreStartNs"], iv["spinCoreEndNs"]) for iv in updated.intervals] == [
                (0.0, 100.0), (100.0, 200.0),
            ]
            # And it reads back through the response model.
            schemas.TimingProgramOut.model_validate(updated)
        finally:
            await delete_program(created.id, db)
