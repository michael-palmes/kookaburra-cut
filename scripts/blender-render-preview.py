"""Headless picker-card render for Kookaburra Cut's device catalog previews.

Run via Blender's CLI (see scripts/render-device-previews.sh):

    blender -b <colour>.blend --python scripts/blender-render-preview.py -- <out>.png [size] [fill] [roll]
        [--glb <built>.glb] [--tint name=#hex,...] [--frame N] [--turn yaw,pitch]

The vendor .blends ship a complete studio (active camera + area-light rig + packed HDRI
world, Cycles) — this script only makes the shot card-friendly: transparent film (the
baked backdrops are hidden), the vendor camera dollied along its own view axis so the
subject fills a consistent fraction of the card regardless of the vendor's framing, a
sane sample count for a small still, and a square card resolution. Output PNGs are
COMMITTED under src/assets/device-previews/ so the app never needs Blender at runtime.

`--glb` swaps the vendor's device for the app's BUILT glb inside the vendor studio, for a
finish that has no vendor colour blend (the iPhone Duo's Night Sky): `--tint` multiplies
named materials exactly as the catalogue's colour overrides do, `--frame` poses the glb's
clip, and `--turn` rotates the device in front of the vendor camera.
"""

import math
import sys

import bpy
from mathutils import Matrix, Vector

argv = sys.argv
argv = argv[argv.index("--") + 1 :] if "--" in argv else []
out = argv[0]
size = int(argv[1]) if len(argv) > 1 else 640
# Fraction of the frame the subject's bounding sphere should span.
fill = float(argv[2]) if len(argv) > 2 else 0.9
# Camera roll (degrees about its view axis) so a portrait-authored vendor studio can
# card a landscape device (the iPad); matches the export's corrective roll.
roll = float(argv[3]) if len(argv) > 3 and not argv[3].startswith("--") else 0.0


def option(name):
    return argv[argv.index(name) + 1] if name in argv else ""


glb = option("--glb")
tints = dict(pair.split("=") for pair in option("--tint").split(",") if pair)
pose_frame = int(option("--frame") or 0)
turn = [float(a) for a in (option("--turn") or "0,0").split(",")]

scene = bpy.context.scene


def srgb_to_linear(hex_colour):
    channels = [int(hex_colour.lstrip("#")[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels] + [1.0]


if glb:
    # Keep the studio (camera, lights, their aim target, world); the device comes from the glb.
    for obj in list(bpy.data.objects):
        if obj.type in {"MESH", "ARMATURE"} or (obj.type == "EMPTY" and obj.children):
            bpy.data.objects.remove(obj, do_unlink=True)
    before = set(bpy.data.objects)
    scene.render.fps = 30  # the fold clip is one frame per degree at 30 fps
    bpy.ops.import_scene.gltf(filepath=glb)
    # The importer adds an unrendered bone-shape helper that would skew the framing bounds.
    for obj in [o for o in bpy.data.objects if o not in before and o.type == "MESH" and not o.data.materials]:
        bpy.data.objects.remove(obj, do_unlink=True)
    imported = [o for o in bpy.data.objects if o not in before]
    scene.frame_set(pose_frame)
    for name, hex_colour in tints.items():
        material = bpy.data.materials.get(name)
        if not material:
            raise SystemExit(f"[blender-render-preview] tint material not in the glb: {name}")
        tree = material.node_tree
        base = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"]
        mix = tree.nodes.new("ShaderNodeMix")
        mix.data_type, mix.blend_type = "RGBA", "MULTIPLY"
        # The Mix node repeats its A/B/Result names per data type; 6, 7 and 2 are the colour sockets.
        colour_a, colour_b, result = mix.inputs[6], mix.inputs[7], mix.outputs[2]
        mix.inputs[0].default_value = 1.0
        colour_b.default_value = srgb_to_linear(hex_colour)
        if base.is_linked:
            tree.links.new(base.links[0].from_socket, colour_a)
        else:
            colour_a.default_value = base.default_value
        tree.links.new(result, base)
    spin = Matrix.Rotation(math.radians(turn[0]), 4, "Z") @ Matrix.Rotation(math.radians(turn[1]), 4, "X")
    for obj in imported:
        if obj.parent is None:
            obj.matrix_world = spin @ obj.matrix_world
    bpy.context.view_layer.update()

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
# (MacBook). "Apple Pencil Pro" is the accessory the iPad vendor stages beside the device
# (excluded from the exported glb too). Match loosely in case of suffixes; hide descendants
# since the pencil is an empty with mesh children.
BACKDROPS = ("bg plane", "bg", "cube", "view blocker", "apple pencil pro")
for obj in bpy.data.objects:
    name = obj.name.replace("_", " ").lower()
    if any(name == b or name.startswith(f"{b}.") for b in BACKDROPS):
        for hidden in [obj, *obj.children_recursive]:
            hidden.hide_render = True

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
    if roll:
        cam.rotation_euler.rotate_axis("Z", math.radians(roll))

scene.render.use_stamp = False  # never bake file-path/host metadata into committed previews
bpy.ops.render.render(write_still=True)
print(f"[blender-render-preview] wrote {out}")
