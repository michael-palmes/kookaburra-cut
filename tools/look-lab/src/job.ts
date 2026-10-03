import { CAMERA } from "../../../src/engine/format";
import { orbitToView } from "../../../src/engine/orbit";
import {
  SCENE3D_PREVIEW_POSES,
  type Scene3dPreviewPose,
} from "../../../src/toolkit/stage/scene3d/previewCamera";
import type { Scene3dPreviewCamera } from "../../../src/toolkit/stage/scene3d/types";

/** A camera pose in world space; `fov` is vertical, like the app camera. */
export interface LabPose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

const view = (pose: Scene3dPreviewPose): Omit<LabPose, "fov"> => {
  const v = orbitToView(pose);
  return { position: v.position, target: v.lookAt };
};

const orbit = (azimuthDeg: number, elevationDeg: number, distance: number, ty = 0) =>
  view({ target: [0, ty, 0], azimuthDeg, elevationDeg, distance });

/** Named poses. `front` is the app default camera; `lab`, `static` and `ceiling` the generated preview-lab stills (`lab` is the eye-level sweep). */
export const LAB_CAMS: Record<string, Omit<LabPose, "fov">> = {
  front: {
    position: [CAMERA.position[0], CAMERA.position[1], CAMERA.position[2]],
    target: [0, 0, CAMERA.contentZ],
  },
  lab: view(SCENE3D_PREVIEW_POSES.sweep),
  static: view(SCENE3D_PREVIEW_POSES.static),
  ceiling: view(SCENE3D_PREVIEW_POSES.ceiling),
  wide: orbit(32, 20, 22),
  behind: orbit(180, 10, 9),
  far: orbit(20, 14, 45),
  low: orbit(10, -12, 8),
  top: orbit(0, 70, 14),
};

/** A named pose, or `orbit:az:el:dist[:targetY]` in degrees and world units (`preview`, and `lab` for ceiling looks, are resolved per look by `previewAlias`). */
export function resolveCam(name: string): LabPose | null {
  const named = LAB_CAMS[name];
  if (named) return { ...named, fov: CAMERA.fov };
  const m = /^orbit:(-?[\d.]+):(-?[\d.]+):([\d.]+)(?::(-?[\d.]+))?$/.exec(name);
  if (!m) return null;
  const [az, el, dist, ty] = m.slice(1).map((v) => (v === undefined ? 0 : Number(v)));
  return { ...orbit(az, el, dist, ty), fov: CAMERA.fov };
}

/** Per-look camera names: `preview` is the picker still's pose, and a ceiling look's `lab` is its ceiling pose (the pose its clip sweeps). */
export function previewAlias(name: string, kind: Scene3dPreviewCamera): string {
  const still = kind === "sweep" ? "lab" : kind;
  if (name === "preview") return still;
  return name === "lab" && kind === "ceiling" ? "ceiling" : name;
}

export interface LabJob {
  look: string;
  /** `sheet`: rows per preset and time, columns per camera plus a 9:16 tile. `grid`: every listed preset as one tile at `cams[0]`, by default the picker still's pose with no stand-ins. */
  mode: "sheet" | "grid";
  presets: string[];
  /** Look seconds on the absolute project clock; several give one row each per preset. */
  times: number[];
  cams: string[];
  /** Camera for the 9:16 tile, or null for none. */
  tall: string | null;
  /** 16:9 tile width in output pixels. */
  width: number;
  /** Render at this multiple and box-filter down. */
  ss: number;
  /** Param overrides applied on top of every preset. */
  params: Record<string, number>;
  headline: string;
  content: boolean;
  theme: string;
  /** One bare tile, no labels (pixel comparisons). */
  raw: boolean;
  /** POST the sheet to the runner instead of only showing it. */
  post: boolean;
}

const list = (v: string | null, fallback: string[]) =>
  v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : fallback;

/** Parses the page query (the runner and a browser use the same keys). */
export function parseJob(query: URLSearchParams): LabJob {
  const mode = query.get("mode") === "grid" ? "grid" : "sheet";
  const params: Record<string, number> = {};
  for (const pair of list(query.get("params"), [])) {
    const [k, v] = pair.split("=");
    if (k && v !== undefined && Number.isFinite(Number(v))) params[k] = Number(v);
  }
  const tall = query.get("tall") ?? "lab";
  return {
    look: query.get("look") ?? "",
    mode,
    presets: list(
      query.get("presets"),
      mode === "grid" ? ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"] : ["p1", "p6"],
    ),
    times: list(query.get("t"), ["8"]).map(Number),
    cams: list(
      query.get("cams"),
      mode === "grid" ? ["preview"] : ["front", "lab", "wide", "behind", "far"],
    ),
    tall: mode === "grid" || tall === "none" ? null : tall,
    width: Number(query.get("width") ?? (mode === "grid" ? 640 : 480)),
    ss: Math.max(1, Math.min(4, Math.round(Number(query.get("ss") ?? 1)))),
    params,
    headline: query.get("headline") ?? "Every frame, on purpose",
    content: query.has("content") ? query.get("content") !== "0" : mode !== "grid",
    theme: query.get("theme") ?? "kookaburra-default",
    raw: query.get("raw") === "1",
    post: query.get("post") === "1",
  };
}
