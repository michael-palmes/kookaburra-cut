# Blender headless EXR → Radiance .hdr conversion (v8 · M1) — used by prepare-hdri.sh
# because the Homebrew ImageMagick lacks the OpenEXR delegate. Blender is already a
# dev-time dependency (device previews render through it).
#
#   blender -b --factory-startup -P scripts/exr-to-hdr.py -- <in.exr> <out.hdr>
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1 :]
src, dest = argv[0], argv[1]

img = bpy.data.images.load(src)
img.file_format = "HDR"
scene = bpy.context.scene
scene.render.image_settings.file_format = "HDR"
# save_render routes through the scene's colour management — override to a straight copy.
scene.view_settings.view_transform = "Raw"
scene.display_settings.display_device = "None" if "None" in [
    d.identifier for d in type(scene.display_settings).bl_rna.properties["display_device"].enum_items
] else scene.display_settings.display_device
img.save_render(dest, scene=scene)
print(f"wrote {dest}")
