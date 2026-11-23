"""kb check camera: each scene's camera sampled the way the app renders it (camera/sample.py), checked for the moves that
read as mistakes in motion: a kick on a continuous cut or on a turn, a move that wanders off its line and back, jump cuts
that swing to either side of one subject, a push that tilts the background, and a numeric focus that sits on nothing.
Advice, never a rule: the person decides, and a warning they keep is accepted with their reason (kb camera accept).
docs/agent-kit.md ("Camera check") gives each threshold's evidence."""

from __future__ import annotations

import hashlib
import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import sample as cs

KINDS = ("kick-at-cut", "kick-on-turn", "sway", "wobble", "climb", "focus")
STEP_MS = 1000.0 / 120
FIRST_MOMENT_MS = 120.0
SAME_POSITION = 0.02
SAME_DEG = 1.0
TURN_DEG = 2.0
WANDER = 0.02
BACKTRACK = 0.02
MIN_MOVE = 0.01
SAME_AIM = 1e-6
SIDE_DEG = 6.0
ROLL_SIDE_DEG = 1.5
SUBJECT_REACH = 0.6
SLIDE = 0.03
PUSH_RATIO = 2.0
LENS_COC = 0.01
VIEW_MARGIN = 1.1
FOCUS_MODES = ("depth", "split", "lens")
DEFAULT_BOX = (1.25, 2.6, 0.23)


def issue_id(kind: str, scene: str, anchor: str) -> str:
    return hashlib.sha1(f"camera|{kind}|{scene}|{anchor}".encode("utf-8")).hexdigest()[:8]


def secs(ms: float) -> str:
    return f"{ms / 1000:.2f}s"


def angle_deg(a: Sequence[float], b: Sequence[float]) -> float:
    return math.degrees(math.acos(max(-1.0, min(1.0, cs.dot(a, b)))))


def forward_of(pose: Dict[str, Any]) -> cs.V3:
    return cs.normalize(cs.sub(pose["lookAt"], pose["position"])) or cs.DEGENERATE_FORWARD


def project(pose: Dict[str, Any], point: Sequence[float]) -> Optional[Tuple[float, float, float]]:
    """(x, y, depth) of a world point: x and y in frame heights from the centre, depth along the view axis."""
    right, up, back = cs.view_basis(pose["position"], pose["lookAt"], pose.get("rollDeg") or 0.0)
    v = cs.sub(point, pose["position"])
    depth = -cs.dot(v, back)
    if depth <= 1e-6:
        return None
    half = math.tan(math.radians(pose["fov"]) / 2) * depth * 2
    return cs.dot(v, right) / half, cs.dot(v, up) / half, depth


def orientation_deg(a: Sequence[float], b: Sequence[float]) -> float:
    """The angle between two Euler XYZ orientations."""
    ma, mb = cs.euler_matrix(a), cs.euler_matrix(b)
    trace = sum(ma[r][c] * mb[r][c] for r in range(3) for c in range(3))
    return math.degrees(math.acos(max(-1.0, min(1.0, (trace - 1) / 2))))


def relative_view(pose: Dict[str, Any], device: Dict[str, Any]) -> Tuple[float, float, float]:
    """(yaw, pitch, roll) in degrees: where the camera looks from in the device's own frame, and how far its up axis leans on screen."""
    m = cs.euler_matrix(device["rotationDeg"])
    back = cs.scale(forward_of(pose), -1)
    local = (m[0][0] * back[0] + m[1][0] * back[1] + m[2][0] * back[2],
             m[0][1] * back[0] + m[1][1] * back[1] + m[2][1] * back[2],
             m[0][2] * back[0] + m[1][2] * back[1] + m[2][2] * back[2])
    yaw = math.degrees(math.atan2(local[0], local[2]))
    pitch = math.degrees(math.atan2(local[1], math.hypot(local[0], local[2])))
    right, up, _ = cs.view_basis(pose["position"], pose["lookAt"], pose.get("rollDeg") or 0.0)
    device_up = cs.mat_apply(m, (0.0, 1.0, 0.0))
    roll = math.degrees(math.atan2(cs.dot(device_up, right), cs.dot(device_up, up)))
    return yaw, pitch, roll


class Scene:
    """One scene's camera, devices and slot, sampled without kicks unless asked."""

    def __init__(self, index: int, slot: Dict[str, Any], doc: Optional[Dict[str, Any]], tracks: Optional[Dict[str, Any]],
                 boxes: Dict[str, Tuple[float, float, float]], aspect: float) -> None:
        self.index = index
        self.stem = str(slot.get("stem") or "")
        self.start = float(slot["startMs"])
        self.duration = float(slot["durationMs"])
        self.doc = doc if isinstance(doc, dict) else None
        self.tracks = tracks
        self.boxes = boxes
        self.aspect = aspect
        self.device_track = cs.device_track(self.doc)
        self.calm = dict(tracks, kicks=[]) if tracks else None

    @property
    def keyed(self) -> bool:
        t = self.tracks
        return bool(t and ((t["mode"] == "rig" and t["rig"]) or t["orbit"]))

    @property
    def track(self) -> Optional[Dict[str, Any]]:
        if not self.tracks:
            return None
        return self.tracks["rig"] if self.tracks["mode"] == "rig" else self.tracks["orbit"]

    def pose(self, t: float) -> Dict[str, Any]:
        return cs.scene_pose(self.calm, t)

    def devices(self, t: float) -> List[Dict[str, Any]]:
        return cs.devices_at(self.doc, self.device_track, t)

    def in_view(self, pose: Dict[str, Any], point: Sequence[float]) -> bool:
        p = project(pose, point)
        return p is not None and abs(p[0]) <= self.aspect / 2 * VIEW_MARGIN and abs(p[1]) <= 0.5 * VIEW_MARGIN

    def box(self, device: Dict[str, Any]) -> Tuple[float, float, float]:
        w, h, d = self.boxes.get(str(device.get("model")), DEFAULT_BOX)
        return w * device["scale"], h * device["scale"], d * device["scale"]

    def depth_span(self, pose: Dict[str, Any], device: Dict[str, Any]) -> Tuple[float, float]:
        f = forward_of(pose)
        m = cs.euler_matrix(device["rotationDeg"])
        centre = cs.dot(cs.sub(device["position"], pose["position"]), f)
        half = sum(abs(cs.dot((m[0][i], m[1][i], m[2][i]), f)) * extent / 2 for i, extent in enumerate(self.box(device)))
        return centre - half, centre + half

    def subject(self, pose: Dict[str, Any], t: float) -> Optional[Dict[str, Any]]:
        """The device the camera aims at: the nearest to its aim point, within reach of the aim distance."""
        near = None
        for d in self.devices(t):
            gap = cs.length(cs.sub(d["position"], pose["lookAt"]))
            if gap <= SUBJECT_REACH * pose["aimDistance"] and (near is None or gap < near[0]):
                near = (gap, d)
        return near[1] if near else None


# ── shots and moves ──────────────────────────────────────────────────────────


def cuts(track: Optional[Dict[str, Any]], duration: float) -> List[float]:
    """Where the camera jumps inside a scene: the end of each `jump` segment, and a held key snapping to the next."""
    if not track:
        return []
    out: List[float] = []
    keys = track["keys"]
    for seg in track["segments"]:
        if seg["ease"] == "jump":
            out.append(seg["to"]["tMs"])
    for a, b in zip(keys, keys[1:]):
        inside = any(s["from"]["tMs"] <= a["tMs"] and b["tMs"] <= s["to"]["tMs"] for s in track["segments"])
        if not inside and b["tMs"] > a["tMs"] and placed(a) != placed(b):
            out.append(b["tMs"])
    return sorted(t for t in set(out) if 0 < t < duration)


def placed(key: Dict[str, Any]) -> Dict[str, Any]:
    """Where a key puts the camera, focus aside."""
    return {k: v for k, v in key["pose"].items() if k != "dof"}


def _aim_of(key: Dict[str, Any]) -> Optional[cs.V3]:
    pose = key["pose"]
    if "target" in pose:
        return pose["target"]
    return None if pose["aim"]["mode"] == "tangent" else pose["aim"]["at"]


def same_aim(a: Optional[cs.V3], b: Optional[cs.V3]) -> bool:
    return a is not None and b is not None and cs.length(cs.sub(a, b)) <= SAME_AIM


def moves(track: Optional[Dict[str, Any]]) -> List[Tuple[List[Dict[str, Any]], Optional[cs.V3]]]:
    """Runs of joined, non-jump segments that hold one aim point, with that point; any other segment alone, with None."""
    out: List[Tuple[List[Dict[str, Any]], Optional[cs.V3]]] = []
    for seg in (track or {}).get("segments") or []:
        if seg["ease"] == "jump":
            continue
        aim = _aim_of(seg["from"])
        held = aim if same_aim(aim, _aim_of(seg["to"])) else None
        last = out[-1] if out else None
        if last and held is not None and same_aim(held, last[1]) and last[0][-1]["to"]["id"] == seg["from"]["id"]:
            last[0].append(seg)
        else:
            out.append(([seg], held))
    return out


def times(a: float, b: float, step: float = STEP_MS) -> List[float]:
    n = max(1, int(math.ceil((b - a) / step)))
    return [a + (b - a) * i / n for i in range(n)] + [b - 1e-6]


# ── the rules ────────────────────────────────────────────────────────────────


def kick_issues(scenes: List[Scene], only: Optional[Sequence[str]] = None) -> List[Dict[str, Any]]:
    out = []
    for n, sc in enumerate(scenes):
        if only is not None and sc.stem not in only:
            continue
        for kick in (sc.tracks or {}).get("kicks") or []:
            at, end = kick["atMs"], kick["atMs"] + cs.envelope_length(kick)
            anchor = str(kick.get("id") or kick.get("at"))
            what = kick_words(kick)
            prev = scenes[n - 1] if n > 0 else None
            if at <= FIRST_MOMENT_MS and end > 0 and prev is not None and sc.keyed and prev.keyed and continuous(prev, sc):
                out.append({"kind": "kick-at-cut", "scene": sc.stem, "anchor": anchor, "atMs": sc.start + max(0.0, at),
                            "message": f"{sc.stem} {secs(max(0.0, at))}: the {what} kick lands on the cut, and the camera carries straight on from "
                                       f"{prev.stem}, so it reads as the camera jumping; move it off the cut (a beat in) or drop it"})
            turn = turn_onset(sc, max(0.0, at), min(sc.duration, end))
            if turn and turn[0] >= TURN_DEG:
                out.append({"kind": "kick-on-turn", "scene": sc.stem, "anchor": anchor, "atMs": sc.start + at,
                            "message": f"{sc.stem} {secs(at)}: the {what} kick lands as {turn[1]} starts a {turn[0]:.1f}° turn, two moves at once that "
                                       "read as a jump; put the kick where nothing starts to turn, or drop it"})
    return out


def kick_words(kick: Dict[str, Any]) -> str:
    parts = []
    if cs.finite(kick.get("zoom")):
        parts.append(f"{(kick['zoom'] - 1) * 100:+.0f}% zoom")
    if cs.finite(kick.get("rollDeg")):
        parts.append(f"{kick['rollDeg']:g}° roll")
    if cs.finite3(kick.get("offset")):
        parts.append("offset")
    return ", ".join(parts) or "camera"


def continuous(prev: Scene, sc: Scene) -> bool:
    """The camera ends one scene where the next begins: same place, direction and lens."""
    a, b = prev.pose(prev.duration), sc.pose(0.0)
    reach = max(a["aimDistance"], b["aimDistance"], 1e-6)
    return (cs.length(cs.sub(a["position"], b["position"])) <= SAME_POSITION * reach and angle_deg(forward_of(a), forward_of(b)) <= SAME_DEG
            and abs(a["fov"] - b["fov"]) <= SAME_DEG)


def turns(sc: Scene, a: float, b: float, poses0: Dict[str, Any]) -> Dict[str, float]:
    """How far each view source turns between a and b: the camera (direction and roll), and each device in view at the kick."""
    ts = times(a, b, STEP_MS / 2)
    poses = [sc.pose(t) for t in ts]
    out = {"the camera": sum(angle_deg(forward_of(p), forward_of(q)) for p, q in zip(poses, poses[1:]))
           + abs((poses[-1].get("rollDeg") or 0.0) - (poses[0].get("rollDeg") or 0.0))}
    states = [sc.devices(t) for t in ts]
    for i, device in enumerate(states[0]):
        if sc.in_view(poses0, device["position"]):
            out[f"the {device['id']} device"] = sum(orientation_deg(s[i]["rotationDeg"], u[i]["rotationDeg"]) for s, u in zip(states, states[1:]))
    return out


def turn_onset(sc: Scene, a: float, b: float) -> Optional[Tuple[float, str]]:
    """The turn that starts under a kick: how much more a view turns between a and b than it was turning just before."""
    if b <= a:
        return None
    pose = sc.pose(a)
    during = turns(sc, a, b, pose)
    lead = max(0.0, a - (b - a))
    if a - lead >= (b - a) / 2:
        span, before = a - lead, turns(sc, lead, a, pose)
    else:
        span, before = min(b - a, sc.duration - b), turns(sc, b, min(sc.duration, b + (b - a)), pose)
    best: Optional[Tuple[float, str]] = None
    for name, turned in during.items():
        onset = turned - before.get(name, 0.0) * (b - a) / span if span > 1e-6 else turned
        if best is None or onset > best[0]:
            best = (onset, name)
    return best


def sway_issues(sc: Scene) -> List[Dict[str, Any]]:
    out = []
    track = sc.track
    keys = track["keys"] if track else []
    shot_of = shot_index(track, sc.duration)
    for run, aim in moves(track):
        a, b = run[0]["from"], run[-1]["to"]
        anchor = f"{a['id']}-{b['id']}"
        ts = times(a["tMs"], min(b["tMs"], sc.duration))
        poses = [sc.pose(t) for t in ts]
        if aim is not None:
            pts = [project(p, aim) for p in poses]
            pts = [p for p in pts if p]
            path = sum(math.hypot(q[0] - p[0], q[1] - p[1]) for p, q in zip(pts, pts[1:]))
            net = math.hypot(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1]) if pts else 0.0
            if (path - net) / 2 >= WANDER:
                hint = bend_hint(run, keys, shot_of)
                out.append({"kind": "sway", "scene": sc.stem, "anchor": anchor, "atMs": sc.start + a["tMs"], "toMs": sc.start + b["tMs"],
                            "message": f"{sc.stem} {secs(a['tMs'])}-{secs(b['tMs'])}: what the camera aims at drifts {(path - net) / 2 * 100:.1f}% of the "
                                       f"frame off its line and back inside one move ({a['id']} to {b['id']}), which reads as a sway; {hint}"})
                continue
        for seg in run:
            back = backtrack(sc, seg)
            if back is not None:
                out.append({"kind": "sway", "scene": sc.stem, "anchor": f"{seg['from']['id']}-{seg['to']['id']}", "atMs": sc.start + seg["from"]["tMs"],
                            "toMs": sc.start + seg["to"]["tMs"],
                            "message": f"{sc.stem} {secs(seg['from']['tMs'])}-{secs(seg['to']['tMs'])}: the camera runs back {back * 100:.0f}% of its move "
                                       f"before it lands ({seg['from']['id']} to {seg['to']['id']}, ease {seg['ease']}); use an ease that never reverses "
                                       "(linear, outSine, inOutSine)"})
                break
    return out


def shot_index(track: Optional[Dict[str, Any]], duration: float) -> Dict[str, int]:
    bounds = cuts(track, duration)
    return {k["id"]: sum(1 for c in bounds if c <= k["tMs"]) for k in (track or {}).get("keys") or []}


def bend_hint(run: List[Dict[str, Any]], keys: List[Dict[str, Any]], shot_of: Dict[str, int]) -> str:
    """Why a smooth run bends: a shaping neighbour in another shot pulls the spline towards it."""
    first, last = run[0], run[-1]
    if first.get("smooth") or last.get("smooth"):
        ids = [k["id"] for k in keys]
        i, j = ids.index(first["from"]["id"]), ids.index(last["to"]["id"])
        far = [ids[x] for x in (i - 1, j + 1) if 0 <= x < len(ids) and shot_of.get(ids[x]) != shot_of.get(first["from"]["id"])]
        if far:
            return (f"the spline bends towards {' and '.join(far)} in another shot: set \"smooth\": false on these segments "
                    "for one straight move")
        return 'the look re-aims only at keys, so a curved path drifts off its subject between them: add keys along the curve, or set "smooth": false'
    return "keep the aim on the subject and move the camera along one line"


def backtrack(sc: Scene, seg: Dict[str, Any]) -> Optional[float]:
    """How far back along its own chord a segment runs, as a fraction of the chord; None when it never reverses."""
    a, b = seg["from"], seg["to"]
    pa, pb = sc.pose(a["tMs"]), sc.pose(min(b["tMs"], sc.duration))
    chord = cs.sub(pb["position"], pa["position"])
    span = cs.length(chord)
    if span < MIN_MOVE * max(pa["aimDistance"], 1e-6):
        return None
    unit = cs.scale(chord, 1 / span)
    ps = [sc.pose(t)["position"] for t in times(a["tMs"], min(b["tMs"], sc.duration))]
    back = sum(-s for s in (cs.dot(cs.sub(q, p), unit) for p, q in zip(ps, ps[1:])) if s < 0)
    return back / span if back >= BACKTRACK * span else None


def wobble_issues(sc: Scene) -> List[Dict[str, Any]]:
    track = sc.track
    if not track:
        return []
    bounds = [0.0] + cuts(track, sc.duration)
    if len(bounds) < 3:
        return []
    shots = []
    for t in bounds:
        pose = sc.pose(t)
        device = sc.subject(pose, t)
        key = next((k for k in reversed(track["keys"]) if k["tMs"] <= t), track["keys"][0])
        shots.append({"t": t, "key": key["id"], "model": device.get("model") if device else None,
                      "view": relative_view(pose, device) if device else None})
    out = []
    for c, (name, side) in enumerate((("angle", SIDE_DEG), ("height", SIDE_DEG), ("roll", ROLL_SIDE_DEG))):
        for i in range(len(shots) - 2):
            trio = shots[i:i + 3]
            if not all(s["view"] and s["model"] == trio[0]["model"] for s in trio):
                continue
            values = [s["view"][c] for s in trio]
            signs = [0 if abs(v) < side else (1 if v > 0 else -1) for v in values]
            if 0 in signs or signs[0] == signs[1] or signs[1] == signs[2]:
                continue
            run = trio
            for s in shots[i + 3:]:
                v = s["view"][c] if s["view"] and s["model"] == trio[0]["model"] else 0.0
                sign = 0 if abs(v) < side else (1 if v > 0 else -1)
                if sign == 0 or sign == (1 if run[-1]["view"][c] > 0 else -1):
                    break
                run = run + [s]
            seq = ", ".join(f"{s['view'][c]:+.0f}°" for s in run)
            way = {"angle": "from one side of it to the other", "height": "above and below it in turn", "roll": "leaning one way then the other"}[name]
            out.append({"kind": "wobble", "scene": sc.stem, "anchor": f"{name}:{run[0]['key']}", "atMs": sc.start + run[0]["t"],
                        "toMs": sc.start + (bounds[bounds.index(run[-1]["t"]) + 1] if bounds.index(run[-1]["t"]) + 1 < len(bounds) else sc.duration),
                        "message": f"{sc.stem} {secs(run[0]['t'])}-{secs(run[-1]['t'])}: {len(run)} jump cuts of the {trio[0]['model']} swing {way} "
                                   f"({name} {seq}; shots from {run[0]['key']}), which reads as a wobble; keep one {name} and change the shot size instead"})
            break
    return out


def climb_issues(sc: Scene) -> List[Dict[str, Any]]:
    out = []
    for run, aim in moves(sc.track):
        if aim is None:
            continue
        a, b = run[0]["from"], run[-1]["to"]
        end = min(b["tMs"], sc.duration)
        p0, p1 = sc.pose(a["tMs"]), sc.pose(end)
        chord = cs.sub(p1["position"], p0["position"])
        right, up, _ = cs.view_basis(p0["position"], p0["lookAt"], p0.get("rollDeg") or 0.0)
        push = cs.dot(chord, forward_of(p0))
        if push <= MIN_MOVE * p0["aimDistance"] or push < PUSH_RATIO * max(abs(cs.dot(chord, right)), abs(cs.dot(chord, up))):
            continue
        pitch0 = math.degrees(math.asin(max(-1.0, min(1.0, forward_of(p0)[1]))))
        worst = max((math.degrees(math.asin(max(-1.0, min(1.0, forward_of(sc.pose(t))[1])))) - pitch0 for t in times(a["tMs"], end)), key=abs)
        slide = abs(worst) / max(p0["fov"], 1e-6)
        if slide >= SLIDE:
            way = "climbs" if worst < 0 else "drops"
            out.append({"kind": "climb", "scene": sc.stem, "anchor": f"{a['id']}-{b['id']}", "atMs": sc.start + a["tMs"], "toMs": sc.start + end,
                        "message": f"{sc.stem} {secs(a['tMs'])}-{secs(end)}: the push {way} {abs(worst):.1f}° round its subject as it goes in ({a['id']} to "
                                   f"{b['id']}), sliding the background {slide * 100:.0f}% of the frame; push along the line to the subject, or make the rise its own move"})
    return out


def focus_band(dof: Dict[str, Any], focus: float, pose: Dict[str, Any]) -> Tuple[float, float]:
    """The depths held sharp around one focus distance: the dof range, or where the lens keeps text readable."""
    if dof["mode"] != "lens":
        return focus - dof["range"], focus + dof["range"]
    half_tan = math.tan(math.radians(pose["fov"]) / 2)
    focal = dof["focalMm"] if dof["focalMm"] is not None else dof["sensorMm"] / 2 / half_tan
    sensor = 2 * dof["focalMm"] * half_tan if dof["focalMm"] is not None else dof["sensorMm"]
    focus_mm = max(focus * cs.LENS_MM_PER_UNIT, focal * 1.001)
    coc_inf = max(0.0, dof["blur"]) * (focal / dof["fStop"]) * focal / (focus_mm - focal) / sensor
    if coc_inf <= LENS_COC:
        return focus / (1 + LENS_COC / max(coc_inf, 1e-12)), math.inf
    return focus / (1 + LENS_COC / coc_inf), focus / (1 - LENS_COC / coc_inf)


def focus_issues(sc: Scene) -> List[Dict[str, Any]]:
    """A numeric focus checked where it is authored: at each key that sets one, which is also where every rack lands."""
    track = sc.track
    if not track or track["dofMode"] not in FOCUS_MODES or not track["dofActive"]:
        return []
    missed = []
    for key in track["keys"]:
        authored = key["pose"].get("dof") or {}
        if not (cs.finite(authored.get("focus")) or (track["dofMode"] == "split" and cs.finite(authored.get("focusB")))):
            continue
        t = min(key["tMs"], max(0.0, sc.duration - 1e-6))
        pose = sc.pose(t)
        dof = pose.get("dof")
        if dof and dof.get("manual") and dof["blur"] > 0:
            miss = focus_miss(sc, pose, dof, t)
            if miss:
                missed.append((key, t, miss))
    if not missed:
        return []
    key, t, worst = missed[0]
    more = f" ({len(missed)} of its focus keys miss)" if len(missed) > 1 else ""
    return [{"kind": "focus", "scene": sc.stem, "anchor": key["id"], "atMs": sc.start + t,
             "message": f"{sc.stem} {secs(t)}: focus {worst['focus']:.2f} at {key['id']} sits {worst['gap']:.2f} from the nearest subject kb can see "
                        f"({worst['nearest']}), outside what the {worst['band']} keeps sharp{more}; use \"focus\": \"auto\" to follow the aim, or set "
                        "the subject's own depth (never a guess). If it holds something kb cannot see (a lifted card, a title in front), keep it"}]


def focus_miss(sc: Scene, pose: Dict[str, Any], dof: Dict[str, Any], t: float) -> Optional[Dict[str, Any]]:
    """None when a focus plane's sharp band reaches a subject (the aim, a device in view, a stage media entry); else the miss."""
    subjects: List[Tuple[str, float, float]] = [(f"the aim at {pose['aimDistance']:.2f}", pose["aimDistance"], pose["aimDistance"])]
    for device in sc.devices(t):
        if sc.in_view(pose, device["position"]):
            lo, hi = sc.depth_span(pose, device)
            lo, hi = lo + (hi - lo) / 4, hi - (hi - lo) / 4
            subjects.append((f"the middle of the {device['id']} device at {lo:.2f}-{hi:.2f}", lo, hi))
    for entry in (sc.doc or {}).get("media") or []:
        stage = entry.get("stage") if isinstance(entry, dict) and entry.get("host") == "stage" else None
        if isinstance(stage, dict) and cs.finite3(stage.get("position")) and sc.in_view(pose, stage["position"]):
            p = project(pose, stage["position"])
            if p:
                subjects.append((f"the {entry.get('id') or 'media'} at {p[2]:.2f}", p[2], p[2]))
    planes = [dof["focus"]] + ([dof["focusB"]] if dof["mode"] == "split" else [])
    best: Optional[Dict[str, Any]] = None
    for focus in planes:
        lo, hi = focus_band(dof, focus, pose)
        for name, a, b in subjects:
            if b >= lo and a <= hi:
                return None
            gap = a - focus if a > focus else focus - b
            if best is None or gap < best["gap"]:
                band = f"f/{dof['fStop']:.1f} lens" if dof["mode"] == "lens" else f"{dof['range']:g} range"
                best = {"focus": focus, "gap": gap, "nearest": name, "band": band}
    return best


# ── the check ────────────────────────────────────────────────────────────────


def check(scenes: List[Scene], accepted: List[Dict[str, Any]], only: Optional[Sequence[str]] = None) -> Dict[str, Any]:
    issues = kick_issues(scenes, only)
    for sc in scenes:
        if not sc.tracks or (only is not None and sc.stem not in only):
            continue
        issues += sway_issues(sc) + wobble_issues(sc) + climb_issues(sc) + focus_issues(sc)
    order = {sc.stem: n for n, sc in enumerate(scenes)}
    issues.sort(key=lambda i: (order.get(i["scene"], 0), i["atMs"]))
    kept_by = {a.get("id"): a for a in accepted}
    open_, kept = [], []
    seen: Dict[str, int] = {}
    for issue in issues:
        base = f"{issue['kind']}|{issue['scene']}|{issue['anchor']}"
        seen[base] = seen.get(base, 0) + 1
        if seen[base] > 1:
            issue["anchor"] = f"{issue['anchor']}#{seen[base]}"
        issue["id"] = issue_id(issue["kind"], issue["scene"], issue["anchor"])
        hit = kept_by.get(issue["id"])
        if hit is None:
            open_.append(issue)
        else:
            kept.append(dict(issue, why=hit.get("why"), by=hit.get("by")))
    return {"issues": open_, "accepted": kept, "scenes": len(scenes), "checked": sum(1 for sc in scenes if sc.tracks)}
