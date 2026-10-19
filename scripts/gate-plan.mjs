// The gate plan for a set of changed paths (docs/determinism.md "Gate tiers"); ready.mjs runs it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// gate:merge: the one PR gate, in this order (anchors run first; later legs inherit GPU state).
export const ANCHORS = ["showcase-tour", "ws:launch-2026"];

// Outside src/, paths that never reach exported pixels. Unlisted paths count as render.
const NO_VERIFY = [
  /^docs\//,
  /\.md$/,
  /^\.github\//,
  /^\.agents\//,
  /^\.claude\//,
  /^tools\//,
  /^presets\//,
  /^projects\/(?!showcase-tour\/)/,
  /^fixtures\/(README\.md|preview-lab|inspector-redesign-gate)/,
  /\.test\.(ts|tsx|mjs)$/,
  /\/(__fixtures__|__snapshots__)\//,
  /^scripts\/(?!kookaburra-run\.sh$|setup-ffmpeg\.sh$|build-ffmpeg-sidecar\.sh$)/,
  /^(biome\.json|\.gitignore|\.npmrc|LICENSE.*|AGENTS\.md|CLAUDE\.md)$/,
  /^src-tauri\/(capabilities|dmg|icons|templates|tests|resources\/models)\//,
  /^src-tauri\/src\/(bridge|bridge_export|bridge_health|capture_service|claude_update|cli|cli_check|cli_media|cli_song|edit|edit_masks|export_presets|global_screenshots|kit|library|library_previews|live_edits|packs_win|present|preset_posters|pty|render_win|settings_win|tap_dot_frames\.generated|theme_editor_win|theme_move|updater|website)\.rs$/,
];

// src/ files the closure can't see but the export path still depends on.
const SRC_RENDER = [/^src\/(App|main)\.tsx$/, /^src\/[^/]+\.d\.ts$/];

// Feature legs: the fixture whose content exercises the path (Tier 1), run only when touched.
export const FEATURE_LEGS = [
  {
    leg: "ws:device-video-spike",
    match: [
      /^src\/toolkit\/(device|media)\//,
      /^src\/engine\/(deviceScreens|deviceRegistry|clip\w*|media|sceneMedia\w*|previewMedia)\.tsx?$/,
      /^src-tauri\/src\/(clip_cache|conform|conform_av|media|mp4box)\.rs$/,
    ],
  },
  {
    leg: "ws:duo-spike",
    match: [/^src\/toolkit\/device\/fold\w*\.ts$/, /^src\/engine\/foldTransition\.ts$/],
  },
  {
    leg: "ws:fx-spike",
    match: [/^src\/engine\/(effects|effectParams|effectsStore|\w+Effect)\.tsx?$/],
  },
  {
    leg: "ws:dof-spike",
    match: [
      /^src\/engine\/(dof|SoftFocusEffect|depthStageRegistry)\.tsx?$/,
      /^src\/toolkit\/stage\/DepthStage\.tsx$/,
    ],
  },
  {
    leg: "ws:motion-blur-spike",
    match: [
      /^src\/engine\/(motionBlur|shutter\w*|SmearEffect)\.tsx?$/,
      /^src\/toolkit\/motion\/MotionBlur\.tsx$/,
    ],
  },
  { leg: "ws:motion-toolkit-spike", match: [/^src\/toolkit\/(motion|shapes)\//] },
  {
    leg: "ws:camera-kick-spike",
    match: [
      /^src\/engine\/(cameraKicks|beatCameraSync|beatState|musicTime|musicGridEdit)\.ts$/,
      /^src\/toolkit\/music\//,
    ],
  },
  {
    leg: "ws:camera-rig-spike-opus",
    match: [
      /^src\/engine\/(sceneRig\w*|rigFraming|orbit|cameraTrack|cameraBounds|cameraPresets|sceneCamera\w*)\.tsx?$/,
    ],
  },
  {
    leg: "ws:lighting-spike-fable",
    match: [
      /^src\/engine\/(sceneLighting|fixtures|lightingState|lightingAnimation|environments|kelvin)\.ts$/,
      /^src\/toolkit\/lighting\//,
      /^src\/toolkit\/stage\/StageLights\.tsx$/,
    ],
  },
  {
    leg: "transition-spike",
    match: [/^src\/engine\/(transition\w*|sharedElement)\.ts$/, /^src\/toolkit\/transitions\//],
  },
  {
    leg: "compare-spike",
    match: [/^src\/engine\/(sceneCompare|compare\w*)\.ts$/, /^src\/toolkit\/compare\//],
  },
  {
    leg: "ws:layered-screenshot-spike",
    match: [
      /^src\/engine\/(sceneLayeredScreenshot|layeredScreenshot\w*)\.ts$/,
      /^src\/toolkit\/media\/LayeredScreenshot\.tsx$/,
    ],
  },
  {
    leg: "ws:video-window-spike",
    match: [/^src\/engine\/sceneVideoWindow\.ts$/, /^src\/toolkit\/media\/VideoWindow\.tsx$/],
  },
  { leg: "ws:multi-device-spike", match: [/^src\/toolkit\/device\/layout\.ts$/] },
  {
    leg: "ws:chart-spike",
    match: [/^src\/toolkit\/chart\//, /^src\/engine\/(sceneChart|chart\w*)\.ts$/],
  },
  {
    leg: "ws:text-outline-spike",
    match: [
      /^src\/toolkit\/text\//,
      /^src\/engine\/(textStyleResolve|textMotionRegistry|reveal)\.ts$/,
    ],
  },
  {
    leg: "ws:rooms-spike",
    match: [/^src\/engine\/sceneRoom\.ts$/, /^src\/toolkit\/stage\/Room\.tsx$/],
  },
];

// Tier 2: the shared render seam adds the other class project and one 9:16 spot check.
const SEAM = [
  /^src\/engine\/(compositor|exporter|exportFrame|CompositorDriver|StageScenes|SceneHost|readback|frameFormat|sceneCamera)\.tsx?$/,
  /^src\/toolkit\/stage\/(SceneStage|sceneCamera)\.tsx?$/,
];
const SEAM_LEGS = [
  { leg: "ws:device-video-spike", aspect: "16:9" },
  { leg: "showcase-tour", aspect: "9:16" },
];

// Engine-wide constants live here; the planner can't tell a constant edit from any other, so it says so.
const MATRIX_CANDIDATES = [
  /^src\/engine\/(format|renderSettings|acesCurve)\.ts$/,
  /^src\/toolkit\/stage\/shadowRig\.ts$/,
  /^src\/theme\/fonts?\w*\.ts$/,
];

export const ACTION_LEGS = [
  {
    action: "packroundtrip",
    project: "ws:launch-2026",
    match: [/^src-tauri\/src\/pack\//, /^src-tauri\/src\/fonts\.rs$/],
  },
  {
    action: "stillsverify",
    project: "showcase-tour",
    match: [
      /^src-tauri\/src\/stills\//,
      /^src\/engine\/(still\w*|exportFrame|downscale|presentHold\w*|presentTimingRegistry)\.ts$/,
    ],
  },
];

const any = (patterns, path) => patterns.some((re) => re.test(path));

/** Whether a path needs the render gate, and why. `closure` is render-closure.mjs's set. */
export function classify(path, closure, { depsChanged = true } = {}) {
  const render = (why) => ({ kind: "render", why });
  const none = (why) => ({ kind: "none", why });
  if (path === "package.json")
    return depsChanged ? render("dependencies changed") : none("scripts only");
  if (any(SRC_RENDER, path)) return render("app shell");
  if (path.startsWith("src/") && !/\.test\.tsx?$/.test(path)) {
    return closure.has(path) ? render("on the export path") : none("outside the export path");
  }
  if (any(NO_VERIFY, path)) return none("never reaches exported pixels");
  // A bundled gate fixture's own files gate only that fixture.
  const fixture = path.match(/^fixtures\/([^/]+)\//)?.[1];
  if (fixture) return { kind: "fixture", why: "bundled gate fixture", leg: fixture };
  return render("unlisted, so gated");
}

export function plan(paths, closure, opts = {}) {
  const files = paths.map((path) => ({ path, ...classify(path, closure, opts) }));
  const renderFiles = files.filter((f) => f.kind === "render").map((f) => f.path);
  const legs = [];
  const add = (project, aspect, why) => {
    const found = legs.find((l) => l.project === project && l.aspect === aspect);
    if (found) found.why.push(why);
    else legs.push({ project, aspect, why: [why] });
  };
  if (renderFiles.length > 0) {
    for (const anchor of ANCHORS) add(anchor, "16:9", "gate:merge");
  }
  for (const f of files) if (f.kind === "fixture") add(f.leg, "16:9", f.path);
  for (const path of renderFiles) {
    for (const { leg, match } of FEATURE_LEGS) if (any(match, path)) add(leg, "16:9", path);
    if (any(SEAM, path)) for (const { leg, aspect } of SEAM_LEGS) add(leg, aspect, `seam: ${path}`);
  }
  const actions = [];
  for (const { action, project, match } of ACTION_LEGS) {
    const hits = paths.filter((p) => any(match, p));
    if (hits.length > 0) actions.push({ action, project, why: hits });
  }
  const notes = [];
  const matrix = paths.filter((p) => any(MATRIX_CANDIDATES, p));
  if (matrix.length > 0) {
    notes.push(
      `engine-wide constants live in ${matrix.join(", ")}: if one changed, run the full matrix (Tier 3) instead`,
    );
  }
  if (paths.includes("pnpm-lock.yaml"))
    notes.push(
      "a three, troika, drei, r3f or postprocessing bump moves hashes everywhere: run the full matrix",
    );
  // Tier 2: a shared seam verifies every leg ×2 (docs/decisions.md "The gate").
  const twice = renderFiles.some((p) => any(SEAM, p));
  if (twice) notes.push("shared render seam changed: every leg verifies ×2");
  return { files, legs, actions, notes, twice, statics: statics(paths, opts) };
}

// Narrower than ci-scope.sh on purpose: data folders (themes, assets, presets) rarely break these, and CI runs both.
const LOCAL_RUST =
  /^(src-tauri\/(src|tests|templates|build\.rs|Cargo\.(toml|lock)|tauri\.conf\.json)|\.agents\/|\.cargo\/)/;
const LOCAL_KIT = /^(\.agents\/|src-tauri\/templates\/|scripts\/test-kit\.mjs$)/;

/** The Tier 0 checks this diff needs; CI reruns all of them on push. */
export function statics(paths, { depsChanged = true } = {}) {
  const has = (re) => paths.some((p) => re.test(p));
  const config =
    has(/^(pnpm-lock\.yaml|vite\.config\.ts|tsconfig[\w.]*\.json)$/) ||
    (depsChanged && has(/^package\.json$/));
  const src = paths.filter((p) => /^src\/.*\.(ts|tsx|json)$/.test(p));
  // The agentKit tests pin the kit's generated catalogue and vectors against the TypeScript.
  const dirs = has(/^\.agents\//) ? ["src/agentKit"] : [];
  return {
    lint: paths.length > 0,
    build: config || src.length > 0 || has(/^src-tauri\/tauri\.conf\.json$/),
    vitest: config ? "all" : src.length + dirs.length > 0 ? { related: src, dirs } : null,
    scripts: has(/^scripts\//),
    kit: has(LOCAL_KIT),
    rust: has(LOCAL_RUST),
  };
}

const DETERMINISM = join(ROOT, "docs", "determinism.md");

/** The nth run of table lines under "### Current baselines" (0 = video, 1 = stills). */
function baselineTable(markdown, nth) {
  const all = (markdown.split(/^### Current baselines$/m)[1] ?? "").split(/^## /m)[0].split("\n");
  const tables = [];
  let current = [];
  for (const line of [...all, ""]) {
    if (line.startsWith("|")) current.push(line);
    else if (current.length > 0) {
      tables.push(current);
      current = [];
    }
  }
  return tables[nth] ?? [];
}

const cellsOf = (line) =>
  line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());

/** Stills baselines: {project: {pdf|png: pagesHash}}. */
export function readStillsBaselines(markdown = readFileSync(DETERMINISM, "utf8")) {
  const baselines = {};
  for (const line of baselineTable(markdown, 1).slice(2)) {
    const [name, format, , pages] = cellsOf(line);
    const project = name?.match(/^`([^`]+)`/)?.[1];
    const hash = pages?.match(/^`([0-9a-f]{64})`$/)?.[1];
    if (!project || !hash) continue;
    baselines[project] = {
      ...baselines[project],
      [format.startsWith("PNG") ? "png" : "pdf"]: hash,
    };
  }
  return baselines;
}

/** Video baselines from docs/determinism.md's "Current baselines" table: {project: {aspect: hashPrefix}}. */
export function readBaselines(markdown = readFileSync(DETERMINISM, "utf8")) {
  const lines = baselineTable(markdown, 0);
  const header = lines.length > 0 ? cellsOf(lines[0]).slice(1) : [];
  const baselines = {};
  for (const line of lines.slice(2)) {
    const cells = cellsOf(line);
    const project = cells[0]?.match(/^`([^`]+)`/)?.[1];
    if (!project) continue;
    const row = {};
    header.forEach((aspect, i) => {
      const hash = cells[i + 1]?.match(/^`([0-9a-f]{8,64})…?`$/)?.[1];
      if (hash) row[aspect] = hash;
    });
    if (Object.keys(row).length > 0) baselines[project] = row;
  }
  return baselines;
}
