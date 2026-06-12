"""Write-guard for ``locked`` rows (alembic 0112).

A locked Kind / Asset3D is human-confirmed "complete, do not adjust". The
API rejects any write that changes a field other than ``locked`` itself,
so a locked row can still be *unlocked* (``locked=False``) but nothing
else can be patched while it stays locked. Delete is rejected outright.

Shared by app/routers/{kinds,assets,v3_catalog}.py so the rule is
identical on every write path.
"""

from __future__ import annotations

from collections.abc import Iterable

from fastapi import HTTPException, status


def assert_update_allowed(
    *, locked: bool, changed_fields: Iterable[str], label: str
) -> None:
    """Reject an update to a locked row unless it only toggles ``locked``."""
    if not locked:
        return
    non_lock = {f for f in changed_fields if f != "locked"}
    if non_lock:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"{label} is locked (human-confirmed complete). Unlock it "
                f"first before editing. Rejected fields: {sorted(non_lock)}."
            ),
        )


def assert_delete_allowed(*, locked: bool, label: str) -> None:
    """Reject deleting a locked row — unlock it first."""
    if locked:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{label} is locked (human-confirmed complete). Unlock it first to delete.",
        )
