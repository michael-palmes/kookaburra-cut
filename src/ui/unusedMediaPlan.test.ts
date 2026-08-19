import { describe, expect, it } from "vitest";
import type { MediaDeleteFailure, UnusedAsset } from "../engine/media";
import {
  allUnusedRels,
  toggleUnusedRel,
  unusedOutcome,
  unusedSummary,
  unusedTotals,
} from "./unusedMediaPlan";

function asset(rel: string, bytes: number): UnusedAsset {
  return { rel, bytes, kind: rel.endsWith(".mp4") ? "video" : "image" };
}

function failure(rel: string): MediaDeleteFailure {
  return { rel, message: `${rel} is still used by: 02-hero.json` };
}

describe("allUnusedRels", () => {
  it("arms every row, so the sheet opens ready to sweep", () => {
    const assets = [asset("assets/one.mp4", 10), asset("assets/two.png", 20)];

    expect(allUnusedRels(assets)).toEqual(new Set(["assets/one.mp4", "assets/two.png"]));
    expect(allUnusedRels([])).toEqual(new Set());
  });
});

describe("unusedTotals", () => {
  it("sums only the ticked rows", () => {
    const assets = [asset("assets/one.mp4", 1000), asset("assets/two.png", 24)];

    expect(unusedTotals(assets, new Set(["assets/two.png"]))).toEqual({ count: 1, bytes: 24 });
    expect(unusedTotals(assets, new Set(["assets/one.mp4", "assets/two.png"]))).toEqual({
      count: 2,
      bytes: 1024,
    });
  });

  it("ignores a tick for a row that is no longer listed", () => {
    const assets = [asset("assets/one.mp4", 1000)];

    expect(unusedTotals(assets, new Set(["assets/one.mp4", "assets/gone.png"]))).toEqual({
      count: 1,
      bytes: 1000,
    });
  });

  it("is empty when nothing is ticked", () => {
    expect(unusedTotals([asset("assets/one.mp4", 1000)], new Set())).toEqual({
      count: 0,
      bytes: 0,
    });
  });
});

describe("toggleUnusedRel", () => {
  it("adds a missing rel and drops a present one, always in a new Set", () => {
    const selected = new Set(["assets/one.mp4"]);

    const added = toggleUnusedRel(selected, "assets/two.png");
    expect(added).toEqual(new Set(["assets/one.mp4", "assets/two.png"]));
    expect(added).not.toBe(selected);

    const dropped = toggleUnusedRel(selected, "assets/one.mp4");
    expect(dropped).toEqual(new Set());
    expect(dropped).not.toBe(selected);
  });
});

describe("unusedSummary", () => {
  it("counts files in singular and plural", () => {
    expect(unusedSummary({ count: 0, bytes: 0 })).toBe("Nothing ticked");
    expect(unusedSummary({ count: 1, bytes: 831488 })).toBe(
      "1 file · 812 KB will move to the Trash",
    );
    expect(unusedSummary({ count: 4, bytes: 13002343 })).toBe(
      "4 files · 12.4 MB will move to the Trash",
    );
  });

  it("renders sizes in units, never raw bytes", () => {
    expect(unusedSummary({ count: 1, bytes: 1024 })).toContain("1.0 KB");
    expect(unusedSummary({ count: 1, bytes: 1048576 })).toContain("1.0 MB");
    expect(unusedSummary({ count: 1, bytes: 209715200 })).toContain("200 MB");
  });
});

describe("unusedOutcome", () => {
  it("says nothing when every ticked file went", () => {
    expect(unusedOutcome(5, [])).toBeNull();
    expect(unusedOutcome(0, [])).toBeNull();
  });

  it("names both counts on a partial sweep", () => {
    expect(unusedOutcome(3, [failure("assets/a.mp4"), failure("assets/b.png")])).toBe(
      "Moved 3 files to the Trash. 2 files stayed put:",
    );
    expect(unusedOutcome(1, [failure("assets/a.mp4")])).toBe(
      "Moved 1 file to the Trash. 1 file stayed put:",
    );
  });

  it("says nothing was deleted when the whole sweep was refused", () => {
    expect(unusedOutcome(0, [failure("assets/a.mp4")])).toBe(
      "Nothing was deleted. 1 file stayed put:",
    );
  });
});
