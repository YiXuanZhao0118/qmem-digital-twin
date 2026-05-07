"""Boolean-cut the AOM end-cap holes and add a TeO2 crystal, then export GLB.

Run with:
  "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" --background \\
    --python qmem-digital-twin/backend/scripts/fix_aom_blend.py -- \\
    <input.blend> <output.glb>

Steps:
  1. Open the input .blend (the user's AOM source).
  2. For each end_cap (left/right), add a BOOLEAN DIFFERENCE modifier using
     `laser_path_cutter`, then APPLY it. This converts the end-cap from a
     solid plate into a plate with a through-hole sized exactly like the
     cutter's cross-section. The user designed the cutter geometry but
     never applied the boolean — that's why the GLB came out with sealed
     end caps.
  3. Add a small TeO2 crystal mesh INSIDE the body, centred on the laser
     path. Its dimensions match a typical AA-Optoelectronic crystal
     (~3 × 3 × 25 mm). Slight gold-brown colour so it reads as a
     "Bragg cell" through the new through-hole.
  4. Delete the cutter meshes so they don't bloat the GLB or accidentally
     render.
  5. Export to GLB at the given output path.
"""

from __future__ import annotations

import sys

import bpy
import mathutils


def get_arg(name: str, *, required: bool = True) -> str | None:
    """Parse positional args after `--` (Blender's convention)."""
    if "--" not in sys.argv:
        if required:
            raise SystemExit(f"Missing argument: {name}")
        return None
    tail = sys.argv[sys.argv.index("--") + 1 :]
    if name == "input":
        return tail[0] if tail else None
    if name == "output":
        return tail[1] if len(tail) >= 2 else None
    return None


def apply_boolean_difference(target_name: str, cutter_name: str) -> None:
    """Add Boolean DIFFERENCE modifier on target using cutter, then apply.

    Skips silently when either mesh is missing — the caller already
    decides whether the mesh should exist."""
    target = bpy.data.objects.get(target_name)
    cutter = bpy.data.objects.get(cutter_name)
    if not target or not cutter:
        print(f"  skip boolean: target={bool(target)} cutter={bool(cutter)}")
        return
    # Need the cutter visible & evaluated to be used as a boolean operand.
    cutter.hide_viewport = False
    cutter.hide_render = False
    bpy.context.view_layer.update()

    bpy.context.view_layer.objects.active = target
    target.select_set(True)
    mod = target.modifiers.new(name=f"hole_{cutter_name}", type="BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.object = cutter
    # Apply existing modifiers (BEVEL etc.) IN ORDER so the boolean cuts
    # the bevelled-edge geometry, not the raw box. Then apply the boolean.
    for m in list(target.modifiers):
        try:
            bpy.ops.object.modifier_apply(modifier=m.name)
        except Exception as exc:
            print(f"  modifier_apply failed for {m.name}: {exc}")
    target.select_set(False)
    print(f"  boolean: {target_name} - {cutter_name} -> applied")


def add_teo2_crystal(scene_collection) -> None:
    """Insert a small TeO2 Bragg-cell crystal at the centre of the body,
    along the laser axis. Visible through the new end-cap through-hole."""
    # Reuse the user's body to read the optical-axis offset (their cutter
    # is centred at z=+0.002 m = +2 mm above the geometric centre — that
    # IS the optical axis height the user authored).
    cutter = bpy.data.objects.get("laser_path_cutter")
    z_offset = cutter.location.z if cutter else 0.002

    # Create a thin rectangular prism — 3×3×25 mm.
    bpy.ops.mesh.primitive_cube_add(
        size=1.0,
        location=(0.0, 0.0, z_offset),
    )
    crystal = bpy.context.active_object
    crystal.name = "teo2_crystal"
    crystal.scale = (0.0125, 0.0015, 0.0015)  # half-extents → 25 × 3 × 3 mm
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    # Material — translucent gold-brown so it reads as the Bragg cell.
    mat = bpy.data.materials.new("teo2_crystal_mat")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (0.78, 0.55, 0.18, 1.0)
        # Some Blender versions expose Transmission as a slot; guard it.
        if "Transmission" in bsdf.inputs:
            bsdf.inputs["Transmission"].default_value = 0.4
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = 0.18
    crystal.data.materials.append(mat)
    print("  added crystal: teo2_crystal (25 × 3 × 3 mm)")


def main() -> None:
    in_path = get_arg("input")
    out_path = get_arg("output")
    if not in_path or not out_path:
        raise SystemExit("usage: ... -- <input.blend> <output.glb>")

    bpy.ops.wm.open_mainfile(filepath=in_path)
    bpy.ops.object.select_all(action="DESELECT")

    # Step 1: drill input/output through-holes via boolean DIFF if the
    # blend has cutters with the conventional names. Skips silently when
    # the names don't exist (newer blend revisions sometimes re-name or
    # already pre-apply the boolean).
    apply_boolean_difference("left_end_cap", "laser_path_cutter")
    apply_boolean_difference("right_end_cap", "laser_path_cutter")
    # Newer blend names ("left end cap", "laser path cutter" with spaces).
    apply_boolean_difference("left end cap", "laser path cutter")
    apply_boolean_difference("right end cap", "laser path cutter")

    # Step 2: only add a fallback crystal when the user hasn't authored
    # one. Detect existing crystal-like meshes by name keyword and skip
    # add_teo2_crystal if present.
    crystal_names = {"crystal", "teo2", "ao crystal"}
    has_crystal = any(
        any(k in obj.name.lower() for k in crystal_names)
        for obj in bpy.data.objects
        if obj.type == "MESH"
    )
    if not has_crystal:
        add_teo2_crystal(bpy.context.scene.collection)
    else:
        print("  user-authored crystal detected — skipping fallback insert")

    # Step 3: remove every mesh whose name contains "cutter". User adds
    # these as boolean operands; they should never appear in the final
    # GLB. Catches both the old (`laser_path_cutter`) and new
    # (`inner cavity cutter`) naming. Snapshot NAMES first because
    # bpy.data.objects.remove invalidates the StructRNA on the live
    # iterator — iterating it directly throws "StructRNA has been
    # removed".
    cutter_names = [
        obj.name
        for obj in list(bpy.data.objects)
        if obj.type == "MESH" and "cutter" in obj.name.lower()
    ]
    for name in cutter_names:
        obj = bpy.data.objects.get(name)
        if obj is not None:
            bpy.data.objects.remove(obj, do_unlink=True)
            print(f"  removed cutter: {name}")

    # Step 4: export GLB.
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        export_apply=True,
    )
    print(f"  exported -> {out_path}")


if __name__ == "__main__":
    main()
