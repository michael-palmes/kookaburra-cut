import { useThree } from "@react-three/fiber";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { CanvasTexture, SRGBColorSpace, type Texture } from "three";
import { type ClipPendingState, clipPendingState, subscribeClipPending } from "../../engine/clips";
import { isExporting, subscribeExporting } from "../../engine/exportState";
import { assertProjectRelative } from "../../engine/project";
import { ProjectIdContext } from "../../engine/sceneContext";
import { clipSourceKey, nativePort } from "../../engine/stageRealm";
import { useEditorStore } from "../../store/editorStore";
import { preparingVideoTexture } from "./preparingTexture";

/** The clip stand-in, PREVIEW ONLY, an extension of the shared "Preparing video…" card: a clip placed while its conform still writes the file shows the original's poster under a progress ring, then the real frames bind in its place when the mezzanine lands. It stands down whenever `isExporting()` (exports wait for pending conforms anyway), and canvas-2D text is fine for the same reason as the preparing card. */

export type ClipStandInMode = "conform" | "preparing";

/** Which card a clip that has no frames yet shows: the conform card only outside an export. */
export function clipStandInMode(
  pending: ClipPendingState | null,
  exporting: boolean,
): ClipStandInMode {
  return pending && !exporting ? "conform" : "preparing";
}

/** The ring's sweep in radians: none while the job waits for a slot. */
export function conformRingSweep(progress: number | null): number {
  if (progress === null || !(progress > 0)) return 0;
  return Math.min(1, progress) * Math.PI * 2;
}

/** The line under the ring. */
export function conformStandInLabel(progress: number | null): string {
  return progress === null ? "Waiting to conform" : "Conforming";
}

/** The source rect that cover-fits a `srcW`×`srcH` image into a card of `aspect` (width / height). */
export function coverSourceRect(
  srcW: number,
  srcH: number,
  aspect: number,
): { sx: number; sy: number; sw: number; sh: number } {
  if (srcW / srcH > aspect) {
    const sw = srcH * aspect;
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
  }
  const sh = srcW / aspect;
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}

type Poster = CanvasImageSource & { width: number; height: number };

/** Paints the card: the poster cover-fitted and dimmed, the ring and its percentage. */
export function drawConformStandIn(
  canvas: HTMLCanvasElement,
  poster: Poster | null,
  progress: number | null,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  const s = Math.min(w, h);
  ctx.fillStyle = "#101418";
  ctx.fillRect(0, 0, w, h);
  if (poster && poster.width > 0 && poster.height > 0) {
    const { sx, sy, sw, sh } = coverSourceRect(poster.width, poster.height, w / h);
    ctx.drawImage(poster, sx, sy, sw, sh, 0, 0, w, h);
    ctx.fillStyle = "rgba(4, 6, 8, 0.55)";
    ctx.fillRect(0, 0, w, h);
  }
  const cx = w / 2;
  const cy = h / 2 - s * 0.04;
  const r = s * 0.12;
  ctx.lineWidth = s * 0.018;
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(232, 237, 242, 0.28)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const sweep = conformRingSweep(progress);
  if (sweep > 0) {
    ctx.strokeStyle = "#e8edf2";
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + sweep);
    ctx.stroke();
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#e8edf2";
  if (progress !== null) {
    ctx.font = `600 ${Math.round(s * 0.062)}px system-ui, sans-serif`;
    ctx.fillText(`${Math.floor(Math.min(1, progress) * 100)}%`, cx, cy);
  }
  ctx.font = `600 ${Math.round(s * 0.058)}px system-ui, sans-serif`;
  ctx.fillText(conformStandInLabel(progress), cx, cy + r + s * 0.1);
}

function createStandInTexture(aspect: number, flipY: boolean): CanvasTexture {
  const w = aspect >= 1 ? 768 : 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = Math.max(1, Math.round(w / aspect));
  drawConformStandIn(canvas, null, null);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.flipY = flipY;
  tex.needsUpdate = true;
  return tex;
}

/** Poster bitmaps per pending clip, dropped once it lands. Read as bytes through `read_media_thumb`, since an asset-protocol image would taint the canvas WebGL uploads. */
const posterLoads = new Map<string, Promise<ImageBitmap | null>>();

function loadPoster(slug: string, rel: string): Promise<ImageBitmap | null> {
  const key = `${slug}\n${rel}`;
  let load = posterLoads.get(key);
  if (!load) {
    load = nativePort()
      .conformPoster(slug, rel)
      .then((bytes) => (bytes ? createImageBitmap(new Blob([bytes])) : null))
      .catch((e) => {
        console.warn(`[media] no poster for conforming ${rel}:`, e);
        posterLoads.delete(key);
        return null;
      });
    posterLoads.set(key, load);
  }
  return load;
}

function usePendingPoster(slug: string | null, rel: string | null): ImageBitmap | null {
  const [poster, setPoster] = useState<{ key: string; bitmap: ImageBitmap } | null>(null);
  const key = slug && rel ? `${slug}\n${rel}` : null;
  useEffect(() => {
    if (!slug || !rel || !key) return;
    let alive = true;
    void loadPoster(slug, rel).then((bitmap) => {
      if (alive && bitmap) setPoster({ key, bitmap });
    });
    return () => {
      alive = false;
      posterLoads.delete(key);
    };
  }, [slug, rel, key]);
  return poster && poster.key === key ? poster.bitmap : null;
}

function subscribeStandIn(listener: () => void): () => void {
  const offPending = subscribeClipPending(listener);
  const offExporting = subscribeExporting(listener);
  return () => {
    offPending();
    offExporting();
  };
}

/** The texture a clip consumer shows before its first frame binds: the shared "Preparing video…" card, or, while a conform is still writing the clip's file, this consumer's own poster-and-ring card, redrawn as the job reports progress. Resolves `src` exactly as `useClipEntry` does, so it reads the same pending state. */
export function useClipStandInTexture(src: string, aspect: number, flipY: boolean): Texture {
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((s) => s.projectId);
  const projectId = contextProjectId ?? storeProjectId;
  const source = useMemo(() => {
    try {
      return clipSourceKey({ projectId, rel: assertProjectRelative(src) });
    } catch {
      return null;
    }
  }, [projectId, src]);
  // Null throughout an export, so a running export never re-renders a consumer for it.
  const pending = useSyncExternalStore(subscribeStandIn, () =>
    source && !isExporting() ? clipPendingState(source) : null,
  );
  const mode = clipStandInMode(pending, isExporting());
  const invalidate = useThree((s) => s.invalidate);
  const live = mode === "conform" ? pending : null;
  const poster = usePendingPoster(live?.slug ?? null, live?.rel ?? null);
  // The preparing card's cache grain, so a plane easing its size doesn't mint a canvas per frame.
  const shape = Math.round(aspect * 100) / 100;
  const texture = useMemo(
    () => (mode === "conform" ? createStandInTexture(shape, flipY) : null),
    [mode, shape, flipY],
  );
  useEffect(() => () => texture?.dispose(), [texture]);
  const progress = live?.progress ?? null;
  const percent = progress === null ? null : Math.floor(Math.min(1, progress) * 100);
  useLayoutEffect(() => {
    if (!texture) return;
    drawConformStandIn(
      texture.image as HTMLCanvasElement,
      poster,
      percent === null ? null : percent / 100,
    );
    texture.needsUpdate = true;
    invalidate();
  }, [texture, poster, percent, invalidate]);
  return texture ?? preparingVideoTexture(aspect, flipY);
}
