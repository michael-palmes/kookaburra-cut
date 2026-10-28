import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeDocDof } from "../engine/dof";
import { parseRenderSettings } from "../engine/renderSettings";
import { parseSceneDoc } from "../engine/sceneDocSchema";
import { normalizeLighting } from "../engine/sceneLighting";
import { parseBackdropSpec, parseBackgroundSpec, parseTextAnimationSpec } from "../theme/schema";
import * as toolkit from "../toolkit";
import { buildAgentCatalog, EM_DASH, serialiseAgentCatalog, TOOLKIT_SUMMARIES } from "./catalog";

// Every registry the catalogue reads imports cleanly under vitest's node environment, so nothing is copied without a parser check below. Hand-written vocabularies are exhaustive by type (Record<Union, ...>) and validated here against the real parsers.

const CATALOG_PATH = fileURLToPath(
  new URL("../../.agents/skills/kookaburra-scene-authoring/catalog.json", import.meta.url),
);

const catalog = buildAgentCatalog();
type Entry = { id: string; [key: string]: unknown };
const family = (path: string): Entry[] =>
  path
    .split(".")
    .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], catalog) as Entry[];
const ids = (path: string): string[] => family(path).map((e) => e.id);
const silent = () => {};

describe("agent catalogue", () => {
  it("matches the committed catalog.json (run pnpm agent:catalog when this fails)", () => {
    if (process.env.KB_WRITE_CATALOG) {
      writeFileSync(CATALOG_PATH, serialiseAgentCatalog(catalog));
      return;
    }
    let committed: unknown = null;
    try {
      committed = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
    } catch {
      committed = null;
    }
    const fresh = JSON.stringify(committed) === JSON.stringify(catalog);
    expect(fresh, "catalog.json is stale: run pnpm agent:catalog").toBe(true);
  });

  it("is deterministic and em-dash free", () => {
    expect(serialiseAgentCatalog(buildAgentCatalog())).toBe(serialiseAgentCatalog(catalog));
    expect(serialiseAgentCatalog(catalog)).not.toContain(EM_DASH);
  });

  it("gives every entry in every family an id", () => {
    const visit = (node: unknown, path: string) => {
      if (Array.isArray(node)) {
        for (const item of node) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            expect(typeof (item as Entry).id, `${path} entry without an id`).toBe("string");
          }
        }
        return;
      }
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (Array.isArray(value)) visit(value, `${path}.${key}`);
        }
      }
    };
    for (const [key, value] of Object.entries(catalog)) {
      if (key === "toolkit" || key === "sceneDoc" || key === "projectManifest") continue;
      visit(value, key);
    }
  });

  it("summarises every runtime toolkit export (add one to TOOLKIT_SUMMARIES)", () => {
    const missing = Object.keys(toolkit).filter((name) => !TOOLKIT_SUMMARIES[name]);
    const stale = Object.keys(TOOLKIT_SUMMARIES).filter((name) => !(name in toolkit));
    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("lists sidecar keys the parser keeps", () => {
    const doc = parseSceneDoc(
      {
        version: 1,
        name: "x",
        cameraMode: "rig",
        animatedTrack: "chart",
        themeId: "kookaburra-neon",
      },
      "test",
    );
    expect(doc?.cameraMode).toBe("rig");
    const tracks = family("sceneDoc.keys").find((k) => k.id === "animatedTrack")?.values;
    for (const value of (tracks ?? []) as string[]) {
      expect(parseSceneDoc({ version: 1, animatedTrack: value }, "test")?.animatedTrack).toBe(
        value,
      );
    }
  });

  it("lists every device media key the parser keeps", () => {
    const media: Record<string, unknown> = {
      src: "assets/clip.mp4",
      kind: "video",
      startMs: 400,
      fit: "cover",
      rotateDeg: "auto",
      startOn: "open",
      inMs: 1000,
      outMs: 4000,
      speed: 2,
      loop: true,
      posterMs: 0,
    };
    expect(ids("deviceMedia.keys").sort()).toEqual(Object.keys(media).sort());
    const doc = parseSceneDoc(
      { version: 1, devices: [{ id: "d1", model: "iphone-17-pro", media }] },
      "test",
    );
    expect(doc?.devices?.[0].media).toEqual(media);
  });

  it("lists background and backdrop types the parsers accept", () => {
    const samples: Record<string, Record<string, unknown>> = {
      none: { type: "none" },
      color: { type: "color", color: "#101418" },
      gradient: { type: "gradient", gradient: "brand" },
      image: { type: "image", src: "assets/bg.jpg" },
      video: { type: "video", src: "assets/bg.mp4" },
      shader: { type: "shader", shader: "mesh-gradient" },
      scene3d: { type: "scene3d", look: "grid-plain" },
    };
    for (const type of ids("backgrounds.types")) {
      expect(parseBackgroundSpec(samples[type], "test", { video: true })?.type).toBe(type);
    }
    const backdrops: Record<string, Record<string, unknown>> = {
      none: { type: "none" },
      floor: { type: "floor", color: "#ffffff" },
      gradient: { type: "gradient", gradient: "brand" },
      image: { type: "image", src: "assets/bg.jpg" },
    };
    for (const type of ids("backgrounds.backdrops")) {
      expect(parseBackdropSpec(backdrops[type], "test")?.type).toBe(type);
    }
  });

  it("lists lighting vocabulary the parser accepts", () => {
    const placement = { mode: "point", position: [0, 1, 2] };
    for (const form of ids("lighting.fixtureForms")) {
      const spec = normalizeLighting(
        {
          fixtures: [{ id: "f", form, size: [1, 0.1], emissive: 2, lightIntensity: 1, placement }],
        },
        "test",
      );
      expect(spec?.fixtures?.[0]?.form, form).toBe(form);
    }
    expect(
      normalizeLighting(
        {
          fixtures: [
            { id: "f", form: "lava-lamp", size: [1, 1], emissive: 2, lightIntensity: 1, placement },
          ],
        },
        "test",
      )?.fixtures ?? [],
    ).toEqual([]);
    const lights: Record<string, Record<string, unknown>> = {
      directional: { type: "directional" },
      point: { type: "point" },
      spot: { type: "spot", angleDeg: 40, penumbra: 0.3 },
      area: { type: "area", width: 2, height: 1 },
    };
    for (const type of ids("lighting.lightTypes")) {
      for (const space of ids("lighting.spaces")) {
        const spec = normalizeLighting(
          { lights: [{ id: "l", intensity: 1, placement, space, ...lights[type] }] },
          "test",
        );
        expect(spec?.lights?.[0]?.type, type).toBe(type);
        expect(spec?.lights?.[0]?.space, space).toBe(space);
      }
    }
    for (const mode of ids("lighting.toneMapping")) {
      expect(parseRenderSettings({ toneMapping: mode }, "test").toneMapping).toBe(mode);
    }
  });

  it("lists dof modes and text deliveries the parsers accept", () => {
    for (const mode of ids("camera.dof")) {
      expect(normalizeDocDof({ mode }, silent)?.mode).toBe(mode);
    }
    for (const delivery of family("textDeliveries")) {
      const writes = delivery.writes as Record<string, unknown>;
      const spec = parseTextAnimationSpec(
        { in: "fade", out: "none", staggerMs: 0, ...writes },
        "test",
      );
      expect(spec, delivery.id).toBeDefined();
      for (const [key, value] of Object.entries(writes)) {
        expect(spec?.[key as keyof typeof spec], `${delivery.id}.${key}`).toBe(value);
      }
    }
  });

  it("keeps the families the kit documents populated", () => {
    expect(ids("transitions")).toHaveLength(26);
    expect(ids("aspects")).toContain("phone");
    expect(ids("themes").length).toBeGreaterThan(30);
    expect(ids("backgrounds.shaders").length).toBeGreaterThan(5);
    for (const shader of family("backgrounds.shaders")) {
      expect((shader.presets as unknown[]).length, shader.id).toBe(9);
    }
    for (const look of family("backgrounds.scene3d")) {
      expect((look.presets as unknown[]).length, look.id).toBe(9);
    }
    expect(ids("deviceShadows")).toContain("wetfloor");
    expect(ids("fonts.bundled")).toContain("JetBrains Mono");
    expect(ids("presets")).toContain("title");
    expect(ids("exportPresets")[0]).not.toBe("kookaburra-standard");
    const hq = family("exportPresets").find((e) => e.id === "kookaburra-standard");
    expect(hq).toMatchObject({
      fps: 60,
      shortEdge: null,
      codec: "libx264",
      lane: "frozen",
      hardware: false,
    });
    expect(family("exportPresets").find((e) => e.id === "tiktok")).toMatchObject({
      aspects: ["9:16", "1:1"],
      fps: 30,
      shortEdge: 1080,
      loudnessTarget: -14,
      lane: "spec",
    });
    expect(ids("templates").length).toBeGreaterThan(5);
    expect(ids("toolkit.imports")).toContain("@kookaburra/toolkit");
    expect(ids("toolkit.types")).toContain("SceneDoc");
  });
});
