import { describe, expect, it } from "vitest";
import { collectParseWarnings } from "./parseWarnings";
import { parseSceneDoc } from "./sceneDocSchema";
import {
  MOSAIC_DEFAULT_REVEAL,
  mosaicGrid,
  mosaicRevealEndMs,
  mosaicRevealRanks,
  mosaicTileKind,
  mosaicTileRects,
  mosaicTileReveal,
  mosaicVideoSources,
  resolveMosaic,
  resolveMosaicReveal,
  resolveSceneColour,
} from "./sceneMosaic";

const LANDSCAPE = 16 / 9;
const PORTRAIT = 9 / 16;
const colors = { background: "#000000", text: "#ffffff", accent: "#ff0000", muted: "#808080" };

describe("mosaicGrid", () => {
  it("reflows per aspect toward square tiles", () => {
    expect(mosaicGrid(3, LANDSCAPE)).toEqual({ columns: 3, rows: 1 });
    expect(mosaicGrid(3, PORTRAIT)).toEqual({ columns: 1, rows: 3 });
    expect(mosaicGrid(6, LANDSCAPE)).toEqual({ columns: 3, rows: 2 });
    expect(mosaicGrid(6, PORTRAIT)).toEqual({ columns: 2, rows: 3 });
    expect(mosaicGrid(4, LANDSCAPE)).toEqual({ columns: 2, rows: 2 });
    expect(mosaicGrid(1, LANDSCAPE)).toEqual({ columns: 1, rows: 1 });
  });

  it("clamps a fixed column count to the tiles", () => {
    expect(mosaicGrid(5, LANDSCAPE, 2)).toEqual({ columns: 2, rows: 3 });
    expect(mosaicGrid(3, LANDSCAPE, 9)).toEqual({ columns: 3, rows: 1 });
    expect(mosaicGrid(3, LANDSCAPE, 0)).toEqual({ columns: 1, rows: 3 });
  });
});

describe("mosaicTileRects", () => {
  it("fills the area edge to edge with gaps only between tiles", () => {
    const rects = mosaicTileRects(4, { width: 4, height: 2 }, { columns: 2, rows: 2 }, 0.2);
    expect(rects[0]).toEqual({ x: -1.05, y: 0.55, width: 1.9, height: 0.9, row: 0, column: 0 });
    expect(rects[3].x + rects[3].width / 2).toBeCloseTo(2);
    expect(rects[3].y - rects[3].height / 2).toBeCloseTo(-1);
  });

  it("stretches a short last row across the width", () => {
    const rects = mosaicTileRects(3, { width: 4, height: 2 }, { columns: 2, rows: 2 }, 0);
    expect(rects[2]).toEqual({ x: 0, y: -0.5, width: 4, height: 1, row: 1, column: 0 });
  });
});

describe("mosaicRevealRanks", () => {
  const rects = mosaicTileRects(6, { width: 3, height: 2 }, { columns: 3, rows: 2 }, 0);

  it("ranks rows in reading order", () => {
    expect(mosaicRevealRanks(rects, "rows")).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("ranks columns left to right, top first", () => {
    expect(mosaicRevealRanks(rects, "columns")).toEqual([0, 2, 4, 1, 3, 5]);
  });

  it("ranks rings from the centre, equidistant tiles together", () => {
    expect(mosaicRevealRanks(rects, "centre")).toEqual([1, 0, 1, 1, 0, 1]);
  });
});

describe("mosaic reveal", () => {
  it("staggers each rank and settles at 1", () => {
    const reveal = resolveMosaicReveal({ at: 100, staggerMs: 50, durationMs: 200, ease: "linear" });
    expect(mosaicTileReveal(99, 0, reveal)).toBe(0);
    expect(mosaicTileReveal(200, 0, reveal)).toBe(0.5);
    expect(mosaicTileReveal(200, 2, reveal)).toBe(0);
    expect(mosaicTileReveal(400, 2, reveal)).toBe(1);
  });

  it("settles when the last-ranked tile does", () => {
    const reveal = resolveMosaicReveal({ at: 100, staggerMs: 50, durationMs: 200, ease: "linear" });
    expect(mosaicRevealEndMs([0, 2, 1], reveal)).toBe(400);
    expect(mosaicTileReveal(mosaicRevealEndMs([0, 2, 1], reveal), 2, reveal)).toBe(1);
    expect(mosaicRevealEndMs([], reveal)).toBe(300);
  });

  it("layers reveal fields over the defaults, skipping absent ones", () => {
    expect(resolveMosaicReveal(undefined)).toEqual(MOSAIC_DEFAULT_REVEAL);
    expect(
      resolveMosaicReveal({ at: 300, order: "centre" }, { at: undefined, staggerMs: 0 }),
    ).toEqual({ ...MOSAIC_DEFAULT_REVEAL, at: 300, order: "centre", staggerMs: 0 });
  });
});

describe("sidecar mosaic", () => {
  it("parses tiles and fields, dropping what the app can't draw", () => {
    const { result: doc, warnings } = collectParseWarnings(() =>
      parseSceneDoc(
        {
          version: 1,
          mosaic: {
            tiles: [
              { src: "assets/a.jpg" },
              { src: "assets/clip.mp4", startMs: 200, loop: true },
              { colour: "accent" },
              { src: "assets/notes.txt" },
              { src: "/abs/b.png" },
              { colour: "#12345" },
            ],
            columns: 2.5,
            gap: 0.03,
            reveal: { at: 400, order: "diagonal", ease: "outBack", staggerMs: -1 },
            extra: true,
          },
        },
        "test",
      ),
    );
    expect(doc?.mosaic).toEqual({
      tiles: [
        { src: "assets/a.jpg" },
        { src: "assets/clip.mp4", startMs: 200, loop: true },
        { colour: "accent" },
        {},
      ],
      gap: 0.03,
      reveal: { at: 400, ease: "outBack" },
    });
    expect(warnings.map((w) => w.replace("[sceneDoc] test: ", ""))).toEqual([
      "mosaic.extra isn't a mosaic field, ignored",
      "mosaic.tiles[3].src isn't a project image or video, dropped",
      "mosaic.tiles[4].src isn't a project image or video, dropped",
      "mosaic.tiles[5].colour isn't a hex or theme colour, dropped",
      "mosaic.columns isn't a whole number from 1, dropped",
      "mosaic.reveal.staggerMs isn't a non-negative number, dropped",
      "mosaic.reveal.order isn't rows|columns|centre, dropped",
    ]);
  });

  it("drops a block with no usable tiles", () => {
    const { result, warnings } = collectParseWarnings(() => [
      parseSceneDoc({ version: 1, mosaic: { tiles: [] } }, "test")?.mosaic,
      parseSceneDoc({ version: 1, mosaic: [] }, "test")?.mosaic,
    ]);
    expect(result).toEqual([undefined, undefined]);
    expect(warnings).toHaveLength(2);
  });

  it("resolves defaults and lists video sources", () => {
    const doc = {
      version: 1,
      mosaic: { tiles: [{ src: "assets/a.png" }, { src: "assets/b.mov" }, {}] },
    };
    expect(resolveMosaic(doc.mosaic)).toEqual({
      tiles: doc.mosaic.tiles,
      gap: 0.02,
      reveal: MOSAIC_DEFAULT_REVEAL,
    });
    expect(resolveMosaic(undefined)).toBeNull();
    expect(mosaicVideoSources(doc)).toEqual(["assets/b.mov"]);
    expect(doc.mosaic.tiles.map(mosaicTileKind)).toEqual(["image", "video", "colour"]);
  });

  it("resolves a hex or a theme token, else the fallback token", () => {
    expect(resolveSceneColour("accent", colors, "muted")).toBe("#ff0000");
    expect(resolveSceneColour("#123456", colors, "muted")).toBe("#123456");
    expect(resolveSceneColour(undefined, colors, "muted")).toBe("#808080");
  });
});
