import { invoke } from "@tauri-apps/api/core";
import { clipCacheCensus, setClipCacheCapacity } from "./clips";
import { canvasHandle } from "./exportBridge";
import type { ExportProgress } from "./exporter";
import type { SceneSlot } from "./sceneTimeline";

/** Long-film memory probe (`kookaburra:run --action memory`): rides a real export's progress and every 2 s records the render rate, each WebKit process's footprint (native sampler), three's GPU residency and the clip frame cache, so growth is measured, not guessed (docs/determinism.md, "Memory probe"). Wall-clock reads stay in this diagnostics module; nothing on the render path reads them. */

/** One change per memory run (`kookaburra:run --action memory --lever L`), so a growth is pinned on one cause at a time. */
export function applyMemoryLever(lever: string | undefined): void {
  if (!lever) return;
  const cache = /^clip-cache=(\d+)$/.exec(lever);
  if (cache) {
    setClipCacheCapacity(Number(cache[1]));
    return;
  }
  throw new Error(`unknown memory lever "${lever}" (expected clip-cache=N)`);
}

export interface MemoryPoint {
  frame: number;
  scene: string | null;
  wallMs: number;
  fps: number | null;
  editorMb: number | null;
  gpuMb: number | null;
  renderMb: number | null;
  appMb: number | null;
  ffmpegMb: number | null;
  glTextures: number;
  glGeometries: number;
  glPrograms: number;
  clipTextures: number;
  clipMb: number;
}

export interface MemorySummary {
  /** The acceptance check: the last 10 s render at 80% of the first 10 s or better, and the editor grew by 512 MB at most. */
  holds: boolean;
  /** Why it doesn't hold. */
  failures: string[];
  frames: number;
  filmSeconds: number;
  wallMs: number;
  /** Render rate over the first, middle and last 10 s of the run. */
  fps: number[];
  editorMb: { first: number | null; peak: number | null; last: number | null };
  gpuMb: { first: number | null; peak: number | null; last: number | null };
  /** The editor's median over the last third of the run minus its median over the first third: growth that stays, not a transition's MSAA pair coming and going. */
  editorGrowthMb: number | null;
  clipMbPeak: number;
  glTextures: { first: number; last: number };
  points: MemoryPoint[];
}

interface NativeSample {
  editor: number | null;
  gpu: number | null;
  render: number | null;
  app: number | null;
  ffmpeg: number | null;
}

const SAMPLE_MS = 2_000;
const HOLD_FPS_RATIO = 0.8;
const HOLD_GROWTH_MB = 512;
const WINDOW_MS = 10_000;
const MAX_POINTS = 150;
const mb = (bytes: number | null | undefined) =>
  typeof bytes === "number" ? Math.round(bytes / 1e6) : null;
const round1 = (v: number) => Math.round(v * 10) / 10;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

export class MemoryRecorder {
  private readonly points: MemoryPoint[] = [];
  private readonly pending: Promise<void>[] = [];
  private startedAt: number | null = null;
  private lastAt = 0;
  private lastFrame = 0;
  private frames = 0;

  constructor(
    private readonly slots: SceneSlot[],
    private readonly fps: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  onProgress(p: ExportProgress): void {
    if (p.stage !== "render") return;
    const now = this.now();
    this.frames = p.frame;
    if (this.startedAt === null) {
      this.startedAt = now;
      this.lastAt = now;
      this.lastFrame = p.frame;
    }
    if (now - this.lastAt < SAMPLE_MS && p.frame < p.total && this.points.length > 0) return;
    const elapsed = now - this.lastAt;
    const fps = elapsed > 0 ? round1(((p.frame - this.lastFrame) * 1000) / elapsed) : null;
    this.lastAt = now;
    this.lastFrame = p.frame;
    const info = canvasHandle.current?.gl.info;
    const clips = clipCacheCensus();
    const point: MemoryPoint = {
      frame: p.frame,
      scene: this.sceneAt(p.frame),
      wallMs: Math.round(now - this.startedAt),
      fps: this.points.length === 0 ? null : fps,
      editorMb: null,
      gpuMb: null,
      renderMb: null,
      appMb: null,
      ffmpegMb: null,
      glTextures: info?.memory.textures ?? 0,
      glGeometries: info?.memory.geometries ?? 0,
      glPrograms: info?.programs?.length ?? 0,
      clipTextures: clips.textures,
      clipMb: mb(clips.bytes) ?? 0,
    };
    this.points.push(point);
    this.pending.push(
      invoke<NativeSample>("export_memory_sample")
        .then((s) => {
          point.editorMb = mb(s.editor);
          point.gpuMb = mb(s.gpu);
          point.renderMb = mb(s.render);
          point.appMb = mb(s.app);
          point.ffmpegMb = mb(s.ffmpeg);
        })
        .catch(() => {}),
    );
  }

  private sceneAt(frame: number): string | null {
    const t = (frame * 1000) / this.fps;
    const on = this.slots.filter((s) => s.startMs <= t && t < s.endMs);
    return on.length ? on[on.length - 1].id : (this.slots[this.slots.length - 1]?.id ?? null);
  }

  private rate(from: number, to: number): number | null {
    const a = this.points.find((p) => p.wallMs >= from);
    const b = [...this.points].reverse().find((p) => p.wallMs <= to);
    if (!a || !b || b.wallMs <= a.wallMs) return null;
    return round1(((b.frame - a.frame) * 1000) / (b.wallMs - a.wallMs));
  }

  async summary(): Promise<MemorySummary> {
    await Promise.all(this.pending);
    const pts = this.points;
    const last = pts[pts.length - 1];
    const span = last?.wallMs ?? 0;
    const fps =
      span < WINDOW_MS * 3
        ? [this.rate(0, span)]
        : [
            this.rate(0, WINDOW_MS),
            this.rate(span / 2 - WINDOW_MS / 2, span / 2 + WINDOW_MS / 2),
            this.rate(span - WINDOW_MS, span),
          ];
    const series = (pick: (p: MemoryPoint) => number | null) => {
      const values = pts.map(pick).filter((v): v is number => v !== null);
      return {
        first: values[0] ?? null,
        peak: values.length ? Math.max(...values) : null,
        last: values[values.length - 1] ?? null,
      };
    };
    const editorMb = series((p) => p.editorMb);
    const editorValues = pts.map((p) => p.editorMb).filter((v): v is number => v !== null);
    const third = Math.floor(editorValues.length / 3);
    const editorGrowthMb =
      third > 0 ? median(editorValues.slice(-third)) - median(editorValues.slice(0, third)) : null;
    const filmSeconds = this.frames / this.fps;
    const step = Math.max(1, Math.ceil(pts.length / MAX_POINTS));
    const rates = fps.filter((v): v is number => v !== null);
    const failures: string[] = [];
    if (rates.length > 1 && rates[rates.length - 1] < rates[0] * HOLD_FPS_RATIO) {
      failures.push(`render slowed from ${rates[0]} to ${rates[rates.length - 1]} fps`);
    }
    if (editorGrowthMb !== null && editorGrowthMb > HOLD_GROWTH_MB) {
      failures.push(`the editor grew ${editorGrowthMb} MB and kept it`);
    }
    return {
      holds: failures.length === 0,
      failures,
      frames: this.frames,
      filmSeconds: round1(filmSeconds),
      wallMs: span,
      fps: rates,
      editorMb,
      gpuMb: series((p) => p.gpuMb),
      editorGrowthMb,
      clipMbPeak: Math.max(0, ...pts.map((p) => p.clipMb)),
      glTextures: { first: pts[0]?.glTextures ?? 0, last: last?.glTextures ?? 0 },
      points: pts.filter((_, i) => i % step === 0 || i === pts.length - 1),
    };
  }
}
