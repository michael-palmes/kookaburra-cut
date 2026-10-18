import { describe, expect, it } from "vitest";
import { collectParseWarnings } from "../engine/parseWarnings";
import {
  collectThemeChain,
  mergeThemeDocs,
  patchThemeVariant,
  resolveThemeDocument,
  themeDependents,
  themeExtendsOf,
} from "./extends";

const base = {
  version: 2,
  id: "base",
  name: "Base",
  colors: { background: "#000000", text: "#ffffff", accent: "#ff0000", muted: "#888888" },
  background: { type: "gradient", gradient: "brand", parallax: 0.2 },
  chartColors: ["#111111", "#222222"],
};

describe("theme extends", () => {
  it("returns a document that extends nothing as the same object", () => {
    const doc = { version: 3, id: "solo" };
    expect(resolveThemeDocument(doc, "ws:solo", () => undefined)).toBe(doc);
  });

  it("honours extends from version 3 only", () => {
    expect(themeExtendsOf({ version: 3, extends: " ws:base " })).toBe("ws:base");
    expect(themeExtendsOf({ version: 2, extends: "ws:base" })).toBeUndefined();
    const { result, warnings } = collectParseWarnings(() =>
      resolveThemeDocument({ ...base, extends: "ws:other" }, "ws:old", () => base),
    );
    expect(result).toEqual(base);
    expect(warnings).toEqual(['[theme] ws:old: "extends" needs theme version 3, ignored']);
  });

  it("names the broken link of a chain", () => {
    const docs: Record<string, unknown> = {
      "ws:a": { version: 3, extends: "ws:b" },
      "ws:b": { version: 3, extends: "ws:a" },
    };
    const loop = collectParseWarnings(() =>
      resolveThemeDocument(docs["ws:a"], "ws:a", (id) => docs[id]),
    );
    expect(loop.result).toBeUndefined();
    expect(loop.warnings[0]).toContain("ws:a > ws:b > ws:a");
    const gone = collectParseWarnings(() =>
      resolveThemeDocument({ version: 3, extends: "ws:gone" }, "ws:c", () => undefined),
    );
    expect(gone.result).toBeUndefined();
    expect(gone.warnings).toEqual([
      `[theme] ws:c: its base theme "ws:gone" can't be found, so the theme can't load`,
    ]);
  });

  it("fetches each chain document once, stopping at a loop", async () => {
    const reads: string[] = [];
    const docs: Record<string, unknown> = {
      "ws:b": { version: 3, extends: "ws:c" },
      "ws:c": { version: 3, extends: "ws:b" },
    };
    const chain = await collectThemeChain({ version: 3, extends: "ws:b" }, async (id) => {
      reads.push(id);
      return docs[id];
    });
    expect([...chain.keys()]).toEqual(["ws:b", "ws:c"]);
    expect(reads).toEqual(["ws:b", "ws:c"]);
    const failing = await collectThemeChain({ version: 3, extends: "ws:x" }, async () => {
      throw new Error("unreadable");
    });
    expect(failing.get("ws:x")).toBeUndefined();
  });

  it("lists every theme whose chain reaches a base, nearest first", () => {
    const docs = new Map<string, unknown>([
      ["ws:base", base],
      ["ws:child", { version: 3, extends: "ws:base" }],
      ["ws:grandchild", { version: 3, extends: "ws:child" }],
      ["ws:legacy", { version: 2, extends: "ws:base" }],
      ["ws:other", { version: 3, extends: "kookaburra-paper" }],
    ]);
    expect(themeDependents("ws:base", docs)).toEqual(["ws:child", "ws:grandchild"]);
    expect(themeDependents("kookaburra-paper", docs)).toEqual(["ws:other"]);
    expect(themeDependents("ws:grandchild", docs)).toEqual([]);
  });
});

describe("patchThemeVariant", () => {
  const child = { version: 3, id: "child", extends: "ws:base", colors: { accent: "#00ff00" } };
  const view = () => mergeThemeDocs(base, child);
  const patch = (edit: (doc: Record<string, unknown>) => Record<string, unknown>) =>
    patchThemeVariant(child, base, view(), edit(structuredClone(view())));

  it("lands a changed leaf in the child and keeps untouched overrides", () => {
    const next = patch((doc) => ({
      ...doc,
      colors: { ...(doc.colors as object), text: "#eeeeee" },
    }));
    expect(next).toEqual({ ...child, colors: { accent: "#00ff00", text: "#eeeeee" } });
    expect(mergeThemeDocs(base, next).colors).toEqual({
      ...base.colors,
      accent: "#00ff00",
      text: "#eeeeee",
    });
  });

  it("clears a removed inherited value with null and drops a removed own one", () => {
    const next = patch((doc) => {
      const { background: _b, ...rest } = doc;
      return { ...rest, colors: { ...base.colors } };
    });
    expect(next.background).toBeNull();
    expect(next.colors).toEqual({ accent: "#ff0000" });
    expect(mergeThemeDocs(base, next)).toEqual({
      ...mergeThemeDocs(base, child),
      colors: base.colors,
      background: undefined,
    });
  });

  it("replaces a block whole so the merge lands exactly on the edit", () => {
    const next = patch((doc) => ({ ...doc, background: { type: "color", color: "#101010" } }));
    expect(next.background).toEqual({
      type: "color",
      color: "#101010",
      gradient: null,
      parallax: null,
    });
    expect(mergeThemeDocs(base, next).background).toEqual({ type: "color", color: "#101010" });
    const swapped = patchThemeVariant(
      { ...child, background: null },
      base,
      mergeThemeDocs(base, { ...child, background: null }),
      { ...mergeThemeDocs(base, child), background: { type: "color", color: "#202020" } },
    );
    expect(mergeThemeDocs(base, swapped).background).toEqual({ type: "color", color: "#202020" });
  });

  it("keeps arrays whole and never touches extends", () => {
    const next = patch((doc) => ({ ...doc, chartColors: ["#333333"], extends: "ws:else" }));
    expect(next.chartColors).toEqual(["#333333"]);
    expect(next.extends).toBe("ws:base");
  });
});
