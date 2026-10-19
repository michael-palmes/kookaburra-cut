import { describe, expect, it } from "vitest";
import { collectParseWarnings } from "./parseWarnings";
import { parseSceneDoc } from "./sceneDocSchema";
import { screenTaps, worldTaps } from "./sceneTaps";

const parse = (taps: unknown) =>
  collectParseWarnings(() => parseSceneDoc({ version: 1, taps }, "test")?.taps);
const clean = (warnings: string[]) => warnings.map((w) => w.replace("[sceneDoc] test: ", ""));

describe("sidecar taps", () => {
  it("keeps world and screen taps with their optional fields", () => {
    const { result, warnings } = parse([
      { at: 400, position: [0.5, -0.2, 0.1], colour: "accent", size: 1.5 },
      { at: 900, screenUv: [0.5, 0.7], device: "d1", colour: "#ffcc00" },
    ]);
    expect(result).toEqual([
      { at: 400, position: [0.5, -0.2, 0.1], colour: "accent", size: 1.5 },
      { at: 900, screenUv: [0.5, 0.7], device: "d1", colour: "#ffcc00" },
    ]);
    expect(warnings).toEqual([]);
  });

  it("drops what can't be placed and falls back on bad optional fields", () => {
    const { result, warnings } = parse([
      { at: -1, position: [0, 0, 0] },
      { at: 100, screenUv: [0.5, 0.5] },
      { at: 200, position: [0, 0] },
      "tap",
      {
        at: 300,
        position: [0, 0, 0],
        screenUv: [0.2, 0.2],
        device: "d2",
        size: 0,
        colour: "red",
        why: 1,
      },
    ]);
    expect(result).toEqual([{ at: 300, screenUv: [0.2, 0.2], device: "d2" }]);
    expect(clean(warnings)).toEqual([
      "taps[0].at isn't a non-negative number, dropped",
      "taps[1] needs a position [x, y, z] or screenUv [u, v] with a device, dropped",
      "taps[2] needs a position [x, y, z] or screenUv [u, v] with a device, dropped",
      "taps[3] isn't an object, dropped",
      "taps[4].why isn't a tap field, ignored",
      "taps[4] has screenUv and position, using screenUv",
      "taps[4].colour isn't a hex or theme colour, dropped",
      "taps[4].size isn't a positive number, dropped",
    ]);
  });

  it("drops a block that isn't an array or keeps nothing", () => {
    expect(parse({ at: 0 }).result).toBeUndefined();
    expect(parse([]).result).toBeUndefined();
  });

  it("splits world taps from each device's screen taps", () => {
    const doc = {
      version: 1,
      taps: [
        { at: 0, position: [0, 0, 0] as [number, number, number] },
        { at: 100, screenUv: [0.5, 0.5] as [number, number], device: "d1" },
        { at: 200, screenUv: [0.1, 0.9] as [number, number], device: "d2" },
      ],
    };
    expect(worldTaps(doc).map((t) => t.at)).toEqual([0]);
    expect(screenTaps(doc, "d1").map((t) => t.at)).toEqual([100]);
    expect(screenTaps(doc, undefined)).toEqual([]);
    expect(worldTaps(null)).toEqual([]);
  });
});
