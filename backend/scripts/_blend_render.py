import bpy
import mathutils

scene = bpy.context.scene
master = scene.collection
linked = {c.name for c in master.children_recursive}
for col in bpy.data.collections:
    if col.name == "AOM" and col.name not in linked:
        master.children.link(col)
    col.hide_render = False
    col.hide_viewport = False

# Compute bounding box of meshes only.
all_verts = []
for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    for v in obj.data.vertices:
        all_verts.append(obj.matrix_world @ v.co)
mn = mathutils.Vector((min(v.x for v in all_verts), min(v.y for v in all_verts), min(v.z for v in all_verts)))
mx = mathutils.Vector((max(v.x for v in all_verts), max(v.y for v in all_verts), max(v.z for v in all_verts)))
center = (mn + mx) / 2
size = max((mx - mn).x, (mx - mn).y, (mx - mn).z)

# Brighten: replace the Sun and add an area fill from the front-top.
for light in bpy.data.lights:
    if light.type == "SUN":
        light.energy = 12.0

key = bpy.data.lights.new("Key", type="AREA")
key.energy = 200
key.size = size * 4
key_obj = bpy.data.objects.new("KeyLight", key)
master.objects.link(key_obj)
key_obj.location = center + mathutils.Vector((-size * 1.2, -size * 1.2, size * 1.5))
key_obj.rotation_mode = "QUATERNION"
key_obj.rotation_quaternion = (center - key_obj.location).to_track_quat("-Z", "Y")

# Camera in 3/4 view, framed wide enough to see the whole AOM + bolts.
cam_data = bpy.data.cameras.new("RenderCam")
cam_data.lens = 50
cam = bpy.data.objects.new("RenderCam", cam_data)
master.objects.link(cam)
distance = size * 2.6
cam.location = center + mathutils.Vector((distance * 0.8, -distance * 1.0, distance * 0.6))
cam.rotation_mode = "QUATERNION"
cam.rotation_quaternion = (center - cam.location).to_track_quat("-Z", "Y")
scene.camera = cam

scene.render.resolution_x = 800
scene.render.resolution_y = 600
scene.render.image_settings.file_format = "PNG"
scene.render.engine = "BLENDER_EEVEE"
# Slight ambient so the shadowed side isn't pitch-black.
world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = False
world.color = (0.5, 0.5, 0.55)

out_path = "C:/Users/admin/Downloads/_zhao_aom_thumb.png"
scene.render.filepath = out_path
bpy.ops.render.render(write_still=True)
print(f"BBOX_MM={(mx - mn).x*1000:.2f}x{(mx - mn).y*1000:.2f}x{(mx - mn).z*1000:.2f}")
print(f"OUT={out_path}")
