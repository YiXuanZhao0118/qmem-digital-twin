import bpy
import json

out = {
    "all_objects_in_data": [],
    "all_meshes_in_data": [{"name": m.name, "vertex_count": len(m.vertices), "polygon_count": len(m.polygons)} for m in bpy.data.meshes],
    "all_collections": [],
    "libraries_linked": [{"name": lib.name, "filepath": lib.filepath} for lib in bpy.data.libraries],
    "all_lights": [{"name": l.name, "type": l.type} for l in bpy.data.lights],
    "all_materials": [m.name for m in bpy.data.materials],
    "all_images": [{"name": i.name, "filepath": i.filepath, "size": list(i.size)} for i in bpy.data.images],
    "all_texts": [{"name": t.name, "lines": len(t.lines)} for t in bpy.data.texts],
}
for obj in bpy.data.objects:
    info = {
        "name": obj.name,
        "type": obj.type,
        "location_mm": [round(c * 1000, 3) for c in obj.location],
        "scale": [round(s, 4) for s in obj.scale],
        "dimensions_mm": [round(d * 1000, 3) for d in obj.dimensions],
        "parent": obj.parent.name if obj.parent else None,
        "library": obj.library.filepath if obj.library else None,
        "users": obj.users,
    }
    if obj.type == "MESH" and obj.data:
        info["mesh_name"] = obj.data.name
        info["vertex_count"] = len(obj.data.vertices)
        info["material_slots"] = [m.material.name if m.material else None for m in obj.material_slots]
    if obj.instance_collection:
        info["instance_collection"] = obj.instance_collection.name
    out["all_objects_in_data"].append(info)
for col in bpy.data.collections:
    out["all_collections"].append({
        "name": col.name,
        "object_names": [o.name for o in col.objects],
        "child_collections": [c.name for c in col.children],
    })
print("BLEND_DATA_START")
print(json.dumps(out, indent=2))
print("BLEND_DATA_END")
