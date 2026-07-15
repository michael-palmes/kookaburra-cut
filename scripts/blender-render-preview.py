"""Headless picker-card render for Kookaburra Cut's device catalog previews.

Run via Blender's CLI (see scripts/render-device-previews.sh):

    blender -b <colour>.blend --python scripts/blender-render-preview.py -- <out>.png [size] [fill]

The vendor .blends ship a complete studio (active camera + area-light rig + packed HDRI
world, Cycles) — this script only makes the shot card-friendly: transparent film (the
baked backdrops are hidden), the vendor camera dollied along its own view axis so the
subject fills a consistent fraction of the card regardless of the vendor's framing, a
sane sample count for a small still, and a square card resolution. Output PNGs are
COMMITTED under src/assets/device-previews/ so the app never needs Blender at runtime.
"""

import math
import sys

import bpy
from mathutils import Vector

argv = sys.argv
argv = argv[argv.index("--") + 1 :] if "--" in argv else []
out = argv[0]
size = int(argv[1]) if len(argv) > 1 else 640
# Fraction of the frame the subject's bounding sphere should span.
fill = float(argv[2]) if len(argv) > 2 else 0.9

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 128
scene.render.resolution_x = size
scene.render.resolution_y = size
scene.render.film_transparent = True
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.filepath = out

# The studio backdrops would defeat the transparent film (same nodes HIDDEN_NODES culls in
# the app): "BG Plane" (iPhone 15 Pro), "Bg" (iPhone 17 Pro), "Cube"/"View_Blocker"
# (MacBook). Match loosely in case of suffixes.
BACKDROPS = ("bg plane", "bg", "cube", "view blocker")
for obj in bpy.data.objects:
    name = obj.name.replace("_", " ").lower()
    if any(name == b or name.startswith(f"{b}.") for b in BACKDROPS):
        obj.hide_render = True

# Dolly the vendor camera along its own view axis so the subject's bounding sphere spans
# the same frame fraction for every device; each vendor frames its studio differently.
cam = scene.camera
if cam:
    # Vendor rigs may parent or track-constrain the camera; both would fight the reframe.
    world = cam.matrix_world.copy()
    cam.parent = None
    cam.constraints.clear()
    cam.matrix_world = world
    deps = bpy.context.evaluated_depsgraph_get()
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for obj in scene.objects:
        if obj.type != "MESH" or obj.hide_render:
            continue
        for corner in obj.evaluated_get(deps).bound_box:
            point = obj.matrix_world @ Vector(corner)
            lo = Vector(map(min, lo, point))
            hi = Vector(map(max, hi, point))
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 1e-6)
    direction = (cam.matrix_world.translation - center).normalized()
    if cam.data.type == "ORTHO":
        cam.data.ortho_scale = (2 * radius) / fill
        distance = radius * 4
    else:
        distance = radius / (fill * math.tan(cam.data.angle / 2))
    cam.location = center + direction * distance
    # Aim precisely at the subject centre so the reframe never crops it.
    cam.rotation_mode = "XYZ"
    cam.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler("XYZ")

scene.render.use_stamp = False  # never bake file-path/host metadata into committed previews
bpy.ops.render.render(write_still=True)
print(f"[blender-render-preview] wrote {out}")
