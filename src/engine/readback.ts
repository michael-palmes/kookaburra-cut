import { canvasContextLosses } from "./exportBridge";

export type ReadbackContext = Pick<
  WebGLRenderingContext,
  "readPixels" | "isContextLost" | "RGBA" | "UNSIGNED_BYTE"
>;

export type GpuStallReason = "contextLost" | "blankReadback";

/** A frame the GPU never delivered. Its message (and `String(error)`) reads exactly as the plain Error it replaces; `reason` lets the bridge answer a stall instead of a content failure. */
export class GpuStallError extends Error {
  readonly reason: GpuStallReason;

  constructor(reason: GpuStallReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** True when not one byte of a readback was written. A lost context, or a read that outlives WebKit's GPU-process sync timeout, leaves the zero-filled buffer untouched; a real frame never is, since every scene clears to an opaque background. */
export function isBlankReadback(rgba: Uint8Array): boolean {
  for (let i = 0; i < rgba.length; i++) if (rgba[i] !== 0) return false;
  return true;
}

/** Throws unless the live canvas has held its WebGL context since it opened (see `canvasContextLosses`). `where` names the frame or run for the error. */
export function assertContextHeld(
  ctx: Pick<ReadbackContext, "isContextLost">,
  where: string,
): void {
  if (ctx.isContextLost() || canvasContextLosses() > 0) {
    throw new GpuStallError(
      "contextLost",
      `GPU stalled (${where}): the WebGL context was lost, and a restored context renders with empty environment maps; quit and reopen Kookaburra Cut, then rerun`,
    );
  }
}

/** Reads the drawing buffer into `rgba` and throws rather than hand on a frame the GPU never delivered. The buffer is zeroed first because the export reuses it: a read that never lands would otherwise repeat the previous frame. A delivered read overwrites every byte, so its pixels are exactly readPixels'. */
export function readFrameOrThrow(
  ctx: ReadbackContext,
  width: number,
  height: number,
  rgba: Uint8Array,
  where: string,
): void {
  rgba.fill(0);
  ctx.readPixels(0, 0, width, height, ctx.RGBA, ctx.UNSIGNED_BYTE, rgba);
  assertContextHeld(ctx, where);
  if (isBlankReadback(rgba)) {
    throw new GpuStallError(
      "blankReadback",
      `GPU stalled (${where}): readPixels returned an all-zero frame, so it was discarded; rerun, and if it repeats, quit and reopen Kookaburra Cut`,
    );
  }
}
