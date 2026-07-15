import { useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect } from "react";
import type { Camera, Scene, WebGLRenderer } from "three";
import { useClockStore } from "./clock";

/** Imperative handle onto the live r3f canvas, captured for the export loop. */
export interface CanvasHandle {
  gl: WebGLRenderer;
  scene: Scene;
  camera: Camera;
  /** r3f's manual frameloop step, runs the useFrame subscribers (i.e. the CompositorDriver render) synchronously, exactly as an rAF tick would; the snapshot/preview capture path calls it because rAF is suspended in occluded WKWebView windows (the AFK lesson), so without it captures in a headless `kookaburra:run` read a stale drawing buffer. The export loop never uses it (it calls renderComposited directly). */
  advance: (timestamp: number) => void;
}

export const canvasHandle: { current: CanvasHandle | null } = { current: null };

/** The clock value the canvas tree last committed. The canvas subtree renders in the react-three-fiber reconciler, which react-dom's `flushSync` does not flush, its commits land on the r3f scheduler's own timing; the export loop must therefore not trust per-mesh readiness hooks until the canvas tree has provably committed the frame's clock value, polling this stamp to know. Without this the capture races the r3f commit and can grab the previous frame's texture/text (the back-to-back Verify ×2 divergence). See docs/determinism.md. */
let committedClockMs = Number.NaN;

export function canvasCommittedClockMs(): number {
  return committedClockMs;
}

/** The loaded project identity the canvas tree last committed (stamped by CompositorDriver's layout effect). A project/theme swap is a concurrent-lane update while the capture paths' clock writes are sync-lane, so the clock stamp can land on the old tree before the swap commits and a capture right after `applyLoadedProject` reads the previous theme's content (the stale scene-1 theme-preview bug); batch/preview capture paths wait for this stamp before seeking. */
let committedProject: unknown = null;

export function canvasCommittedProject(): unknown {
  return committedProject;
}

export function stampCommittedProject(project: unknown): void {
  committedProject = project;
}

/** Mounts inside `<Canvas>`; publishes the renderer/scene/camera so the deterministic exporter (`engine/exporter.ts`) can drive renders and read pixels off the same GL context the preview uses, no second canvas, so preview and export cannot drift. */
export function ExportBridge() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const advance = useThree((s) => s.advance);
  const currentMs = useClockStore((s) => s.currentMs);
  useEffect(() => {
    canvasHandle.current = { gl, scene, camera, advance };
    return () => {
      canvasHandle.current = null;
    };
  }, [gl, scene, camera, advance]);
  // Stamps the committed clock synchronously with this canvas-tree commit: every clock subscriber in the canvas tree re-renders in the same reconciler flush, so once this stamp equals a clock value, every scene primitive has committed for it too.
  useLayoutEffect(() => {
    committedClockMs = currentMs;
  }, [currentMs]);
  return null;
}
