import { describe, expect, it, vi } from "vitest";
import { createUserCatalogue, type LibraryItemInfo } from "./library";

const info = (slug: string): LibraryItemInfo => ({
  slug,
  path: `/library/${slug}`,
  manifestJson: "{}",
  projectJson: "{}",
  durationMs: 4000,
  sceneCount: 1,
  posterPath: null,
});

describe("user library refresh", () => {
  it("retains the last successful catalogue when the library becomes unreadable", async () => {
    const list = vi
      .fn<() => Promise<LibraryItemInfo[]>>()
      .mockResolvedValueOnce([info("title")])
      .mockRejectedValueOnce(new Error("Permission denied"));
    const catalogue = createUserCatalogue(list, (item) => item.slug, "presets");
    const changed = vi.fn();
    catalogue.subscribe(changed);
    await catalogue.refresh();
    const previous = catalogue.entries();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(catalogue.refresh()).rejects.toThrow("Could not read your presets library");
      expect(catalogue.entries()).toBe(previous);
      expect(catalogue.version()).toBe(1);
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it("keeps a later refresh when an older listing finishes afterwards", async () => {
    let finishEarlier!: (items: LibraryItemInfo[]) => void;
    const list = vi
      .fn<() => Promise<LibraryItemInfo[]>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishEarlier = resolve;
          }),
      )
      .mockResolvedValueOnce([info("updated")]);
    const catalogue = createUserCatalogue(list, (item) => item.slug, "templates");
    const earlier = catalogue.refresh();
    await catalogue.refresh();
    finishEarlier([info("stale")]);
    await earlier;
    expect(catalogue.entries()).toEqual(["updated"]);
    expect(catalogue.version()).toBe(1);
  });
});
