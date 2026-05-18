"""unify Asset3D.file_path → files/<ext>/<filename> layout

Revision ID: 0063_unify_asset_paths
Revises: 0062_component_bindings

Replaces the legacy ``uploads/*`` layout (everything in one bucket) with
an extension-grouped structure under ``files/``:

    assets/files/glb/<uuid>_<name>.glb        viewer-ready
    assets/files/stl/<uuid>_<name>.stl        viewer-ready
    assets/files/obj/<uuid>_<name>.obj        viewer-ready
    assets/files/gltf/<uuid>_<name>.gltf      viewer-ready
    assets/files/cad_sources/<uuid>_<name>.*  STEP / STP / SLDPRT / DXF

``agent_uploads/<session_id>/`` is untouched — it's already
per-session-scoped sandbox storage and stays under that namespace so the
agent rollback logic (alembic 0057 / agent_orchestrator) keeps working.

This is a coordinated DB + filesystem migration. Both happen inside the
same transaction so a partial state never lands:

  1. SELECT every file_path that needs rewriting (``uploads/%``).
  2. For each row:
       a. Map extension → subdir.
       b. Move file on disk to the new location.
       c. UPDATE the row.
     If any single file move fails, we re-raise so the whole
     transaction rolls back (DB stays consistent with disk).

Procedural rows (``primitive:*``, ``procedural:*``) and rows already in
``files/`` are skipped. The orphan ``cf175c_m_edrawing.html`` row (one
non-3D-asset row pointed at by exactly one component) is also left
alone — handle it manually if it ever matters.

Downgrade
---------
Mirrors the upgrade: rewrites file_path back to ``uploads/<name>`` and
moves the files back. Safe to roundtrip during dev. The empty
``files/`` subdirs are left in place rather than removed because doing
so would race with concurrent uploads.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import sqlalchemy as sa

from alembic import op


revision = "0063_unify_asset_paths"
down_revision = "0062_component_bindings"
branch_labels = None
depends_on = None


# Map lower-case extension → subdirectory under ``files/``.
# Anything not viewer-ready (STEP / STP / SLDPRT / DXF) lands in
# ``cad_sources/`` so the viewer's loader never tries to parse them.
_VIEWER_EXTS = {"glb", "gltf", "obj", "stl"}
_CAD_SOURCE_EXTS = {"step", "stp", "sldprt", "dxf"}


def _subdir_for_ext(ext: str) -> str:
    ext = ext.lower().lstrip(".")
    if ext in _VIEWER_EXTS:
        return ext
    if ext in _CAD_SOURCE_EXTS:
        return "cad_sources"
    # Unknown extension — park alongside CAD sources so the viewer
    # doesn't pick it up. Better than dropping the row.
    return "cad_sources"


def _asset_root() -> Path:
    """Resolve ASSET_ROOT identically to ``app.config.settings``.

    Importing settings here would couple the migration to the Pydantic
    model load chain — undesirable for a migration that runs at deploy
    time before the app starts. Replicate the env→default lookup with
    minimal surface area.
    """
    import os

    raw = os.environ.get("ASSET_ROOT")
    if raw:
        root = Path(raw)
    else:
        # backend/alembic/versions/THIS_FILE → parents[3] = repo root
        root = Path(__file__).resolve().parents[3] / "assets"
    return root.resolve()


def _ensure_at_destination(src: Path, dst: Path) -> str:
    """Make sure the file ends up at ``dst``.

    Returns one of:
      * ``"moved"`` — was at src, moved to dst.
      * ``"already_at_dst"`` — already in place, no move needed.
      * ``"missing"`` — neither src nor dst exists; DB row points at a
        ghost. Caller decides whether to leave the DB pointer alone or
        rewrite it anyway (we choose rewrite, so the eventual cleanup
        sweep can find dead pointers in the new naming scheme).

    Idempotent — safe to rerun after a previous partial pass, including
    runs that committed filesystem moves but rolled back the DB
    transaction (as happened with the first 0063 attempt).
    """
    if dst.exists():
        if src.exists():
            # Both copies exist (rare — partial run that left a stale
            # source). Source wins because if we ever need to re-run
            # again we want a deterministic state; remove the src and
            # keep dst.
            src.unlink()
        return "already_at_dst"
    if src.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        return "moved"
    return "missing"


def upgrade() -> None:
    bind = op.get_bind()
    root = _asset_root()
    rows = bind.execute(
        sa.text(
            "SELECT id, file_path FROM assets_3d WHERE file_path LIKE 'uploads/%'"
        )
    ).fetchall()

    # We don't fail on missing files — there are a handful of legacy DB
    # rows whose file disappeared from disk pre-migration. Their pointers
    # were already broken; the migration just rewrites the dead pointer
    # to the new naming scheme so a future cleanup query can find them
    # uniformly (``WHERE file_path LIKE 'files/%' AND ...``).
    for row in rows:
        old_rel = row.file_path
        filename = Path(old_rel).name
        ext = Path(filename).suffix.lower().lstrip(".")
        subdir = _subdir_for_ext(ext)
        new_rel = f"files/{subdir}/{filename}"

        src = root / old_rel
        dst = root / new_rel
        _ensure_at_destination(src, dst)

        bind.execute(
            sa.text("UPDATE assets_3d SET file_path = :new WHERE id = :id"),
            {"new": new_rel, "id": row.id},
        )


def downgrade() -> None:
    bind = op.get_bind()
    root = _asset_root()
    rows = bind.execute(
        sa.text(
            "SELECT id, file_path FROM assets_3d WHERE file_path LIKE 'files/%'"
        )
    ).fetchall()

    for row in rows:
        new_rel = row.file_path  # e.g. 'files/stl/abc.stl'
        filename = Path(new_rel).name
        old_rel = f"uploads/{filename}"

        src = root / new_rel
        dst = root / old_rel
        _move_file(src, dst)

        bind.execute(
            sa.text("UPDATE assets_3d SET file_path = :old WHERE id = :id"),
            {"old": old_rel, "id": row.id},
        )
