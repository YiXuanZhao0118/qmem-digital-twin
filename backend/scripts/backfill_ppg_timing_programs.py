"""One-off backfill: create a TimingProgram for every PPG with
``kind_params.timingProgramId is null`` and bind it.

Why: PPG ↔ TimingProgram became a 1:1 invariant in the right-click /
Add PPG flow, but earlier code (and the now-fixed UUID-JSON serializer
bug) left orphan PPG rows whose ``timingProgramId`` is null. The
frontend Pulse & Timing panel therefore showed nothing while the RF
Link panel still rendered the PPG nodes.

For each orphan PPG, this script:
  1. Picks ``kind = "TTL"`` if ``output_domain == "ttl"`` else ``"Trigger"``.
  2. Picks the lowest unused PB ``channel_index`` 0..23 (or null if all
     24 are taken).
  3. Creates a TimingProgram row.
  4. Patches the PhysicsElement's ``kind_params.timingProgramId``.

Idempotent: re-running finds zero orphans on the second pass.

Run with:
    .venv/Scripts/python.exe scripts/backfill_ppg_timing_programs.py
"""

from __future__ import annotations

import asyncio
import sys
import uuid
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db import AsyncSessionLocal  # noqa: E402
from app.models import PhysicsElement, SceneObject, TimingProgram  # noqa: E402


async def main() -> None:
    async with AsyncSessionLocal() as session:
        elements = (
            await session.scalars(
                select(PhysicsElement).where(
                    PhysicsElement.element_kind == "programmable_pulse_generator"
                )
            )
        ).all()
        orphans = [
            e for e in elements if not (e.kind_params or {}).get("timingProgramId")
        ]
        if not orphans:
            print("No orphan PPGs found. Nothing to do.")
            return

        used_channels = {
            p.channel_index
            for p in (await session.scalars(select(TimingProgram))).all()
            if p.channel_index is not None
        }

        def next_channel() -> int | None:
            for i in range(24):
                if i not in used_channels:
                    used_channels.add(i)
                    return i
            return None

        objects_by_id = {
            o.id: o for o in (await session.scalars(select(SceneObject))).all()
        }

        for element in orphans:
            params = dict(element.kind_params or {})
            output_domain = params.get("outputDomain") or "ttl"
            kind = "TTL" if output_domain == "ttl" else "Trigger"
            channel_index = next_channel()
            owner = objects_by_id.get(element.object_id)
            owner_name = (owner.name if owner else None) or "PPG"
            program_name = (
                f"{kind} ch{channel_index}"
                if channel_index is not None
                else f"{kind} ({owner_name})"
            )
            program = TimingProgram(
                id=uuid.uuid4(),
                name=program_name,
                kind=kind,
                channel_index=channel_index,
                invert=False,
                intervals=[],
            )
            session.add(program)
            await session.flush()

            params["timingProgramId"] = str(program.id)
            element.kind_params = params
            flag_modified(element, "kind_params")
            print(
                f"Backfilled PPG {element.object_id} → "
                f"TimingProgram {program.id} ({program_name})"
            )

        await session.commit()
        print(f"Backfilled {len(orphans)} orphan PPG(s).")


if __name__ == "__main__":
    asyncio.run(main())
