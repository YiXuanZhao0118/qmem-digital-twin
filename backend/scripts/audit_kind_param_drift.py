"""Report: does the ``kinds`` table still match ``backend/data/kinds.json``?

The value-level companion to ``audit_kind_drift.py``, which only compares
the *set* of kind names across the registry tables and so never noticed
that 29 of the 31 plugin-backed rows were out of sync in their actual
params, anchor templates and descriptions.

Same invariant ``tests/test_kind_manifest_sync.py`` asserts, printed as a
report instead of an assertion — use this when the test fails and you want
to see everything at once, or before writing a resync migration.

Read-only; no rows are modified. Exits 1 when drift is found so it can gate
CI.

Run via:
    cd backend && .venv/Scripts/python.exe scripts/audit_kind_param_drift.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import select  # noqa: E402

from app.db import AsyncSessionLocal  # noqa: E402
from app.kinds_manifest import (  # noqa: E402
    MANIFEST_OWNED_KIND_COLUMNS,
    kind_rows_from_manifest,
    load_manifest,
)
from app.models import Kind  # noqa: E402

# Key renames the codebase has already performed elsewhere, so the report
# can say "stale key name" instead of listing one missing + one undeclared.
RENAMES = {
    "acousticVelocityMPerS": "acousticVelocityMps",  # alembic 0101
    "focalMm": "focalLengthMm",
    "transmission": "transmittance",
    "retardanceLambda": "retardanceDeg",
}


def _normalize(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, dict):
        return {k: _normalize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    return value


def _same(a, b) -> bool:
    return _normalize(a) == _normalize(b)


def _fmt(value) -> str:
    return json.dumps(value, default=str, separators=(",", " "))


def _short(value, limit: int = 60) -> str:
    text = _fmt(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


async def main() -> int:
    async with AsyncSessionLocal() as session:
        rows = {r.name: r for r in (await session.scalars(select(Kind))).all()}

    manifest = load_manifest()
    want = kind_rows_from_manifest()
    passive = {p["id"] for p in manifest.get("passive_plugins", [])}

    print("=" * 78)
    print("kinds table  <->  backend/data/kinds.json")
    print(f"manifest generated_at : {manifest['generated_at']}")
    print(
        f"db rows               : {len(rows)}   "
        f"physics_plugins: {len(want)}   passive_plugins: {len(passive)}"
    )
    print(f"manifest-owned columns: {', '.join(MANIFEST_OWNED_KIND_COLUMNS)}")
    print("=" * 78)

    findings = 0

    # ---- membership ------------------------------------------------------
    no_row = sorted(set(want) - set(rows))
    if no_row:
        findings += len(no_row)
        print(f"\n[!] physics plugins with NO kinds row ({len(no_row)}) --")
        print("    unpickable in the Asset3D editor's kind dropdown:")
        for name in no_row:
            print(f"      {name}")

    unbacked = sorted(set(rows) - set(want) - passive)
    if unbacked:
        print(f"\n[i] kinds rows with NO plugin ({len(unbacked)}) -- "
              "user variants, placeholders, or orphans:")
        for name in unbacked:
            row = rows[name]
            print(
                f"      {name:<28} op_set={row.op_set_name:<18} "
                f"params={len(row.default_params or {})}"
            )

    # ---- default_params --------------------------------------------------
    print("\n" + "=" * 78)
    print("default_params")
    print("=" * 78)

    totals = {"value": 0, "renamed": 0, "missing": 0, "undeclared": 0}
    clean: list[str] = []
    for name, target in sorted(want.items()):
        row = rows.get(name)
        if row is None:
            continue
        got = row.default_params or {}
        spec = target["default_params"]

        renamed = {k: RENAMES[k] for k in got if k in RENAMES and RENAMES[k] in spec}
        value = {k: (got[k], spec[k]) for k in spec if k in got and not _same(got[k], spec[k])}
        missing = {k: v for k, v in spec.items() if k not in got and k not in renamed.values()}
        undeclared = {k: v for k, v in got.items() if k not in spec and k not in renamed}

        if not (renamed or value or missing or undeclared):
            clean.append(name)
            continue

        totals["value"] += len(value)
        totals["renamed"] += len(renamed)
        totals["missing"] += len(missing)
        totals["undeclared"] += len(undeclared)
        findings += len(value) + len(renamed) + len(missing) + len(undeclared)

        print(f"\n--- {name}{' [LOCKED]' if row.locked else ''}")
        for key, (g, w) in sorted(value.items()):
            print(f"    ~ {key:<32} db={_short(g):<26} manifest={_short(w)}")
        for key, new in sorted(renamed.items()):
            print(f"    R {key:<32} db={_short(got[key]):<26} -> key renamed to {new!r}")
        for key, w in sorted(missing.items()):
            print(f"    + {key:<32} {'(absent)':<26} manifest={_short(w)}")
        for key, g in sorted(undeclared.items()):
            print(f"    - {key:<32} db={_short(g):<26} (plugin does not declare it)")

    print(f"\nclean: {len(clean)}/{len(want)} rows")
    print(
        f"drift: {totals['value']} value | {totals['renamed']} stale key name | "
        f"{totals['missing']} missing | {totals['undeclared']} undeclared"
    )

    # ---- the other manifest-owned columns --------------------------------
    other = [c for c in MANIFEST_OWNED_KIND_COLUMNS if c != "default_params"]
    print("\n" + "=" * 78)
    print(", ".join(other))
    print("=" * 78)

    hits = 0
    for name, target in sorted(want.items()):
        row = rows.get(name)
        if row is None:
            continue
        issues: list[str] = []
        for column in other:
            got = getattr(row, column)
            spec = target[column]
            if _same(got, spec):
                continue
            if column == "anchor_template":
                issues.append("anchor_template:")
                for key in sorted(set(got or {}) | set(spec or {})):
                    if not _same((got or {}).get(key), (spec or {}).get(key)):
                        issues.append(
                            f"    .{key}: db={_fmt((got or {}).get(key))} "
                            f"manifest={_fmt((spec or {}).get(key))}"
                        )
            elif column == "description":
                issues.append(
                    f"description: db {len(got or '')} ch, "
                    f"manifest {len(spec or '')} ch"
                )
            else:
                issues.append(f"{column}: db={_fmt(got)} manifest={_fmt(spec)}")
        if issues:
            hits += 1
            findings += 1
            print(f"\n--- {name}")
            for line in issues:
                print(f"    {line}")
    if not hits:
        print("\n(no drift)")

    print("\n" + "=" * 78)
    if findings:
        print(f"DRIFT FOUND ({findings} finding(s)). "
              "Fix with a resync migration -- see 0126_kinds_manifest_resync.")
    else:
        print("IN SYNC.")
    print("=" * 78)
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
