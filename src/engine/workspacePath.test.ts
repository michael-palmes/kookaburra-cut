import { describe, expect, it } from "vitest";
import { shortenPath } from "./workspace";

describe("shortenPath", () => {
  const home = "/Users/x";

  it("abbreviates the home folder", () => {
    expect(shortenPath("/Users/x/Kookaburra Cut", home)).toBe("~/Kookaburra Cut");
    expect(shortenPath("/Users/x/Desktop/Vids/Kookaburra Cut", home)).toBe(
      "~/Desktop/Vids/Kookaburra Cut",
    );
    expect(shortenPath(home, home)).toBe("~");
  });

  it("leaves paths outside home alone", () => {
    expect(shortenPath("/Volumes/Media/Kookaburra Cut", home)).toBe(
      "/Volumes/Media/Kookaburra Cut",
    );
    // Another account's folder shares the prefix but is not inside this home.
    expect(shortenPath("/Users/x-other/Kookaburra Cut", home)).toBe(
      "/Users/x-other/Kookaburra Cut",
    );
  });

  it("passes the path through when the home folder is unknown", () => {
    expect(shortenPath("/Users/x/Kookaburra Cut", null)).toBe("/Users/x/Kookaburra Cut");
  });
});
