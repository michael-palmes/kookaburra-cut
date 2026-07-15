import { CanvasTexture, SRGBColorSpace } from "three";

/** The shared "Preparing video…" card texture, PREVIEW ONLY: export/verify can never sample it since the export preamble pre-extracts every clip and `awaitVideoFramesReady` barriers each capture, and every consumer also stands down while `isExporting()` (canvas-2D text is fine here for the same reason); `flipY` follows the consumer's UV convention (glTF screens want false, a plain plane wants true), cached per (aspect, flipY). */
const cache = new Map<string, CanvasTexture>();

export function preparingVideoTexture(aspect: number, flipY: boolean): CanvasTexture {
  const key = `${aspect.toFixed(2)}/${flipY}`;
  let tex = cache.get(key);
  if (!tex) {
    const w = aspect >= 1 ? 768 : 512;
    const h = Math.round(w / aspect);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const s = Math.min(w, h);
      ctx.fillStyle = "#101418";
      ctx.fillRect(0, 0, w, h);
      ctx.textAlign = "center";
      ctx.fillStyle = "#e8edf2";
      ctx.font = `600 ${Math.round(s * 0.078)}px system-ui, sans-serif`;
      ctx.fillText("Preparing video…", w / 2, h / 2 - s * 0.03);
      ctx.fillStyle = "#8a949e";
      ctx.font = `400 ${Math.round(s * 0.057)}px system-ui, sans-serif`;
      ctx.fillText("This can take a minute", w / 2, h / 2 + s * 0.08);
    }
    tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.flipY = flipY;
    tex.needsUpdate = true;
    cache.set(key, tex);
  }
  return tex;
}
