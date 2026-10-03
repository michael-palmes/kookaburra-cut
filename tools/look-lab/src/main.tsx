import { createRoot, extend, type RootStore } from "@react-three/fiber";
import type { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import * as THREE from "three";
import { useClockStore } from "../../../src/engine/clock";
import { FORMATS, SHADOW_MAP_TYPE } from "../../../src/engine/format";
import { ensureRectAreaLightUniforms } from "../../../src/engine/lightingState";
import { applyRenderSettings } from "../../../src/engine/RenderSettingsApplier";
import { DEFAULT_RENDER_SETTINGS } from "../../../src/engine/renderSettings";
import { useEditorStore } from "../../../src/store/editorStore";
import { builtinThemes, defaultTheme } from "../../../src/theme/registry";
import {
  SCENE3D_BACKGROUND_IDS,
  SCENE3D_BACKGROUND_PRESETS,
  SCENE3D_BACKGROUNDS,
} from "../../../src/toolkit/stage/scene3d";
import { scene3dPreviewCamera } from "../../../src/toolkit/stage/scene3d/previewCamera";
import { type LabJob, type LabPose, parseJob, previewAlias, resolveCam } from "./job";
import { type LabFrame, LabScene, type Scene3dSpec } from "./LabScene";
import { boxDownsample, composeSheet, type Diagnostic, motionTile, SheetBody } from "./sheet";

const job = parseJob(new URLSearchParams(location.search));
const statusEl = document.getElementById("status") as HTMLElement;

extend(THREE as unknown as Parameters<typeof extend>[0]);

const diagnostics = new Map<string, Diagnostic>();
// Library notices that say nothing about the look under test.
const NOISE = [/THREE\.Clock: This module has been deprecated/];

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function note(level: Diagnostic["level"], args: unknown[]) {
  let text = args.map(describe).join(" ").replace(/%c/g, "").trim();
  if (NOISE.some((re) => re.test(text))) return;
  const shader = text.includes("THREE.WebGLProgram: Shader Error");
  if (shader) {
    // Keep three's headline, the material, the stage and the compiler lines; drop the source context.
    text = text
      .split("\n")
      .filter((l) => /^\s*(THREE\.|Material Name|FRAGMENT|VERTEX|ERROR|WARNING|>)/.test(l))
      .map((l) => l.trim())
      .join("\n");
  }
  const key = `${level}:${(shader ? text.replace(/Shader Error \d+/, "") : text).slice(0, 400)}`;
  const seen = diagnostics.get(key);
  if (seen) seen.count++;
  else diagnostics.set(key, { level, text, count: 1 });
}

const consoleError = console.error.bind(console);
const consoleWarn = console.warn.bind(console);
console.error = (...args: unknown[]) => {
  note("error", args);
  consoleError(...args);
};
console.warn = (...args: unknown[]) => {
  note("warning", args);
  consoleWarn(...args);
};
addEventListener("error", (e) => note("error", [e.error ?? e.message]));
addEventListener("unhandledrejection", (e) => note("error", ["Unhandled rejection:", e.reason]));

async function post(path: string, body: BodyInit, type: string): Promise<void> {
  if (!job.post) return;
  await fetch(path, { method: "POST", body, headers: { "content-type": type } });
}

function progress(msg: string) {
  statusEl.textContent = msg;
  void post("/__lab/log", JSON.stringify({ msg }), "application/json").catch(() => {});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for every troika text mesh to finish its async layout (font fetch plus worker SDF). */
async function settleText(scene: Scene): Promise<void> {
  const deadline = performance.now() + 20_000;
  for (let quiet = 0; quiet < 2; ) {
    let busy = 0;
    scene.traverse((o) => {
      const t = o as unknown as {
        _needsSync?: boolean;
        _isSyncing?: boolean;
        textRenderInfo?: unknown;
        sync?: () => void;
      };
      if (!("_private_text" in o) || typeof t.sync !== "function") return;
      if (t._needsSync) t.sync();
      if (t._needsSync || t._isSyncing || !t.textRenderInfo) busy++;
    });
    if (performance.now() > deadline) {
      note("error", [`${busy} text mesh(es) never finished syncing`]);
      return;
    }
    quiet = busy ? 0 : quiet + 1;
    await sleep(busy ? 25 : 40);
  }
}

interface Row {
  /** `motion` rows render nothing: they diff the two time rows above them. */
  kind: "frame" | "motion";
  preset: string;
  name: string;
  mode: string;
  t: number;
  spec: Scene3dSpec;
  textColor: string;
}

function buildRows(j: LabJob): Row[] {
  const presets = SCENE3D_BACKGROUND_PRESETS[j.look] ?? [];
  const rows: Row[] = [];
  for (const id of j.presets) {
    const p = presets.find((x) => x.id === id);
    if (!p) {
      note("error", [`preset "${id}" not found for ${j.look} (has ${presets.map((x) => x.id)})`]);
      continue;
    }
    const motion = j.mode === "sheet" && !j.raw && j.times.length === 2;
    for (const [k, t] of (motion ? [...j.times, j.times[1]] : j.times).entries()) {
      rows.push({
        kind: motion && k === 2 ? "motion" : "frame",
        preset: p.id,
        name: p.name,
        mode: p.mode,
        t,
        textColor: p.textColor,
        spec: {
          type: "scene3d",
          look: j.look,
          colors: p.colors,
          speed: p.speed ?? 1,
          params: { ...p.params, ...j.params },
          backing: { type: "color", color: p.backing },
          preset: p.id,
        },
      });
    }
  }
  return rows;
}

async function run(): Promise<void> {
  const started = performance.now();
  progress("loaded");
  const def = SCENE3D_BACKGROUNDS[job.look];
  if (!def) {
    throw new Error(`Unknown look "${job.look}". Known: ${SCENE3D_BACKGROUND_IDS.join(", ")}`);
  }
  const rows = buildRows(job);
  if (rows.length === 0) throw new Error("No rows to render (check --presets)");
  // The picker still's pose, as scripts/gen-bg3d-preview-labs.ts picks it.
  const kind = scene3dPreviewCamera(def);
  const cams = job.cams
    .map((name) => previewAlias(name, kind))
    .map((name) => ({ name, pose: resolveCam(name) }));
  const tallName = job.tall ? previewAlias(job.tall, kind) : null;
  const tallPose = tallName ? resolveCam(tallName) : null;
  for (const c of [...cams, ...(tallName ? [{ name: tallName, pose: tallPose }] : [])]) {
    if (!c.pose) throw new Error(`Unknown camera "${c.name}" (named or orbit:az:el:dist[:y])`);
  }
  const theme = builtinThemes[job.theme] ?? defaultTheme;
  useEditorStore.getState().setTheme(theme);

  const wide = { width: job.width, height: Math.round((job.width * 9) / 16) };
  const tall = { width: Math.round((wide.height * 9) / 16), height: wide.height };

  const canvas = document.createElement("canvas");
  const root = createRoot(canvas);
  await root.configure({
    gl: { antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" },
    dpr: 1,
    frameloop: "never",
    size: { width: wide.width * job.ss, height: wide.height * job.ss, top: 0, left: 0 },
    camera: { fov: 45, near: 0.1, far: 1000, position: [0, 0, 5], manual: true },
    shadows: { enabled: true, type: SHADOW_MAP_TYPE },
    onCreated: ({ gl, scene }) => {
      ensureRectAreaLightUniforms();
      applyRenderSettings(gl, scene, DEFAULT_RENDER_SETTINGS);
    },
  });

  let pending: { key: string; resolve: () => void } | null = null;
  const onCommit = (key: string) => {
    if (pending?.key !== key) return;
    const done = pending;
    pending = null;
    done.resolve();
  };
  const onError = (error: unknown) => note("error", [`${def.id} threw:`, error]);
  const live: { store: RootStore | null } = { store: null };
  const commit = (frame: LabFrame) =>
    new Promise<void>((resolve, reject) => {
      pending = { key: frame.key, resolve };
      useEditorStore.getState().setFormat(FORMATS[frame.aspect]);
      useClockStore.setState({ currentMs: frame.tMs, durationMs: frame.tMs + 10_000 });
      live.store = root.render(<LabScene frame={frame} onCommit={onCommit} onError={onError} />);
      setTimeout(() => reject(new Error(`Commit timed out for ${frame.key}`)), 30_000);
    });

  const single = job.raw;
  const grid = job.mode === "grid";
  const body = single
    ? SheetBody.single(wide)
    : grid
      ? SheetBody.grid(
          rows.map(
            (r) => `${r.preset} ${r.name} (${r.mode})${job.times.length > 1 ? ` t ${r.t}` : ""}`,
          ),
          wide,
          3,
        )
      : SheetBody.rows(
          rows.map((r) =>
            r.kind === "motion"
              ? {
                  title: `${r.preset} motion`,
                  detail: `|t ${job.times[1]} - t ${job.times[0]}|\nmax channel x4`,
                }
              : { title: `${r.preset} ${r.name}`, detail: `${r.mode}\nt ${r.t} s` },
          ),
          [
            ...cams.map((c) => ({ title: c.name, width: wide.width })),
            ...(tallPose ? [{ title: `9:16 ${tallName}`, width: tall.width }] : []),
          ],
          wide.height,
        );

  let info = "";
  const tileMs: number[] = [];
  const syncPixel = new Uint8Array(4);

  const renderTile = (pose: LabPose, size: { width: number; height: number }) => {
    const state = live.store?.getState();
    if (!state) throw new Error("Renderer not ready");
    const gl = state.gl as WebGLRenderer;
    const w = size.width * job.ss;
    const h = size.height * job.ss;
    gl.setSize(w, h, false);
    const cam = state.camera as PerspectiveCamera;
    cam.fov = pose.fov;
    cam.aspect = w / h;
    cam.position.set(...pose.position);
    cam.up.set(0, 1, 0);
    cam.lookAt(...pose.target);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    gl.render(state.scene, cam);
    if (!info) {
      const ctx = gl.getContext();
      const ext = ctx.getExtension("WEBGL_debug_renderer_info");
      const name = ext
        ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)
        : ctx.getParameter(ctx.RENDERER);
      info = `${name} · MSAA ${ctx.getParameter(ctx.SAMPLES)} (max ${gl.capabilities.maxSamples})`;
    }
    return { gl, w, h };
  };

  const blit = (gl: WebGLRenderer, w: number, h: number, x: number, y: number) => {
    const g = body.context;
    if (job.ss === 1) {
      g.drawImage(gl.domElement, 0, 0, w, h, x, y, w, h);
      return;
    }
    const ctx = gl.getContext();
    const px = new Uint8Array(w * h * 4);
    ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
    g.putImageData(boxDownsample(px, w, h, job.ss), x, y);
  };

  const motion: { preset: string; col: number; mean: number; moving: number }[] = [];
  for (const [r, row] of rows.entries()) {
    if (row.kind === "motion") {
      const cols = cams.length + (tallPose ? 1 : 0);
      for (let col = 0; col < cols; col++) {
        const stats = motionTile(
          body.context,
          body.slot(r - 2, col),
          body.slot(r - 1, col),
          body.slot(r, col),
        );
        motion.push({ preset: row.preset, col, ...stats });
      }
      continue;
    }
    const aspects: ("16:9" | "9:16")[] = grid || single || !tallPose ? ["16:9"] : ["16:9", "9:16"];
    for (const aspect of aspects) {
      progress(`row ${r + 1}/${rows.length} ${row.preset} t ${row.t} ${aspect}`);
      const frame: LabFrame = {
        key: `${row.preset}|${row.t}|${aspect}`,
        aspect,
        tMs: Math.round(row.t * 1000),
        spec: row.spec,
        textColor: row.textColor,
        headline: job.headline,
        content: job.content,
        theme,
      };
      await commit(frame);
      if (live.store) await settleText(live.store.getState().scene);
      const shots =
        aspect === "9:16"
          ? [{ pose: tallPose as LabPose, size: tall, col: cams.length }]
          : (single || grid ? cams.slice(0, 1) : cams).map((c, col) => ({
              pose: c.pose as LabPose,
              size: wide,
              col,
            }));
      for (const shot of shots) {
        const t0 = performance.now();
        const { gl, w, h } = renderTile(shot.pose, shot.size);
        const slot = grid ? body.slot(r, 0) : single ? body.slot(0, 0) : body.slot(r, shot.col);
        blit(gl, w, h, slot.x, slot.y);
        // A one-pixel readback waits for the GPU, so tile times are real render costs.
        gl.getContext().readPixels(
          0,
          0,
          1,
          1,
          WebGL2RenderingContext.RGBA,
          WebGL2RenderingContext.UNSIGNED_BYTE,
          syncPixel,
        );
        tileMs.push(performance.now() - t0);
      }
      if (grid || single) break;
    }
    if (single) break;
  }
  root.unmount();

  const totalMs = performance.now() - started;
  const rest = tileMs.slice(1);
  const avg = rest.length ? rest.reduce((a, b) => a + b, 0) / rest.length : 0;
  const timing = `first tile ${Math.round(tileMs[0] ?? 0)} ms (compiles) · ${rest.length} more at ${Math.round(avg)} ms avg · page ${(totalMs / 1000).toFixed(1)} s`;
  const list = [...diagnostics.values()].sort((a, b) =>
    a.level === b.level ? 0 : a.level === "error" ? -1 : 1,
  );
  const header = [
    `Look lab · ${def.name} (${def.id}) · ${def.family}${def.lit ? " · lit" : ""} · ${grid ? `presets grid at ${cams[0].name}` : "sheet"} · t ${job.times.join(", ")} s${
      Object.keys(job.params).length ? ` · params ${JSON.stringify(job.params)}` : ""
    }`,
    `${wide.width}x${wide.height} tiles${job.ss > 1 ? ` (${job.ss}x box-filtered)` : ""} for a ${FORMATS["16:9"].width}x${FORMATS["16:9"].height} format · ${theme.id} · ACES 1.0 · ${info}`,
    timing,
  ];
  const sheet = job.raw ? body.canvas : composeSheet(body, header, list);
  sheet.className = "sheet";
  document.body.append(sheet);
  statusEl.textContent = header.join("  |  ");
  const report = {
    look: def.id,
    mode: job.mode,
    width: sheet.width,
    height: sheet.height,
    renderer: info,
    timing: { totalMs, firstTileMs: tileMs[0] ?? 0, tiles: tileMs.length, avgTileMs: avg },
    motion: motion.map((m) => ({
      ...m,
      cam: m.col < cams.length ? cams[m.col].name : `9:16 ${tallName}`,
    })),
    diagnostics: list,
  };
  await post("/__lab/report", JSON.stringify(report), "application/json");
  const blob = await new Promise<Blob | null>((r) => sheet.toBlob(r, "image/png"));
  if (!blob) throw new Error("PNG encode failed");
  await post("/__lab/png", blob, "image/png");
}

run().catch(async (error) => {
  note("error", [error]);
  statusEl.textContent = `Look lab failed: ${describe(error)}`;
  await post(
    "/__lab/fail",
    JSON.stringify({ error: describe(error), diagnostics: [...diagnostics.values()] }),
    "application/json",
  ).catch(() => {});
});
