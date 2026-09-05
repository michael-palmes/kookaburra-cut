import { describe, expect, it } from "vitest";
import { BUILTIN_THEME_CATALOGUE } from "../../theme/catalogue";
import type { FixtureSpec, LightSpec } from "../../theme/tokens";
import { FIXTURE_DEFAULTS, LIGHT_DEFAULTS } from "../inspector/LightingSection";
import { applyLightingShadowStyle } from "../inspector/lightingEditorModel";
import {
  getIn,
  parseThemeDraft,
  setIn,
  type ThemeDoc,
  writeThemeShadow,
  writeThemeTextLook,
} from "./themeDraft";
import {
  appendThemeLightingEntity,
  changeThemeLightType,
  duplicateThemeLightingEntity,
  nextThemeLightingId,
  patchThemeLightingEntity,
  removeThemeLightingEntity,
} from "./themeLightingDraft";

function base(): ThemeDoc {
  const source = BUILTIN_THEME_CATALOGUE.find(({ id }) => id === "kookaburra-studio-white");
  if (!source) throw new Error("Missing starter theme");
  const doc = structuredClone(source.doc) as ThemeDoc;
  delete doc.lighting;
  return doc;
}

describe("theme lighting entity edits", () => {
  it("keeps light colour sources, aim and falloff through an intensity change", () => {
    const spot = LIGHT_DEFAULTS.spot("light-1");
    if (spot.type !== "spot") throw new Error("Expected a spot light");
    const doc = appendThemeLightingEntity(base(), "lights", {
      ...spot,
      name: "Warm rim",
      kelvin: 2900,
      colorToken: "accent",
      target: [1, 2, 3],
      distance: 12,
      decay: 1.5,
    });
    const light = parseThemeDraft(doc, "test").theme?.lighting?.lights?.[0];
    if (!light) throw new Error("Light did not parse");
    const next = patchThemeLightingEntity(doc, "lights", light, (value) => {
      value.intensity = 5;
    });
    expect((getIn(next, ["lighting", "lights"]) as unknown[])[0]).toMatchObject({
      intensity: 5,
      name: "Warm rim",
      kelvin: 2900,
      colorToken: "accent",
      target: [1, 2, 3],
      distance: 12,
      decay: 1.5,
    });
  });
  it("edits parsed controls while retaining raw nested fields and other entities", () => {
    const raw = {
      ...FIXTURE_DEFAULTS.tube("fixture-1"),
      future: "fixture",
      placement: { mode: "point", position: [1, 2, 3], future: "placement" },
      repeat: { count: 2, spacing: 1, axis: "x", future: "repeat" },
    };
    const doc = setIn(base(), ["lighting", "fixtures"], [raw, { future: "unrecognised-entry" }]);
    const fixture = parseThemeDraft(doc, "test").theme?.lighting?.fixtures?.[0];
    if (!fixture) throw new Error("Fixture did not parse");
    const next = patchThemeLightingEntity(doc, "fixtures", fixture, (value) => {
      value.emissive = 4;
      if (value.repeat) value.repeat.count = 3;
    });
    const entries = getIn(next, ["lighting", "fixtures"]) as ThemeDoc[];
    expect(entries[0]).toMatchObject({
      emissive: 4,
      future: "fixture",
      placement: { future: "placement" },
      repeat: { count: 3, future: "repeat" },
    });
    expect(entries[1]).toEqual({ future: "unrecognised-entry" });
    expect(raw.repeat.count).toBe(2);
  });

  it("adds every shared fixture default as a renderable theme fixture", () => {
    for (const [form, create] of Object.entries(FIXTURE_DEFAULTS)) {
      const doc = appendThemeLightingEntity(base(), "fixtures", create("fixture-1"));
      expect(parseThemeDraft(doc, form).theme?.lighting?.fixtures?.[0]?.form).toBe(form);
      expect(nextThemeLightingId(doc, "fixtures")).toBe("fixture-2");
      expect(removeThemeLightingEntity(doc, "fixtures", "fixture-1").lighting).toBeUndefined();
    }
  });

  it("duplicates a complete fixture under a fresh id without sharing nested objects", () => {
    const doc = appendThemeLightingEntity(base(), "fixtures", {
      ...FIXTURE_DEFAULTS.tube("fixture-1"),
      repeat: { count: 3, spacing: 1, axis: "x" },
    });
    const next = duplicateThemeLightingEntity(doc, "fixtures", "fixture-1");
    const entries = getIn(next, ["lighting", "fixtures"]) as FixtureSpec[];
    expect(entries.map(({ id }) => id)).toEqual(["fixture-1", "fixture-2"]);
    if (entries[1].repeat) entries[1].repeat.count = 8;
    expect(entries[0].repeat?.count).toBe(3);
  });

  it("changes each light type without dropping its aim or emitting incompatible fields", () => {
    let doc = appendThemeLightingEntity(base(), "lights", {
      ...LIGHT_DEFAULTS.spot("light-1"),
      target: [2, 1, 0],
      castShadow: true,
    });
    for (const type of ["point", "area", "directional", "spot"] as LightSpec["type"][]) {
      const light = parseThemeDraft(doc, "test").theme?.lighting?.lights?.[0];
      if (!light) throw new Error("Light did not parse");
      doc = patchThemeLightingEntity(doc, "lights", light, (next) =>
        changeThemeLightType(next, type),
      );
      const parsed = parseThemeDraft(doc, type).theme?.lighting?.lights?.[0];
      expect(parsed?.type).toBe(type);
      expect(parsed?.target).toEqual([2, 1, 0]);
      if (type === "area" || type === "point") expect(parsed?.castShadow).toBeUndefined();
    }
  });
});

describe("theme shadow and text appearance edits", () => {
  it("adds a valid shadow rig to an unlit theme and preserves extra shadow fields", () => {
    const doc = setIn(base(), ["lighting", "shadow"], { future: "keep" });
    const next = writeThemeShadow(doc, applyLightingShadowStyle(undefined, "cast"));
    const lighting = parseThemeDraft(next, "shadow").theme?.lighting;
    expect(lighting?.sun).toBeDefined();
    expect(lighting?.shadow?.technique).toBe("map");
    expect(getIn(next, ["lighting", "shadow", "future"])).toBe("keep");
  });

  it("clears prior text-look parameters when the shared editor resets them", () => {
    const doc = {
      textLook: {
        preset: "gradient",
        colorA: "#ff0000",
        colorB: "#000000",
        angleDeg: 30,
        future: "keep",
      },
    };
    const next = writeThemeTextLook(doc, { preset: "outline", strokeEm: 0.03 });
    expect(next.textLook).toEqual({ preset: "outline", strokeEm: 0.03, future: "keep" });
    expect(writeThemeTextLook(next, undefined).textLook).toBeUndefined();
  });
});
