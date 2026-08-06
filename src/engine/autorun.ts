import { invoke } from "@tauri-apps/api/core";
import { findBundledPreset } from "../export/presetRegistry";
import {
  type EncodeSpec,
  type ExportPresetDoc,
  parseExportPreset,
  resolvePresetToEncodeSpec,
} from "../export/presetSchema";
import { useEditorStore } from "../store/editorStore";
import { THEME_LINEUP } from "../theme/registry";
import { preloadBundledBackdrops } from "../toolkit/stage/backdrops";
import { releaseCompositorPools } from "./compositor";
import { releaseComposer } from "./effects";
import { collectEnvironmentSources, preloadEnvironments } from "./environments";
import { canvasHandle } from "./exportBridge";
import {
  awaitSceneHostsCommitted,
  type Codec,
  captureScreenshot,
  type ExportProgress,
  exportProject,
  type FrameDelta,
  verifyDeterminism,
} from "./exporter";
import { type AspectName, FORMATS, type FormatSpec, FPS, STANDING_ASPECTS } from "./format";
import { captureOptionPreviews, optionPreviewSetsOf } from "./optionPreviews";
import { runPackRoundTrip } from "./packRoundTrip";
import { runPerfProbe } from "./perfProbe";
import { type LoadedProject, loadProject, previewLabProjectIds, sceneFileStem } from "./project";
import type { RenderStateFingerprint } from "./renderFingerprint";
import {
  awaitProjectCommitted,
  captureThemePreviewFrames,
  THEME_PREVIEW_PROJECT_ID,
  writeThemePreviews,
} from "./themePreviews";
import { createProject } from "./workspace";

/** Headless auto-run: `pnpm kookaburra:run` sets `KOOKABURRA_*` env vars read via native `get_autorun_config` (process env, not `import.meta.env`, which is baked at build time and unreadable in a packaged app); drives the store then calls the same `verifyDeterminism`/`exportProject` the UI buttons call, so it never bypasses the real WebGL/ffmpeg export path. See docs/determinism.md. */

export type AutoRunAction =
  | "verify"
  | "export"
  | "theme-previews"
  | "option-previews"
  | "perf"
  | "screenshot"
  | "packroundtrip"
  | "create";

export interface AutoRunConfig {
  action: AutoRunAction;
  /** First project of the run: the one App boots into (falls back to the store default when unset). */
  project: string;
  /** Every project of the run, in order (KOOKABURRA_PROJECT accepts a comma list so the gate pair shares one app boot). */
  projects: string[];
  /** Aspects to run: an explicit one, or every format. */
  aspects: FormatSpec[];
  encode?: EncodeSpec;
  loudnessTarget?: number;
  codec: Codec;
  /** Output filename suffix: the preset id (`ws:` prefix stripped) or "custom" for --encode-json. Absent means the legacy name. */
  outputSuffix?: string;
  /** screenshot: scene selector (index or file stem); absent means project-global time. */
  scene?: string;
  /** screenshot: seconds into the scene (or the project when no scene is given). */
  atSeconds?: number;
  /** option-previews: stale set names to capture (from the wrapper's manifest diff); absent = every set (`--all`). */
  sets?: string[];
}

/** A single aspect's outcome: determinism digests (verify) or the output path (export). */
interface AutoRunResult {
  aspect: string;
  /** Which project this row belongs to (multi-project runs verify several in one boot). */
  project?: string;
  /** theme-previews: which theme this row's preview set belongs to. */
  theme?: string;
  identical?: boolean;
  hashA?: string;
  hashB?: string;
  /** Verify failure diagnostics, present only when not identical. */
  divergentCount?: number;
  divergentRanges?: [number, number][];
  divergentTiles?: { frame: number; tiles: number[] }[];
  boundMismatches?: [number, number, number][];
  frameDeltas?: FrameDelta[];
  /** Render-state snapshot from verify's pass A; always present on verify rows, diffing it across builds/machines localizes hash divergence to a named value. */
  fingerprint?: RenderStateFingerprint;
  path?: string;
  /** create: slot count of the created project after a full load-and-commit. */
  scenes?: number;
  /** perf rows: one per scene × elimination pass (see engine/perfProbe.ts). */
  scene?: string;
  pass?: string;
  frames?: number;
  avgFps?: number;
  avgMs?: number;
  p95Ms?: number;
  maxMs?: number;
  drawCalls?: number;
  triangles?: number;
  texturesInMemory?: number;
}

/** The full run payload serialised to `~/Kookaburra Cut/_autorun/last-run.json`. */
interface AutoRunReport {
  action: AutoRunAction;
  project: string;
  codec: Codec;
  ok: boolean;
  durationMs: number;
  results: AutoRunResult[];
  /** packroundtrip only: the two legs' hashes and whether they matched. */
  roundTrip?: {
    packPath: string;
    packBytes: number;
    itemCount: number;
    importedProjectId: string;
    sourceHash?: string;
    importedHash?: string;
    equal: boolean;
  };
  error?: string;
}

function parseAspects(raw: string | undefined): FormatSpec[] {
  const value = (raw ?? "all").trim();
  // "all" = the STANDING matrix (16:9, 9:16, 1:1); 4:5 / 5:4 / 3:2 / 2:3 are first-class but their gates stay feature-scoped, so they must be requested explicitly.
  if (value === "" || value === "all") return STANDING_ASPECTS.map((a) => FORMATS[a]);
  const spec = FORMATS[value as AspectName];
  if (!spec) {
    throw new Error(
      `unknown KOOKABURRA_ASPECT "${value}" (expected 16:9 | 9:16 | 1:1 | 4:5 | 5:4 | 3:2 | 2:3 | all)`,
    );
  }
  return [spec];
}

function parseCodec(raw: string | undefined): Codec {
  const value = (raw ?? "libx264").trim();
  if (value !== "libx264" && value !== "h264_videotoolbox" && value !== "prores_ks") {
    throw new Error(
      `unknown KOOKABURRA_CODEC "${value}" (expected libx264 | h264_videotoolbox | prores_ks)`,
    );
  }
  return value;
}

/** The native env read, as `get_autorun_config` returns it (unset values are null). */
interface AutoRunEnv {
  action: string | null;
  project: string | null;
  aspect: string | null;
  codec: string | null;
  preset: string | null;
  encodeJson: string | null;
  scene: string | null;
  at: string | null;
  sets: string | null;
}

let autoRunEnv: AutoRunEnv | null = null;
/** A `ws:` preset doc prefetched by `initAutoRunConfig` (the listing command is async; every consumer reads `getAutoRunConfig()` synchronously). */
let wsPresetDoc: ExportPresetDoc | null = null;

/** Prefetches the auto-run env once, before React renders; every consumer reads `getAutoRunConfig()` synchronously during mount. Failures read as "interactive" (never throws), since nothing could report a result if IPC is down anyway. */
export async function initAutoRunConfig(): Promise<void> {
  if (autoRunEnv) return;
  try {
    autoRunEnv = await invoke<AutoRunEnv>("get_autorun_config");
    // User presets: `--preset ws:<slug>` resolves through the workspace registry; prefetch the doc here so getAutoRunConfig stays synchronous.
    const presetId = autoRunEnv.preset?.trim();
    if (presetId?.startsWith("ws:")) {
      const slug = presetId.slice(3);
      const listings = await invoke<{ slug: string; json: string }[]>("list_export_presets");
      const hit = listings.find((l) => l.slug === slug);
      if (hit) wsPresetDoc = parseExportPreset(JSON.parse(hit.json), presetId) ?? null;
    }
  } catch (e) {
    console.warn("[autorun] get_autorun_config failed — treating as interactive:", e);
    autoRunEnv = {
      action: null,
      project: null,
      aspect: null,
      codec: null,
      preset: null,
      encodeJson: null,
      scene: null,
      at: null,
      sets: null,
    };
  }
}

/** Reads the prefetched auto-run intent; returns `null` when unset so the app stays fully interactive under a normal launch, and throws on a malformed action/aspect/codec so the wrapper surfaces the mistake immediately. */
export function getAutoRunConfig(): AutoRunConfig | null {
  const env = autoRunEnv;
  const action = env?.action?.trim();
  if (!env || !action) return null;
  if (
    action !== "verify" &&
    action !== "export" &&
    action !== "theme-previews" &&
    action !== "option-previews" &&
    action !== "perf" &&
    action !== "screenshot" &&
    action !== "packroundtrip" &&
    action !== "create"
  ) {
    throw new Error(
      `unknown KOOKABURRA_ACTION "${action}" (expected verify | export | theme-previews | option-previews | perf | screenshot | packroundtrip | create)`,
    );
  }
  const at = env.at?.trim();
  const atSeconds = at ? Number(at) : undefined;
  if (at && !Number.isFinite(atSeconds)) {
    throw new Error(`invalid KOOKABURRA_AT "${at}" (expected seconds)`);
  }
  // The encode spec: --preset resolves through the bundled registry; --encode-json carries the spec inline (the wrapper cats the file, no fs scopes).
  let encode: EncodeSpec | undefined;
  let preset: ExportPresetDoc | undefined;
  let outputSuffix: string | undefined;
  const presetId = env.preset?.trim();
  if (presetId) {
    preset = presetId.startsWith("ws:") ? (wsPresetDoc ?? undefined) : findBundledPreset(presetId);
    if (!preset) throw new Error(`unknown KOOKABURRA_PRESET "${presetId}"`);
    encode = resolvePresetToEncodeSpec(preset);
    outputSuffix = presetId.startsWith("ws:") ? presetId.slice(3) : presetId;
  } else if (env.encodeJson?.trim()) {
    encode = JSON.parse(env.encodeJson) as EncodeSpec;
    outputSuffix = "custom";
  }
  // The preview batches render their dedicated projects unless one is forced.
  const projects = (
    env.project?.trim() ||
    (action === "theme-previews"
      ? THEME_PREVIEW_PROJECT_ID
      : action === "option-previews"
        ? (previewLabProjectIds()[0] ?? "preview-lab-text")
        : useEditorStore.getState().projectId)
  )
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (projects.length > 1 && action !== "verify" && action !== "export") {
    throw new Error(
      `KOOKABURRA_PROJECT lists ${projects.length} projects; only verify and export accept a list`,
    );
  }
  return {
    action,
    project: projects[0],
    projects,
    // --preset without --aspect exports the preset's favoured aspect; perf and screenshot default to one 16:9 pass.
    aspects:
      preset && !env.aspect?.trim()
        ? [FORMATS[preset.favouredAspect]]
        : (action === "perf" || action === "screenshot") && !env.aspect?.trim()
          ? [FORMATS["16:9"]]
          : parseAspects(env.aspect ?? undefined),
    codec: parseCodec(env.codec ?? undefined),
    encode,
    loudnessTarget: preset?.audio.loudnessTarget,
    outputSuffix,
    scene: env.scene?.trim() || undefined,
    atSeconds,
    sets: env.sets?.trim()
      ? env.sets
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  };
}

/** Yields two macrotask hops for a store change to commit into the scene tree; deliberately setTimeout-based not requestAnimationFrame, since WKWebView suspends rAF while occluded or asleep (the normal state of an AFK `kookaburra:run`), which used to stall the whole run before the first export. */
function nextCommit(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => setTimeout(resolve, 0), 0);
  });
}

type FinishPayload = AutoRunReport | { ok: false; error: string };

let finished = false;
/** Hands a result to native `finish_autorun` exactly once per process (it persists JSON and exits with a pass/fail code); idempotent so a config/load error, a later run, or a StrictMode re-invoke can't double-fire. */
async function finish(payload: FinishPayload): Promise<void> {
  if (finished) return;
  finished = true;
  await invoke("finish_autorun", {
    resultJson: JSON.stringify(payload, null, 2),
    ok: payload.ok,
  });
}

/** Reports a fatal auto-run error to the wrapper instead of hanging until timeout; a no-op unless an auto-run was actually requested, since `finish_autorun` exits the process and an interactive session must never be closed by an unhandled rejection. */
export function reportAutoRunError(error: unknown): void {
  void (async () => {
    await initAutoRunConfig();
    if (!autoRunEnv?.action?.trim()) return;
    await finish({ ok: false, error: String(error) });
  })().catch(() => {});
}

/** Drives a full auto-run: for each aspect, sets the store format so scenes lay out correctly (the in-app Verify button only resizes the drawing buffer), lets React commit, then runs the same verify/export the button runs; `applyProject` swaps a freshly-loaded project into the canvas exactly as the App's loader effect does. */
/** `--scene` picks a slot (midpoint default); `--at` is seconds into it, or into the project without one; absent both = project start. Shared by the autorun screenshot action and the capture bridge, so both resolve identically. */
export function resolveScreenshotTimeMs(
  project: Pick<LoadedProject, "slots" | "sceneFiles" | "totalMs">,
  scene: string | undefined,
  atSeconds: number | undefined,
  fallbackMs?: number,
): number {
  if (scene !== undefined) {
    const idx = /^\d+$/.test(scene)
      ? Number(scene)
      : project.sceneFiles.findIndex((f) => sceneFileStem(f) === scene);
    const slot = project.slots[idx];
    if (!slot) {
      throw new Error(
        `unknown scene "${scene}" (expected a scene index 0-${project.slots.length - 1} or file stem)`,
      );
    }
    const local = atSeconds !== undefined ? atSeconds * 1000 : slot.durationMs / 2;
    return slot.startMs + Math.min(Math.max(0, local), Math.max(0, slot.durationMs - 1));
  }
  const t = atSeconds !== undefined ? atSeconds * 1000 : (fallbackMs ?? 0);
  return Math.min(Math.max(0, t), Math.max(0, project.totalMs - 1));
}

export async function runAutoRun(
  project: LoadedProject,
  config: AutoRunConfig,
  applyProject?: (loaded: LoadedProject) => void,
): Promise<void> {
  const startedAt = performance.now();
  const results: AutoRunResult[] = [];
  let ok = true;
  let error: string | undefined;

  // Reload latch: WebKit kills the WebContent process when the page footprint nears its 4 GB ceiling (a 4K verify rides just under it), and wry auto-reloads the page, silently restarting the run in a loop until the wrapper times out. sessionStorage survives the reload, so tolerate one benign restart (a cold-cache Vite re-optimization) and fail fast on the second.
  const restarts = Number(sessionStorage.getItem("kookaburra-autorun-restarts") ?? "0");
  sessionStorage.setItem("kookaburra-autorun-restarts", String(restarts + 1));
  if (restarts > 1) {
    await finish({
      ok: false,
      error:
        "the page reloaded twice mid-run (WebKit likely killed the WebContent process near its 4 GB footprint ceiling; see _autorun/dev.log and docs/determinism.md)",
    });
    return;
  }

  // Boot latch: a Vite dep re-optimization can hard-reload the page mid-run, orphaning the ffmpeg child and leaving native export state busy, so clear any stale export before starting or a re-fired autorun dies as "already in progress".
  await invoke("cancel_export").catch(() => {});

  const onProgress = (p: ExportProgress) => {
    // console.warn not log: only warn/error forward into the wrapper's dev.log, and these breadcrumbs are how a stalled AFK run (or a WebContent footprint kill) gets localized post-hoc.
    if (p.frame % 120 === 0 || p.frame === p.total)
      console.warn(`[autorun] frame ${p.frame}/${p.total}`);
  };

  if (config.action === "option-previews") {
    // Iterates the dev-only preview-lab projects (one per option-preview family) and captures picker preview sets off the preview canvas using a borrowed clock; `config.sets` (the wrapper's manifest diff) limits capture to stale sets, and lab projects owning none are never mounted. Frames go native and the wrapper encodes/copies them into src/assets/option-previews/.
    try {
      if (!applyProject) throw new Error("option-previews needs the applyProject hook");
      useEditorStore.getState().setFormat(FORMATS["16:9"]);
      await nextCommit();
      await preloadBundledBackdrops();
      const only = config.sets ? new Set(config.sets) : null;
      let total = 0;
      for (const labId of previewLabProjectIds()) {
        const loaded = await loadProject(labId);
        if (only && !optionPreviewSetsOf(loaded).some((s) => only.has(s))) continue;
        applyProject(loaded);
        await nextCommit();
        await awaitProjectCommitted(loaded);
        await awaitSceneHostsCommitted(loaded.slots.length);
        const sets = await captureOptionPreviews(loaded, only ?? undefined);
        if (sets === null) throw new Error("option-previews: capture unavailable");
        total += sets;
      }
      results.push({ aspect: "16:9", path: `option-previews (${total} sets)` });
    } catch (e) {
      ok = false;
      error = String(e);
    }
    await finish({
      action: config.action,
      project: config.project,
      codec: config.codec,
      ok,
      durationMs: Math.round(performance.now() - startedAt),
      results,
      ...(error ? { error } : {}),
    });
    return;
  }

  if (config.action === "theme-previews") {
    // Loads the starter under each lineup theme, captures the 4 scene middles off the preview canvas (borrowed clock, never the export loop), and hands the JPEGs to the native side for the wrapper to copy into src/assets/theme-previews/; one fixed 16:9 pass.
    try {
      if (!applyProject) throw new Error("theme-previews needs the applyProject hook");
      useEditorStore.getState().setFormat(FORMATS["16:9"]);
      await nextCommit();
      // A theme switch must never suspend on a bundled backdrop mid-batch, since an update-suspension keeps the previous theme's tree on screen and the capture reads it (the loft-1 stale-preview bug).
      await preloadBundledBackdrops();
      for (const themeId of THEME_LINEUP) {
        console.warn(`[autorun] theme-previews ${themeId} starting`);
        const loaded = await loadProject(config.project, { themeId });
        // The theme's PMREM environment resolves BEFORE the swap (the preloadBundledBackdrops rationale): headless windows never fire rAF, so a texture landing after the swap would otherwise stay unpainted into the first capture.
        const gl = canvasHandle.current?.gl;
        if (gl) {
          await preloadEnvironments(
            gl,
            collectEnvironmentSources(
              loaded.id,
              [loaded.theme, ...loaded.sceneThemes],
              loaded.projectLighting,
              loaded.sceneDocs,
            ),
          ).catch((e) => console.warn(`[autorun] environment preload failed for ${themeId}:`, e));
        }
        applyProject(loaded);
        await nextCommit();
        // Two commit barriers: the project swap itself (concurrent-lane; without this the first capture reads the previous theme) then a cold-mount wait so the scenes are actually in the canvas.
        await awaitProjectCommitted(loaded);
        await awaitSceneHostsCommitted(loaded.slots.length);
        const frames = await captureThemePreviewFrames(loaded);
        if (!frames) throw new Error(`theme-previews: capture unavailable for ${themeId}`);
        await writeThemePreviews("autorun", themeId, frames);
        results.push({ aspect: "16:9", theme: themeId, path: `theme-previews/${themeId}` });
      }
    } catch (e) {
      ok = false;
      error = String(e);
    }
    await finish({
      action: config.action,
      project: config.project,
      codec: config.codec,
      ok,
      durationMs: Math.round(performance.now() - startedAt),
      results,
      ...(error ? { error } : {}),
    });
    return;
  }

  if (config.action === "perf") {
    // Plays a window of every scene under elimination passes (baseline, dpr-1, no-shadows, no-transmission, frozen-media, no-devices); needs a visible window since WKWebView suspends rAF when occluded.
    try {
      const format = config.aspects[0];
      useEditorStore.getState().setFormat(format);
      await nextCommit();
      await awaitSceneHostsCommitted(project.slots.length);
      const rows = await runPerfProbe(project);
      for (const row of rows) results.push({ aspect: format.name, ...row });
    } catch (e) {
      ok = false;
      error = String(e);
    }
    await finish({
      action: config.action,
      project: config.project,
      codec: config.codec,
      ok,
      durationMs: Math.round(performance.now() - startedAt),
      results,
      ...(error ? { error } : {}),
    });
    return;
  }

  if (config.action === "screenshot") {
    // One deterministic frame via the export path, written as a PNG under _autorun/.
    try {
      const format = config.aspects[0];
      useEditorStore.getState().setFormat(format);
      await nextCommit();
      const tMs = resolveScreenshotTimeMs(project, config.scene, config.atSeconds);
      const name = `screenshot-${project.id.replace(/^ws:/, "")}-${Math.round(tMs)}ms-${format.name.replace(":", "x")}`;
      const path = await captureScreenshot(
        {
          projectId: project.id,
          fps: FPS,
          durationMs: project.totalMs,
          slots: project.slots,
          cameraTrack: project.cameraTrack,
          sceneDocs: project.sceneDocs,
          theme: project.theme,
          sceneThemes: project.sceneThemes,
          projectLighting: project.projectLighting,
          sceneFrames: project.sceneFrames,
          compareBDocs: project.compareBDocs,
          compareBThemes: project.compareBThemes,
          codec: config.codec,
          format,
        },
        tMs,
        name,
      );
      results.push({ aspect: format.name, path });
    } catch (e) {
      ok = false;
      error = String(e);
    }
    await finish({
      action: config.action,
      project: config.project,
      codec: config.codec,
      ok,
      durationMs: Math.round(performance.now() - startedAt),
      results,
      ...(error ? { error } : {}),
    });
    return;
  }

  if (config.action === "create") {
    // The create smoke: the same native create_project the dialog calls, then a full load-and-commit so a missing scene, seeded asset or theme fails here, not in a user's hands. Works packaged via --app, where templates_root() takes the resource_dir() branch.
    try {
      const templateId = config.projects[0];
      if (!applyProject) throw new Error("the create action needs the applyProject hook");
      const info = await createProject(`Create smoke ${templateId}`, templateId, null);
      releaseCompositorPools();
      releaseComposer();
      const created = await loadProject(`ws:${info.slug}`);
      applyProject(created);
      await nextCommit();
      await awaitProjectCommitted(created);
      await awaitSceneHostsCommitted(created.slots.length);
      results.push({
        aspect: config.aspects[0]?.name ?? "16:9",
        project: created.id,
        path: info.path,
        scenes: created.slots.length,
      });
    } catch (e) {
      ok = false;
      error = String(e);
    }
    await finish({
      action: config.action,
      project: config.project,
      codec: config.codec,
      ok,
      durationMs: Math.round(performance.now() - startedAt),
      results,
      ...(error ? { error } : {}),
    });
    return;
  }

  // The round trip packs the first project and imports it back under a new slug, then verifies BOTH legs and demands
  // the same hash. Building the second leg here means the loop below needs no round-trip knowledge at all.
  let roundTrip: Awaited<ReturnType<typeof runPackRoundTrip>> | undefined;
  if (config.action === "packroundtrip") {
    try {
      roundTrip = await runPackRoundTrip(config.projects[0]);
      console.warn(
        `[autorun] packed ${config.projects[0]} -> ${roundTrip.packPath} (${roundTrip.itemCount} items, ${roundTrip.packBytes} bytes), re-imported as ${roundTrip.importedProjectId}`,
      );
      config = { ...config, projects: [config.projects[0], roundTrip.importedProjectId] };
    } catch (e) {
      await finish({
        action: config.action,
        project: config.projects.join(","),
        codec: config.codec,
        ok: false,
        durationMs: Math.round(performance.now() - startedAt),
        results: [],
        error: `pack round trip failed before rendering: ${String(e)}`,
      });
      return;
    }
  }

  try {
    // The first project arrives loaded and committed by App's boot effect; later list entries swap in mid-run through the same load/apply/commit barriers the theme-previews batch uses.
    let current = project;
    for (const [index, projectId] of config.projects.entries()) {
      if (index > 0) {
        if (!applyProject) throw new Error("a multi-project run needs the applyProject hook");
        // One WebContent process hosts every leg, so the previous project's render-target pools and composer must not stack onto this leg's footprint (WebKit kills the process near 4 GB).
        releaseCompositorPools();
        releaseComposer();
        console.warn(`[autorun] loading "${projectId}"`);
        current = await loadProject(projectId);
        applyProject(current);
        await nextCommit();
        await awaitProjectCommitted(current);
        await awaitSceneHostsCommitted(current.slots.length);
      }
      for (const format of config.aspects) {
        console.warn(`[autorun] ${config.action} ${current.id} ${format.name} starting`);
        useEditorStore.getState().setFormat(format);
        await nextCommit();
        console.warn(`[autorun] ${format.name} format committed`);
        // Loudness is gain-only: measured through the exact export graph (cached native-side) and summed into the spec's volume slot.
        let encode = config.encode;
        // Renders at the output rate: a 30fps spec steps the clock at 30 directly, so the export graph's frame count is computed at outFps too.
        const outFps = encode?.fps ?? FPS;
        if (encode && config.loudnessTarget !== undefined && current.audio) {
          const outFrames = Math.max(1, Math.round((current.totalMs / 1000) * outFps));
          const measured = await invoke<{ integratedLufs: number; truePeakDbtp: number }>(
            "measure_loudness",
            {
              file: current.audio.abs,
              gainDb: current.audio.gainDb ?? 0,
              fadeInMs: current.audio.fadeInMs ?? 0,
              fadeOutMs: current.audio.fadeOutMs ?? 0,
              startOffsetMs: current.audio.startOffsetMs ?? 0,
              totalFrames: outFrames,
              fps: outFps,
            },
          );
          const delta = Math.round((config.loudnessTarget - measured.integratedLufs) * 100) / 100;
          if (measured.truePeakDbtp + delta > -1.5) {
            console.warn(
              `[autorun] loudness: projected true peak ${(measured.truePeakDbtp + delta).toFixed(1)} dBTP exceeds −1.5 — export proceeds (gain-only, never limited)`,
            );
          }
          encode = {
            ...encode,
            audio: { ...(encode.audio ?? { codec: { aacKbps: 192 } }), loudnessGainDb: delta },
          };
        }
        const base = {
          projectId: current.id,
          fps: outFps,
          durationMs: current.totalMs,
          slots: current.slots,
          cameraTrack: current.cameraTrack,
          sceneDocs: current.sceneDocs,
          theme: current.theme,
          sceneThemes: current.sceneThemes,
          projectLighting: current.projectLighting,
          sceneFrames: current.sceneFrames,
          compareBDocs: current.compareBDocs,
          compareBThemes: current.compareBThemes,
          audio: current.audio,
          codec: config.codec,
          encode,
          outputSuffix: config.outputSuffix,
          format,
        };
        // GPU-residency breadcrumb: three's texture/geometry/program counts localize footprint growth to a leg without a debugger attached.
        const glInfo = canvasHandle.current?.gl.info;
        if (glInfo) {
          console.warn(
            `[autorun] gl memory before ${current.id} ${format.name}: geometries ${glInfo.memory.geometries} textures ${glInfo.memory.textures} programs ${glInfo.programs?.length ?? 0}`,
          );
        }
        if (config.action === "verify" || config.action === "packroundtrip") {
          const r = await verifyDeterminism(base, onProgress);
          results.push({
            aspect: format.name,
            project: current.id,
            identical: r.identical,
            hashA: r.hashA,
            hashB: r.hashB,
            fingerprint: r.fingerprint,
            ...(r.divergentCount !== undefined
              ? {
                  divergentCount: r.divergentCount,
                  divergentRanges: r.divergentRanges,
                  divergentTiles: r.divergentTiles,
                  boundMismatches: r.boundMismatches,
                  frameDeltas: r.frameDeltas,
                }
              : {}),
          });
          if (!r.identical) ok = false;
        } else {
          const path = await exportProject(base, onProgress);
          results.push({ aspect: format.name, project: current.id, path });
        }
        if (glInfo) {
          console.warn(
            `[autorun] gl memory after ${current.id} ${format.name}: geometries ${glInfo.memory.geometries} textures ${glInfo.memory.textures} programs ${glInfo.programs?.length ?? 0}`,
          );
        }
      }
    }
  } catch (e) {
    ok = false;
    error = String(e);
  }

  // The whole point of the round trip: the re-imported copy must render byte-identically to the original.
  let roundTripSummary: AutoRunReport["roundTrip"];
  if (config.action === "packroundtrip" && roundTrip) {
    const source = results.find((r) => r.project === config.projects[0]);
    const imported = results.find((r) => r.project === roundTrip.importedProjectId);
    const equal = Boolean(source?.hashA && imported?.hashA && source.hashA === imported.hashA);
    roundTripSummary = {
      packPath: roundTrip.packPath,
      packBytes: roundTrip.packBytes,
      itemCount: roundTrip.itemCount,
      importedProjectId: roundTrip.importedProjectId,
      sourceHash: source?.hashA,
      importedHash: imported?.hashA,
      equal,
    };
    if (!equal) {
      ok = false;
      error ??= `pack round trip: the re-imported copy rendered differently (source ${source?.hashA ?? "?"}, imported ${imported?.hashA ?? "?"}). Check path-independence first: duplicate the project to a new slug and verify both.`;
    }
  }

  const report: AutoRunReport = {
    action: config.action,
    project: config.projects.join(","),
    codec: config.codec,
    ok,
    durationMs: Math.round(performance.now() - startedAt),
    results,
    ...(roundTripSummary ? { roundTrip: roundTripSummary } : {}),
    ...(error ? { error } : {}),
  };

  await finish(report);
}
