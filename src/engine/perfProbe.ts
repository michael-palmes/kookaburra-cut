import { invoke } from "@tauri-apps/api/core";
import type { Material, Mesh, Object3D, Scene, WebGLRenderer } from "three";
import { useClockStore } from "./clock";
import { canvasHandle } from "./exportBridge";
import {
  setPreviewClipStride,
  setPreviewDofOff,
  setPreviewEnvironmentOff,
  setPreviewMotionBlurOff,
  setPreviewPlaybackActive,
} from "./previewMedia";
import { type LoadedProject, sceneFileStem } from "./project";

/** Playback performance probe (`kookaburra:run --action perf`): plays a window of every scene under a matrix of elimination passes and reports frame-time stats plus renderer counters per pass, so regressions and hotspots (device glass, screen media, shadows, fill rate) can be pinned as scenes grow. Preview-only diagnostics; the export path never reads any of this. Needs a visible window: WKWebView suspends rAF while occluded. */

export interface PerfRow {
  scene: string;
  pass: string;
  frames: number;
  avgFps: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  drawCalls: number;
  triangles: number;
  texturesInMemory: number;
}

/** True while the frozen-media pass runs: clip consumers hold their current frame instead of decoding a new one per tick. Only the perf probe ever sets it. */
let clipsFrozen = false;
export function perfClipsFrozen(): boolean {
  return clipsFrozen;
}

/** Cold-extraction metric: when each clip (lane + source) was first referenced and when a consumer first bound one of its frames. Wall-clock reads stay in this diagnostics module; nothing on the render path reads them. */
const clipReferencedAt = new Map<string, number>();
const clipBoundAt = new Map<string, number>();

export function noteClipReferenced(key: string): void {
  if (!clipReferencedAt.has(key)) clipReferencedAt.set(key, performance.now());
}

export function noteClipBound(key: string): void {
  if (clipReferencedAt.has(key) && !clipBoundAt.has(key)) clipBoundAt.set(key, performance.now());
}

/** The cold-extraction row (`--action perf`): reference-to-first-bind times and what this session wrote to the clip cache. */
export interface ClipColdRow {
  scene: string;
  pass: "cold-extraction";
  clipsReferenced: number;
  clipsBound: number;
  firstBindMaxMs: number | null;
  firstBindAvgMs: number | null;
  clipBytesWritten: number;
  clipChunksExtracted: number;
  clipCountPasses: number;
}

export async function clipColdMetric(): Promise<ClipColdRow> {
  const waits = [...clipBoundAt.entries()].map(
    ([key, bound]) => bound - (clipReferencedAt.get(key) ?? bound),
  );
  const stats = await invoke<{
    bytesWritten: number;
    chunksExtracted: number;
    countPasses: number;
  }>("clip_cache_session_stats").catch(() => ({
    bytesWritten: 0,
    chunksExtracted: 0,
    countPasses: 0,
  }));
  const round = (ms: number) => Math.round(ms * 10) / 10;
  return {
    scene: "all",
    pass: "cold-extraction",
    clipsReferenced: clipReferencedAt.size,
    clipsBound: waits.length,
    firstBindMaxMs: waits.length ? round(Math.max(...waits)) : null,
    firstBindAvgMs: waits.length ? round(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
    clipBytesWritten: stats.bytesWritten,
    clipChunksExtracted: stats.chunksExtracted,
    clipCountPasses: stats.countPasses,
  };
}

/** Consecutive steady frames (each under WARMUP_STEADY_MS) that end a window's unsampled warm-up; absorbs shader recompiles and first-frame loads. */
const WARMUP_FRAMES = 20;
const WARMUP_STEADY_MS = 1000;
/** Sampled playback per scene per pass, ms. */
const WINDOW_MS = 2000;
/** No rAF for this long = the window is occluded; fail loudly instead of hanging. */
const RAF_STALL_MS = 3000;
/** The warm-up's stall limit: a window's first draw can compile programs for seconds (3.2 s on 40 lit devices). */
const WARMUP_STALL_MS = 20_000;
const WARMUP_CAP_MS = 120_000;

interface PerfPass {
  id: string;
  /** Applies the toggle and returns its restore. */
  apply: (gl: WebGLRenderer, scene: Scene) => () => void;
}

const PASSES: PerfPass[] = [
  { id: "baseline", apply: () => () => {} },
  {
    id: "dpr-1",
    apply: (gl) => {
      const prev = gl.getPixelRatio();
      gl.setPixelRatio(1);
      return () => gl.setPixelRatio(prev);
    },
  },
  {
    id: "no-shadows",
    apply: (gl) => {
      const prev = gl.shadowMap.enabled;
      gl.shadowMap.enabled = false;
      return () => {
        gl.shadowMap.enabled = prev;
      };
    },
  },
  {
    id: "no-transmission",
    apply: (_gl, scene) => {
      // Zeroing transmission removes three's hidden per-frame transmission render pass; the recompile lands in warm-up.
      const touched: { material: Material & { transmission: number }; value: number }[] = [];
      scene.traverse((obj) => {
        const mesh = obj as Mesh;
        if (!mesh.isMesh) return;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const phys = material as Material & { transmission?: number };
          if (typeof phys.transmission === "number" && phys.transmission > 0) {
            touched.push({
              material: phys as Material & { transmission: number },
              value: phys.transmission,
            });
            phys.transmission = 0;
            phys.needsUpdate = true;
          }
        }
      });
      return () => {
        for (const t of touched) {
          t.material.transmission = t.value;
          t.material.needsUpdate = true;
        }
      };
    },
  },
  {
    id: "frozen-media",
    apply: () => {
      clipsFrozen = true;
      return () => {
        clipsFrozen = false;
      };
    },
  },
  {
    id: "half-media",
    apply: () => {
      // The Balanced/Performance stride lever, measured directly.
      setPreviewClipStride(2);
      return () => setPreviewClipStride(1);
    },
  },
  {
    id: "no-devices",
    apply: (_gl, scene) => {
      const hidden: Object3D[] = [];
      scene.traverse((obj) => {
        if (obj.userData.kookaburraDevice && obj.visible) {
          obj.visible = false;
          hidden.push(obj);
        }
      });
      return () => {
        for (const obj of hidden) obj.visible = true;
      };
    },
  },
  {
    id: "no-bg3d",
    apply: (_gl, scene) => hidePass(scene, (obj) => obj.userData.kookaburraBg3d === true),
  },
  // ── v9 lighting eliminations ─────────────────────────────────────
  {
    id: "no-extra-lights",
    apply: (_gl, scene) => hidePass(scene, (obj) => obj.userData.kookaburraFreeLight === true),
  },
  {
    // The whole fixture: glow geometry AND paired lights.
    id: "no-fixtures",
    apply: (_gl, scene) => hidePass(scene, (obj) => obj.userData.kookaburraFixture === true),
  },
  {
    // Geometry keeps glowing, the paired lights go: separates draw-call cost from shader-permutation cost.
    id: "no-fixture-lights",
    apply: (_gl, scene) => hidePass(scene, (obj) => obj.userData.kookaburraFixtureLight === true),
  },
  {
    // Free area lights and fixture rect lights together: isolates the LTC cost.
    id: "no-area-lights",
    apply: (_gl, scene) =>
      hidePass(scene, (obj) => (obj as { isRectAreaLight?: boolean }).isRectAreaLight === true),
  },
  {
    // Depth-of-field cost: the compositor drops the dof union while the flag is on, so the dof/tilt passes leave the chain (dof-less scenes measure identical to baseline).
    id: "no-dof",
    apply: () => {
      setPreviewDofOff(true);
      return () => setPreviewDofOff(false);
    },
  },
  {
    // Motion blur cost: the preview renders every frame plain while the flag is on (blur-free projects measure identical to baseline).
    id: "no-motion-blur",
    apply: () => {
      setPreviewMotionBlurOff(true);
      return () => setPreviewMotionBlurOff(false);
    },
  },
  {
    // IBL sampling cost: the compositor nulls scene.environment after the state plan while the flag is on.
    id: "env-off",
    apply: (_gl, scene) => {
      setPreviewEnvironmentOff(true);
      const prev = scene.environment;
      scene.environment = null;
      return () => {
        setPreviewEnvironmentOff(false);
        scene.environment = prev;
      };
    },
  },
];

/** Hide every matching visible object for the pass; returns the restore. */
function hidePass(scene: Scene, match: (obj: Object3D) => boolean): () => void {
  const hidden: Object3D[] = [];
  scene.traverse((obj) => {
    if (match(obj) && obj.visible) {
      obj.visible = false;
      hidden.push(obj);
    }
  });
  return () => {
    for (const obj of hidden) obj.visible = true;
  };
}

/** Real-playback measurement: advances the shared clock by wall-clock delta each rAF (the preview's own pipeline: clock write, React commit, demand render) and samples the tick gaps once the warm-up has steadied. */
function measureWindow(
  slot: { startMs: number; durationMs: number },
  gl: WebGLRenderer,
): Promise<Omit<PerfRow, "scene" | "pass">> {
  return new Promise((resolve, reject) => {
    const windowMs = Math.min(WINDOW_MS, Math.max(300, slot.durationMs - 100));
    const samples: number[] = [];
    let warming = true;
    let steady = 0;
    let longest = 0;
    let sceneLocal = 0;
    let sampledMs = 0;
    const started = performance.now();
    let last = started;
    let raf = 0;
    let stall = 0;
    const fail = (message: string) => {
      window.clearTimeout(stall);
      cancelAnimationFrame(raf);
      reject(new Error(message));
    };
    const bump = () => {
      window.clearTimeout(stall);
      stall = window.setTimeout(
        () => fail("perf: rAF stalled, keep the app window visible and unoccluded for a perf run"),
        warming ? WARMUP_STALL_MS : RAF_STALL_MS,
      );
    };
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      if (warming) {
        longest = Math.max(longest, dt);
        steady = dt < WARMUP_STEADY_MS ? steady + 1 : 0;
        if (steady >= WARMUP_FRAMES) {
          warming = false;
          if (longest >= WARMUP_STEADY_MS) {
            console.warn(
              `[autorun] perf warm-up took ${Math.round(now - started)} ms (longest frame gap ${Math.round(longest)} ms)`,
            );
          }
        } else if (now - started > WARMUP_CAP_MS) {
          fail(
            `perf: playback never steadied within ${WARMUP_CAP_MS / 1000} s (longest frame gap ${Math.round(longest)} ms)`,
          );
          return;
        }
      } else {
        samples.push(dt);
        sampledMs += dt;
      }
      bump();
      // Advance within the scene; wrapping keeps clip playback essentially linear.
      sceneLocal = (sceneLocal + dt) % Math.max(1, slot.durationMs - 50);
      const clock = useClockStore.getState();
      clock.setCurrentMs(Math.min(clock.durationMs, slot.startMs + sceneLocal));
      if (sampledMs >= windowMs || samples.length >= 400) {
        window.clearTimeout(stall);
        const avgMs = sampledMs / samples.length;
        const sorted = [...samples].sort((a, b) => a - b);
        resolve({
          frames: samples.length,
          avgMs: Math.round(avgMs * 100) / 100,
          avgFps: Math.round((1000 / avgMs) * 10) / 10,
          p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 100) / 100,
          maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
          // autoReset means these reflect the most recent render.
          drawCalls: gl.info.render.calls,
          triangles: gl.info.render.triangles,
          texturesInMemory: gl.info.memory.textures,
        });
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    bump();
    raf = requestAnimationFrame(tick);
  });
}

/** Runs every elimination pass over every scene; rows come back per scene × pass. Measures with the playback flag up so clips bind their preview tier exactly as real playback does. */
export async function runPerfProbe(project: LoadedProject): Promise<PerfRow[]> {
  const handle = canvasHandle.current;
  if (!handle) throw new Error("perf: canvas handle unavailable");
  const { gl, scene } = handle;
  const rows: PerfRow[] = [];
  setPreviewPlaybackActive(true);
  try {
    for (const [i, slot] of project.slots.entries()) {
      const name = project.sceneDocs[i]?.name ?? sceneFileStem(project.sceneFiles[i]);
      for (const pass of PASSES) {
        console.warn(`[autorun] perf ${name} · ${pass.id}`);
        const restore = pass.apply(gl, scene);
        try {
          const stats = await measureWindow(slot, gl);
          rows.push({ scene: name, pass: pass.id, ...stats });
        } finally {
          restore();
        }
      }
    }
  } finally {
    setPreviewPlaybackActive(false);
  }
  return rows;
}
