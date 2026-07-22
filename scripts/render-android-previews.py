"""
Render the Android device's picker-card previews, one per catalog colour.

    blender -b --python scripts/render-android-previews.py -- <in>.glb <out-dir>

Imports the committed GLB, applies each colour's frame + back-glass override (the same
values as src/toolkit/device/catalog.ts, kept in sync by hand), and renders a front-on
orthographic PNG with a transparent background. Outputs <out-dir>/<colour>.png for the
catalog's `previews` map. See src/assets/models/README.md.
"""

import math
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
GLB, OUTDIR = argv[0], argv[1]

# Keep these frame/back values in step with androidColour(...) in catalog.ts.
COLOURS = {
    "graphite": {"frame": "#4a4a4d", "back": "#3a3a3c"},
    "black": {"frame": "#2c2c2e", "back": "#202022"},
    "white": {"frame": "#dcdcda", "back": "#ededea"},
}
FRAME_MATS = {"frame_metal", "camera_bar", "lens_ring", "lens_ring_0", "lens_ring_2"}
BACK_MATS = {"back_glass"}


def s2l(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexlin(h):
    h = h.lstrip("#")
    return tuple(s2l(int(h[i : i + 2], 16) / 255) for i in (0, 2, 4)) + (1.0,)


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

meshes = [o for o in bpy.data.objects if o.type == "MESH"]
lo = Vector((1e9,) * 3)
hi = Vector((-1e9,) * 3)
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        lo = Vector(map(min, lo, w))
        hi = Vector(map(max, hi, w))
center = (lo + hi) / 2
size = hi - lo
extent = max(size.x, size.z, 0.001)

cam_data = bpy.data.cameras.new("C")
cam_data.type = "ORTHO"
cam_data.ortho_scale = extent * 1.3
cam_data.clip_end = 1000
cam = bpy.data.objects.new("C", cam_data)
cam.location = (center.x, lo.y - max(size.length, 1), center.z)
cam.rotation_euler = (math.radians(90), 0, 0)
bpy.context.scene.collection.objects.link(cam)
bpy.context.scene.camera = cam

for ang, energy in [((55, 0, 20), 3.0), ((65, 0, -45), 1.6)]:
    ld = bpy.data.lights.new("S", type="SUN")
    ld.energy = energy
    s = bpy.data.objects.new("S", ld)
    s.rotation_euler = tuple(math.radians(a) for a in ang)
    bpy.context.scene.collection.objects.link(s)
world = bpy.data.worlds.new("W")
world.color = (0.55, 0.55, 0.6)
bpy.context.scene.world = world

sc = bpy.context.scene
sc.render.resolution_x = 512
sc.render.resolution_y = 512
sc.render.film_transparent = True


def bsdf(mat):
    return next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)


for cid, cols in COLOURS.items():
    for mat in bpy.data.materials:
        b = bsdf(mat)
        if not b:
            continue
        if mat.name in FRAME_MATS:
            b.inputs["Base Color"].default_value = hexlin(cols["frame"])
        elif mat.name in BACK_MATS:
            b.inputs["Base Color"].default_value = hexlin(cols["back"])
    sc.render.filepath = f"{OUTDIR}/{cid}.png"
    bpy.ops.render.render(write_still=True)
    print(f"[render-android-previews] wrote {cid}.png")
