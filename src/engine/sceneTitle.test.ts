import { describe, expect, it } from "vitest";
import { sceneTitle } from "./sceneTitle";

describe("sceneTitle", () => {
  it("prefers the sidecar name, then the largest text, then the stem, then Scene N", () => {
    expect(sceneTitle({ name: "Intro" }, "Big words", "01-intro", 0)).toBe("Intro");
    expect(sceneTitle({}, "Big words", "01-intro", 0)).toBe("Big words");
    expect(sceneTitle(undefined, null, "01-intro", 0)).toBe("01-intro");
    expect(sceneTitle(null, null, null, 2)).toBe("Scene 3");
  });
});
