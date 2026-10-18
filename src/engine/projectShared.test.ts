import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ProjectSharedContext,
  parseProjectShared,
  resolveSharedPath,
  useProjectShared,
} from "./projectShared";

describe("parseProjectShared", () => {
  it("is undefined when absent", () => {
    expect(parseProjectShared(undefined, "p/project.json")).toBeUndefined();
  });

  it("drops non-objects with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const raw of [null, 3, "x", [1, 2]]) {
      expect(parseProjectShared(raw, "p/project.json")).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[0][0]).toContain("p/project.json: shared must be an object");
    warn.mockRestore();
  });

  it("deep-freezes a copy and leaves the manifest alone", () => {
    const raw = { palette: { accent: "#ff6a3d" }, beats: [0, 480] };
    const shared = parseProjectShared(raw, "p/project.json");
    expect(shared).toEqual(raw);
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(shared?.palette)).toBe(true);
    expect(Object.isFrozen(shared?.beats)).toBe(true);
    expect(Object.isFrozen(raw.palette)).toBe(false);
  });
});

describe("resolveSharedPath", () => {
  const shared = { palette: { accent: "#ff6a3d" }, beats: [0, 480], none: null };
  it("walks objects and array indexes", () => {
    expect(resolveSharedPath(shared, "palette.accent")).toBe("#ff6a3d");
    expect(resolveSharedPath(shared, "beats.1")).toBe(480);
    expect(resolveSharedPath(shared, "none")).toBeNull();
  });
  it("is undefined for missing steps and inherited keys", () => {
    expect(resolveSharedPath(shared, "palette.muted")).toBeUndefined();
    expect(resolveSharedPath(shared, "beats.x")).toBeUndefined();
    expect(resolveSharedPath(shared, "palette.toString")).toBeUndefined();
    expect(resolveSharedPath(shared, "palette.accent.length")).toBeUndefined();
  });
});

describe("useProjectShared", () => {
  let seen: unknown;
  const useAny = useProjectShared as (path?: string, fallback?: unknown) => unknown;
  function Probe({ path, fallback }: { path?: string; fallback?: unknown }) {
    seen = useAny(path, fallback);
    return null;
  }
  const read = (value: unknown, path?: string, fallback?: unknown) => {
    seen = Symbol("unset");
    const probe = createElement(Probe, { path, fallback });
    renderToStaticMarkup(
      value === undefined
        ? probe
        : createElement(ProjectSharedContext.Provider, { value: value as never }, probe),
    );
    return seen;
  };

  it("returns the whole block, a path, or the fallback", () => {
    const shared = parseProjectShared({ timing: { beatMs: 480 } }, "p");
    expect(read(shared)).toBe(shared);
    expect(read(shared, "timing.beatMs", 500)).toBe(480);
    expect(read(shared, "timing.barMs", 1920)).toBe(1920);
  });

  it("is an empty object outside a provider", () => {
    expect(read(undefined)).toEqual({});
    expect(read(undefined, "a", 1)).toBe(1);
  });
});
