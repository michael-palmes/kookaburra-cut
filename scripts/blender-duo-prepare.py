"""
Headless GLB export for the iPhone Duo (the foldable), run by scripts/prepare-device-model.sh:

    blender -b iphone-duo.blend --python scripts/blender-duo-prepare.py -- <out>.glb [debug-dir]

The generic exporter bakes modifiers, which would flatten this rig, so the Duo has its own
step. It keeps the one live armature, rebuilds the fold as a fan of fractional bend bones
(so the inside screen curves instead of creasing), re-keys the vendor action to ONE FRAME
PER DEGREE of hinge angle (frame 0 closed, frame 180 open flat) with the camera half held
static, splits the single body material into tintable parts, and exports skins plus that
one clip. The app samples the clip at foldDeg / 30 s. See src/assets/models/README.md.
"""

import math
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Quaternion, Vector

argv = sys.argv
argv = argv[argv.index("--") + 1 :] if "--" in argv else []
out = argv[0] if argv else "/tmp/iphone-duo-raw.glb"
debug_dir = argv[1] if len(argv) > 1 else ""

TAG = "[blender-duo-prepare]"
ARMATURE = "Armature"
KEEP = {ARMATURE, "left", "right", "middle ", "screen_lg", "screen_xm", "left_glass", "right_glass"}
ANCHOR_BONE = "Bone_R"  # carries `left`, the camera half: held static so it always faces the viewer
SWING_BONE = "Bone_L"  # carries `right` and the outside screen
ROOT_BONE = "Bone"
BEND_BONES = 4  # helpers per side; adjacent fan bones differ by at most 90 / 5 = 18 degrees
# Half-width of the bend, in metres. The rigid halves have a tray 0.55 mm under the screen
# beyond ~5 mm from the hinge and a 4 mm deep cavity inside it, so the curve must stay inside.
BEND_HALF_WIDTH = 0.00462
CLIP = "Fold"
OPEN_DEG = 180
FPS = 30


def fail(message):
    raise SystemExit(f"{TAG} ERROR: {message}")


# --- 1. Keep the live armature only -------------------------------------------------------
for obj in list(bpy.data.objects):
    if obj.name not in KEEP:
        bpy.data.objects.remove(obj, do_unlink=True)
missing = KEEP - {o.name for o in bpy.data.objects}
if missing:
    fail(f"source objects missing: {sorted(missing)}")

arm = bpy.data.objects[ARMATURE]
frame = bpy.data.objects["middle "]
frame.name = "fold_frame"
frame.data.name = "fold_frame"
main_screen = bpy.data.objects["screen_lg"]
cover_screen = bpy.data.objects["screen_xm"]
main_screen.name, cover_screen.name = "screen_main", "screen_cover"

# Vendor leftovers: a COLOR_0 attribute makes every glTF loader fork a vertex-colour variant
# of the material, which multiplies the body by those colours and dodges name-keyed tints.
for obj in bpy.data.objects:
    if obj.type == "MESH":
        for attribute in list(obj.data.color_attributes):
            obj.data.color_attributes.remove(attribute)


# --- 2. Sample the vendor action before it is replaced ------------------------------------
def vendor_curves():
    action = arm.animation_data.action
    curves = {}
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for fc in bag.fcurves:
                    curves[(fc.data_path, fc.array_index)] = fc
    return curves


curves = vendor_curves()


def channel(bone, prop, index, at):
    fc = curves.get((f'pose.bones["{bone}"].{prop}', index))
    return fc.evaluate(at) if fc else 0.0


def fold_axis():
    """The one euler component the vendor animates, found rather than assumed."""
    spans = [
        max(abs(channel(ANCHOR_BONE, "rotation_euler", i, f)) for f in range(1, 76)) for i in range(3)
    ]
    axis = int(np.argmax(spans))
    if sorted(spans)[1] > 1e-4:
        fail(f"vendor fold rotates about more than one euler axis: {spans}")
    return axis


AXIS = fold_axis()
FOLDED_FRAME = 75.0
full_turn = channel(ANCHOR_BONE, "rotation_euler", AXIS, FOLDED_FRAME)
if abs(abs(full_turn) - math.pi / 2) > 1e-3:
    fail(f"expected a 90 degree per-side fold, vendor reaches {math.degrees(full_turn):.2f}")


def vendor_frame_for(closedness):
    """The vendor frame whose per-side rotation is `closedness` of the full fold (monotonic, so bisect)."""
    target = abs(full_turn) * closedness
    lo, hi = 1.0, FOLDED_FRAME
    for _ in range(60):
        mid = (lo + hi) / 2
        if abs(channel(ANCHOR_BONE, "rotation_euler", AXIS, mid)) < target:
            lo = mid
        else:
            hi = mid
    return hi


def vendor_pose(bone, at):
    loc = Vector([channel(bone, "location", i, at) for i in range(3)])
    rot = Euler([channel(bone, "rotation_euler", i, at) for i in range(3)], "XYZ")
    return loc, rot


# Sampled up front: the vendor action is deleted before the re-key, and its curves die with it.
VENDOR = []
for deg in range(OPEN_DEG + 1):
    at = vendor_frame_for((OPEN_DEG - deg) / OPEN_DEG)
    VENDOR.append({bone: vendor_pose(bone, at) for bone in (ANCHOR_BONE, SWING_BONE)})
if VENDOR[0][SWING_BONE][0].length < 1e-4 or VENDOR[OPEN_DEG][SWING_BONE][0].length > 1e-6:
    fail("vendor samples look wrong: expected the hinge slide when closed and none when open")


# --- 3. Fan of bend bones, all under the root ---------------------------------------------
bpy.context.view_layer.objects.active = arm
arm.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
edit = arm.data.edit_bones
for side_bone, tag in ((ANCHOR_BONE, "A"), (SWING_BONE, "S")):
    src = edit[side_bone]
    src.parent = edit[ROOT_BONE]
    src.use_connect = False
    for k in range(1, BEND_BONES + 1):
        bend = edit.new(f"Bend_{tag}{k}")
        bend.head, bend.tail, bend.roll = src.head.copy(), src.tail.copy(), src.roll
        bend.parent = edit[ROOT_BONE]
        bend.use_connect = False
        bend.use_deform = True
bpy.ops.object.mode_set(mode="OBJECT")


def fan(tag, side_bone):
    """(fraction of the side's motion, bone name) from the root (0) out to the rigid half (1)."""
    steps = [(0.0, ROOT_BONE)]
    steps += [(k / (BEND_BONES + 1), f"Bend_{tag}{k}") for k in range(1, BEND_BONES + 1)]
    return steps + [(1.0, side_bone)]


# The anchored half sits at +x in the rest pose; the swinging half at -x.
anchor_sign = 1.0 if arm.data.bones[ANCHOR_BONE].tail_local.x > 0 else -1.0
FANS = {anchor_sign: fan("A", ANCHOR_BONE), -anchor_sign: fan("S", SWING_BONE)}


# --- 4. Re-weight the skinned meshes across the fan ---------------------------------------
def smoothstep(a):
    a = min(1.0, max(0.0, a))
    return a * a * (3.0 - 2.0 * a)


def spine_vertices(obj):
    """Vertices of mesh islands weighted wholly to the root: the rigid hinge spine."""
    root_index = obj.vertex_groups[ROOT_BONE].index
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    deform = bm.verts.layers.deform.active
    seen, spine = set(), set()
    for start in bm.verts:
        if start.index in seen:
            continue
        stack, island = [start], []
        while stack:
            v = stack.pop()
            if v.index in seen:
                continue
            seen.add(v.index)
            island.append(v)
            stack.extend(e.other_vert(v) for e in v.link_edges)
        if all(v[deform].get(root_index, 0.0) > 0.999 for v in island):
            spine.update(v.index for v in island)
    bm.free()
    return spine


def add_bend_loops(obj, positions, skip):
    """Loop cuts at each x so every bending surface shares the screen's tessellation."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for x in positions:
        bm.verts.ensure_lookup_table()
        geom = [f for f in bm.faces if not any(v.index in skip for v in f.verts)]
        geom += list({e for f in geom for e in f.edges}) + list({v for f in geom for v in f.verts})
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=(x, 0, 0), plane_no=(1, 0, 0))
    bm.to_mesh(obj.data)
    bm.free()


def reweight(obj, skip):
    for steps in FANS.values():
        for _, bone in steps:
            if bone not in obj.vertex_groups:
                obj.vertex_groups.new(name=bone)
    groups = obj.vertex_groups
    for v in obj.data.vertices:
        if v.index in skip:
            continue
        for g in groups:
            g.remove([v.index])
        x = v.co.x
        if abs(x) < 1e-7:
            groups[ROOT_BONE].add([v.index], 1.0, "REPLACE")
            continue
        steps = FANS[1.0 if x > 0 else -1.0]
        f = smoothstep(abs(x) / BEND_HALF_WIDTH)
        for (f0, b0), (f1, b1) in zip(steps, steps[1:]):
            if f <= f1:
                t = (f - f0) / (f1 - f0)
                if t < 1.0:
                    groups[b0].add([v.index], 1.0 - t, "REPLACE")
                if t > 0.0:
                    groups[b1].add([v.index], t, "REPLACE")
                break


bend_loops = sorted({round(v.co.x, 6) for v in main_screen.data.vertices if abs(v.co.x) <= BEND_HALF_WIDTH + 1e-6})
if len(bend_loops) < 9:
    fail(f"inside screen has too few loop cuts across the bend: {len(bend_loops)}")
frame_spine = spine_vertices(frame)
if not frame_spine:
    fail("no root-weighted spine island found in the fold frame")
# Bisecting renumbers vertices, so cut first and find the spine again afterwards.
add_bend_loops(frame, bend_loops, frame_spine)
reweight(frame, spine_vertices(frame))
reweight(main_screen, set())
print(f"{TAG} re-weighted the fold across {2 * BEND_BONES + 3} bones, bend half-width {BEND_HALF_WIDTH * 1000:.2f} mm")


# --- 5. Re-key: one frame per degree, camera half static ----------------------------------
for action in list(bpy.data.actions):
    bpy.data.actions.remove(action)
arm.animation_data_clear()
arm.animation_data_create()
arm.animation_data.action = bpy.data.actions.new(CLIP)

scene = bpy.context.scene
scene.render.fps = FPS
scene.frame_start, scene.frame_end = 0, OPEN_DEG

pose = arm.pose.bones
for pb in pose:
    pb.rotation_mode = "QUATERNION" if pb.name == ROOT_BONE else "XYZ"
rest_anchor = arm.data.bones[ANCHOR_BONE].matrix_local.copy()
rest_root = arm.data.bones[ROOT_BONE].matrix_local.copy()

previous = Quaternion()
for deg in range(OPEN_DEG + 1):
    for steps, side_bone in ((FANS[anchor_sign], ANCHOR_BONE), (FANS[-anchor_sign], SWING_BONE)):
        loc, rot = VENDOR[deg][side_bone]
        for fraction, bone in steps[1:]:
            pose[bone].location = loc * fraction
            pose[bone].rotation_euler = Euler([a * fraction for a in rot], "XYZ")
            pose[bone].keyframe_insert("location", frame=deg)
            pose[bone].keyframe_insert("rotation_euler", frame=deg)
    # Counter-move the root by the anchored half's motion so that half never leaves its rest pose.
    loc, rot = VENDOR[deg][ANCHOR_BONE]
    basis = Matrix.Translation(loc) @ rot.to_matrix().to_4x4()
    delta = rest_anchor @ basis.inverted() @ rest_anchor.inverted()
    root_basis = rest_root.inverted() @ delta @ rest_root
    quat = root_basis.to_quaternion()
    if quat.dot(previous) < 0:
        quat.negate()
    previous = quat
    pose[ROOT_BONE].location = root_basis.to_translation()
    pose[ROOT_BONE].rotation_quaternion = quat
    pose[ROOT_BONE].keyframe_insert("location", frame=deg)
    pose[ROOT_BONE].keyframe_insert("rotation_quaternion", frame=deg)

for layer in arm.animation_data.action.layers:
    for strip in layer.strips:
        for bag in strip.channelbags:
            for fc in bag.fcurves:
                for key in fc.keyframe_points:
                    key.interpolation = "LINEAR"


def evaluated_bounds(obj):
    deps = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(deps)
    mesh = ev.to_mesh()
    pts = np.array([ev.matrix_world @ v.co for v in mesh.vertices])
    ev.to_mesh_clear()
    return pts.min(axis=0), pts.max(axis=0)


# Hard checks: the camera half is static at every degree, the open frame is the rest pose,
# and closed puts the outside screen in front of the camera half, facing the viewer (-Y).
for deg in range(OPEN_DEG + 1):
    scene.frame_set(deg)
    drift = max(abs(a - b) for ra, rb in zip(pose[ANCHOR_BONE].matrix, rest_anchor) for a, b in zip(ra, rb))
    if drift > 1e-5:
        fail(f"camera half moves at {deg} degrees (drift {drift:.2e})")
scene.frame_set(OPEN_DEG)
for pb in pose:
    rest = arm.data.bones[pb.name].matrix_local
    if max(abs(a - b) for ra, rb in zip(pb.matrix, rest) for a, b in zip(ra, rb)) > 1e-5:
        fail(f"{pb.name} is not at rest on the open frame")
scene.frame_set(0)
cover_lo, cover_hi = evaluated_bounds(cover_screen)
body_lo, _ = evaluated_bounds(bpy.data.objects["left"])
if cover_hi[1] > body_lo[1] or (cover_hi[0] - cover_lo[0]) < 0.07:
    fail(f"closed pose is wrong: outside screen y {cover_lo[1]:.4f}..{cover_hi[1]:.4f}, camera half front {body_lo[1]:.4f}")
print(f"{TAG} re-keyed '{CLIP}': frames 0..{OPEN_DEG} = hinge degrees, camera half static")


# --- 6. Tintable body parts ---------------------------------------------------------------
def atlas(image, size=1024):
    copy = image.copy()
    copy.scale(size, size)
    px = np.empty(size * size * 4, dtype=np.float32)
    copy.pixels.foreach_get(px)
    bpy.data.images.remove(copy)
    return px.reshape(size, size, 4)


def image_of(material, socket):
    bsdf = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    node = bsdf.inputs[socket].links[0].from_node
    while node.type != "TEX_IMAGE":
        node = next(i.links[0].from_node for i in node.inputs if i.is_linked)
    return node.image


duo = bpy.data.materials["duo"]
base_px = atlas(image_of(duo, "Base Color"))
metal_px = atlas(image_of(duo, "Metallic"))
PARTS = {"body": duo.copy(), "frame": duo.copy()}
PARTS["body"].name, PARTS["frame"].name = "duo_body", "duo_frame"
duo.name = "duo_detail"
for part, material in {**PARTS, "detail": duo}.items():
    # Distinct extras stop gltf-transform's dedup fusing these property-identical materials.
    material["kookaburraPart"] = part


def classify(u, v):
    size = base_px.shape[0]
    x = min(size - 1, max(0, int(u % 1.0 * size)))
    y = min(size - 1, max(0, int(v % 1.0 * size)))
    r, g, b = base_px[y, x, :3]
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    sat = max(r, g, b) - min(r, g, b)
    if sat > 0.18 or lum < 0.45:
        return "detail"
    return "frame" if metal_px[y, x, 0] > 0.5 else "body"


counts = {"body": 0, "frame": 0, "detail": 0}
for obj in (bpy.data.objects["left"], bpy.data.objects["right"], frame):
    mesh = obj.data
    slot = {"detail": next(i for i, m in enumerate(mesh.materials) if m == duo)}
    for part, material in PARTS.items():
        mesh.materials.append(material)
        slot[part] = len(mesh.materials) - 1
    uvs = mesh.uv_layers.active.data
    for poly in mesh.polygons:
        if poly.material_index != slot["detail"]:
            continue
        corners = [Vector(uvs[i].uv) for i in poly.loop_indices]
        centre = sum(corners, Vector((0, 0))) / len(corners)
        votes = [classify(*centre)] + [classify(*(centre.lerp(c, 0.6))) for c in corners]
        part = max(set(votes), key=votes.count)
        poly.material_index = slot[part]
        counts[part] += 1
print(f"{TAG} body material split by face: {counts}")
if min(counts.values()) == 0:
    fail("the tint split produced an empty part")


# --- 7. Screens: plain black placeholders the app replaces, kept distinct for dedup -------
for obj, name, rough in ((main_screen, "SCREEN_MAIN", 0.5), (cover_screen, "SCREEN_COVER", 0.6)):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    bsdf = material.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0, 0, 0, 1)
    bsdf.inputs["Roughness"].default_value = rough
    material["kookaburraScreen"] = name
    obj.data.materials.clear()
    obj.data.materials.append(material)

if debug_dir:
    debug = {"duo_body": (0.1, 0.3, 0.9, 1), "duo_frame": (0.9, 0.5, 0.1, 1), "duo_detail": (0.1, 0.8, 0.2, 1)}
    for name, colour in debug.items():
        bpy.data.materials[name].diffuse_color = colour
    bpy.ops.wm.save_as_mainfile(filepath=f"{debug_dir}/duo-prepared.blend", copy=True)

# Blender 5 names an active-action clip "Animation"; an NLA track exports under its own name.
fold_action = arm.animation_data.action
fold_slot = arm.animation_data.action_slot
arm.animation_data.action = None
strip = arm.animation_data.nla_tracks.new()
strip.name = CLIP
strip = strip.strips.new(CLIP, 0, fold_action)
strip.action_slot = fold_slot

scene.frame_set(OPEN_DEG)
bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    export_apply=False,  # applying modifiers would bake the armature out
    export_yup=True,
    export_skins=True,
    export_animations=True,
    export_animation_mode="NLA_TRACKS",
    export_force_sampling=True,
    export_optimize_animation_size=False,
    export_optimize_animation_keep_anim_armature=True,
    export_rest_position_armature=True,
    export_extras=True,
    export_draco_mesh_compression_enable=False,
)
print(f"{TAG} wrote {out}")
