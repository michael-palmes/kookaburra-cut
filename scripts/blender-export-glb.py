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
import numpy as np
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


def mix_shader_parts(mat):
    """The (output, mix, BSDF at factor 0, BSDF at factor 1, mask) of an image-mixed two-Principled material, else None."""
    nodes = mat.node_tree.nodes
    output = next((n for n in nodes if n.type == "OUTPUT_MATERIAL"), None)
    surface = output.inputs["Surface"] if output else None
    if not surface or not surface.is_linked:
        return None
    mix = surface.links[0].from_node
    if mix.type != "MIX_SHADER":
        return None
    shaders = [inp.links[0].from_node for inp in mix.inputs[1:] if inp.is_linked]
    factor = mix.inputs[0]
    if len(shaders) != 2 or not all(n.type == "BSDF_PRINCIPLED" for n in shaders):
        return None
    if not factor.is_linked or factor.links[0].from_node.type != "TEX_IMAGE":
        return None
    image = factor.links[0].from_node.image
    return (output, mix, shaders[0], shaders[1], image) if image else None


# A Mix Shader is not expressible in glTF, so a material that mixes two Principled BSDFs
# through an image (the MacBook's PLASTIC Keyboard, whose mask carries the key legends)
# would export with no texture at all and then dedup into a neighbouring plain material.
# Composite the mask into a single base-colour texture so one Principled carries it.
for mat in bpy.data.materials:
    if not mat.use_nodes:
        continue
    parts = mix_shader_parts(mat)
    if not parts:
        continue
    output, mix, at_zero, at_one, mask = parts
    for socket in ("Metallic", "Roughness", "IOR"):
        if abs(at_zero.inputs[socket].default_value - at_one.inputs[socket].default_value) > 1e-6:
            print(f"[blender-export-glb] WARNING: {mat.name} mixes differing {socket}, baking base colour only")

    width, height = mask.size
    src = np.empty(width * height * 4, dtype=np.float32)
    mask.pixels.foreach_get(src)
    src = src.reshape(-1, 4)
    # Blender resolves a colour feeding a float socket to the channel average; the mask is
    # greyscale so this is exact. Pixels are already scene-linear, matching the BSDF factors.
    fac = src[:, :3].mean(axis=1, keepdims=True)
    lo = np.array(at_zero.inputs["Base Color"].default_value[:3], dtype=np.float32)
    hi = np.array(at_one.inputs["Base Color"].default_value[:3], dtype=np.float32)

    baked = np.empty((width * height, 4), dtype=np.float32)
    baked[:, :3] = lo * (1.0 - fac) + hi * fac
    baked[:, 3] = 1.0

    image = bpy.data.images.new(f"{mat.name} Baked Base Color", width=width, height=height)
    image.colorspace_settings.name = "sRGB"
    image.pixels.foreach_set(baked.reshape(-1))
    image.pack()

    # Keep the factor-0 BSDF: it carries the vendor's normal/bevel wiring.
    links = mat.node_tree.links
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    links.new(tex.outputs["Color"], at_zero.inputs["Base Color"])
    for link in list(output.inputs["Surface"].links):
        links.remove(link)
    links.new(at_zero.outputs["BSDF"], output.inputs["Surface"])
    mat.node_tree.nodes.remove(mix)
    print(f"[blender-export-glb] baked mix-shader mask into a base-colour texture: {mat.name}")


def world_bounds(obj):
    """(min, max) world-space corners of an object's bounding box."""
    from mathutils import Vector

    lo = Vector((1e30, 1e30, 1e30))
    hi = Vector((-1e30, -1e30, -1e30))
    for corner in obj.bound_box:
        w = obj.matrix_world @ Vector(corner)
        lo = Vector(map(min, lo, w))
        hi = Vector(map(max, hi, w))
    return lo, hi


def add_quad(name, x0, x1, y0, y1, z, mat):
    """A flat +Z quad at height z; winding gives an upward normal."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], [], [(0, 1, 2, 3)])
    mesh.update()
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)


# The MacBook's speaker grilles are perforations through the top case, so at a glance you see
# the internal shell and port shapes behind them (a busy, inconsistent dotted mess). Real
# grilles read as a flat dark field: drop an opaque dark quad just under each perforated
# strip so every hole shows the same dark grey. Derived from the model's own bounds (casing
# edge to keyboard-tray edge, keyboard depth) so it self-skips any device without the casing.
casing = bpy.data.objects.get("Main_Casing.001")
tray = bpy.data.objects.get("Keys_Inlay.001") or bpy.data.objects.get("Keys.001")
if casing and tray:
    (cx0, cy0, _cz0), (cx1, _cy1, cz1) = world_bounds(casing)
    (tx0, ty0, _tz0), (tx1, ty1, _tz1) = world_bounds(tray)
    backing = bpy.data.materials.new("SPEAKER Grille Backing")
    backing.use_nodes = True
    bsdf = backing.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.03, 0.03, 0.03, 1.0)
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.7
    edge = 0.0005  # the deck is flat to within 0.1 mm of the casing edge, so back the holes almost to it
    overlap = 0.003  # tuck under the keyboard tray so there is no seam between them
    z = cz1 - 0.0004  # a hair below the perforated skin: seen through the holes, not z-fighting
    y0, y1 = ty0 - 0.02, ty1 + 0.006
    add_quad("Speaker_Grille_Backing_L", cx0 + edge, tx0 + overlap, y0, y1, z, backing)
    add_quad("Speaker_Grille_Backing_R", tx1 - overlap, cx1 - edge, y0, y1, z, backing)
    print("[blender-export-glb] added dark backing quads under the speaker grilles")

bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    export_apply=True,  # bake modifiers into the exported mesh
    export_yup=True,  # three.js is Y-up
    export_draco_mesh_compression_enable=False,
)

print(f"[blender-export-glb] wrote {out}")
