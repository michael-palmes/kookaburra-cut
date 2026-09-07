import { describe, expect, it } from "vitest";
import { shortenPath } from "./workspace";

describe("shortenPath", () => {
  const home = "/Users/michael";

  it("abbreviates the home folder", () => {
    expect(shortenPath("/Users/michael/Kookaburra Cut", home)).toBe("~/Kookaburra Cut");
    expect(shortenPath("/Users/michael/Desktop/Vids/Kookaburra Cut", home)).toBe(
      "~/Desktop/Vids/Kookaburra Cut",
    );
    expect(shortenPath(home, home)).toBe("~");
  });

  it("leaves paths outside home alone", () => {
    expect(shortenPath("/Volumes/Media/Kookaburra Cut", home)).toBe(
      "/Volumes/Media/Kookaburra Cut",
    );
    // Another account's folder shares the prefix but is not inside this home.
    expect(shortenPath("/Users/michaela/Kookaburra Cut", home)).toBe(
      "/Users/michaela/Kookaburra Cut",
    );
  });

  it("passes the path through when the home folder is unknown", () => {
    expect(shortenPath("/Users/michael/Kookaburra Cut", null)).toBe(
      "/Users/michael/Kookaburra Cut",
    );
  });
});
