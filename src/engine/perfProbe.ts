import type { Material, Mesh, Object3D, Scene, WebGLRenderer } from "three";
import { useClockStore } from "./clock";
import { canvasHandle } from "./exportBridge";
import { setPreviewClipStride, setPreviewPlaybackActive } from "./previewMedia";
import type { LoadedProject } from "./project";

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

/** Frames skipped before sampling starts; absorbs shader recompiles and first-frame loads. */
const WARMUP_FRAMES = 20;
/** Sampled playback per scene per pass, ms. */
const WINDOW_MS = 2000;
/** No rAF for this long = the window is occluded; fail loudly instead of hanging. */
const RAF_STALL_MS = 3000;

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
];

/** Real-playback measurement: advances the shared clock by wall-clock delta each rAF (the preview's own pipeline: clock write, React commit, demand render) and samples the tick gaps. */
function measureWindow(
  slot: { startMs: number; durationMs: number },
  gl: WebGLRenderer,
): Promise<Omit<PerfRow, "scene" | "pass">> {
  return new Promise((resolve, reject) => {
    const windowMs = Math.min(WINDOW_MS, Math.max(300, slot.durationMs - 100));
    const samples: number[] = [];
    let frame = 0;
    let sceneLocal = 0;
    let sampledMs = 0;
    let last = performance.now();
    let raf = 0;
    let stall = 0;
    const bump = () => {
      window.clearTimeout(stall);
      stall = window.setTimeout(() => {
        cancelAnimationFrame(raf);
        reject(
          new Error(
            "perf: rAF stalled — keep the app window visible and unoccluded for a perf run",
          ),
        );
      }, RAF_STALL_MS);
    };
    const tick = (now: number) => {
      bump();
      const dt = now - last;
      last = now;
      frame += 1;
      if (frame > WARMUP_FRAMES) {
        samples.push(dt);
        sampledMs += dt;
      }
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
      const name = project.sceneDocs[i]?.name ?? slot.id;
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
