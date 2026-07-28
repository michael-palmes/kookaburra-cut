import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeLighting, resolveLighting } from "../../engine/sceneLighting";
import { LIGHTING_PRESETS } from "./presets";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** STRUCTURE PIN: a preset that fails validation would apply as a silently-degraded look (the gate-sidecar lesson); every preset must round-trip the parser verbatim and resolve renderable. */
describe("LIGHTING_PRESETS", () => {
  it("ships exactly six, ids unique", () => {
    expect(LIGHTING_PRESETS).toHaveLength(6);
    expect(new Set(LIGHTING_PRESETS.map((p) => p.id)).size).toBe(6);
  });

  it.each(LIGHTING_PRESETS.map((p) => [p.id, p] as const))(
    "%s parses verbatim and resolves renderable",
    (_id, preset) => {
      const parsed = normalizeLighting({ ...preset.spec, preset: preset.id }, "preset");
      expect(parsed).toEqual({ ...preset.spec, preset: preset.id });
      expect(resolveLighting(undefined, undefined, parsed ?? undefined)).toBeDefined();
    },
  );

  it("dark-rim demonstrates theme-linked colour and camera space", () => {
    const darkRim = LIGHTING_PRESETS.find((p) => p.id === "dark-rim");
    expect(darkRim?.spec.lights?.every((l) => l.colorToken === "accent")).toBe(true);
    expect(darkRim?.spec.lights?.every((l) => l.space === "camera")).toBe(true);
  });

  it("neon-corridor demonstrates fixtures with a repeat run", () => {
    const corridor = LIGHTING_PRESETS.find((p) => p.id === "neon-corridor");
    expect(corridor?.spec.fixtures?.[0].repeat?.count).toBe(8);
    expect(corridor?.spec.sun?.enabled).toBe(false);
  });
});
