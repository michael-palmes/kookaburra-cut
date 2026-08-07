import { describe, expect, it } from "vitest";
import { resolveDocPatchIndex } from "./useSceneDocPatch";

const files = ["scenes/01-title.tsx", "scenes/02-device.tsx", "scenes/03-outro.tsx"];

describe("resolveDocPatchIndex", () => {
  it("keeps the index when the file is still there", () => {
    expect(resolveDocPatchIndex(files, 1, "scenes/02-device.tsx")).toBe(1);
  });

  it("follows the file when an insert shifted the scene down", () => {
    const after = ["scenes/01-title.tsx", "scenes/04-new.tsx", ...files.slice(1)];
    expect(resolveDocPatchIndex(after, 1, "scenes/02-device.tsx")).toBe(2);
  });

  it("follows the file when a reorder moved the scene up", () => {
    const after = ["scenes/02-device.tsx", "scenes/01-title.tsx", "scenes/03-outro.tsx"];
    expect(resolveDocPatchIndex(after, 1, "scenes/02-device.tsx")).toBe(0);
  });

  it("drops the patch when the scene left the project", () => {
    expect(resolveDocPatchIndex(["scenes/01-title.tsx"], 1, "scenes/02-device.tsx")).toBeNull();
  });

  it("never lands a device doc on the title scene that took its index", () => {
    // The phantom device: the write targeted 02-device, an insert shifted it to 2.
    const after = ["scenes/01-title.tsx", "scenes/00-new-title.tsx", ...files.slice(1)];
    expect(resolveDocPatchIndex(after, 1, "scenes/02-device.tsx")).not.toBe(1);
  });

  it("matches regardless of a leading ./ on either side", () => {
    expect(resolveDocPatchIndex(files, 0, "./scenes/01-title.tsx")).toBe(0);
    expect(resolveDocPatchIndex(["./scenes/02-device.tsx"], 0, "scenes/02-device.tsx")).toBe(0);
  });

  it("falls back to the bounds check when no file is given", () => {
    expect(resolveDocPatchIndex(files, 2)).toBe(2);
    expect(resolveDocPatchIndex(files, 3)).toBeNull();
    expect(resolveDocPatchIndex(files, -1)).toBeNull();
  });
});
