"""One-shot: remove `_stl` / `_glb` mech-shell Asset3D rows that are
duplicates of a catalog-bearing row pointing at the same geometry file.

These shells were ingested before the v3 catalog flow and now show up
as confusing "kind: none" entries in the mechanical Asset3D list. The
catalog row (with catalog_id slug, full faces/transitions/etc.) is the
canonical record; the shell adds nothing.

Cascade: deleting a shell also deletes any ComponentBinding that
references it (matches the existing DELETE /api/v3/assets3d/{key}
behavior). The script prints those bindings up-front so you can audit.

Usage:
  # Dry-run (default) — prints the plan, deletes nothing.
  python backend/scripts/cleanup_mech_shells.py

  # Actually delete.
  python backend/scripts/cleanup_mech_shells.py --commit
"""

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402
from app.db import AsyncSessionLocal, engine  # noqa: E402
from app.models import Asset3D, ComponentBinding  # noqa: E402


async def find_shells():
    """Return [(shell_row, sibling_catalog_id)] for each '_stl' / '_glb'
    naming pattern where another row with non-null catalog_id shares the
    same file_path."""
    async with AsyncSessionLocal() as s:
        rows = (await s.execute(select(Asset3D))).scalars().all()

        # Group by file_path → list of rows
        by_path: dict[str, list[Asset3D]] = {}
        for r in rows:
            by_path.setdefault(r.file_path, []).append(r)

        shells: list[tuple[Asset3D, str]] = []
        for path, group in by_path.items():
            # Skip primitive:// and empty-path groups — those aren't file shells.
            if not path or path.startswith("primitive://"):
                continue
            catalog_rows = [r for r in group if r.catalog_id]
            null_rows = [r for r in group if not r.catalog_id]
            if not catalog_rows or not null_rows:
                continue
            sibling_slug = catalog_rows[0].catalog_id
            for shell in null_rows:
                # Only target the conventional `_stl` / `_glb` mech shells.
                # Other null-catalog rows (e.g. user-uploaded WIP) stay put.
                if shell.name.endswith(("_stl", "_glb")):
                    shells.append((shell, sibling_slug))
        return shells


async def find_bindings_for(asset_ids: list):
    async with AsyncSessionLocal() as s:
        rows = (await s.execute(
            select(ComponentBinding).where(ComponentBinding.asset_3d_id.in_(asset_ids))
        )).scalars().all()
        return list(rows)


async def main(commit: bool, include_bound: bool) -> None:
    shells = await find_shells()
    if not shells:
        print("No mech shells found — nothing to do.")
        return

    binding_rows = await find_bindings_for([s.id for s, _ in shells])
    bound_ids = {b.asset_3d_id for b in binding_rows}

    print(f"Found {len(shells)} mech shell candidate(s):")
    for shell, sibling in shells:
        marker = "  [BOUND]" if shell.id in bound_ids else ""
        print(f"  - {shell.name}  (id={shell.id}){marker}")
        print(f"      file_path: {shell.file_path}")
        print(f"      covered by catalog row: {sibling}")

    if binding_rows:
        print(f"\n{len(binding_rows)} ComponentBinding row(s) reference these shells:")
        for b in binding_rows:
            print(f"  binding {b.id}  component={b.component_id}  asset_3d_id={b.asset_3d_id}")
        if include_bound:
            print("--include-bound set: bound shells WILL be deleted and their bindings cascade away.")
        else:
            print("Skipping [BOUND] shells. Re-bind to the catalog row in Components editor first, then re-run.")
    else:
        print("\nNo ComponentBindings reference these shells.")

    targets = [
        (shell, sibling) for shell, sibling in shells
        if include_bound or shell.id not in bound_ids
    ]
    skipped = len(shells) - len(targets)
    print(f"\nWill delete {len(targets)} shell(s); skipping {skipped} bound shell(s).")

    if not commit:
        print("Dry-run (no --commit) — exiting without changes.")
        return
    if not targets:
        print("Nothing to delete.")
        return

    async with AsyncSessionLocal() as s:
        ids = [shell.id for shell, _ in targets]
        # Cascade bindings first to mirror the DELETE endpoint's semantics.
        bindings = (await s.execute(
            select(ComponentBinding).where(ComponentBinding.asset_3d_id.in_(ids))
        )).scalars().all()
        for b in bindings:
            await s.delete(b)
        for shell_row in (await s.execute(
            select(Asset3D).where(Asset3D.id.in_(ids))
        )).scalars().all():
            await s.delete(shell_row)
        await s.commit()
        print(f"Deleted {len(bindings)} binding(s) + {len(ids)} shell asset(s).")


async def _run(commit: bool, include_bound: bool) -> None:
    try:
        await main(commit, include_bound)
    finally:
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--commit",
        action="store_true",
        help="Actually delete rows. Without this flag the script prints what it would do.",
    )
    parser.add_argument(
        "--include-bound",
        action="store_true",
        help="Also delete shells that are referenced by ComponentBinding rows. "
             "Their bindings will cascade away — re-point to the catalog row first.",
    )
    args = parser.parse_args()
    asyncio.run(_run(args.commit, args.include_bound))
