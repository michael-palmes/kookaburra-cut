import { describe, expect, it } from "vitest";
import { allowedProjectRows } from "./appData";

const NOW = Date.UTC(2026, 10, 6, 12);
const record = (path: string, ago: number) => ({
  scenesFingerprint: "f",
  path,
  allowedAtMs: NOW - ago,
});

describe("allowedProjectRows", () => {
  it("names each grant, shortens its folder and says when it was allowed", () => {
    const rows = allowedProjectRows(
      {
        "product-tour": record("/Users/x/Kookaburra Cut/product-tour", 20_000),
        "ws-template:launch_kit": record(
          "/Users/x/Kookaburra Cut/templates/launch_kit",
          3 * 3_600_000,
        ),
        "ws-preset:highlights": record("/Volumes/Work/presets/highlights", 48 * 3_600_000),
      },
      null,
      "/Users/x",
      NOW,
    );
    expect(rows.map((row) => row.name)).toEqual(["Highlights", "Launch kit", "Product tour"]);
    expect(rows[2].detail).toBe("~/Kookaburra Cut/product-tour · allowed just now");
    expect(rows[1].detail).toMatch(
      /^Template · ~\/Kookaburra Cut\/templates\/launch_kit · allowed .*hour/,
    );
    expect(rows[0].detail).toMatch(
      /^Scene preset · \/Volumes\/Work\/presets\/highlights · allowed /,
    );
    expect(rows.some((row) => row.open)).toBe(false);
  });

  it("marks the project open in the main window, whichever id shape it has", () => {
    const trusted = {
      "product-tour": record("/w/product-tour", 0),
      "ws-template:launch-kit": record("/w/templates/launch-kit", 0),
    };
    const open = (last: string) =>
      allowedProjectRows(trusted, last, null, NOW)
        .filter((row) => row.open)
        .map((row) => row.key);
    expect(open("ws:product-tour")).toEqual(["product-tour"]);
    expect(open("ws-template:launch-kit")).toEqual(["ws-template:launch-kit"]);
    expect(open("product-tour")).toEqual([]);
  });

  it("is empty with nothing allowed", () => {
    expect(allowedProjectRows(undefined, null, null, NOW)).toEqual([]);
  });
});
