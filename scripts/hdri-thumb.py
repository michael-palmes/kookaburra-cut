# Blender headless EXR -> picker thumbnail JPEG (v9 lighting) — used by prepare-hdri.sh.
# UI-only output (picker tiles), never an export input, so the view transform is free to
# be the display default rather than the Raw copy exr-to-hdr.py uses.
#
#   blender -b --factory-startup -P scripts/hdri-thumb.py -- <in.exr> <out.jpg>
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1 :]
src, dest = argv[0], argv[1]

img = bpy.data.images.load(src)
img.scale(160, 80)
scene = bpy.context.scene
scene.render.image_settings.file_format = "JPEG"
scene.render.image_settings.quality = 82
scene.view_settings.view_transform = "Standard"
img.save_render(dest, scene=scene)
print(f"wrote {dest}")
