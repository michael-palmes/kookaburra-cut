import { describe, expect, it } from "vitest";
import { frameLayout } from "../toolkit/frame/frameLayout";
import type { FrameSpec } from "../toolkit/frame/types";
import { ndcToStagePx, type Pt, stagePxToNdc } from "../ui/gizmo/gizmo2dMath";
import type { StageRect } from "./gizmoRegistry";
import {
  cutoutStageRect,
  frameWorldCutout,
  setStageCutout,
  stageCutout,
  worldViewportRect,
} from "./stageViewport";

const WIDE = 16 / 9;
const TALL = 9 / 16;

/** The letterboxed canvas box at an arbitrary page offset, so an origin bug cannot pass. Its aspect IS the format's, which is what the live camera carries. */
const frameRect = (aspect: number): StageRect =>
  aspect > 1
    ? { left: 40, top: 12, width: 1920, height: 1080 }
    : { left: 40, top: 12, width: 1080, height: 1920 };

const WIDE_FRAME = frameRect(WIDE);

const spec = (frame: Partial<FrameSpec> & Pick<FrameSpec, "cutout">): FrameSpec => frame;

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

/** The identity the aspect correction exists for: an NDC the live (frame-aspect) camera produces, mapped through the world viewport, lands exactly where the same world point's cutout-aspect NDC lands in the drawn cutout. */
function agrees(ndc: Pt, aspect: number, cutout: ReturnType<typeof frameWorldCutout>): void {
  const frame = frameRect(aspect);
  const drawn = cutoutStageRect(frame, cutout);
  const viewport = worldViewportRect(frame, cutout);
  // A perspective x divides by the aspect, so the same world point reads narrower under the frame's than under the cutout's.
  const live: Pt = [(ndc[0] * (drawn.width / drawn.height)) / aspect, ndc[1]];
  const [x, y] = ndcToStagePx(live, viewport);
  const [dx, dy] = ndcToStagePx(ndc, drawn);
  near(x, dx);
  near(y, dy);
}

describe("frameWorldCutout", () => {
  it("is null wherever the world still fills the frame", () => {
    expect(frameWorldCutout(undefined, WIDE)).toBeNull();
    expect(frameWorldCutout(spec({ cutout: { shape: "none" } }), WIDE)).toBeNull();
    // Only the shape decides: a transparent panel with no cutout still renders full-bleed.
    expect(
      frameWorldCutout(
        spec({ cutout: { shape: "none" }, background: { type: "transparent" } }),
        WIDE,
      ),
    ).toBeNull();
  });

  it("keeps a transparent panel on the cutout path, matching the render", () => {
    const cutout = { shape: "rounded-rect" as const };
    expect(frameWorldCutout(spec({ cutout, background: { type: "transparent" } }), WIDE)).toEqual(
      frameLayout(WIDE, cutout).cutout,
    );
  });

  it("is the layout's cutout for a painted panel, on either side and either axis", () => {
    for (const aspect of [WIDE, TALL]) {
      for (const side of ["start", "end"] as const) {
        const cutout = { shape: "rounded-rect" as const, side };
        expect(frameWorldCutout(spec({ cutout }), aspect)).toEqual(
          frameLayout(aspect, cutout).cutout,
        );
      }
    }
  });

  it("keeps a flat colour panel on the cutout path", () => {
    const cutout = { shape: "squircle" as const };
    expect(frameWorldCutout(spec({ cutout, background: "accent" }), WIDE)).toEqual(
      frameLayout(WIDE, cutout).cutout,
    );
  });
});

describe("cutoutStageRect", () => {
  it("is the frame itself with no cutout, so an unframed scene is untouched", () => {
    expect(cutoutStageRect(WIDE_FRAME, null)).toEqual(WIDE_FRAME);
  });

  it("puts a start-side cutout left of centre and an end-side one right of it (16:9)", () => {
    const start = cutoutStageRect(
      WIDE_FRAME,
      frameWorldCutout(spec({ cutout: { shape: "rect" } }), WIDE),
    );
    const end = cutoutStageRect(
      WIDE_FRAME,
      frameWorldCutout(spec({ cutout: { shape: "rect", side: "end" } }), WIDE),
    );
    const centre = WIDE_FRAME.left + WIDE_FRAME.width / 2;
    expect(start.left + start.width / 2).toBeLessThan(centre);
    expect(end.left + end.width / 2).toBeGreaterThan(centre);
    // One config, mirrored: the two sit symmetrically about the frame centre and match in size.
    near(start.width, end.width);
    near(centre - (start.left + start.width / 2), end.left + end.width / 2 - centre);
    near(start.top, end.top);
  });

  it("splits top and bottom on a tall frame", () => {
    const frame = frameRect(TALL);
    const start = cutoutStageRect(
      frame,
      frameWorldCutout(spec({ cutout: { shape: "rect" } }), TALL),
    );
    const end = cutoutStageRect(
      frame,
      frameWorldCutout(spec({ cutout: { shape: "rect", side: "end" } }), TALL),
    );
    const middle = frame.top + frame.height / 2;
    expect(start.top + start.height / 2).toBeLessThan(middle);
    expect(end.top + end.height / 2).toBeGreaterThan(middle);
    near(start.left, end.left);
  });
});

describe("worldViewportRect", () => {
  it("is the frame itself with no cutout", () => {
    expect(worldViewportRect(WIDE_FRAME, null)).toEqual(WIDE_FRAME);
  });

  it("keeps the cutout's height and centre, and the frame's aspect", () => {
    const cutout = frameWorldCutout(spec({ cutout: { shape: "rect", side: "end" } }), WIDE);
    const drawn = cutoutStageRect(WIDE_FRAME, cutout);
    const viewport = worldViewportRect(WIDE_FRAME, cutout);
    near(viewport.height, drawn.height);
    near(viewport.top, drawn.top);
    near(viewport.left + viewport.width / 2, drawn.left + drawn.width / 2);
    near(viewport.width / viewport.height, WIDE_FRAME.width / WIDE_FRAME.height);
  });

  it("reproduces the cutout mapping on both sides and both axes", () => {
    for (const aspect of [WIDE, TALL]) {
      for (const side of ["start", "end"] as const) {
        const cutout = frameWorldCutout(spec({ cutout: { shape: "rounded-rect", side } }), aspect);
        for (const ndc of [
          [0, 0],
          [1, 1],
          [-1, -1],
          [0.4, -0.7],
        ] as Pt[]) {
          agrees(ndc, aspect, cutout);
        }
      }
    }
  });

  it("round trips client pixels back to the NDC that produced them", () => {
    const cutout = frameWorldCutout(spec({ cutout: { shape: "rect" } }), WIDE);
    const viewport = worldViewportRect(WIDE_FRAME, cutout);
    const px = ndcToStagePx([0.25, -0.6], viewport);
    const back = stagePxToNdc(px, viewport);
    expect(back).not.toBeNull();
    near((back as Pt)[0], 0.25);
    near((back as Pt)[1], -0.6);
  });

  it("leaves a degenerate frame alone rather than dividing by zero", () => {
    const flat: StageRect = { left: 0, top: 0, width: 0, height: 0 };
    const cutout = frameWorldCutout(spec({ cutout: { shape: "rect" } }), WIDE);
    expect(worldViewportRect(flat, cutout)).toEqual(flat);
  });
});

describe("setStageCutout", () => {
  it("publishes the cutout the canvas-side surfaces read, and clears back to null", () => {
    expect(stageCutout()).toBeNull();
    const cutout = frameWorldCutout(spec({ cutout: { shape: "circle" } }), WIDE);
    setStageCutout(cutout);
    expect(stageCutout()).toBe(cutout);
    setStageCutout(null);
    expect(stageCutout()).toBeNull();
  });
});
