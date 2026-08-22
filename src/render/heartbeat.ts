import { invoke } from "@tauri-apps/api/core";
import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";

/** One beat a second to `render_heartbeat`: the wall-clock delta (naps and throttling stretch it) plus a tiny real GL render with a pixel readback (proves the hidden context still draws, not just that timers fire). Diagnostic only, never part of any export path. */
export function startHeartbeat(): () => void {
  const canvas = document.createElement("canvas");
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
    void invoke("render_heartbeat", { seq, deltaMs, glMs }).catch(() => {});
    seq += 1;
    timer = window.setTimeout(tick, 1000);
  };
  tick();
  return () => {
    window.clearTimeout(timer);
    renderer.dispose();
  };
}
