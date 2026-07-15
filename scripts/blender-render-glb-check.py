"""
Orientation sanity render for an exported device GLB.

    blender -b --python scripts/blender-render-glb-check.py -- <in>.glb <out>.png

Imports the glb into an empty scene and renders it head-on along the glTF +Z (front) axis
with an orthographic camera, so the PNG directly shows what the app's identity rotation
(`rotationDeg [0,0,0]`) faces. Known vendor backdrop nodes are removed first.
"""

import math
import sys

import bpy
from mathutils import Vector

# Blender's importer keeps the raw glTF names (spaces and dots intact), unlike three.js.
HIDDEN = {"BG Plane", "BG_Plane", "Bg", "Cube", "View_Blocker.001"}

argv = sys.argv
argv = argv[argv.index("--") + 1 :] if "--" in argv else []
src, out = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

for obj in list(bpy.data.objects):
    if obj.name in HIDDEN:
        bpy.data.objects.remove(obj, do_unlink=True)

# World-space bounds of everything imported.
lo = Vector((1e9, 1e9, 1e9))
hi = Vector((-1e9, -1e9, -1e9))
for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    for corner in obj.bound_box:
        world = obj.matrix_world @ Vector(corner)
        lo = Vector(map(min, lo, world))
        hi = Vector(map(max, hi, world))
center = (lo + hi) / 2
size = hi - lo
extent = max(size.x, size.z, 0.001)

# glTF +Z (front) imports as Blender -Y; a camera on -Y looking back sees the front.
cam_data = bpy.data.cameras.new("CheckCam")
cam_data.type = "ORTHO"
cam_data.ortho_scale = extent * 1.2
cam_data.clip_end = 1000
cam = bpy.data.objects.new("CheckCam", cam_data)
cam.location = (center.x, lo.y - max(size.length, 1), center.z)
cam.rotation_euler = (math.radians(90), 0, 0)
bpy.context.scene.collection.objects.link(cam)
bpy.context.scene.camera = cam

sun_data = bpy.data.lights.new("Sun", type="SUN")
sun_data.energy = 3
sun = bpy.data.objects.new("Sun", sun_data)
sun.rotation_euler = (math.radians(60), 0, math.radians(15))
bpy.context.scene.collection.objects.link(sun)
world = bpy.data.worlds.new("World")
world.color = (0.6, 0.6, 0.6)
bpy.context.scene.world = world

scene = bpy.context.scene
scene.render.resolution_x = 640
scene.render.resolution_y = 640
scene.render.film_transparent = True
scene.render.filepath = out
bpy.ops.render.render(write_still=True)
print(f"[render-glb-check] wrote {out}")
