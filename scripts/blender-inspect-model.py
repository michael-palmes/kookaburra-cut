"""
Headless model inspection for Kookaburra Cut's device asset pipeline.

    blender -b <file>.blend --python scripts/blender-inspect-model.py

Dumps to stdout, one section per concern, so colour variants of the same model can be
diffed: unit scale, objects (name, type, world dimensions, rotation, vert count), the
active camera, materials (base colour as linear + sRGB hex, texture inputs), and screen
candidates (near-planar meshes with their UV bounds and dominant world normal). Read-only.
"""

import math

import bpy


def srgb_hex(linear_rgba):
    def enc(c):
        c = max(0.0, min(1.0, c))
        return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055

    r, g, b = (round(enc(c) * 255) for c in linear_rgba[:3])
    return f"#{r:02x}{g:02x}{b:02x}"


def main():
    scene = bpy.context.scene
    unit = scene.unit_settings
    print(f"[units] system={unit.system} scale_length={unit.scale_length}")

    cam = scene.camera
    if cam:
        loc = cam.matrix_world.translation
        rot = cam.matrix_world.to_euler()
        print(
            f"[camera] {cam.name} loc=({loc.x:.3f},{loc.y:.3f},{loc.z:.3f}) "
            f"rot_deg=({math.degrees(rot.x):.1f},{math.degrees(rot.y):.1f},{math.degrees(rot.z):.1f})"
        )

    deps = bpy.context.evaluated_depsgraph_get()
    for obj in sorted(scene.objects, key=lambda o: o.name):
        d = obj.dimensions
        rot = obj.rotation_euler
        verts = len(obj.evaluated_get(deps).to_mesh().vertices) if obj.type == "MESH" else 0
        mats = [s.material.name for s in obj.material_slots if s.material] if obj.type == "MESH" else []
        print(
            f"[object] {obj.name!r} type={obj.type} parent={obj.parent.name if obj.parent else None} "
            f"dims=({d.x:.4f},{d.y:.4f},{d.z:.4f}) "
            f"rot_deg=({math.degrees(rot.x):.1f},{math.degrees(rot.y):.1f},{math.degrees(rot.z):.1f}) "
            f"verts={verts} hidden={obj.hide_render or obj.hide_viewport} mats={mats}"
        )

    for mat in sorted(bpy.data.materials, key=lambda m: m.name):
        if not mat.use_nodes:
            print(f"[material] {mat.name!r} nodes=False")
            continue
        bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if not bsdf:
            print(f"[material] {mat.name!r} no-principled")
            continue
        base = bsdf.inputs["Base Color"]
        linked = [
            input_name
            for input_name in ("Base Color", "Normal", "Roughness", "Metallic")
            if bsdf.inputs[input_name].is_linked
        ]
        col = tuple(base.default_value)
        print(
            f"[material] {mat.name!r} base_linear=({col[0]:.4f},{col[1]:.4f},{col[2]:.4f}) "
            f"srgb={srgb_hex(col)} metallic={bsdf.inputs['Metallic'].default_value:.2f} "
            f"rough={bsdf.inputs['Roughness'].default_value:.2f} textured_inputs={linked}"
        )

    # Screen candidates: near-planar meshes (thinnest world axis under 2% of the longest).
    for obj in scene.objects:
        if obj.type != "MESH":
            continue
        d = sorted((obj.dimensions.x, obj.dimensions.y, obj.dimensions.z))
        if d[2] <= 0 or d[0] / d[2] > 0.02:
            continue
        mesh = obj.evaluated_get(deps).to_mesh()
        if not mesh.polygons:
            continue
        normal = obj.matrix_world.to_3x3() @ mesh.polygons[0].normal
        uv = mesh.uv_layers.active
        if uv:
            us = [x.uv[0] for x in uv.data]
            vs = [x.uv[1] for x in uv.data]
            uv_txt = f"uv=[{min(us):.3f}..{max(us):.3f}, {min(vs):.3f}..{max(vs):.3f}]"
        else:
            uv_txt = "uv=None"
        plane = [x for x in (obj.dimensions.x, obj.dimensions.y, obj.dimensions.z) if x != d[0]]
        aspect = min(plane) / max(plane) if len(plane) == 2 and max(plane) > 0 else 0
        print(
            f"[screen?] {obj.name!r} mats={[s.material.name for s in obj.material_slots if s.material]} "
            f"plane_dims=({plane[0]:.4f}x{plane[1]:.4f})" if len(plane) == 2 else f"[screen?] {obj.name!r}",
        )
        print(
            f"[screen?] {obj.name!r} aspect={aspect:.4f} "
            f"normal_world=({normal.x:.2f},{normal.y:.2f},{normal.z:.2f}) {uv_txt}"
        )


main()
