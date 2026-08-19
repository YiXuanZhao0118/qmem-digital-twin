"""Move the two annotation types onto the standard four-layer data model.

Before this migration an annotation broke the spine rule (data-model.md): every
label / marking got its OWN Component whose ``properties`` carried the styling,
i.e. the catalog template layer was being used as per-instance storage. Two
concrete symptoms: a second annotation 409s on the unique component name, and
"one object = one component" made the catalog grow without bound.

After it, each annotation type is an ordinary catalog entry::

    Kind (default_params = the style template, editable in the PHY Editor)
      ^
    Asset3D (primitive://..., default_params = its own copy, tunable_params =
             the keys an instance may override)
      ^ root ComponentBinding
    Component (ONE shared catalog row per annotation type)
      ^ instantiated as
    SceneObject (per-instance overrides in dynamic_sources)

which is exactly the documented merge order
``effective = asset.default_params (+) (dynamic_sources ^ tunable_params)``.
Adding an annotation to the scene is now "create a SceneObject", the same as
placing any other catalog part.

Existing annotations are migrated in place: each old per-object Component's
``properties`` folds into its SceneObject's ``dynamic_sources`` (so every label
keeps its exact styling), the object is re-pointed at the shared Component, and
the emptied Component rows are deleted.

Kind rows are left UNLOCKED on purpose - the whole point of putting the style
template on the kind is that the user can retune the defaults in the PHY Editor.

Revision ID: 0125_annotation_catalog
Revises: 0124_rect_annotation_asset
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0125_annotation_catalog"
down_revision = "0124_rect_annotation_asset"
branch_labels = None
depends_on = None


# Style templates. These are the ONLY definition of an annotation's default
# size / colour / content; the renderer reads the merged result, never a
# hard-coded literal.
ANNOTATIONS = [
    {
        "kind": "rect_annotation",
        "display_name": "Rect Annotation",
        "description": (
            "Rectangular table marking - a flat outline (plus optional fill, "
            "caption and size readout) used to mark out a region of the "
            "optical table. No physics; mechanical domain only."
        ),
        "asset_catalog_id": "rect_annotation_frame",
        "component_catalog_id": "rect_annotation",
        "component_name": "Rect Annotation",
        "params": {
            "widthMm": 300,
            "depthMm": 200,
            "color": "#38bdf8",
            "lineWidthMm": 3,
            "fillOpacity": 0.12,
            "showLabel": True,
            "showDimensions": True,
            "label": "Region",
            "textHeightMm": 20,
        },
    },
    {
        "kind": "text_annotation",
        "display_name": "Text Annotation",
        "description": (
            "Free-form scene text label, rendered as a billboard sprite. "
            "No physics; mechanical domain only."
        ),
        "asset_catalog_id": "text_annotation_label",
        "component_catalog_id": "text_annotation",
        "component_name": "Text Annotation",
        "params": {
            "text": "Text",
            "textColor": "#ffffff",
            "bgColor": "rgba(15, 23, 42, 0.85)",
            "accentColor": "#38bdf8",
            "fontSizePx": 56,
            "scaleMm": 80,
        },
    },
]


def upgrade() -> None:
    bind = op.get_bind()
    for spec in ANNOTATIONS:
        params = json.dumps(spec["params"])
        tunable = json.dumps(sorted(spec["params"].keys()))

        # 1. The kind owns the style template. op_set_name='none' + the
        #    mechanical domain matches how every other physics-free kind is
        #    registered (0121 `mechanical`).
        bind.execute(
            sa.text(
                "INSERT INTO kinds ("
                " name, display_name, op_set_name, domains, default_params,"
                " anchor_template, needs_aperture, wavelength_range_nm,"
                " frequency_range_mhz, description"
                ") VALUES ("
                " :name, :display_name, 'none', ARRAY['mechanical']::text[],"
                " CAST(:params AS jsonb), CAST('{}' AS jsonb), false, NULL,"
                " NULL, :description"
                ") ON CONFLICT (name) DO NOTHING"
            ),
            {
                "name": spec["kind"],
                "display_name": spec["display_name"],
                "params": params,
                "description": spec["description"],
            },
        )

        # 2. The asset carries its own copy of the defaults (the Kind row is a
        #    template, not a live pointer - see the Kind model docstring) plus
        #    the tunable declaration that lets an instance override them.
        bind.execute(
            sa.text(
                "UPDATE assets_3d SET kind_id = :kind,"
                " default_params = CAST(:params AS jsonb),"
                " tunable_params = CAST(:tunable AS jsonb)"
                " WHERE catalog_id = :catalog_id"
            ),
            {
                "kind": spec["kind"],
                "params": params,
                "tunable": tunable,
                "catalog_id": spec["asset_catalog_id"],
            },
        )

        # 3. One shared catalog Component per annotation type.
        bind.execute(
            sa.text(
                "INSERT INTO components (name, kind_id, catalog_id, properties)"
                " SELECT :name, :kind, :catalog_id, CAST('{}' AS jsonb)"
                " WHERE NOT EXISTS ("
                "  SELECT 1 FROM components WHERE catalog_id = :catalog_id"
                " )"
            ),
            {
                "name": spec["component_name"],
                "kind": spec["kind"],
                "catalog_id": spec["component_catalog_id"],
            },
        )

        # 4. Its single root binding - without a binding leaf the tree walk
        #    renders an empty Group (the bug 0119 fixed for text labels).
        bind.execute(
            sa.text(
                "INSERT INTO component_bindings ("
                " component_id, target_kind, asset_3d_id, role, sort_order"
                ") SELECT c.id, 'asset', a.id, 'body', 0"
                " FROM components c, assets_3d a"
                " WHERE c.catalog_id = :component_catalog_id"
                "   AND a.catalog_id = :asset_catalog_id"
                "   AND NOT EXISTS ("
                "    SELECT 1 FROM component_bindings b WHERE b.component_id = c.id"
                "   )"
            ),
            {
                "component_catalog_id": spec["component_catalog_id"],
                "asset_catalog_id": spec["asset_catalog_id"],
            },
        )

        shared_id = bind.execute(
            sa.text("SELECT id FROM components WHERE catalog_id = :catalog_id"),
            {"catalog_id": spec["component_catalog_id"]},
        ).scalar_one()

        # 5. Existing annotations: their styling lived on the per-object
        #    Component, so fold it into the object's dynamic_sources (the
        #    object's own values win, though today there are none) and
        #    re-point the object at the shared catalog Component.
        bind.execute(
            sa.text(
                "UPDATE objects o SET"
                # jsonb_typeof, not COALESCE: a column holding the jsonb
                # scalar `null` is not SQL NULL, and `object || null` yields
                # an ARRAY, which then fails SceneObjectOut validation.
                " dynamic_sources = COALESCE(c.properties, '{}'::jsonb) || ("
                "  CASE WHEN jsonb_typeof(o.dynamic_sources) = 'object'"
                "       THEN o.dynamic_sources ELSE '{}'::jsonb END),"
                " component_id = :shared_id"
                " FROM components c"
                " WHERE o.component_id = c.id"
                "   AND c.kind_id = :kind"
                "   AND c.id <> :shared_id"
            ),
            {"shared_id": shared_id, "kind": spec["kind"]},
        )

        # 6. Drop the now-empty per-object Components (bindings cascade). The
        #    NOT EXISTS guards keep this a no-op on any row something else
        #    still points at, rather than failing the whole migration.
        bind.execute(
            sa.text(
                "DELETE FROM components c"
                " WHERE c.kind_id = :kind"
                "   AND c.id <> :shared_id"
                "   AND NOT EXISTS (SELECT 1 FROM objects o WHERE o.component_id = c.id)"
                "   AND NOT EXISTS ("
                "    SELECT 1 FROM component_bindings b WHERE b.sub_component_id = c.id"
                "   )"
            ),
            {"kind": spec["kind"], "shared_id": shared_id},
        )


def downgrade() -> None:
    bind = op.get_bind()
    for spec in ANNOTATIONS:
        # Fail loud rather than orphaning scene data: the upgrade collapsed N
        # per-object Components into one, and that is not reversible without
        # inventing N new rows. Delete the annotations first if you really need
        # to go back.
        in_use = bind.execute(
            sa.text(
                "SELECT count(*) FROM objects o JOIN components c"
                " ON o.component_id = c.id WHERE c.catalog_id = :catalog_id"
            ),
            {"catalog_id": spec["component_catalog_id"]},
        ).scalar_one()
        if in_use:
            raise RuntimeError(
                str(in_use) + " SceneObject(s) still instantiate the shared '"
                + str(spec["component_catalog_id"])
                + "' Component. Delete those annotations before downgrading "
                "past 0125."
            )
        bind.execute(
            sa.text("DELETE FROM components WHERE catalog_id = :catalog_id"),
            {"catalog_id": spec["component_catalog_id"]},
        )
        bind.execute(
            sa.text(
                "UPDATE assets_3d SET kind_id = 'unclassified',"
                " default_params = CAST('{}' AS jsonb),"
                " tunable_params = CAST('[]' AS jsonb)"
                " WHERE catalog_id = :catalog_id"
            ),
            {"catalog_id": spec["asset_catalog_id"]},
        )
        bind.execute(
            sa.text("DELETE FROM kinds WHERE name = :name"), {"name": spec["kind"]}
        )
