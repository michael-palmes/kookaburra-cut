import { describe, expect, it } from "vitest";
import { POPOVER_MAX_HEIGHT, POPOVER_MIN_HEIGHT, placeColourPopover } from "./colourPopoverLayout";

const viewport = { width: 1440, height: 900 };
const box = { width: 288, height: 620 };

describe("placeColourPopover", () => {
  it("sits below the anchor when it fits", () => {
    const place = placeColourPopover({ left: 1000, top: 100, bottom: 120 }, box, viewport);
    expect(place.left).toBe(1000);
    expect(place.top).toBe(126);
    expect(place.maxHeight).toBe(POPOVER_MAX_HEIGHT);
  });

  it("flips above when below cannot hold it and above has more room", () => {
    const place = placeColourPopover({ left: 400, top: 700, bottom: 720 }, box, viewport);
    expect(place.top).toBe(224);
    expect(place.maxHeight).toBe(POPOVER_MAX_HEIGHT);
  });

  it("stays below when neither side fits but below is the roomier one", () => {
    const place = placeColourPopover({ left: 400, top: 400, bottom: 420 }, box, viewport);
    // Short of the cap: the room available wins whenever it is the smaller of the two.
    expect(place.maxHeight).toBe(466);
    expect(place.top + Math.min(box.height, place.maxHeight)).toBeLessThanOrEqual(892);
  });

  it("clamps to the right edge", () => {
    const place = placeColourPopover({ left: 1400, top: 100, bottom: 120 }, box, viewport);
    expect(place.left).toBe(1144);
  });

  it("keeps the left margin when the viewport is narrower than the box", () => {
    const place = placeColourPopover({ left: 100, top: 100, bottom: 120 }, box, {
      width: 200,
      height: 900,
    });
    expect(place.left).toBe(8);
  });

  it("never grows past the cap even when the viewport is huge", () => {
    const place = placeColourPopover({ left: 100, top: 100, bottom: 120 }, box, {
      width: 1440,
      height: 2000,
    });
    expect(place.maxHeight).toBe(POPOVER_MAX_HEIGHT);
  });

  it("stays below when the cap fits under the anchor, without flipping", () => {
    const place = placeColourPopover({ left: 400, top: 300, bottom: 320 }, box, viewport);
    expect(place.top).toBe(326);
  });

  it("never reports a max height below the floor", () => {
    const place = placeColourPopover({ left: 100, top: 260, bottom: 280 }, box, {
      width: 1440,
      height: 300,
    });
    expect(place.maxHeight).toBeGreaterThanOrEqual(POPOVER_MIN_HEIGHT);
  });
});
