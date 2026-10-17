import { invoke } from "@tauri-apps/api/core";
import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";
import { tagGlCanvas } from "../engine/glContexts";

/** The heartbeat's own canvas while it runs (a second WebGL context in this realm, so the census names it). */
export let heartbeatCanvas: HTMLCanvasElement | null = null;

/** One beat a second to `render_heartbeat`: the wall-clock delta (naps and throttling stretch it) plus a tiny real GL render with a pixel readback (proves the hidden context still draws, not just that timers fire), and whatever `extras` adds (the census, the loaded project). Diagnostic only, never part of any export path. */
export function startHeartbeat(extras: () => Record<string, unknown> = () => ({})): () => void {
  const canvas = document.createElement("canvas");
  tagGlCanvas(canvas, "heartbeat");
  heartbeatCanvas = canvas;
  const renderer = new WebGLRenderer({ canvas, antialias: false });
  renderer.setSize(64, 64, false);
  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 0.1, 10);
  camera.position.z = 3;
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 0x44aa88 }));
  scene.add(mesh);
  const px = new Uint8Array(4);
  let seq = 0;
  let last = performance.now();
  let timer = 0;
  const tick = () => {
    const now = performance.now();
    const deltaMs = now - last;
    last = now;
    mesh.rotation.y = seq * 0.1;
    renderer.render(scene, camera);
    const ctx = renderer.getContext();
    ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
    const glMs = performance.now() - now;
    void invoke("render_heartbeat", { seq, deltaMs, glMs, ...extras() }).catch(() => {});
    seq += 1;
    timer = window.setTimeout(tick, 1000);
  };
  tick();
  return () => {
    window.clearTimeout(timer);
    renderer.dispose();
    // A disposed renderer keeps its context live until GC; WebKit counts it against the 16.
    renderer.forceContextLoss();
    if (heartbeatCanvas === canvas) heartbeatCanvas = null;
  };
}
