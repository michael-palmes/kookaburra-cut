import { describe, expect, it } from "vitest";
import { registryModuleSource } from "./moduleRegistrySource";

describe("registryModuleSource — registry-module codegen (v9 · M1)", () => {
  it("re-exports every named export off the global registry", () => {
    const src = registryModuleSource("@kookaburra/toolkit", {
      defineScene: 1,
      AnimatedHeadline: 2,
    });
    expect(src).toContain('const m = globalThis.__KOOKABURRA_MODULES__["@kookaburra/toolkit"];');
    expect(src).toContain("export const defineScene = m.defineScene;");
    expect(src).toContain("export const AnimatedHeadline = m.AnimatedHeadline;");
  });

  it("emits names sorted — the output is canonical regardless of key order", () => {
    const a = registryModuleSource("x", { b: 1, a: 2 });
    const b = registryModuleSource("x", { a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a.indexOf("export const a")).toBeLessThan(a.indexOf("export const b"));
  });

  it("forwards a default export when the namespace has one", () => {
    const src = registryModuleSource("react/jsx-runtime", { jsx: 1, default: 2 });
    expect(src).toContain("export default m.default;");
    expect(src).not.toContain("export const default");
  });

  it("omits the default export line when there is none", () => {
    expect(registryModuleSource("x", { jsx: 1 })).not.toContain("export default");
  });

  it("skips non-identifier keys instead of emitting broken syntax", () => {
    const src = registryModuleSource("x", { ok: 1, "not-an-identifier": 2, "1bad": 3 });
    expect(src).toContain("export const ok = m.ok;");
    expect(src).not.toContain("not-an-identifier");
    expect(src).not.toContain("1bad");
  });

  it("escapes the specifier into the lookup literal", () => {
    const src = registryModuleSource('weird"name', {});
    expect(src).toContain('globalThis.__KOOKABURRA_MODULES__["weird\\"name"];');
  });
});
