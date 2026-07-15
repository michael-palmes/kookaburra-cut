# Generate the bundled GENERIC placeholder handset (src/assets/models/placeholder-phone.glb).
#
# Public clones build against this model; a licensed model dropped into
# src/assets/models/licensed/ overrides it at build time (src/toolkit/device/modelUrl.ts).
# It honours the device-model contract (src/assets/models/README.md):
#   - display mesh named "Display", material named "SCREEN",
#   - screen UVs span 0..1 with v=0 at the TOP in glTF orientation,
#   - the SCREEN material carries an embedded texture (the catalog preload's
#     texture-decode guard requires at least one textured material),
#   - no Draco/KTX2; metres scale; front faces glTF +Z.
#
# Run:  /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/make-placeholder-phone.py -- <out.glb>

import sys

import bmesh
import bpy

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
out = argv[0] if argv else "src/assets/models/placeholder-phone.glb"

# Fresh scene
bpy.ops.wm.read_factory_settings(use_empty=True)

# Approximate modern-handset dimensions in metres (generic, not any specific product).
W, H, D = 0.0716, 0.1476, 0.0083  # width (X), height (Blender Z), depth (Blender Y)
BEVEL = 0.006

# ---- Body ---------------------------------------------------------------
mesh = bpy.data.meshes.new("Body")
bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1.0)
for v in bm.verts:
    v.co.x *= W
    v.co.y *= D
    v.co.z *= H
bm.to_mesh(mesh)
bm.free()
body = bpy.data.objects.new("Body", mesh)
bpy.context.collection.objects.link(body)

bevel = body.modifiers.new("bevel", "BEVEL")
bevel.width = BEVEL
bevel.segments = 6
bevel.limit_method = "NONE"

body_mat = bpy.data.materials.new("BodyMatte")
body_mat.use_nodes = True
bsdf = body_mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (0.045, 0.05, 0.058, 1.0)
bsdf.inputs["Metallic"].default_value = 0.55
bsdf.inputs["Roughness"].default_value = 0.55
body.data.materials.append(body_mat)

# ---- Screen texture (embedded; satisfies the catalog texture guard) -----
TEX = 64
img = bpy.data.images.new("PlaceholderScreen", width=TEX, height=TEX, alpha=False)
px = []
for row in range(TEX):
    t = row / (TEX - 1)  # 0 bottom .. 1 top in Blender image space
    r = 0.055 + 0.03 * t
    g = 0.065 + 0.035 * t
    b = 0.085 + 0.05 * t
    px.extend([r, g, b, 1.0] * TEX)
img.pixels = px
img.pack()

screen_mat = bpy.data.materials.new("SCREEN")
screen_mat.use_nodes = True
nt = screen_mat.node_tree
sbsdf = nt.nodes["Principled BSDF"]
sbsdf.inputs["Roughness"].default_value = 0.2
tex_node = nt.nodes.new("ShaderNodeTexImage")
tex_node.image = img
nt.links.new(tex_node.outputs["Color"], sbsdf.inputs["Base Color"])

# ---- Display plane ------------------------------------------------------
SW, SH = W * 0.92, H * 0.955  # bezel margin
smesh = bpy.data.meshes.new("Display")
sbm = bmesh.new()
# Front of the body is Blender -Y (exports to glTF +Z). Sit just proud of the face.
y = -(D / 2) - 0.0004
corners = [
    (-SW / 2, y, -SH / 2),
    (SW / 2, y, -SH / 2),
    (SW / 2, y, SH / 2),
    (-SW / 2, y, SH / 2),
]
verts = [sbm.verts.new(c) for c in corners]
face = sbm.faces.new(verts)
face.normal_update()
if face.normal.y > 0:  # must face -Y (outward)
    face.normal_flip()
uv_layer = sbm.loops.layers.uv.new("UVMap")
for loop in face.loops:
    x, _, z = loop.vert.co
    u = (x + SW / 2) / SW
    v_blender = (z + SH / 2) / SH  # 0 at bottom (Blender); exporter flips → glTF v=0 at TOP
    loop[uv_layer].uv = (u, v_blender)
sbm.to_mesh(smesh)
sbm.free()
display = bpy.data.objects.new("Display", smesh)
display.data.materials.append(screen_mat)
bpy.context.collection.objects.link(display)
display.parent = body

# ---- Export -------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    export_yup=True,
    export_apply=True,
    export_image_format="AUTO",
)
print(f"[make-placeholder-phone] wrote {out}")
