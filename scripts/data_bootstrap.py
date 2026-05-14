"""One-command data bootstrap: bring the QMEM database to a known
working state with all assets correctly linked.

Replaces the sequence that pre-P2 was tribal knowledge:
    alembic upgrade head
    npm run export:kinds
    python -m backend.scripts.seed
    (forget to link STLs)
    open the app, wonder why mechanical parts are grey boxes

Run from repo root:
    python scripts/data_bootstrap.py

Steps (each step prints a banner; any failure aborts the whole run):
    1. Verify backend/data/kinds.json exists (regen via export:kinds)
    2. Verify backend/data/thorlabs_cad_manifest.json exists
    3. alembic upgrade head
    4. backend.scripts.seed
    5. backend.scripts.link_components_to_stl (idempotent — sets
       asset_3d_id from <name>_stl convention for any catalog row that
       didn't get linked during seed)
    6. Sanity check: 0 mechanical components are pointing at
       primitive_box (the pre-P2 grey-box failure mode).

Idempotent — re-running is safe and brings drift back into alignment.
"""
from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND = REPO_ROOT / "backend"


def banner(msg: str) -> None:
    print(f"\n=== {msg} ===")


def check_file(path: Path, hint: str) -> None:
    if not path.is_file():
        print(f"FAIL: {path} missing.\n  {hint}", file=sys.stderr)
        sys.exit(2)
    print(f"  OK   {path.relative_to(REPO_ROOT)}")


def run(cmd: list[str], cwd: Path) -> None:
    print(f"  $ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=cwd, check=False)
    if result.returncode != 0:
        print(f"FAIL: command exited {result.returncode}", file=sys.stderr)
        sys.exit(result.returncode)


def main() -> None:
    banner("1. manifest files present")
    check_file(
        BACKEND / "data" / "kinds.json",
        "Regenerate with `cd frontend && npm run export:kinds`.",
    )
    check_file(
        BACKEND / "data" / "thorlabs_cad_manifest.json",
        "Commit the file from git history or regenerate via "
        "scripts/thorlabs_bulk_cad.py.",
    )

    banner("2. alembic upgrade head")
    run(
        [str(BACKEND / ".venv" / "Scripts" / "python.exe"), "-m", "alembic", "upgrade", "head"],
        BACKEND,
    )

    banner("3. seed catalog + scene")
    run(
        [str(BACKEND / ".venv" / "Scripts" / "python.exe"), "scripts/seed.py"],
        BACKEND,
    )

    banner("4. link components to STL assets (idempotent)")
    run(
        [
            str(BACKEND / ".venv" / "Scripts" / "python.exe"),
            "scripts/link_components_to_stl.py",
        ],
        BACKEND,
    )

    banner("5. sanity: 0 mechanical components on primitive_box")
    # Lazy import so the script can fail-loud at step 1 before pulling
    # in SQLAlchemy / the backend stack.
    sys.path.insert(0, str(BACKEND))
    from app.db import AsyncSessionLocal  # noqa: E402
    from app.models import Asset3D, Component  # noqa: E402
    from sqlalchemy import select  # noqa: E402

    async def check() -> None:
        async with AsyncSessionLocal() as session:
            components = (await session.scalars(select(Component))).all()
            assets = {a.id: a for a in (await session.scalars(select(Asset3D))).all()}
            mechanical_types = {
                "mirror_mount", "laser_diode_mount", "optical_post", "post_holder",
                "clamping_fork", "pedestal_post", "pedestal_base", "pedestal_fork",
                "post_spacer", "post_adapter", "mounting_clamp",
                "polaris_clamping_arm", "bench_enhancement",
            }
            bad: list[str] = []
            for c in components:
                if c.component_type not in mechanical_types:
                    continue
                if c.asset_3d_id is None:
                    bad.append(f"  {c.name}: asset_3d_id is null")
                    continue
                asset = assets.get(c.asset_3d_id)
                if asset and asset.file_path and asset.file_path.startswith("primitive://"):
                    bad.append(f"  {c.name} -> {asset.file_path}")
            if bad:
                print(
                    f"FAIL: {len(bad)} mechanical components will render as "
                    "grey boxes — link script didn't cover them:",
                    file=sys.stderr,
                )
                for line in bad[:10]:
                    print(line, file=sys.stderr)
                if len(bad) > 10:
                    print(f"  ... and {len(bad) - 10} more", file=sys.stderr)
                sys.exit(3)
            print(f"  OK   {len(components)} components, 0 grey-box candidates")

    asyncio.run(check())
    print("\nAll bootstrap steps succeeded.")


if __name__ == "__main__":
    main()
