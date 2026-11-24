import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { collectParseWarnings } from "./parseWarnings";
import { parseSceneDoc, SCENE_DOC_VERSION } from "./sceneDocSchema";

/** Every top-level block the parser reads. */
const BLOCKS = [
  "name",
  "headerIcon",
  "duration",
  "text",
  "managedText",
  "textLayout",
  "textStyle",
  "textLook",
  "textLookForce",
  "textLookOverrides",
  "textAnimation",
  "textAnimationForce",
  "textAnimationOverrides",
  "devices",
  "deviceLayout",
  "deviceTrack",
  "layeredScreenshot",
  "images",
  "media",
  "videoWindow",
  "mosaic",
  "compare",
  "chart",
  "terminal",
  "website",
  "objects",
  "room",
  "frame",
  "backdrop",
  "background",
  "lighting",
  "camera",
  "cameraMode",
  "cameraRig",
  "cameraKicks",
  "animatedTrack",
  "motionBlur",
  "taps",
  "stills",
  "themeId",
] as const;

/** A sidecar-shaped object: a readable version and any mix of the blocks, each holding anything. */
const docLike = fc.record(
  {
    version: fc.integer({ min: 1, max: SCENE_DOC_VERSION }),
    ...Object.fromEntries(BLOCKS.map((block) => [block, fc.anything()])),
  },
  { requiredKeys: ["version"] },
);

const parse = (raw: unknown, source: string) =>
  collectParseWarnings(() => parseSceneDoc(raw, source));

describe("parseSceneDoc", () => {
  it("never throws, whatever the sidecar holds", () => {
    fc.assert(
      fc.property(fc.oneof(fc.anything(), docLike), (raw) => {
        const { result } = parse(raw, "property");
        if (result) expect(result.version).toBe((raw as { version: number }).version);
      }),
    );
  });

  it("ignores the website block a sidecar kept from before live websites were removed", () => {
    const retired = parse(
      {
        version: 1,
        name: "Demo",
        website: {
          url: "https://example.com/product",
          requestedOrigins: ["https://example.com"],
          capture: { src: "assets/website/01-intro.png", width: 1440, height: 900 },
        },
      },
      "retired",
    );
    expect(retired.warnings).toEqual([]);
    expect(retired.result).not.toHaveProperty("website");
    expect(retired.result).toEqual(parse({ version: 1, name: "Demo" }, "plain").result);
  });

  it("reads its own output back without a warning and unchanged", () => {
    fc.assert(
      fc.property(docLike, (raw) => {
        const { result } = parse(raw, "property");
        fc.pre(result !== undefined);
        const again = parse(result, "again");
        expect(again.warnings).toEqual([]);
        expect(again.result).toEqual(result);
      }),
    );
  });
});
