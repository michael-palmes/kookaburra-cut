/** A capture request's contact sheet: every frame scaled into one labelled grid PNG. Diagnostic output composed in a 2D canvas, never part of the export path. */

export interface SheetLayout {
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  labelHeight: number;
  gap: number;
  width: number;
  height: number;
}

const LANDSCAPE_TILE = 480;
const PORTRAIT_TILE = 270;
const LABEL_HEIGHT = 26;
const GAP = 8;

export function contactSheetLayout(
  count: number,
  frameWidth: number,
  frameHeight: number,
): SheetLayout {
  const landscape = frameWidth >= frameHeight;
  const columns = Math.max(1, Math.min(count, landscape ? 4 : 6));
  const rows = Math.max(1, Math.ceil(count / columns));
  const tileWidth = landscape ? LANDSCAPE_TILE : PORTRAIT_TILE;
  const tileHeight = Math.round((tileWidth * frameHeight) / frameWidth);
  return {
    columns,
    rows,
    tileWidth,
    tileHeight,
    labelHeight: LABEL_HEIGHT,
    gap: GAP,
    width: columns * tileWidth + (columns + 1) * GAP,
    height: rows * (tileHeight + LABEL_HEIGHT) + (rows + 1) * GAP,
  };
}

/** Top-left of tile `n` (row-major). */
export function tileOrigin(layout: SheetLayout, n: number): { x: number; y: number } {
  const column = n % layout.columns;
  const row = Math.floor(n / layout.columns);
  return {
    x: layout.gap + column * (layout.tileWidth + layout.gap),
    y: layout.gap + row * (layout.tileHeight + layout.labelHeight + layout.gap),
  };
}

export class ContactSheet {
  readonly layout: SheetLayout;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private scratch: HTMLCanvasElement | null = null;

  constructor(count: number, frameWidth: number, frameHeight: number) {
    this.layout = contactSheetLayout(count, frameWidth, frameHeight);
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.layout.width;
    this.canvas.height = this.layout.height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("could not create the contact sheet canvas");
    this.ctx = ctx;
    ctx.fillStyle = "#0d1016";
    ctx.fillRect(0, 0, this.layout.width, this.layout.height);
  }

  /** Draw frame `n` (GL readback, rows bottom-up) scaled into its tile, with its label underneath. */
  draw(n: number, rgba: Uint8Array, width: number, height: number, label: string): void {
    if (!this.scratch || this.scratch.width !== width || this.scratch.height !== height) {
      this.scratch = document.createElement("canvas");
      this.scratch.width = width;
      this.scratch.height = height;
    }
    const scratchCtx = this.scratch.getContext("2d");
    if (!scratchCtx) return;
    const image = scratchCtx.createImageData(width, height);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      image.data.set(
        rgba.subarray((height - 1 - y) * rowBytes, (height - y) * rowBytes),
        y * rowBytes,
      );
    }
    scratchCtx.putImageData(image, 0, 0);
    const { x, y } = tileOrigin(this.layout, n);
    const { tileWidth, tileHeight, labelHeight } = this.layout;
    this.ctx.imageSmoothingQuality = "high";
    this.ctx.drawImage(this.scratch, x, y, tileWidth, tileHeight);
    this.ctx.fillStyle = "#e8ecf2";
    this.ctx.font = "13px -apple-system, system-ui, sans-serif";
    this.ctx.textBaseline = "middle";
    this.ctx.fillText(label, x + 4, y + tileHeight + labelHeight / 2, tileWidth - 8);
  }

  async png(): Promise<Uint8Array | null> {
    const blob = await new Promise<Blob | null>((resolve) =>
      this.canvas.toBlob(resolve, "image/png"),
    );
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }
}
