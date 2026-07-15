"""
Headless glTF (GLB) export for Kookaburra Cut's DeviceMockup asset pipeline.

Run via Blender's CLI (see scripts/prepare-device-model.sh):

    blender -b <file>.blend --python scripts/blender-export-glb.py -- <out>.glb [yaw-deg]

Exports the whole scene as a single binary GLB, Y-up for three.js, with modifiers
applied. An optional yaw (degrees about the up axis) corrects vendors whose model faces
away from glTF +Z at identity (the app's front-on contract). Draco is left OFF on
purpose: drei's `useGLTF` defaults its Draco decoder to a CDN, which breaks the app's
offline + deterministic-export contract. Texture/mesh size is handled downstream by
gltf-transform. See docs/determinism.md.
"""

import math
import sys

import bpy
from mathutils import Matrix

# Args after the "--" separator are ours; everything before belongs to Blender.
argv = sys.argv
argv = argv[argv.index("--") + 1 :] if "--" in argv else []
out = argv[0] if argv else "/tmp/phone-generic.glb"
yaw_deg = float(argv[1]) if len(argv) > 1 else 0.0

if yaw_deg:
    rot = Matrix.Rotation(math.radians(yaw_deg), 4, "Z")
    for obj in bpy.context.scene.objects:
        if obj.parent is None:
            obj.matrix_world = rot @ obj.matrix_world
    print(f"[blender-export-glb] applied corrective yaw {yaw_deg} deg")


def linked_rgb(socket):
    """The RGB node value feeding a socket, else its own default."""
    if socket.is_linked and socket.links[0].from_node.type == "RGB":
        return tuple(socket.links[0].from_node.outputs[0].default_value)
    return tuple(socket.default_value)


# The glTF exporter only understands Principled BSDF; some vendor blends (iPhone 17 Pro)
# drive materials with the newer Metallic BSDF, which would export as blank white. Rebuild
# those as Principled with the same colour/roughness (and normal map when present).
for mat in bpy.data.materials:
    if not mat.use_nodes:
        continue
    nodes = mat.node_tree.nodes
    if any(n.type == "BSDF_PRINCIPLED" for n in nodes):
        continue
    metallic = next((n for n in nodes if n.type == "BSDF_METALLIC"), None)
    output = next((n for n in nodes if n.type == "OUTPUT_MATERIAL"), None)
    if not metallic or not output:
        continue
    principled = nodes.new("ShaderNodeBsdfPrincipled")
    principled.inputs["Base Color"].default_value = linked_rgb(metallic.inputs["Base Color"])
    principled.inputs["Metallic"].default_value = 1.0
    rough = metallic.inputs["Roughness"]
    principled.inputs["Roughness"].default_value = (
        0.4 if rough.is_linked else float(rough.default_value)
    )
    links = mat.node_tree.links
    normal = metallic.inputs.get("Normal")
    if normal and normal.is_linked:
        links.new(normal.links[0].from_socket, principled.inputs["Normal"])
    for link in list(output.inputs["Surface"].links):
        links.remove(link)
    links.new(principled.outputs["BSDF"], output.inputs["Surface"])
    print(f"[blender-export-glb] rebuilt Metallic BSDF material as Principled: {mat.name}")

bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    export_apply=True,  # bake modifiers into the exported mesh
    export_yup=True,  # three.js is Y-up
    export_draco_mesh_compression_enable=False,
)

print(f"[blender-export-glb] wrote {out}")
