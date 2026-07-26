import { describe, expect, it } from "vitest";
import {
  breakageWarning,
  countByKind,
  defaultPackName,
  EMPTY_STATE,
  isIncluded,
  slugifyFileName,
  toBuildSelection,
  toggle,
  toPlanSelection,
  totalBytes,
} from "./selection";
import type { SelectableItem } from "./types";

const project = (slug: string, bytes = 100): SelectableItem => ({
  kind: "project",
  slug,
  name: slug,
  bytes,
  requiredBy: [],
});

const theme = (slug: string, requiredBy: string[], bytes = 10): SelectableItem => ({
  kind: "theme",
  slug,
  name: slug,
  bytes,
  requiredBy,
});

const font = (slug: string, requiredBy: string[], referenceOnly = false): SelectableItem => ({
  kind: "font",
  slug,
  name: slug,
  bytes: 500,
  requiredBy,
  referenceOnly,
  embedding: referenceOnly ? "restricted" : "installable",
});

describe("selection", () => {
  it("excludes everything before anything is ticked", () => {
    const items = [project("acme"), theme("dark", [])];
    expect(items.filter((i) => isIncluded(EMPTY_STATE, i))).toEqual([]);
  });

  it("includes an auto-pulled item without a direct tick", () => {
    const pulled = theme("dark", ["acme"]);
    expect(isIncluded(EMPTY_STATE, pulled)).toBe(true);
  });

  it("lets an auto-pulled item be unticked, and remembers it", () => {
    const pulled = theme("dark", ["acme"]);
    const state = toggle(EMPTY_STATE, pulled, false);
    expect(isIncluded(state, pulled)).toBe(false);
    // Re-ticking clears the exclusion rather than layering a second flag.
    const back = toggle(state, pulled, true);
    expect(isIncluded(back, pulled)).toBe(true);
    expect(back.excluded).toEqual({});
  });

  it("sends only direct ticks to plan_pack, never the closure", () => {
    const p = project("acme");
    const pulled = theme("dark", ["acme"]);
    let state = toggle(EMPTY_STATE, p, true);
    state = toggle(state, pulled, false);
    const plan = toPlanSelection(state);
    expect(plan.projects).toEqual(["acme"]);
    expect(plan.themes).toEqual([]);
  });

  it("builds from everything included, closure and all", () => {
    const items = [project("acme"), theme("dark", ["acme"]), font("Acme@400", ["dark"])];
    const state = toggle(EMPTY_STATE, items[0], true);
    const build = toBuildSelection(state, items);
    expect(build.projects).toEqual(["acme"]);
    expect(build.themes).toEqual(["dark"]);
    expect(build.fonts).toEqual(["Acme@400"]);
  });

  it("drops an unticked dependency from the build", () => {
    const items = [project("acme"), theme("dark", ["acme"])];
    let state = toggle(EMPTY_STATE, items[0], true);
    state = toggle(state, items[1], false);
    expect(toBuildSelection(state, items).themes).toEqual([]);
  });

  it("counts and sizes only what ships", () => {
    const items = [project("acme", 1000), theme("dark", ["acme"], 50)];
    const state = toggle(EMPTY_STATE, items[0], true);
    expect(countByKind(state, items)).toEqual({ project: 1, theme: 1 });
    expect(totalBytes(state, items)).toBe(1050);
  });

  it("counts a reference-only font as zero bytes", () => {
    const items = [project("acme", 100), font("Helvetica@400", ["acme"], true)];
    const state = toggle(EMPTY_STATE, items[0], true);
    expect(totalBytes(state, items)).toBe(100);
    expect(countByKind(state, items).font).toBe(1);
  });

  it("names what breaks, per kind", () => {
    expect(breakageWarning(theme("dark", ["Acme Promo"]))).toContain("default theme");
    expect(breakageWarning(font("Acme@400", ["Acme Dark"]))).toContain("substitute face");
    expect(breakageWarning(project("acme"))).toBeNull();
  });

  it("prefers the organisation for a pack name", () => {
    expect(defaultPackName("Acme Pty Ltd", "Michael")).toBe("Acme Pty Ltd");
    expect(defaultPackName(undefined, "Michael")).toBe("Michael");
    expect(defaultPackName(undefined, undefined)).toBe("Kookaburra Pack");
    expect(defaultPackName("   ", "Michael")).toBe("Michael");
  });

  it("slugifies a file name safely", () => {
    expect(slugifyFileName("Acme Brand Kit")).toBe("acme-brand-kit");
    expect(slugifyFileName("  ../../etc/passwd  ")).toBe("etc-passwd");
    expect(slugifyFileName("!!!")).toBe("kookaburra-pack");
  });
});
