/** 2D contact-sheet layout: tiles land in a body canvas as they render, then `composeSheet` wraps it with the header and the diagnostics footer. */

export interface TileSlot {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SheetRow {
  title: string;
  detail: string;
}

export interface SheetColumn {
  title: string;
  width: number;
}

const BG = "#16181c";
const INK = "#d8dce2";
const DIM = "#8b93a0";
const RED = "#ff7a6e";
const AMBER = "#e8b85a";
const FONT = "-apple-system, 'Helvetica Neue', Arial, sans-serif";
const GAP = 6;
const LABEL_W = 132;
const COL_HEAD = 18;
const CAPTION = 20;

export class SheetBody {
  readonly canvas = document.createElement("canvas");
  private readonly slots: TileSlot[][] = [];

  /** Sheet mode: a label column, then one tile per column, rows top to bottom. */
  static rows(rows: SheetRow[], cols: SheetColumn[], tileHeight: number): SheetBody {
    const body = new SheetBody();
    const width = LABEL_W + cols.reduce((sum, c) => sum + c.width + GAP, 0);
    const height = COL_HEAD + rows.length * (tileHeight + GAP);
    const g = body.begin(width, height);
    g.fillStyle = DIM;
    g.font = `12px ${FONT}`;
    let x = LABEL_W;
    for (const col of cols) {
      g.fillText(col.title, x + 2, 13);
      x += col.width + GAP;
    }
    rows.forEach((row, r) => {
      const y = COL_HEAD + r * (tileHeight + GAP);
      g.fillStyle = INK;
      g.font = `600 13px ${FONT}`;
      wrapText(g, row.title, 8, y + 16, LABEL_W - 14, 16);
      g.fillStyle = DIM;
      g.font = `12px ${FONT}`;
      wrapText(g, row.detail, 8, y + 52, LABEL_W - 14, 15);
      let cx = LABEL_W;
      body.slots[r] = cols.map((col) => {
        const slot = { x: cx, y, width: col.width, height: tileHeight };
        cx += col.width + GAP;
        return slot;
      });
    });
    return body;
  }

  /** Grid mode: captioned tiles, `perRow` across. */
  static grid(captions: string[], tile: { width: number; height: number }, perRow: number) {
    const body = new SheetBody();
    const cols = Math.min(perRow, captions.length);
    const rows = Math.ceil(captions.length / cols);
    const g = body.begin(
      GAP + cols * (tile.width + GAP),
      GAP + rows * (tile.height + CAPTION + GAP),
    );
    captions.forEach((caption, i) => {
      const x = GAP + (i % cols) * (tile.width + GAP);
      const y = GAP + Math.floor(i / cols) * (tile.height + CAPTION + GAP);
      g.fillStyle = INK;
      g.font = `12px ${FONT}`;
      g.fillText(caption, x + 2, y + tile.height + 14);
      body.slots[i] = [{ x, y, ...tile }];
    });
    return body;
  }

  /** Raw mode: exactly one tile, no chrome. */
  static single(tile: { width: number; height: number }): SheetBody {
    const body = new SheetBody();
    body.begin(tile.width, tile.height);
    body.slots[0] = [{ x: 0, y: 0, ...tile }];
    return body;
  }

  slot(row: number, col: number): TileSlot {
    return this.slots[row][col];
  }

  get context(): CanvasRenderingContext2D {
    return this.canvas.getContext("2d") as CanvasRenderingContext2D;
  }

  private begin(width: number, height: number): CanvasRenderingContext2D {
    this.canvas.width = Math.ceil(width);
    this.canvas.height = Math.ceil(height);
    const g = this.context;
    g.fillStyle = BG;
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    return g;
  }
}

/** Paints |b - a| (max channel, x4) into `out` and returns the mean change and the share of pixels that moved more than 2 codes. */
export function motionTile(
  g: CanvasRenderingContext2D,
  a: TileSlot,
  b: TileSlot,
  out: TileSlot,
): { mean: number; moving: number } {
  const pa = g.getImageData(a.x, a.y, a.width, a.height).data;
  const pb = g.getImageData(b.x, b.y, b.width, b.height).data;
  const img = g.createImageData(out.width, out.height);
  let sum = 0;
  let moving = 0;
  for (let i = 0; i < pa.length; i += 4) {
    const d = Math.max(
      Math.abs(pa[i] - pb[i]),
      Math.abs(pa[i + 1] - pb[i + 1]),
      Math.abs(pa[i + 2] - pb[i + 2]),
    );
    sum += d;
    if (d > 2) moving++;
    const v = Math.min(255, d * 4);
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, out.x, out.y);
  const n = pa.length / 4;
  const stats = { mean: sum / n, moving: moving / n };
  g.fillStyle = AMBER;
  g.font = `11px ${FONT}`;
  g.fillText(
    `mean ${stats.mean.toFixed(1)} · ${Math.round(stats.moving * 100)}% moved`,
    out.x + 6,
    out.y + 14,
  );
  return stats;
}

/** Box-filters a bottom-up RGBA readback by an integer factor into a top-down ImageData. */
export function boxDownsample(src: Uint8Array, width: number, height: number, factor: number) {
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new ImageData(w, h);
  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (height - 1 - (y * factor + dy)) * width;
        for (let dx = 0; dx < factor; dx++) {
          const i = (row + x * factor + dx) * 4;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
        }
      }
      const o = (y * w + x) * 4;
      out.data[o] = Math.round(r / n);
      out.data[o + 1] = Math.round(g / n);
      out.data[o + 2] = Math.round(b / n);
      out.data[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

function wrapText(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines = 4,
): number {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (g.measureText(next).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown[maxLines - 1] += " ...";
  shown.forEach((l, i) => {
    g.fillText(l, x, y + i * lineHeight);
  });
  return shown.length;
}

export interface Diagnostic {
  level: "error" | "warning";
  text: string;
  count: number;
}

/** Header, body and the diagnostics footer as one canvas. */
export function composeSheet(
  body: SheetBody,
  header: string[],
  diagnostics: Diagnostic[],
): HTMLCanvasElement {
  const width = Math.max(body.canvas.width, 720);
  const footerLines: { color: string; text: string }[] = [];
  if (diagnostics.length === 0) {
    footerLines.push({ color: DIM, text: "No console or shader errors." });
  }
  for (const d of diagnostics.slice(0, 24)) {
    const tag = d.level === "error" ? "ERROR" : "warn";
    const first = `${tag}${d.count > 1 ? ` x${d.count}` : ""}: `;
    const lines = d.text.split("\n").slice(0, d.level === "error" ? 14 : 3);
    lines.forEach((line, i) => {
      footerLines.push({
        color: d.level === "error" ? RED : AMBER,
        text: `${i === 0 ? first : "    "}${line}`.slice(0, 260),
      });
    });
  }
  if (diagnostics.length > 24) {
    footerLines.push({ color: DIM, text: `... ${diagnostics.length - 24} more (see the report)` });
  }
  const headH = 14 + header.length * 18;
  const footH = 12 + footerLines.length * 15;
  const out = document.createElement("canvas");
  out.width = width;
  out.height = headH + body.canvas.height + footH;
  const g = out.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = BG;
  g.fillRect(0, 0, out.width, out.height);
  header.forEach((line, i) => {
    g.fillStyle = i === 0 ? INK : DIM;
    g.font = i === 0 ? `600 14px ${FONT}` : `12px ${FONT}`;
    g.fillText(line, 8, 20 + i * 18);
  });
  g.drawImage(body.canvas, 0, headH);
  g.font = `12px ui-monospace, Menlo, monospace`;
  footerLines.forEach((line, i) => {
    g.fillStyle = line.color;
    g.fillText(line.text, 8, headH + body.canvas.height + 16 + i * 15);
  });
  return out;
}
