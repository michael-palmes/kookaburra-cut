"""
Headless OBJ -> GLB conversion for the generated Android (Pixel-style) handset.

    blender -b --python scripts/prepare-android-model.py -- <in>.obj <out>.glb

Unlike the licensed vendor models (Blender .blend -> GLB, gitignored UUID outputs), the
Android is a generated, unlicensed OBJ, so its GLB is committed directly. The source OBJ
carries flat MTL colours only, so this: gives the metal/glass/bezel materials sensible PBR
values, and embeds a small gradient on the `screen` material because the catalog preload's
texture-decode guard rejects an all-untextured parse (the placeholder does the same). The
model already measures in metres with the screen facing glTF +Z, so no scale/yaw fixup.
Export flags match scripts/blender-export-glb.py (Y-up, no Draco). See
src/assets/models/README.md and docs/determinism.md.
"""

import sys

import bpy
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OBJ, OUT = argv[0], argv[1]

# Material name -> PBR role. Frame and camera metal are metallic; glass is a glossy
# dielectric; the bezel and sensor read matte-dark. Colour variants override these by
# name in src/toolkit/device/catalog.ts.
METAL = {"frame_metal", "camera_bar", "lens_ring", "lens_ring_0", "lens_ring_2"}
GLASS = {"back_glass", "lens_glass", "lens_glass_dark", "lens_glass_dark_1", "lens_glass_dark_3"}
DARK = {"bezel_black", "sensor"}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.obj_import(filepath=OBJ)


def bsdf(mat):
    if not mat.use_nodes:
        mat.use_nodes = True
    return next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)


for mat in bpy.data.materials:
    b = bsdf(mat)
    if not b:
        continue
    name = mat.name
    if name in METAL:
        b.inputs["Metallic"].default_value = 1.0
        b.inputs["Roughness"].default_value = 0.38
    elif name in GLASS:
        b.inputs["Metallic"].default_value = 0.0
        b.inputs["Roughness"].default_value = 0.12
    elif name in DARK:
        b.inputs["Metallic"].default_value = 0.0
        b.inputs["Roughness"].default_value = 0.55
    elif name == "flash":
        b.inputs["Metallic"].default_value = 0.0
        b.inputs["Roughness"].default_value = 0.30
    elif name == "screen":
        b.inputs["Metallic"].default_value = 0.0
        b.inputs["Roughness"].default_value = 0.25

# A small vertical gradient on the screen material so the parsed glb has a textured
# material (the catalog preload's texture-decode guard rejects an all-untextured parse).
# The Device primitive swaps this material for the scene's media at runtime.
W, H = 4, 160
px = np.zeros((H, W, 4), dtype=np.float32)
for y in range(H):
    t = y / (H - 1)
    px[y, :, 0] = 0.015 + 0.015 * t
    px[y, :, 1] = 0.025 + 0.030 * t
    px[y, :, 2] = 0.050 + 0.070 * t
    px[y, :, 3] = 1.0
img = bpy.data.images.new("screen_gradient", width=W, height=H)
img.colorspace_settings.name = "sRGB"
img.pixels.foreach_set(px.reshape(-1))
img.pack()

screen_mat = bpy.data.materials.get("screen")
if screen_mat:
    b = bsdf(screen_mat)
    tex = screen_mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = img
    screen_mat.node_tree.links.new(tex.outputs["Color"], b.inputs["Base Color"])

bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_apply=True,
    export_yup=True,
    export_draco_mesh_compression_enable=False,
)
print(f"[prepare-android-model] wrote {OUT}")
