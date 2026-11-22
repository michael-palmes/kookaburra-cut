import { useClockStore } from "./clock";
import { type LoadedProject, sceneFileStem } from "./project";
import { stage } from "./stageHandle";
import { setTaskTrace, takeTaskTrace } from "./taskTrace";

/** Gaps between the stage's preview draws while a probe window records. */
export interface DrawStats {
  frames: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  tasks?: Record<string, [number, number, number]>;
}

/** One scene played or skimmed from the editor window, the way a person drives it: the window's clock ticks, what the stage drew, and how long a tick took to reach the screen. */
export interface PlaybackRow {
  scene: string;
  pass: "playback" | "scrub";
  ticks: number;
  tickAvgMs: number;
  tickP95Ms: number;
  tickMaxMs: number;
  frames: number;
  avgFps: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  lagAvgMs: number | null;
  lagP95Ms: number | null;
  commitAvgMs: number | null;
  commitP95Ms: number | null;
  tasks?: Record<string, [number, number, number]>;
}

const WARMUP_MS = 800;
const WINDOW_MS = 2000;
const RAF_STALL_MS = 3000;
const SCRUB_SPEED = 4;
const TICK_MS = 1000 / 60;

const round = (ms: number) => Math.round(ms * 100) / 100;

function spread(samples: number[]): { avg: number; p95: number; max: number } {
  if (samples.length === 0) return { avg: 0, p95: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    avg: round(avg),
    p95: round(sorted[Math.floor(sorted.length * 0.95)]),
    max: round(sorted[sorted.length - 1]),
  };
}

const hop = new MessageChannel();
const hops: (() => void)[] = [];
hop.port1.onmessage = () => hops.shift()?.();
const yieldHop = () =>
  new Promise<void>((resolve) => {
    hops.push(resolve);
    hop.port2.postMessage(0);
  });

/** The next tick: an animation frame, or (`timer`, for a window nobody can see) a 60 Hz pace that never needs one. */
async function nextTick(timer: boolean, last: number): Promise<number> {
  if (timer) {
    while (performance.now() - last < TICK_MS) await yieldHop();
    stage().tickFrame();
    return performance.now();
  }
  return new Promise<number>((resolve, reject) => {
    const stall = setTimeout(
      () => reject(new Error("perf: rAF stalled, keep the app window visible and unoccluded")),
      RAF_STALL_MS,
    );
    requestAnimationFrame((now) => {
      clearTimeout(stall);
      resolve(now);
    });
  });
}

async function measure(
  slot: { startMs: number; durationMs: number },
  pass: PlaybackRow["pass"],
  timer: boolean,
): Promise<Omit<PlaybackRow, "scene" | "pass">> {
  const s = stage();
  const span = Math.max(1, slot.durationMs - 50);
  const gaps: number[] = [];
  const lags: number[] = [];
  const commits: number[] = [];
  const sent = new Map<number, number>();
  const uncommitted = new Map<number, number>();
  const offDrawn = s.subscribeDrawn((clockMs) => {
    const at = sent.get(clockMs);
    if (at === undefined) return;
    sent.delete(clockMs);
    lags.push(performance.now() - at);
  });
  const offStamps = s.subscribeStamps(() => {
    const clockMs = s.stamps().clockMs;
    const at = uncommitted.get(clockMs);
    if (at === undefined) return;
    uncommitted.delete(clockMs);
    commits.push(performance.now() - at);
  });
  const off = () => {
    offDrawn();
    offStamps();
  };
  s.previewFlags({ playbackActive: pass === "playback" });
  let recording = false;
  try {
    let last = performance.now();
    const started = last;
    let travelled = 0;
    let sampling = false;
    let sampledMs = 0;
    while (sampledMs < WINDOW_MS) {
      const now = await nextTick(timer, last);
      const dt = now - last;
      last = now;
      if (!sampling && now - started >= WARMUP_MS) {
        sampling = true;
        sent.clear();
        uncommitted.clear();
        lags.length = 0;
        commits.length = 0;
        await s.drawStats(true);
        recording = true;
        last = performance.now();
        continue;
      }
      if (sampling) {
        gaps.push(dt);
        sampledMs += dt;
      }
      travelled += pass === "scrub" ? dt * SCRUB_SPEED : dt;
      const lap = travelled % (span * 2);
      const local = pass === "scrub" && lap > span ? span * 2 - lap : lap % span;
      const clockMs = slot.startMs + local;
      const at = performance.now();
      sent.set(clockMs, at);
      uncommitted.set(clockMs, at);
      useClockStore.getState().setCurrentMs(clockMs);
    }
    const draws = (await s.drawStats(false)) ?? { frames: 0, avgMs: 0, p95Ms: 0, maxMs: 0 };
    recording = false;
    const tick = spread(gaps);
    const lag = spread(lags);
    const commit = spread(commits);
    return {
      ticks: gaps.length,
      tickAvgMs: tick.avg,
      tickP95Ms: tick.p95,
      tickMaxMs: tick.max,
      frames: draws.frames,
      avgFps: draws.avgMs > 0 ? Math.round((1000 / draws.avgMs) * 10) / 10 : 0,
      avgMs: draws.avgMs,
      p95Ms: draws.p95Ms,
      maxMs: draws.maxMs,
      lagAvgMs: lags.length ? lag.avg : null,
      lagP95Ms: lags.length ? lag.p95 : null,
      commitAvgMs: commits.length ? commit.avg : null,
      commitP95Ms: commits.length ? commit.p95 : null,
      tasks: draws.tasks,
    };
  } finally {
    off();
    s.previewFlags({ playbackActive: false });
    if (recording) void s.drawStats(false).catch(() => {});
  }
}

/** Plays, then skims, every scene from the window through the whole preview pipeline (clock write, the chrome's own renders, the hop to the stage, its commit and draw). The stage-side elimination passes in engine/perfProbe.ts cannot see the window's half. */
export async function runPlaybackProbe(
  project: LoadedProject,
  timer = false,
): Promise<PlaybackRow[]> {
  const rows: PlaybackRow[] = [];
  const restoreMs = useClockStore.getState().currentMs;
  try {
    for (const [i, slot] of project.slots.entries()) {
      const scene = project.sceneDocs[i]?.name ?? sceneFileStem(project.sceneFiles[i]);
      for (const pass of ["playback", "scrub"] as const) {
        console.warn(`[autorun] perf ${scene} · ${pass}`);
        rows.push({ scene, pass, ...(await measure(slot, pass, timer)) });
      }
    }
  } finally {
    useClockStore.getState().setCurrentMs(restoreMs);
  }
  return rows;
}

/** Stage side: the draw log a probe window fills. */
let drawLog: number[] | null = null;

export function recordingDraws(): boolean {
  return drawLog !== null;
}

export function noteDraw(): void {
  drawLog?.push(performance.now());
}

export function setDrawRecording(on: boolean): DrawStats | null {
  const log = drawLog;
  drawLog = on ? [] : null;
  if (on) setTaskTrace(true);
  if (on || !log) return null;
  const tasks = takeTaskTrace();
  setTaskTrace(false);
  const gaps = log.slice(1).map((at, i) => at - log[i]);
  const s = spread(gaps);
  return { frames: log.length, avgMs: s.avg, p95Ms: s.p95, maxMs: s.max, tasks };
}
