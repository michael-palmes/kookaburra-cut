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
import { preloadEnvironments } from "./environments";
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
import { captureOptionPreviews } from "./optionPreviews";
import { runPerfProbe } from "./perfProbe";
import { type LoadedProject, loadProject, sceneFileStem } from "./project";
import type { RenderStateFingerprint } from "./renderFingerprint";
import {
  awaitProjectCommitted,
  captureThemePreviewFrames,
  writeThemePreviews,
} from "./themePreviews";

/** Headless auto-run: `pnpm kookaburra:run` sets `KOOKABURRA_*` env vars read via native `get_autorun_config` (process env, not `import.meta.env`, which is baked at build time and unreadable in a packaged app); drives the store then calls the same `verifyDeterminism`/`exportProject` the UI buttons call, so it never bypasses the real WebGL/ffmpeg export path. See docs/determinism.md. */

export type AutoRunAction =
  | "verify"
  | "export"
  | "theme-previews"
  | "option-previews"
  | "perf"
  | "screenshot";

export interface AutoRunConfig {
  action: AutoRunAction;
  /** Project id to load and run (falls back to the store default when unset). */
  project: string;
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
}

/** A single aspect's outcome: determinism digests (verify) or the output path (export). */
interface AutoRunResult {
  aspect: string;
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
  error?: string;
}

function parseAspects(raw: string | undefined): FormatSpec[] {
  const value = (raw ?? "all").trim();
  // "all" = the STANDING matrix (16:9, 9:16, 1:1); 4:5 is first-class but its gates stay feature-scoped, so it must be requested explicitly.
  if (value === "" || value === "all") return STANDING_ASPECTS.map((a) => FORMATS[a]);
  const spec = FORMATS[value as AspectName];
  if (!spec) {
    throw new Error(
      `unknown KOOKABURRA_ASPECT "${value}" (expected 16:9 | 9:16 | 1:1 | 4:5 | all)`,
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
    action !== "screenshot"
  ) {
    throw new Error(
      `unknown KOOKABURRA_ACTION "${action}" (expected verify | export | theme-previews | option-previews | perf | screenshot)`,
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
  return {
    action,
    // The preview batches render their dedicated projects unless one is forced.
    project:
      env.project?.trim() ||
      (action === "theme-previews"
        ? "theme-starter"
        : action === "option-previews"
          ? "preview-lab"
          : useEditorStore.getState().projectId),
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
export async function runAutoRun(
  project: LoadedProject,
  config: AutoRunConfig,
  applyProject?: (loaded: LoadedProject) => void,
): Promise<void> {
  const startedAt = performance.now();
  const results: AutoRunResult[] = [];
  let ok = true;
  let error: string | undefined;

  // Boot latch: a Vite dep re-optimization can hard-reload the page mid-run, orphaning the ffmpeg child and leaving native export state busy, so clear any stale export before starting or a re-fired autorun dies as "already in progress".
  await invoke("cancel_export").catch(() => {});

  const onProgress = (p: ExportProgress) => {
    // console.warn not log: only warn/error forward into the wrapper's dev.log, and these breadcrumbs are how a stalled AFK run gets diagnosed post-hoc.
    if (p.frame === p.total) console.warn(`[autorun] frame ${p.frame}/${p.total}`);
  };

  if (config.action === "option-previews") {
    // Loads the dev-only preview-lab project and captures picker preview sets (text-motion clips, shadow/stage stills) off the preview canvas using a borrowed clock; frames go native and the wrapper encodes/copies them into src/assets/option-previews/.
    try {
      if (!applyProject) throw new Error("option-previews needs the applyProject hook");
      useEditorStore.getState().setFormat(FORMATS["16:9"]);
      await nextCommit();
      await preloadBundledBackdrops();
      const loaded = await loadProject(config.project);
      applyProject(loaded);
      await nextCommit();
      await awaitProjectCommitted(loaded);
      await awaitSceneHostsCommitted(loaded.slots.length);
      const sets = await captureOptionPreviews(loaded);
      if (sets === null) throw new Error("option-previews: capture unavailable");
      results.push({ aspect: "16:9", path: `option-previews (${sets} sets)` });
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
          await preloadEnvironments(gl, [loaded.theme, ...loaded.sceneThemes]).catch((e) =>
            console.warn(`[autorun] environment preload failed for ${themeId}:`, e),
          );
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
      // --scene picks a slot (midpoint default); --at is seconds into it, or into the project without one.
      let tMs: number;
      if (config.scene !== undefined) {
        const idx = /^\d+$/.test(config.scene)
          ? Number(config.scene)
          : project.sceneFiles.findIndex((f) => sceneFileStem(f) === config.scene);
        const slot = project.slots[idx];
        if (!slot) {
          throw new Error(
            `unknown KOOKABURRA_SCENE "${config.scene}" (expected a scene index 0-${project.slots.length - 1} or file stem)`,
          );
        }
        const local =
          config.atSeconds !== undefined ? config.atSeconds * 1000 : slot.durationMs / 2;
        tMs = slot.startMs + Math.min(Math.max(0, local), Math.max(0, slot.durationMs - 1));
      } else {
        const t = (config.atSeconds ?? 0) * 1000;
        tMs = Math.min(Math.max(0, t), Math.max(0, project.totalMs - 1));
      }
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
          sceneFrames: project.sceneFrames,
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

  try {
    for (const format of config.aspects) {
      console.warn(`[autorun] ${config.action} ${format.name} starting`);
      useEditorStore.getState().setFormat(format);
      await nextCommit();
      console.warn(`[autorun] ${format.name} format committed`);
      // Loudness is gain-only: measured through the exact export graph (cached native-side) and summed into the spec's volume slot.
      let encode = config.encode;
      // Renders at the output rate: a 30fps spec steps the clock at 30 directly, so the export graph's frame count is computed at outFps too.
      const outFps = encode?.fps ?? FPS;
      if (encode && config.loudnessTarget !== undefined && project.audio) {
        const outFrames = Math.max(1, Math.round((project.totalMs / 1000) * outFps));
        const measured = await invoke<{ integratedLufs: number; truePeakDbtp: number }>(
          "measure_loudness",
          {
            file: project.audio.abs,
            gainDb: project.audio.gainDb ?? 0,
            fadeInMs: project.audio.fadeInMs ?? 0,
            fadeOutMs: project.audio.fadeOutMs ?? 0,
            startOffsetMs: project.audio.startOffsetMs ?? 0,
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
        projectId: project.id,
        fps: outFps,
        durationMs: project.totalMs,
        slots: project.slots,
        cameraTrack: project.cameraTrack,
        sceneDocs: project.sceneDocs,
        theme: project.theme,
        sceneThemes: project.sceneThemes,
        sceneFrames: project.sceneFrames,
        audio: project.audio,
        codec: config.codec,
        encode,
        outputSuffix: config.outputSuffix,
        format,
      };
      if (config.action === "verify") {
        const r = await verifyDeterminism(base, onProgress);
        results.push({
          aspect: format.name,
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
        results.push({ aspect: format.name, path });
      }
    }
  } catch (e) {
    ok = false;
    error = String(e);
  }

  const report: AutoRunReport = {
    action: config.action,
    project: project.id,
    codec: config.codec,
    ok,
    durationMs: Math.round(performance.now() - startedAt),
    results,
    ...(error ? { error } : {}),
  };

  await finish(report);
}
