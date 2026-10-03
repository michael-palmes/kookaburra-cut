import { type CSSProperties, useEffect, useLayoutEffect, useRef } from "react";
import type { EditMask, EditSource } from "../engine/edit";
import {
  DEFAULT_MASK_COLOR,
  type MaskRect,
  maskBlockPx,
  maskBlurSigmaPx,
} from "../engine/editMasks";

/** Preview-only mask effects drawn over the editor's <video>/<img> (the render bakes them in ffmpeg, edit_masks.rs). Blur and pixelate read the media into a canvas: CSS `backdrop-filter` can't pixelate and would also blur the tap glows above. */

export type MaskMedia = HTMLVideoElement | HTMLImageElement;

const BLUR_CANVAS_MAX_PX = 480;

const pct = (v: number) => `${v * 100}%`;

/** Positions a box in % of the source box, so it lines up with normalised source coords. */
export function rectStyle(rect: MaskRect): CSSProperties {
  return { left: pct(rect[0]), top: pct(rect[1]), width: pct(rect[2]), height: pct(rect[3]) };
}

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The source pixels a blur samples (the box plus 3 sigma, unclamped) or a mosaic covers (snapped outward to the block grid, clamped), mirroring edit_masks.rs `effect_window`. */
function effectRegion(mask: EditMask, rect: MaskRect, source: EditSource): Region {
  const [sw, sh] = [source.width, source.height];
  const [l, t, r, b] = [
    rect[0] * sw,
    rect[1] * sh,
    (rect[0] + rect[2]) * sw,
    (rect[1] + rect[3]) * sh,
  ];
  if (mask.style === "pixelate") {
    const n = maskBlockPx(mask, source);
    const x = Math.max(0, Math.floor(l / n) * n);
    const y = Math.max(0, Math.floor(t / n) * n);
    return {
      x,
      y,
      w: Math.min(sw, Math.ceil(r / n) * n) - x,
      h: Math.min(sh, Math.ceil(b / n) * n) - y,
    };
  }
  const m = Math.ceil(3 * maskBlurSigmaPx(mask, source));
  return { x: l - m, y: t - m, w: r - l + 2 * m, h: b - t + 2 * m };
}

function mediaReady(media: MaskMedia): boolean {
  return media instanceof HTMLVideoElement
    ? media.readyState >= 2
    : media.complete && media.naturalWidth > 0;
}

/** Draws `region` of the media into the canvas at scale `k`; parts beyond the frame repeat its edge pixels, as ffmpeg's blur does, so a box at the frame edge never fades see-through. */
function drawRegion(
  ctx: CanvasRenderingContext2D,
  media: MaskMedia,
  region: Region,
  source: EditSource,
  k: number,
) {
  const [sw, sh] = [source.width, source.height];
  const ix0 = Math.max(0, region.x);
  const iy0 = Math.max(0, region.y);
  const ix1 = Math.min(sw, region.x + region.w);
  const iy1 = Math.min(sh, region.y + region.h);
  if (ix1 <= ix0 || iy1 <= iy0) return;
  const dx = (v: number) => (v - region.x) * k;
  const dy = (v: number) => (v - region.y) * k;
  const cw = region.w * k;
  const ch = region.h * k;
  const strip = (
    sx: number,
    sy: number,
    sW: number,
    sH: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) => {
    if (x1 > x0 && y1 > y0) ctx.drawImage(media, sx, sy, sW, sH, x0, y0, x1 - x0, y1 - y0);
  };
  strip(ix0, iy0, ix1 - ix0, iy1 - iy0, dx(ix0), dy(iy0), dx(ix1), dy(iy1));
  strip(ix0, iy0, 1, iy1 - iy0, 0, dy(iy0), dx(ix0), dy(iy1));
  strip(ix1 - 1, iy0, 1, iy1 - iy0, dx(ix1), dy(iy0), cw, dy(iy1));
  strip(ix0, iy0, ix1 - ix0, 1, dx(ix0), 0, dx(ix1), dy(iy0));
  strip(ix0, iy1 - 1, ix1 - ix0, 1, dx(ix0), dy(iy1), dx(ix1), ch);
  strip(ix0, iy0, 1, 1, 0, 0, dx(ix0), dy(iy0));
  strip(ix1 - 1, iy0, 1, 1, dx(ix1), 0, cw, dy(iy0));
  strip(ix0, iy1 - 1, 1, 1, 0, dy(iy1), dx(ix0), ch);
  strip(ix1 - 1, iy1 - 1, 1, 1, dx(ix1), dy(iy1), cw, ch);
}

/** Redraws on every presented video frame (and after seeks), or when a still finishes loading; a prop change redraws synchronously. */
function useMediaRedraw(media: MaskMedia | null, draw: () => void, deps: unknown[]) {
  const drawRef = useRef(draw);
  drawRef.current = draw;
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's geometry, the draw reads them through the ref
  useLayoutEffect(() => drawRef.current(), deps);
  useEffect(() => {
    if (!media) return;
    const redraw = () => drawRef.current();
    if (media instanceof HTMLVideoElement) {
      let alive = true;
      let handle = 0;
      const onFrame = () => {
        if (!alive) return;
        redraw();
        handle = media.requestVideoFrameCallback(onFrame);
      };
      handle = media.requestVideoFrameCallback(onFrame);
      media.addEventListener("seeked", redraw);
      media.addEventListener("loadeddata", redraw);
      return () => {
        alive = false;
        media.cancelVideoFrameCallback(handle);
        media.removeEventListener("seeked", redraw);
        media.removeEventListener("loadeddata", redraw);
      };
    }
    media.addEventListener("load", redraw);
    return () => media.removeEventListener("load", redraw);
  }, [media]);
}

function BlurCanvas({
  mask,
  rect,
  source,
  media,
}: {
  mask: EditMask;
  rect: MaskRect;
  source: EditSource;
  media: MaskMedia | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const region = effectRegion(mask, rect, source);
  const sigma = maskBlurSigmaPx(mask, source);
  useMediaRedraw(media, () => {
    const canvas = ref.current;
    if (!canvas || !media || !mediaReady(media)) return;
    const k = Math.min(1, BLUR_CANVAS_MAX_PX / Math.max(region.w, region.h));
    const w = Math.max(1, Math.round(region.w * k));
    const h = Math.max(1, Math.round(region.h * k));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (ctx) drawRegion(ctx, media, region, source, w / region.w);
  }, [region.x, region.y, region.w, region.h, sigma]);
  // Sigma in cqw of the source box: CSS px per source px is the box width over the source width.
  const style: CSSProperties = {
    left: pct((region.x / source.width - rect[0]) / rect[2]),
    top: pct((region.y / source.height - rect[1]) / rect[3]),
    width: pct(region.w / source.width / rect[2]),
    height: pct(region.h / source.height / rect[3]),
    filter: `blur(${(sigma / source.width) * 100}cqw)`,
  };
  return <canvas ref={ref} className="mask-canvas" style={style} />;
}

function PixelCanvas({
  mask,
  rect,
  source,
  media,
}: {
  mask: EditMask;
  rect: MaskRect;
  source: EditSource;
  media: MaskMedia | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const region = effectRegion(mask, rect, source);
  const block = maskBlockPx(mask, source);
  const cols = Math.max(1, Math.ceil(region.w / block));
  const rows = Math.max(1, Math.ceil(region.h / block));
  useMediaRedraw(media, () => {
    const canvas = ref.current;
    if (!canvas || !media || !mediaReady(media)) return;
    if (canvas.width !== cols || canvas.height !== rows) {
      canvas.width = cols;
      canvas.height = rows;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(media, region.x, region.y, region.w, region.h, 0, 0, cols, rows);
  }, [region.x, region.y, region.w, region.h, cols, rows]);
  const style: CSSProperties = {
    left: pct((region.x / source.width - rect[0]) / rect[2]),
    top: pct((region.y / source.height - rect[1]) / rect[3]),
    width: pct(region.w / source.width / rect[2]),
    height: pct(region.h / source.height / rect[3]),
  };
  return <canvas ref={ref} className="mask-canvas pixelated" style={style} />;
}

/** One mask's look at `rect`: an opaque fill, or a canvas clipped to the box. */
export function MaskEffect({
  mask,
  rect,
  source,
  media,
}: {
  mask: EditMask;
  rect: MaskRect;
  source: EditSource;
  media: MaskMedia | null;
}) {
  if (mask.style === "solid") {
    return (
      <div
        className="mask-effect"
        style={{ ...rectStyle(rect), background: mask.color ?? DEFAULT_MASK_COLOR }}
      />
    );
  }
  return (
    <div className="mask-effect" style={rectStyle(rect)}>
      {mask.style === "blur" ? (
        <BlurCanvas mask={mask} rect={rect} source={source} media={media} />
      ) : (
        <PixelCanvas mask={mask} rect={rect} source={source} media={media} />
      )}
    </div>
  );
}
