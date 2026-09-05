import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chartAnimationEndMs } from "../toolkit/chart/animation";
import { listPresets, presetPreviewFrame } from "./presets";
import { resolveChart } from "./sceneChart";
import { followMediaSources } from "./sceneDoc";
import { parseSceneDoc, type SceneManagedTextBlock } from "./sceneDocSchema";

const documents = import.meta.glob<{ managedText?: SceneManagedTextBlock }>(
  "../../presets/*/scenes/*.json",
  { eager: true, import: "default" },
);
const starters = listPresets().filter((entry) => entry.category === "starters");
const starterDocs = Object.fromEntries(
  Object.entries(documents).filter(([path]) =>
    starters.some((entry) => path.startsWith(`../../presets/${entry.id}/`)),
  ),
);
const expected = [
  "device",
  "deviceonly",
  "comparison",
  "title",
  "titleicon",
  "appversion",
  "layeredscreenshot",
  "chart",
  "video",
  "image",
  "videowindow",
  "overlaystart",
  "overlayend",
  "overlaypanel",
  "blank",
];

function source(id: string, relative: string): string {
  return fileURLToPath(new URL(`../../presets/${id}/${relative}`, import.meta.url));
}

describe("canonical scene starters", () => {
  it("follows replacement video duration for both video starters", () => {
    for (const id of ["video", "videowindow"]) {
      const doc = JSON.parse(readFileSync(source(id, `scenes/01-${id}.json`), "utf8"));
      expect(followMediaSources(parseSceneDoc(doc, id))).toEqual([
        "assets/sample-laptop-recording.mp4",
      ]);
      const replaced = JSON.parse(
        JSON.stringify(doc).replaceAll("sample-laptop-recording.mp4", "replacement.mp4"),
      );
      expect(followMediaSources(parseSceneDoc(replaced, id))).toEqual(["assets/replacement.mp4"]);
    }
  });
  it("ships the 15 pictured starters in order alongside the existing six presets", () => {
    expect(starters.map((entry) => entry.id)).toEqual(expected);
    expect(listPresets()).toHaveLength(21);
    for (const id of [
      "hero-device",
      "title-opener",
      "feature-compare",
      "chart-reveal",
      "stat-counter",
      "closing-cta",
    ]) {
      expect(listPresets().some((entry) => entry.id === id)).toBe(true);
    }
  });

  it("keeps each starter portable, editable and registered once in all four aspects", () => {
    for (const entry of starters) {
      const project = JSON.parse(readFileSync(source(entry.id, "project.json"), "utf8"));
      expect(project.scenes, entry.id).toHaveLength(1);
      expect(project.formats).toEqual(["16:9", "9:16", "1:1", "4:5"]);
      const scene = project.scenes[0];
      const tsx = readFileSync(source(entry.id, scene.file), "utf8");
      expect(tsx).toContain(`durationMs: ${scene.durationMs}`);
      expect(tsx).not.toMatch(/Date\.now|performance\.now|requestAnimationFrame|setTimeout/);
      const doc = JSON.parse(
        readFileSync(source(entry.id, scene.file.replace(/\.tsx$/, ".json")), "utf8"),
      );
      expect(parseSceneDoc(doc, entry.id)).toBeDefined();
      for (const asset of [...JSON.stringify(doc).matchAll(/assets\/[A-Za-z0-9_./-]+/g)]) {
        expect(existsSync(source(entry.id, asset[0])), `${entry.id}: ${asset[0]}`).toBe(true);
      }
      expect(entry.previewUrl, entry.id).not.toBeNull();
    }
  });
  it("pins managed-text ownership for every canonical starter", () => {
    const ownership = Object.fromEntries(
      Object.entries(starterDocs).map(([path, doc]) => {
        const stem =
          path
            .split("/")
            .pop()
            ?.replace(/^01-|\.json$/g, "") ?? path;
        return [stem, doc.managedText ?? null];
      }),
    );

    expect(ownership).toEqual({
      appversion: {
        layout: "template",
        items: [
          { key: "icon", type: "icon", icon: "assets/app-icon.png" },
          { key: "title", type: "subtitle", text: "Your App" },
          { key: "subtitle", type: "title", text: "3.1.5" },
        ],
      },
      blank: {
        layout: "template",
        items: [{ key: "title", type: "title", text: "" }],
      },
      chart: {
        layout: "template",
        items: [{ key: "title", type: "title", text: "Revenue by quarter" }],
      },
      comparison: {
        layout: "template",
        items: [
          { key: "title", type: "title", text: "The redesign" },
          { key: "subtitle", type: "subtitle", text: "" },
        ],
      },
      device: {
        layout: "template",
        items: [
          { key: "title", type: "title", text: "Ship faster" },
          { key: "subtitle", type: "subtitle", text: "" },
        ],
      },
      deviceonly: null,
      image: null,
      layeredscreenshot: {
        layout: "template",
        items: [{ key: "title", type: "title", text: "Screenshots in motion" }],
      },
      overlayend: {
        layout: "template",
        items: [
          { key: "title", type: "title", text: "Ship faster" },
          { key: "subtitle", type: "subtitle", text: "Make it yours" },
        ],
      },
      overlaypanel: {
        layout: "template",
        items: [
          { key: "title", type: "title", text: "Ship faster" },
          { key: "subtitle", type: "subtitle", text: "Make it yours" },
        ],
      },
      overlaystart: {
        layout: "template",
        items: [
          { key: "title", type: "title", text: "Ship faster" },
          { key: "subtitle", type: "subtitle", text: "Make it yours" },
        ],
      },
      title: {
        layout: "template",
        items: [
          { key: "title", type: "title", text: "Ship faster" },
          { key: "subtitle", type: "subtitle", text: "Make it yours" },
        ],
      },
      titleicon: {
        layout: "template",
        items: [
          { key: "icon", type: "icon", icon: "🚀" },
          { key: "title", type: "title", text: "Ship faster" },
          { key: "subtitle", type: "subtitle", text: "Make it yours" },
        ],
      },
      video: null,
      videowindow: {
        layout: "template",
        items: [
          { key: "title", type: "title", text: "Show the whole flow" },
          {
            key: "subtitle",
            type: "subtitle",
            text: "A focused window for your screen recording",
          },
        ],
      },
    });
  });

  it("keeps the floating recording editable with the pictured two-line layout", () => {
    const doc = JSON.parse(
      readFileSync(source("videowindow", "scenes/01-videowindow.json"), "utf8"),
    );
    expect(doc.videoWindow).toBeUndefined();
    expect(doc.media).toMatchObject([
      { kind: "video", host: "window", overlay: { size: 0.65, position: [0, -0.16] } },
    ]);
    expect(doc.backdrop).toEqual({ type: "none" });
    expect(doc.managedText.items.map((item: { text: string }) => item.text)).toEqual([
      "Show the whole flow",
      "A focused window for your screen recording",
    ]);
  });

  it("captures the chart after its build has settled", () => {
    const entry = starters.find((preset) => preset.id === "chart");
    expect(entry).toBeDefined();
    if (!entry) return;
    const raw = JSON.parse(readFileSync(source("chart", "scenes/01-chart.json"), "utf8"));
    const chart = resolveChart(parseSceneDoc(raw, "chart"));
    expect(chart).not.toBeNull();
    if (!chart) return;
    const frame = presetPreviewFrame(entry.manifest);
    expect(
      chartAnimationEndMs(chart.animation, {
        seriesCount: chart.data.series.length,
        categoryCount: chart.data.categories.length,
        type: chart.type,
      }),
    ).toBeLessThanOrEqual(frame.atMs ?? entry.durationMs / 2);
  });
});
