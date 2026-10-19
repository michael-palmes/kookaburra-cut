import { describe, expect, it, vi } from "vitest";
import {
  capWarnings,
  cleanParseWarning,
  collectParseWarnings,
  parseInto,
  parseWarn,
} from "./parseWarnings";

describe("parse warnings", () => {
  it("collect inside a collector and reach the console outside one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result, warnings } = collectParseWarnings(() => {
      parseWarn("first");
      parseWarn("second");
      return 7;
    });
    expect(result).toBe(7);
    expect(warnings).toEqual(["first", "second"]);
    expect(warn).not.toHaveBeenCalled();
    parseWarn("loose");
    expect(warn).toHaveBeenCalledWith("loose");
    warn.mockRestore();
  });

  it("nest without leaking and restore after a throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outer = collectParseWarnings(() => {
      parseWarn("outer");
      const inner = collectParseWarnings(() => parseWarn("inner"));
      expect(inner.warnings).toEqual(["inner"]);
    });
    expect(outer.warnings).toEqual(["outer"]);
    expect(() =>
      collectParseWarnings(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    parseWarn("after");
    expect(warn).toHaveBeenCalledWith("after");
    warn.mockRestore();
  });

  it("refuse an async parse", () => {
    expect(() => collectParseWarnings(async () => parseWarn("late"))).toThrow(/synchronous/);
  });

  it("parseInto collects only when given a list", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const into: string[] = [];
    const parsed = parseInto(into, () => {
      parseWarn("a");
      return 1;
    });
    expect(parsed).toBe(1);
    expect(into).toEqual(["a"]);
    parseInto(undefined, () => parseWarn("b"));
    expect(warn).toHaveBeenCalledWith("b");
    warn.mockRestore();
  });

  it("clean the tag and source off a message", () => {
    expect(cleanParseWarning('[theme] ws:brand: "card" is invalid', "ws:brand")).toBe(
      '"card" is invalid',
    );
    expect(cleanParseWarning("[sceneDoc] demo/scenes/01.json: bad", "scenes/01.json")).toBe("bad");
    expect(cleanParseWarning("[theme] demo/scenes/01.json backing: bad", "scenes/01.json")).toBe(
      "backing: bad",
    );
    expect(cleanParseWarning("[project] audio.markers invalid", "project.json")).toBe(
      "audio.markers invalid",
    );
  });

  it("cap a deduped list with a count of the rest", () => {
    expect(capWarnings(["a", "a", "b"])).toEqual(["a", "b"]);
    const many = Array.from({ length: 45 }, (_, i) => `w${i}`);
    const capped = capWarnings(many);
    expect(capped).toHaveLength(40);
    expect(capped[39]).toBe("and 6 more settings were ignored");
  });
});
