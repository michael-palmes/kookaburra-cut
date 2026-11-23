"""The app's camera maths for kb's static camera check: the orbit track (src/engine/sceneCamera.ts), the free-flight rig
(sceneRig.ts, keyframes.ts), kicks (cameraKicks.ts, envelope.ts), carried depth of field (dof.ts) and device track
rotations (sceneDeviceTrack.ts). tests/fixtures/camera-vectors.json (pnpm agent:vectors) holds both sides to the same
poses. Object aims resolve as the app does before it knows the floor and the frame: an ungrounded device by its
placement, anything else by its baked point."""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .. import music as musicmod
from ..scene_ops import ease
from ..util import is_number

V3 = Tuple[float, float, float]

CAMERA_POSITION: V3 = (0.0, 0.0, 5.0)
CAMERA_FOV = 45.0
RIG_FOV_MIN, RIG_FOV_MAX = 15.0, 90.0
KICK_FOV_MIN, KICK_FOV_MAX = 15.0, 90.0
KICK_ZOOM_MIN, KICK_ZOOM_MAX = 0.25, 4.0
DEGENERATE = 1e-9
DEGENERATE_FORWARD: V3 = (0.0, 0.0, -1.0)
CATMULL_ROM_ALPHA = 0.5
DEFAULT_ENVELOPE_EASE = "outQuad"
DOF_MODES = ("depth", "tilt", "soft", "radial", "directional", "split", "lens")
# The dof fields the check reads, their clamps (dof.ts normalizeDocDof) and defaults (DOF_DEFAULTS).
DOF_CLAMPS = {"blur": (0.0, 1.0), "range": (0.0, 10.0), "focus": (0.05, 50.0), "focusB": (0.05, 50.0),
              "fStop": (0.7, 64.0), "focalMm": (4.0, 1200.0), "sensorMm": (2.0, 70.0)}
DOF_DEFAULTS: Dict[str, Any] = {"blur": 0.0, "range": 1.0, "focus": None, "focusB": 2.0, "fStop": 4.0, "focalMm": None, "sensorMm": 24.0}
LENS_MM_PER_UNIT = 146.6 / 2.6
WORLD_UP: V3 = (0.0, 1.0, 0.0)
FALLBACK_UP: V3 = (0.0, 0.0, -1.0)
_EASE_RE = re.compile(r"(?:inOut|in|out)(?:Sine|Quad|Cubic|Quart|Quint|Expo|Circ|Back)")


def is_ease_name(name: Any) -> bool:
    return isinstance(name, str) and (name in ("linear", "jump") or _EASE_RE.fullmatch(name) is not None)


def finite(v: Any) -> bool:
    return is_number(v) and math.isfinite(v)


def finite3(v: Any) -> bool:
    return isinstance(v, (list, tuple)) and len(v) == 3 and all(finite(n) for n in v)


def v3(v: Sequence[float]) -> V3:
    return (float(v[0]), float(v[1]), float(v[2]))


def sub(a: Sequence[float], b: Sequence[float]) -> V3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def add(a: Sequence[float], b: Sequence[float]) -> V3:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def scale(a: Sequence[float], k: float) -> V3:
    return (a[0] * k, a[1] * k, a[2] * k)


def dot(a: Sequence[float], b: Sequence[float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a: Sequence[float], b: Sequence[float]) -> V3:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def length(a: Sequence[float]) -> float:
    return math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])


def normalize(v: Sequence[float]) -> Optional[V3]:
    n = length(v)
    return None if n < DEGENERATE else (v[0] / n, v[1] / n, v[2] / n)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def lerp3(a: Sequence[float], b: Sequence[float], t: float) -> V3:
    return (lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t))


def log_mix(a: float, b: float, t: float) -> float:
    """mixAimDistance and mixFocusDistance: logarithmic, linear when an end is not positive."""
    if a <= 0 or b <= 0:
        return lerp(a, b, t)
    return a * (b / a) ** t


def _least_aligned_axis(v: V3) -> V3:
    ax, ay, az = abs(v[0]), abs(v[1]), abs(v[2])
    if ax <= ay and ax <= az:
        return (1.0, 0.0, 0.0)
    return (0.0, 1.0, 0.0) if ay <= az else (0.0, 0.0, 1.0)


def slerp_unit(a: V3, b: V3, t: float) -> V3:
    d = min(1.0, max(-1.0, dot(a, b)))
    if d > 0.9995:
        return normalize(lerp3(a, b, t)) or a
    if d < -0.9999:
        axis = normalize(cross(a, _least_aligned_axis(a)))
        if axis is None:
            return a
        angle = t * math.pi
        return add(scale(a, math.cos(angle)), scale(cross(axis, a), math.sin(angle)))
    theta = math.acos(d)
    s = math.sin(theta)
    return add(scale(a, math.sin((1 - t) * theta) / s), scale(b, math.sin(t * theta) / s))


def _knot(a: V3, b: V3) -> float:
    dx, dy, dz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    return (dx * dx + dy * dy + dz * dz) ** (CATMULL_ROM_ALPHA / 2)


def catmull_rom(p0: V3, p1: V3, p2: V3, p3: V3, u: float) -> Tuple[V3, V3]:
    """(point, tangent) on the centripetal curve through p1 (u 0) and p2 (u 1), Barry-Goldman as keyframes.ts."""
    d01, d12, d23 = _knot(p0, p1), _knot(p1, p2), _knot(p2, p3)
    if d12 == 0:
        return p1, (0.0, 0.0, 0.0)
    t0, t1 = 0.0, d01
    t2 = t1 + d12
    t3 = t2 + d23
    t = t1 + u * d12
    s02, s13 = t2 - t0, t3 - t1
    point, tangent = [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
    for i in range(3):
        a1 = p1[i] if d01 == 0 else ((t1 - t) * p0[i] + (t - t0) * p1[i]) / d01
        a1d = 0.0 if d01 == 0 else (p1[i] - p0[i]) / d01
        a2 = ((t2 - t) * p1[i] + (t - t1) * p2[i]) / d12
        a2d = (p2[i] - p1[i]) / d12
        a3 = p2[i] if d23 == 0 else ((t3 - t) * p2[i] + (t - t2) * p3[i]) / d23
        a3d = 0.0 if d23 == 0 else (p3[i] - p2[i]) / d23
        b1 = ((t2 - t) * a1 + (t - t0) * a2) / s02
        b1d = (a2 - a1 + (t2 - t) * a1d + (t - t0) * a2d) / s02
        b2 = ((t3 - t) * a2 + (t - t1) * a3) / s13
        b2d = (a3 - a2 + (t3 - t) * a2d + (t - t1) * a3d) / s13
        point[i] = ((t2 - t) * b1 + (t - t1) * b2) / d12
        tangent[i] = b2 - b1 + (t2 - t) * b1d + (t - t1) * b2d
    return v3(point), v3(tangent)


# ── depth of field ───────────────────────────────────────────────────────────


def normalize_dof(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    out: Dict[str, Any] = {}
    if raw.get("mode") in DOF_MODES:
        out["mode"] = raw["mode"]
    for name, (lo, hi) in DOF_CLAMPS.items():
        value = raw.get(name)
        if name == "focus" and value == "auto":
            out["focus"] = "auto"
        elif finite(value):
            out[name] = min(hi, max(lo, float(value)))
    return out or None


def carry_dof(previous: Optional[Dict[str, Any]], authored: Optional[Dict[str, Any]], mode: Optional[str]) -> Optional[Dict[str, Any]]:
    if not authored:
        return previous
    base = previous or dict(DOF_DEFAULTS, blur=1.0 if mode == "lens" else 0.0)
    out = {k: authored.get(k, base[k]) for k in DOF_DEFAULTS}
    out["focus"] = None if authored.get("focus") == "auto" else authored.get("focus", base["focus"])
    return out


def _dof_end(e: Optional[Dict[str, Any]], auto: float) -> Dict[str, Any]:
    eff = e or DOF_DEFAULTS
    return dict(eff, focus=auto if eff["focus"] is None else eff["focus"])


def mix_dof(a: Optional[Dict[str, Any]], b: Optional[Dict[str, Any]], t: float, auto: float) -> Optional[Dict[str, Any]]:
    if not a and not b:
        return None
    ra, rb = _dof_end(a, auto), _dof_end(b, auto)
    fa, fb = ra["focalMm"], rb["focalMm"]
    return {"blur": lerp(ra["blur"], rb["blur"], t), "range": lerp(ra["range"], rb["range"], t),
            "focus": log_mix(ra["focus"], rb["focus"], t), "focusB": log_mix(ra["focusB"], rb["focusB"], t),
            "fStop": log_mix(ra["fStop"], rb["fStop"], t), "sensorMm": log_mix(ra["sensorMm"], rb["sensorMm"], t),
            "focalMm": log_mix(fa, fb, t) if fa is not None and fb is not None else (fa if fa is not None else fb),
            "manual": any(e is not None and e["focus"] is not None for e in (a, b))}


def hold_dof(e: Optional[Dict[str, Any]], auto: float) -> Optional[Dict[str, Any]]:
    return dict(_dof_end(e, auto), manual=e["focus"] is not None) if e else None


def _track_dof(keys: List[Dict[str, Any]]) -> Tuple[Optional[str], bool, Dict[str, Optional[Dict[str, Any]]]]:
    mode: Optional[str] = None
    carried: Optional[Dict[str, Any]] = None
    active = False
    by_key: Dict[str, Optional[Dict[str, Any]]] = {}
    for key in keys:
        authored = key["pose"].get("dof")
        if authored and mode is None:
            mode = authored.get("mode", "depth")
        carried = carry_dof(carried, authored, mode)
        if carried and carried["blur"] > 0:
            active = True
        by_key[key["id"]] = carried
    return mode, active, by_key


# ── the free-flight rig ──────────────────────────────────────────────────────


def _valid_aim(aim: Any) -> bool:
    if not isinstance(aim, dict) or not finite3(aim.get("at")):
        return False
    if aim.get("mode") in ("point", "tangent"):
        return True
    return aim.get("mode") == "object" and isinstance(aim.get("id"), str) and bool(aim["id"])


def _valid_rig_pose(pose: Any) -> bool:
    return (isinstance(pose, dict) and finite3(pose.get("position")) and _valid_aim(pose.get("aim"))
            and (pose.get("fov") is None or finite(pose.get("fov"))) and (pose.get("rollDeg") is None or finite(pose.get("rollDeg"))))


def aim_target(aim_id: str, doc: Optional[Dict[str, Any]]) -> Optional[V3]:
    """resolveAimTarget before the floor and frame are known: an ungrounded device outside a layout by its placement; None keeps the baked point."""
    if not isinstance(doc, dict):
        return None
    device = next((d for d in parsed_devices(doc) if d.get("id") == aim_id), None)
    if device is not None:
        placement = device.get("placement") if isinstance(device.get("placement"), dict) else {}
        if doc.get("deviceLayout") or placement.get("ground") is True:
            return None
        return v3(placement["position"]) if finite3(placement.get("position")) else (0.0, 0.0, 0.0)
    for entry in doc.get("media") if isinstance(doc.get("media"), list) else []:
        if isinstance(entry, dict) and entry.get("id") == aim_id and entry.get("host") == "stage":
            stage = entry.get("stage") if isinstance(entry.get("stage"), dict) else {}
            return v3(stage["position"]) if finite3(stage.get("position")) else (0.0, 0.0, 0.0)
    return None


def keyed_block(raw: Any) -> bool:
    """parseSceneDoc keeps a camera block only with both arrays."""
    return isinstance(raw, dict) and isinstance(raw.get("keys"), list) and isinstance(raw.get("segments"), list)


def normalize_rig(raw: Any, doc: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    if not keyed_block(raw):
        return None
    keys: List[Dict[str, Any]] = []
    seen = set()
    for key in raw.get("keys") or []:
        if not isinstance(key, dict) or not isinstance(key.get("id"), str) or not finite(key.get("tMs")) or not _valid_rig_pose(key.get("pose")):
            continue
        if key["id"] in seen:
            continue
        seen.add(key["id"])
        src = key["pose"]
        aim = dict(src["aim"], at=v3(src["aim"]["at"]))
        if aim["mode"] == "object":
            at = aim_target(aim["id"], doc)
            if at is not None:
                aim["at"] = at
        pose: Dict[str, Any] = {"position": v3(src["position"]), "aim": aim, "rollDeg": float(src.get("rollDeg") or 0)}
        if src.get("fov") is not None:
            pose["fov"] = min(RIG_FOV_MAX, max(RIG_FOV_MIN, float(src["fov"])))
        dof = normalize_dof(src.get("dof"))
        if dof:
            pose["dof"] = dof
        keys.append({"id": key["id"], "tMs": max(0.0, float(key["tMs"])), "pose": pose})
    if not keys:
        return None
    keys.sort(key=lambda k: k["tMs"])
    mode, active, by_key = _track_dof(keys)
    by_id = {k["id"]: k for k in keys}
    index = {k["id"]: i for i, k in enumerate(keys)}
    segments: List[Dict[str, Any]] = []
    for seg in raw.get("segments") or []:
        a = by_id.get(seg.get("from")) if isinstance(seg, dict) else None
        b = by_id.get(seg.get("to")) if isinstance(seg, dict) else None
        if a is None or b is None or a["tMs"] >= b["tMs"]:
            continue
        i, j = index[a["id"]], index[b["id"]]
        pa, pb = a["pose"]["position"], b["pose"]["position"]
        segments.append({
            "from": a, "to": b, "ease": seg.get("ease"), "smooth": seg.get("smooth") is not False,
            "before": keys[i - 1]["pose"]["position"] if i > 0 else sub(scale(pa, 2), pb),
            "after": keys[j + 1]["pose"]["position"] if j + 1 < len(keys) else sub(scale(pb, 2), pa),
            **{c: seg[c] for c in ("easePosition", "easeRotation", "easeLens", "easeDof") if is_ease_name(seg.get(c))},
        })
    segments.sort(key=lambda s: s["from"]["tMs"])
    ordered: List[Dict[str, Any]] = []
    for seg in segments:
        if ordered and seg["from"]["tMs"] < ordered[-1]["to"]["tMs"]:
            continue
        ordered.append(seg)
    return {"keys": keys, "segments": ordered, "dofMode": mode, "dofActive": active, "dofByKey": by_key}


def canonical(pose: Dict[str, Any]) -> Dict[str, Any]:
    delta = sub(pose["aim"]["at"], pose["position"])
    distance = length(delta)
    degenerate = distance < DEGENERATE
    return {"position": pose["position"], "forward": DEGENERATE_FORWARD if degenerate else scale(delta, 1 / distance),
            "aimDistance": 1.0 if degenerate else distance, "rollDeg": pose.get("rollDeg") or 0.0, "fov": pose.get("fov")}


def _applied(c: Dict[str, Any]) -> Dict[str, Any]:
    return {"position": c["position"], "lookAt": add(c["position"], scale(c["forward"], c["aimDistance"])), "fov": c["fov"],
            "rollDeg": c["rollDeg"], "aimDistance": c["aimDistance"], "dof": None}


def _sample_segment(track: Dict[str, Any], seg: Dict[str, Any], p: float) -> Dict[str, Any]:
    a, b = canonical(seg["from"]["pose"]), canonical(seg["to"]["pose"])
    base = seg["ease"]
    e_pos = ease(seg.get("easePosition", base), p)
    e_rot = ease(seg.get("easeRotation", base), p)
    e_lens = ease(seg.get("easeLens", base), p)
    tangent_a = seg["from"]["pose"]["aim"]["mode"] == "tangent"
    tangent_b = seg["to"]["pose"]["aim"]["mode"] == "tangent"
    tangent = None
    if tangent_a or tangent_b:
        frm, to = seg["from"]["pose"]["position"], seg["to"]["pose"]["position"]
        tangent = normalize(catmull_rom(seg["before"], frm, to, seg["after"], e_pos)[1]) if seg["smooth"] else normalize(sub(to, frm))
    fa = (tangent or a["forward"]) if tangent_a else a["forward"]
    fb = (tangent or b["forward"]) if tangent_b else b["forward"]
    fov = None if a["fov"] is None and b["fov"] is None else lerp(CAMERA_FOV if a["fov"] is None else a["fov"], CAMERA_FOV if b["fov"] is None else b["fov"], e_lens)
    mixed = {"position": lerp3(a["position"], b["position"], e_pos), "forward": slerp_unit(fa, fb, e_rot),
             "aimDistance": log_mix(a["aimDistance"], b["aimDistance"], e_rot), "rollDeg": lerp(a["rollDeg"], b["rollDeg"], e_rot), "fov": fov}
    if seg["smooth"]:
        mixed["position"] = catmull_rom(seg["before"], seg["from"]["pose"]["position"], seg["to"]["pose"]["position"], seg["after"], e_pos)[0]
    pose = _applied(mixed)
    if track["dofMode"]:
        pose["dof"] = mix_dof(track["dofByKey"].get(seg["from"]["id"]), track["dofByKey"].get(seg["to"]["id"]), ease(seg.get("easeDof", base), p), mixed["aimDistance"])
        if pose["dof"]:
            pose["dof"]["mode"] = track["dofMode"]
    return pose


def sample_rig(track: Dict[str, Any], local_ms: float) -> Dict[str, Any]:
    for seg in track["segments"]:
        if seg["from"]["tMs"] <= local_ms < seg["to"]["tMs"]:
            return _sample_segment(track, seg, (local_ms - seg["from"]["tMs"]) / (seg["to"]["tMs"] - seg["from"]["tMs"]))
    held = track["keys"][0]
    for key in track["keys"]:
        if key["tMs"] <= local_ms:
            held = key
        else:
            break
    c = canonical(held["pose"])
    pose = _applied(c)
    if track["dofMode"]:
        pose["dof"] = hold_dof(track["dofByKey"].get(held["id"]), c["aimDistance"])
        if pose["dof"]:
            pose["dof"]["mode"] = track["dofMode"]
    return pose


# ── the orbit track ──────────────────────────────────────────────────────────


def _valid_orbit_pose(pose: Any) -> bool:
    return isinstance(pose, dict) and finite3(pose.get("target")) and all(finite(pose.get(k)) for k in ("azimuthDeg", "elevationDeg", "distance"))


def normalize_orbit(raw: Any) -> Optional[Dict[str, Any]]:
    if not keyed_block(raw):
        return None
    keys: List[Dict[str, Any]] = []
    seen = set()
    for key in raw.get("keys") or []:
        if not isinstance(key, dict) or not isinstance(key.get("id"), str) or not finite(key.get("tMs")) or not _valid_orbit_pose(key.get("pose")):
            continue
        if key["id"] in seen:
            continue
        seen.add(key["id"])
        src = key["pose"]
        pose: Dict[str, Any] = {"target": v3(src["target"]), **{k: float(src[k]) for k in ("azimuthDeg", "elevationDeg", "distance")}}
        dof = normalize_dof(src.get("dof"))
        if dof:
            pose["dof"] = dof
        keys.append({"id": key["id"], "tMs": max(0.0, float(key["tMs"])), "pose": pose})
    if not keys:
        return None
    keys.sort(key=lambda k: k["tMs"])
    mode, active, by_key = _track_dof(keys)
    by_id = {k["id"]: k for k in keys}
    segments = []
    for seg in raw.get("segments") or []:
        a = by_id.get(seg.get("from")) if isinstance(seg, dict) else None
        b = by_id.get(seg.get("to")) if isinstance(seg, dict) else None
        if a is None or b is None or a["tMs"] >= b["tMs"]:
            continue
        segments.append({"from": a, "to": b, "ease": seg.get("ease"), **({"easeDof": seg["easeDof"]} if is_ease_name(seg.get("easeDof")) else {})})
    segments.sort(key=lambda s: s["from"]["tMs"])
    ordered: List[Dict[str, Any]] = []
    for seg in segments:
        if ordered and seg["from"]["tMs"] < ordered[-1]["to"]["tMs"]:
            continue
        ordered.append(seg)
    return {"keys": keys, "segments": ordered, "dofMode": mode, "dofActive": active, "dofByKey": by_key}


def orbit_to_view(pose: Dict[str, Any]) -> Tuple[V3, V3]:
    az, el = math.radians(pose["azimuthDeg"]), math.radians(pose["elevationDeg"])
    t, d = pose["target"], pose["distance"]
    cos_el = math.cos(el)
    return (t[0] + d * cos_el * math.sin(az), t[1] + d * math.sin(el), t[2] + d * cos_el * math.cos(az)), t


def sample_orbit(track: Dict[str, Any], local_ms: float) -> Dict[str, Any]:
    pose: Optional[Dict[str, Any]] = None
    dof = None
    for seg in track["segments"]:
        if seg["from"]["tMs"] <= local_ms < seg["to"]["tMs"]:
            p = (local_ms - seg["from"]["tMs"]) / (seg["to"]["tMs"] - seg["from"]["tMs"])
            e = ease(seg["ease"], p)
            a, b = seg["from"]["pose"], seg["to"]["pose"]
            pose = {"target": lerp3(a["target"], b["target"], e), **{k: lerp(a[k], b[k], e) for k in ("azimuthDeg", "elevationDeg", "distance")}}
            if track["dofMode"]:
                dof = mix_dof(track["dofByKey"].get(seg["from"]["id"]), track["dofByKey"].get(seg["to"]["id"]), ease(seg.get("easeDof", seg["ease"]), p), pose["distance"])
            break
    if pose is None:
        held = track["keys"][0]
        for key in track["keys"]:
            if key["tMs"] <= local_ms:
                held = key
            else:
                break
        pose = held["pose"]
        if track["dofMode"]:
            dof = hold_dof(track["dofByKey"].get(held["id"]), pose["distance"])
    if dof:
        dof["mode"] = track["dofMode"]
    position, look = orbit_to_view(pose)
    return {"position": position, "lookAt": look, "fov": None, "rollDeg": 0.0, "aimDistance": length(sub(look, position)), "dof": dof}


# ── kicks ────────────────────────────────────────────────────────────────────


def _non_negative(v: Any) -> float:
    return float(v) if finite(v) and v > 0 else 0.0


def parsed_devices(doc: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The devices parseSceneDoc keeps: a string id and model."""
    raw = doc.get("devices") if isinstance(doc, dict) else None
    return [d for d in raw if isinstance(d, dict) and isinstance(d.get("id"), str) and isinstance(d.get("model"), str)] if isinstance(raw, list) else []


def parse_kick(entry: Any) -> Optional[Dict[str, Any]]:
    """parseCameraKick: a valid `at` and `releaseMs` or nothing; a bad optional field drops alone; no channel left drops the kick."""
    if not isinstance(entry, dict):
        return None
    at = entry.get("at")
    if not ((finite(at) and at >= 0) or musicmod.is_position(at)):
        return None
    if not (finite(entry.get("releaseMs")) and entry["releaseMs"] >= 0):
        return None
    kick = dict(entry)
    if kick.get("zoom") is not None and not (finite(kick["zoom"]) and KICK_ZOOM_MIN <= kick["zoom"] <= KICK_ZOOM_MAX):
        kick.pop("zoom")
    if kick.get("offset") is not None and not finite3(kick["offset"]):
        kick.pop("offset")
    if kick.get("rollDeg") is not None and not finite(kick["rollDeg"]):
        kick.pop("rollDeg")
    for name in ("attackMs", "holdMs"):
        if kick.get(name) is not None and not (finite(kick[name]) and kick[name] >= 0):
            kick.pop(name)
    if kick.get("ease") is not None and not is_ease_name(kick["ease"]):
        kick.pop("ease")
    return kick if any(kick.get(c) is not None for c in ("zoom", "offset", "rollDeg")) else None


def resolve_kicks(raw: Any, music: Optional[Dict[str, Any]], scene_start_ms: float) -> List[Dict[str, Any]]:
    """resolveCameraKicks over the parsed kicks: each with `atMs` (scene-local), its envelope and channels."""
    out: List[Dict[str, Any]] = []
    parsed = [k for k in (parse_kick(e) for e in raw) if k is not None] if isinstance(raw, list) else []
    for index, entry in enumerate(parsed):
        at = entry.get("at")
        if finite(at):
            at_ms = float(at)
        else:
            r = musicmod.resolve_scene_local(str(at), music or {"startOffsetMs": 0, "cues": {}, "sections": {}}, scene_start_ms)
            if not r["ok"]:
                continue
            at_ms = float(r["projectMs"])
        kick = {"atMs": at_ms, "at": at, "index": index, "attackMs": _non_negative(entry.get("attackMs")), "holdMs": _non_negative(entry.get("holdMs")),
                "releaseMs": _non_negative(entry.get("releaseMs")), "ease": entry.get("ease") if entry.get("ease") is not None else DEFAULT_ENVELOPE_EASE}
        for name in ("id", "zoom", "offset", "rollDeg"):
            if entry.get(name) is not None:
                kick[name] = entry[name]
        if "zoom" not in kick and "offset" not in kick and "rollDeg" not in kick:
            continue
        out.append(kick)
    out.sort(key=lambda k: (k["atMs"], k["index"]))
    return out


def envelope_length(kick: Dict[str, Any]) -> float:
    return kick["attackMs"] + kick["holdMs"] + kick["releaseMs"]


def envelope_at(u: float, kick: Dict[str, Any]) -> float:
    if not u >= 0:
        return 0.0
    attack, hold, release = kick["attackMs"], kick["holdMs"], kick["releaseMs"]
    if u >= attack + hold + release:
        return 0.0
    if u < attack:
        return ease(kick["ease"], u / attack)
    if u < attack + hold:
        return 1.0
    return 1 - ease(kick["ease"], (u - attack - hold) / release)


def view_basis(position: V3, look: V3, roll_deg: float = 0.0) -> Tuple[V3, V3, V3]:
    """(right, up, back) as cameraProject.ts viewBasis, roll included."""
    back = normalize(sub(position, look)) or (0.0, 0.0, 1.0)
    up = FALLBACK_UP if abs(dot(back, WORLD_UP)) > 1 - 1e-6 else WORLD_UP
    right = normalize(cross(up, back)) or (1.0, 0.0, 0.0)
    true_up = cross(back, right)
    if not roll_deg:
        return right, true_up, back
    a = math.radians(roll_deg)
    c, s = math.cos(a), math.sin(a)
    return (add(scale(right, c), scale(true_up, s)), sub(scale(true_up, c), scale(right, s)), back)


def apply_kicks(pose: Dict[str, Any], kicks: List[Dict[str, Any]], local_ms: float) -> Dict[str, Any]:
    if not kicks:
        return pose
    shift: Optional[List[float]] = None
    magnify, roll = 1.0, 0.0
    for kick in kicks:
        e = envelope_at(local_ms - kick["atMs"], kick)
        if e == 0:
            continue
        offset = kick.get("offset")
        if finite3(offset):
            shift = shift or [0.0, 0.0, 0.0]
            for i in range(3):
                shift[i] += e * offset[i]
        if finite(kick.get("zoom")):
            magnify *= 1 + (kick["zoom"] - 1) * e
        if finite(kick.get("rollDeg")):
            roll += e * kick["rollDeg"]
    moves = shift is not None and any(shift)
    if not moves and magnify == 1 and roll == 0:
        return pose
    out = dict(pose)
    if moves and shift:
        x, y, z = view_basis(pose["position"], pose["lookAt"], pose.get("rollDeg") or 0.0)
        d = tuple(x[i] * shift[0] + y[i] * shift[1] + z[i] * shift[2] for i in range(3))
        out["position"] = add(pose["position"], d)
        out["lookAt"] = add(pose["lookAt"], d)
    if magnify != 1:
        fov = 2 * math.atan(math.tan(math.radians(pose["fov"]) / 2) / magnify) / (math.pi / 180)
        out["fov"] = min(KICK_FOV_MAX, max(KICK_FOV_MIN, fov))
    if roll != 0:
        out["rollDeg"] = (pose.get("rollDeg") or 0.0) + roll
    return out


# ── one scene's camera ───────────────────────────────────────────────────────


def _earliest(raw: Dict[str, Any]) -> int:
    best = -1
    keys = raw.get("keys") if isinstance(raw.get("keys"), list) else []
    for i, key in enumerate(keys):
        if not isinstance(key, dict) or not finite(key.get("tMs")):
            continue
        if best < 0 or key["tMs"] < keys[best]["tMs"]:
            best = i
    return best


def final_pose(tracks: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """finalScenePose: the pose a scene holds after its last key, as a point-aimed rig pose."""
    if not tracks:
        return None
    if tracks["mode"] == "rig" and tracks["rig"]:
        s = sample_rig(tracks["rig"], tracks["rig"]["keys"][-1]["tMs"])
        pose: Dict[str, Any] = {"position": list(s["position"]), "aim": {"mode": "point", "at": list(s["lookAt"])}}
        if s["fov"] is not None:
            pose["fov"] = s["fov"]
        if s["rollDeg"]:
            pose["rollDeg"] = s["rollDeg"]
        return pose
    if not tracks["orbit"]:
        return None
    s = sample_orbit(tracks["orbit"], tracks["orbit"]["keys"][-1]["tMs"])
    return {"position": list(s["position"]), "aim": {"mode": "point", "at": list(s["lookAt"])}}


def scene_tracks(docs: Sequence[Optional[Dict[str, Any]]], music: Optional[Dict[str, Any]] = None,
                 starts: Optional[Sequence[float]] = None) -> List[Optional[Dict[str, Any]]]:
    """buildSceneCameraTracks: each scene's mode, orbit, rig and kicks, with continueFromPrevious substituted."""
    out: List[Optional[Dict[str, Any]]] = []
    for i, doc in enumerate(docs):
        if not isinstance(doc, dict) or not (finite(doc.get("version")) and doc["version"] >= 1) or doc.get("animatedTrack") == "layeredScreenshot":
            out.append(None)
            continue
        orbit = normalize_orbit(doc.get("camera"))
        raw = doc.get("cameraRig") if doc.get("cameraMode") == "rig" and isinstance(doc.get("cameraRig"), dict) else None
        if raw is not None:
            first = _earliest(raw)
            if first >= 0 and raw["keys"][first].get("continueFromPrevious") is True:
                previous = final_pose(out[i - 1]) if i > 0 else None
                if previous is not None:
                    raw = dict(raw, keys=[dict(k, pose=previous) if n == first else k for n, k in enumerate(raw["keys"])])
        rig = normalize_rig(raw, doc)
        kicks = resolve_kicks(doc.get("cameraKicks"), music, float(starts[i]) if starts and i < len(starts) else 0.0)
        if not orbit and not rig and not kicks:
            out.append(None)
            continue
        out.append({"mode": "rig" if rig else "orbit", "orbit": orbit, "rig": rig, "kicks": kicks})
    return out


def base_pose(fov: float = CAMERA_FOV) -> Dict[str, Any]:
    return {"position": CAMERA_POSITION, "lookAt": (0.0, 0.0, 0.0), "fov": fov, "rollDeg": 0.0, "aimDistance": CAMERA_POSITION[2], "dof": None}


def driving_pose(tracks: Optional[Dict[str, Any]], local_ms: float, fallback: Dict[str, Any]) -> Dict[str, Any]:
    if not tracks:
        return fallback
    if tracks["mode"] == "rig" and tracks["rig"]:
        pose = sample_rig(tracks["rig"], local_ms)
        return dict(pose, fov=fallback["fov"] if pose["fov"] is None else pose["fov"])
    if not tracks["orbit"]:
        return fallback
    return dict(sample_orbit(tracks["orbit"], local_ms), fov=fallback["fov"])


def scene_pose(tracks: Optional[Dict[str, Any]], local_ms: float, fallback: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """sceneCameraPose: the driving pose with the scene's kicks on top."""
    pose = driving_pose(tracks, local_ms, fallback or base_pose())
    return apply_kicks(pose, tracks["kicks"], local_ms) if tracks and tracks["kicks"] else pose


# ── devices ──────────────────────────────────────────────────────────────────


def device_track(doc: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    raw = doc.get("deviceTrack") if isinstance(doc, dict) else None
    keys = [k for k in (raw.get("keys") if isinstance(raw, dict) else None) or [] if isinstance(k, dict) and isinstance(k.get("id"), str) and finite(k.get("tMs"))]
    if not keys:
        return None
    by_id = {k.get("id"): k for k in keys}
    ordered = sorted(keys, key=lambda k: k["tMs"])
    segments = []
    for seg in raw.get("segments") or []:
        if not isinstance(seg, dict) or not all(isinstance(seg.get(f), str) for f in ("from", "to", "ease")):
            continue
        a, b = by_id.get(seg["from"]), by_id.get(seg["to"])
        if a is None or b is None or a["tMs"] >= b["tMs"]:
            continue
        segments.append({"from": a, "to": b, "ease": seg["ease"]})
    segments.sort(key=lambda s: s["from"]["tMs"])
    return {"keys": ordered, "segments": segments}


def _device_delta(pose: Any) -> Tuple[V3, V3]:
    pose = pose if isinstance(pose, dict) and not isinstance(pose.get("slot"), str) else {}
    offset = v3(pose["offset"]) if finite3(pose.get("offset")) else (0.0, 0.0, 0.0)
    rotation = v3(pose["rotationDeg"]) if finite3(pose.get("rotationDeg")) else (0.0, 0.0, 0.0)
    return offset, rotation


def device_delta_at(track: Optional[Dict[str, Any]], device_id: str, local_ms: float) -> Tuple[V3, V3]:
    """deviceTrackPoseAt's offset and rotation (slot-relative poses read as plain deltas)."""
    if not track:
        return (0.0, 0.0, 0.0), (0.0, 0.0, 0.0)
    for seg in track["segments"]:
        if seg["from"]["tMs"] <= local_ms < seg["to"]["tMs"]:
            p = ease(seg["ease"], (local_ms - seg["from"]["tMs"]) / (seg["to"]["tMs"] - seg["from"]["tMs"]))
            oa, ra = _device_delta(seg["from"]["pose"].get(device_id))
            ob, rb = _device_delta(seg["to"]["pose"].get(device_id))
            return lerp3(oa, ob, p), lerp3(ra, rb, p)
    held = track["keys"][0]
    for key in track["keys"]:
        if key["tMs"] <= local_ms:
            held = key
        else:
            break
    return _device_delta(held["pose"].get(device_id))


def euler_matrix(rotation_deg: Sequence[float]) -> Tuple[V3, V3, V3]:
    """three.js Euler XYZ as a row-major matrix (rows), so world = M · local."""
    x, y, z = (math.radians(a) for a in rotation_deg)
    a, b = math.cos(x), math.sin(x)
    c, d = math.cos(y), math.sin(y)
    e, f = math.cos(z), math.sin(z)
    ae, af, be, bf = a * e, a * f, b * e, b * f
    return ((c * e, -c * f, d), (af + be * d, ae - bf * d, -b * c), (bf - ae * d, be + af * d, a * c))


def mat_apply(m: Tuple[V3, V3, V3], v: Sequence[float]) -> V3:
    return (dot(m[0], v), dot(m[1], v), dot(m[2], v))


def devices_at(doc: Optional[Dict[str, Any]], track: Optional[Dict[str, Any]], local_ms: float) -> List[Dict[str, Any]]:
    """Each device's id, model, scale, position and rotation at this moment (placement plus the device track; a grounded device keeps its authored height)."""
    out = []
    for device in parsed_devices(doc):
        placement = device.get("placement") if isinstance(device.get("placement"), dict) else {}
        position = v3(placement["position"]) if finite3(placement.get("position")) else (0.0, 0.0, 0.0)
        rotation = v3(placement["rotationDeg"]) if finite3(placement.get("rotationDeg")) else (0.0, 0.0, 0.0)
        size = float(placement["scale"]) if finite(placement.get("scale")) and placement["scale"] > 0 else 1.0
        offset, turn = device_delta_at(track, device["id"], local_ms)
        out.append({"id": device["id"], "model": device.get("model"), "scale": size, "position": add(position, offset), "rotationDeg": add(rotation, turn)})
    return out
