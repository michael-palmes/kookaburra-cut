import { describe, expect, it, vi } from "vitest";
import manifest from "../../fixtures/inspector-redesign-gate/project.json";
import contentRaw from "../../fixtures/inspector-redesign-gate/scenes/01-content.json";
import lightingRaw from "../../fixtures/inspector-redesign-gate/scenes/02-lighting.json";
import type { SceneModule } from "../toolkit/types";
import { fixtureWorldInstances } from "./fixtures";
import {
  listProjectIds,
  outgoingSceneTransitions,
  type ProjectManifest,
  resolveAssetUrl,
} from "./project";
import { loadSceneDoc } from "./sceneDoc";
import { parseSceneDoc, type SceneDoc } from "./sceneDocSchema";
import {
  animatedFixtureLightIds,
  normalizeLightingTrack,
  sampleLightingPose,
} from "./sceneLighting";
import { buildSceneTimeline, resolveAt, timelineTotalMs } from "./sceneTimeline";

const sceneModules = import.meta.glob<{ default: SceneModule }>(
  "/fixtures/inspector-redesign-gate/scenes/*.tsx",
);
const sceneDocs = import.meta.glob<{ default: unknown }>(
  "/fixtures/inspector-redesign-gate/scenes/*.json",
);
const fixtureAssets = import.meta.glob("/fixtures/inspector-redesign-gate/assets/**", {
  query: "?url",
  import: "default",
});

function parseFixture(raw: unknown, source: string): SceneDoc {
  const warnings: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    const doc = parseSceneDoc(raw, source);
    expect(doc).toBeDefined();
    expect(warnings).toEqual([]);
    return doc as SceneDoc;
  } finally {
    warn.mockRestore();
  }
}

describe("inspector redesign gate fixture", () => {
  it("loads through the dev fixture discovery, module, sidecar, asset and timeline seams", async () => {
    expect(manifest).toMatchObject({
      id: "inspector-redesign-gate",
      version: 2,
      formats: ["16:9", "9:16", "1:1", "4:5", "5:4", "3:2", "2:3"],
      scenes: [
        {
          file: "scenes/01-content.tsx",
          durationMs: 1400,
          transition: { type: "crossfade", durationMs: 300 },
        },
        { file: "scenes/02-lighting.tsx", durationMs: 1600 },
      ],
    });

    expect(listProjectIds()).toContain(manifest.id);
    expect(Object.keys(sceneModules).sort()).toEqual([
      "/fixtures/inspector-redesign-gate/scenes/01-content.tsx",
      "/fixtures/inspector-redesign-gate/scenes/02-lighting.tsx",
    ]);
    for (const [index, scene] of manifest.scenes.entries()) {
      const module = await sceneModules[`/fixtures/${manifest.id}/${scene.file}`]?.();
      expect(module?.default.Scene).toBeTypeOf("function");
      expect(module?.default.durationMs).toBe(scene.durationMs);
      expect(
        await loadSceneDoc(manifest.id, scene.file, sceneDocs, `/fixtures/${manifest.id}`),
      ).toEqual(
        index === 0
          ? parseFixture(contentRaw, "loaded-content")
          : parseFixture(lightingRaw, "loaded-lighting"),
      );
    }

    expect(resolveAssetUrl(manifest.id, "assets/app-icon.png")).toBe(
      "/fixtures/inspector-redesign-gate/assets/app-icon.png",
    );
    const outgoing = outgoingSceneTransitions(manifest as ProjectManifest);
    const slots = buildSceneTimeline(
      manifest.scenes.map((scene, index) => ({
        id: `fixture-${index}`,
        durationMs: scene.durationMs,
        transition: outgoing[index],
      })),
    );
    expect(slots[1]).toMatchObject({ startMs: 1100, transitionIn: { durationMs: 300 } });
    expect(timelineTotalMs(slots)).toBe(2700);
    expect(resolveAt(slots, 1250)).toMatchObject({
      active: [
        { index: 0, localMs: 1250 },
        { index: 1, localMs: 150 },
      ],
      transition: { type: "crossfade", progress: 0.5 },
    });
  });

  it("preserves both Image hosts, managed Text and project-image assets through parsing", () => {
    const doc = parseFixture(contentRaw, "inspector-redesign-gate/01-content.json");

    expect(doc.images?.map(({ id, host }) => [id, host])).toEqual([
      ["stage-mark", "stage"],
      ["overlay-mark", "overlay"],
    ]);
    expect(doc.images?.[0]).toMatchObject({
      src: "assets/app-icon.png",
      castShadow: true,
      motion: { preset: "float", amplitude: 0.08, hz: 0.6 },
    });
    expect(doc.images?.[1]).toMatchObject({
      src: "assets/app-icon.png",
      castShadow: false,
      motion: { preset: "push-in", durationMs: 650 },
    });
    expect(doc.managedText?.items.map(({ key, type }) => [key, type])).toEqual([
      ["headline", "title"],
      ["supporting-copy", "subtitle"],
      ["benefits", "bullets"],
      ["project-icon", "icon"],
    ]);
    expect(doc.managedText?.items[3]?.icon).toBe("assets/app-icon.png");
    expect(doc.textAnimationOverrides?.benefits).toMatchObject({
      in: "slide",
      durationMs: 520,
      distance: 0.45,
      ease: "outCubic",
    });
    expect(doc.frame?.cutout?.shape).toBe("rounded-rect");
    expect(doc.lighting).toMatchObject({
      ambientColor: "#dbe7ff",
      shadow: { technique: "map", enabled: true, catchBackdrop: false },
    });
    expect(Object.keys(fixtureAssets)).toContain(
      "/fixtures/inspector-redesign-gate/assets/app-icon.png",
    );
  });

  it("normalises and samples the keyed area light and zero-base repeated fixture rig", () => {
    const doc = parseFixture(lightingRaw, "inspector-redesign-gate/02-lighting.json");
    const lighting = doc.lighting;
    expect(lighting).toBeDefined();
    if (!lighting) throw new Error("lighting fixture did not parse");

    expect(lighting).toMatchObject({
      ambientColor: "#cfdcff",
      animationEnabled: true,
      shadow: { technique: "map", enabled: false, catchBackdrop: true },
      fixtures: [
        {
          id: "moving-rig",
          lightIntensity: 0,
          repeat: { count: 3, spacing: 1.3, axis: "z", mirrorAxis: "x" },
        },
      ],
    });
    const fixture = lighting.fixtures?.[0];
    expect(fixture).toBeDefined();
    if (!fixture) throw new Error("lighting fixture did not parse");
    const fixturePositions = fixtureWorldInstances(fixture).map(({ position }) => position);
    expect(fixturePositions).toHaveLength(6);
    expect([...new Set(fixturePositions.map(([x]) => x))].sort((a, b) => a - b)).toEqual([-1, 1]);

    const track = normalizeLightingTrack(lighting, "inspector-redesign-gate/02-lighting.json");
    expect(track).not.toBeNull();
    if (!track) throw new Error("lighting track did not normalise");
    expect(animatedFixtureLightIds(track)).toEqual(new Set(["moving-rig"]));
    const middle = sampleLightingPose(track, 800);
    expect(middle.lights?.["moving-area"]).toEqual({
      intensity: 5,
      placement: { mode: "point", position: [0, 1.25, 2.3] },
    });
    const middleFixture = middle.fixtures?.["moving-rig"];
    expect(middleFixture).toMatchObject({
      emissive: 2.8,
      lightIntensity: 6,
    });
    const middlePlacement = middleFixture?.placement;
    expect(middlePlacement?.mode).toBe("point");
    if (middlePlacement?.mode !== "point") {
      throw new Error("fixture placement did not sample as a point");
    }
    [1.25, 1.975, -0.7].forEach((expected, index) => {
      expect(middlePlacement.position[index]).toBeCloseTo(expected, 8);
    });
  });
});
