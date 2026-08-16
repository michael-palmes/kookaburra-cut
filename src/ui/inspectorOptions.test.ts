import { describe, expect, it } from "vitest";
import type { SceneDoc, SceneDocChart } from "../engine/sceneDocSchema";
import type { FrameSpec } from "../toolkit/frame/types";
import {
  CHART_TYPE_IDS,
  CHART_TYPE_LABELS,
  chartRowValue,
  deriveSceneOverview,
  drillStackForScene,
  projectRows,
  sceneSections,
} from "./inspectorOptions";
import { textIconInspectorRoute } from "./inspectorTitles";

describe("projectRows (the Project-tab pin)", () => {
  it("workspace projects get the full set, in order", () => {
    const rows = projectRows({
      isWorkspace: true,
      themeName: "Editorial",
      typographyLabel: "Theme fonts",
      aspect: "16:9",
      soundtrackName: null,
      playbackLabel: "Full quality",
      renderLabel: "ACES",
      scenesCount: 3,
    });
    expect(rows.map((r) => r.id)).toEqual([
      "scenes",
      "theme",
      "typography",
      "media",
      "appIcon",
      "playback",
      "render",
      "aspect",
      "music",
    ]);
    expect(rows.every((r) => r.chevron)).toBe(true);
    expect(rows.find((r) => r.id === "scenes")?.value).toBe("3 scenes");
    expect(rows.find((r) => r.id === "music")?.value).toBe("None");
    expect(rows.find((r) => r.id === "theme")?.value).toBe("Editorial");
    expect(rows.find((r) => r.id === "typography")?.value).toBe("Theme fonts");
    expect(rows.find((r) => r.id === "aspect")?.value).toBe("16:9");
    expect(rows.find((r) => r.id === "playback")?.value).toBe("Full quality");
  });

  it("a soundtrack name replaces the Music 'None' value", () => {
    const rows = projectRows({
      isWorkspace: true,
      themeName: "Pacific",
      typographyLabel: "Inter",
      aspect: "9:16",
      soundtrackName: "sunrise.mp3",
      playbackLabel: "Performance",
      renderLabel: "ACES",
      scenesCount: 1,
    });
    expect(rows.find((r) => r.id === "music")?.value).toBe("sunrise.mp3");
    expect(rows.find((r) => r.id === "playback")?.value).toBe("Performance");
  });

  it("bundled projects keep Aspect ratio, Playback options + a READ-ONLY Theme (decision 12)", () => {
    const rows = projectRows({
      isWorkspace: false,
      themeName: "Default",
      typographyLabel: "Theme fonts",
      aspect: "1:1",
      soundtrackName: null,
      playbackLabel: "Full quality",
      renderLabel: "ACES",
      scenesCount: 2,
    });
    expect(rows.map((r) => r.id)).toEqual(["theme", "playback", "aspect"]);
    expect(rows.find((r) => r.id === "theme")?.chevron).toBe(false);
    expect(rows.find((r) => r.id === "aspect")?.chevron).toBe(true);
    expect(rows.find((r) => r.id === "playback")?.chevron).toBe(true);
  });
});

const docWith = (parts: Partial<SceneDoc>): SceneDoc => ({ version: 1, ...parts }) as SceneDoc;

describe("deriveSceneOverview", () => {
  const overview = (
    doc: SceneDoc,
    parts: Partial<Parameters<typeof deriveSceneOverview>[0]> = {},
  ) =>
    deriveSceneOverview({
      doc,
      durationMs: 4_000,
      slotsCount: 3,
      themeName: "Studio White",
      transitionValue: "Crossfade · 0.4 s",
      ...parts,
    });

  it("derives natural row values, media hints, selection targets and routes", () => {
    const frame: FrameSpec = {
      cutout: { shape: "rounded-rect", side: "end", size: 0.34 },
      decorations: [
        {
          id: "logo",
          src: "assets/brand/logo.png",
          position: [0.5, 0.25],
          size: 0.24,
        },
      ],
    };
    const model = overview(
      docWith({
        text: { headline: "Your App · 3.1.5" },
        textLayout: { align: "center" },
        devices: [
          {
            id: "phone",
            model: "iphone-17-pro",
            media: { kind: "video", src: "assets/demo.mov" },
          },
        ],
        videoWindow: {
          media: { src: "assets/demo-recording.mov" },
          radius: "macos",
        },
        images: [
          {
            id: "hero",
            src: "assets/hero.png",
            host: "stage",
            stage: { position: [0, 0, 0], size: 1.8, rotationDeg: [0, 0, 0] },
            overlay: {
              position: [0, 0],
              size: 0.25,
              rotationDeg: 0,
              shape: "none",
              layer: "above",
            },
          },
        ],
        objects: [{ id: "cup", objectId: "ws:coffee-cup", placement: { position: [-0.5, 0, 0] } }],
      }),
      {
        frame,
        overlayValue: "Right · 34%",
        cameraValue: "Orbit · Push in",
        lightingValue: "Soft studio",
      },
    );

    expect(model.groups.map((group) => group.id)).toEqual([
      "text",
      "devices",
      "images",
      "videos",
      "objects",
    ]);
    expect(model.groups.map((group) => group.label)).toEqual([
      "Text",
      "Devices",
      "Images",
      "Videos",
      "Objects",
    ]);
    const rows = Object.fromEntries(
      model.groups.flatMap((group) => group.rows).map((row) => [row.id, row]),
    );
    expect(rows["text:headline"]).toMatchObject({
      label: "Your App · 3.1.5",
      value: "Left",
      selectionTarget: { kind: "text", id: "headline" },
      openRoute: "text",
    });
    expect(rows["device:phone"]).toMatchObject({
      label: "iPhone 17 Pro",
      value: "demo.mov",
      mediaHint: { kind: "video", src: "assets/demo.mov" },
      selectionTarget: { kind: "device", id: "phone" },
      openRoute: "device",
    });
    expect(rows["image:hero"]).toMatchObject({
      label: "hero.png",
      value: "Stage",
      thumbnail: "assets/hero.png",
      selectionTarget: { kind: "image", id: "hero" },
      openRoute: "image.edit",
    });
    expect(rows["image:legacy:logo"]).toMatchObject({
      label: "logo.png",
      value: "24%",
      readOnly: true,
      selectionTarget: { kind: "legacyImage", id: "logo" },
      openRoute: "legacyImage.edit",
    });
    expect(rows["video:window"]).toMatchObject({
      label: "demo-recording.mov",
      value: "Window",
      selectionTarget: { kind: "videoWindow" },
      openRoute: "videoWindow.edit",
    });
    expect(rows["object:cup"]).toMatchObject({
      label: "Coffee cup",
      value: "Left",
      selectionTarget: { kind: "object", id: "cup" },
      openRoute: "objects.placement",
    });
    expect(model.settings.map((row) => row.value)).toEqual([
      "Right · 34%",
      "Studio White",
      "Theme default",
      "Orbit · Push in",
      "Soft studio",
      "Crossfade · 0.4 s",
      "4.00 s",
    ]);
  });

  it("omits every empty content group and keeps the seven scene settings", () => {
    const model = overview(docWith({}), { durationMs: 3_000, slotsCount: 1 });
    expect(model.groups).toEqual([]);
    expect(model.standalone).toEqual([]);
    expect(model.settings.map((row) => row.id)).toEqual([
      "overlay",
      "theme",
      "background",
      "camera",
      "lighting",
      "transition",
      "duration",
    ]);
    expect(model.settings.find((row) => row.id === "transition")?.openRoute).toBeNull();
    expect(model.settings.find((row) => row.id === "duration")?.value).toBe("3.00 s");
    expect(model.addOptions.find((option) => option.id === "image")).toMatchObject({
      singleton: false,
      disabled: false,
    });
  });

  it("projects mounted fallback copy when code-authored text has no sidecar key", () => {
    const model = overview(docWith({ text: {} }), { fallbackText: "Built in headline" });

    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]).toMatchObject({
      id: "text",
      rows: [
        {
          id: "text:fallback",
          label: "Built in headline",
          openRoute: "text",
          readOnly: true,
        },
      ],
    });
    expect(model.groups[0].rows[0].selectionTarget).toBeUndefined();
  });

  it("uses the ordered managed projection exclusively, including present-empty", () => {
    const doc = docWith({ text: { dormant: "Legacy copy" } });
    const managed = overview(doc, {
      fallbackText: "Code fallback",
      textItems: [
        { key: "subtitle", type: "subtitle", text: "Second" },
        {
          key: "points",
          type: "bullets",
          points: [{ key: "p1", text: "First point" }],
        },
      ],
    });

    expect(managed.groups[0]?.rows.map((row) => row.id)).toEqual(["text:subtitle", "text:points"]);
    expect(managed.groups[0]?.rows[1]?.label).toBe("First point");

    const empty = overview(doc, { fallbackText: "Code fallback", textItems: [] });
    expect(empty.groups.find((group) => group.id === "text")).toBeUndefined();
  });

  it("projects one atomic Content row per managed Text group", () => {
    const doc = docWith({ textLayout: { align: "center" } });
    const model = overview(doc, {
      textGroups: [
        {
          key: "text",
          itemKeys: ["title", "subtitle"],
          items: [
            { key: "title", type: "title", text: "First group" },
            { key: "subtitle", type: "subtitle", text: "Supporting copy" },
          ],
          align: "left",
          implicit: false,
        },
        {
          key: "text-2",
          itemKeys: ["title-2"],
          items: [{ key: "title-2", type: "title", text: "Second group" }],
          align: "right",
          implicit: false,
        },
      ],
    });

    expect(model.groups[0]?.rows).toEqual([
      expect.objectContaining({
        id: "text:text",
        label: "Text 1: First group",
        value: "Left",
        selectionTarget: { kind: "text", id: "text" },
        openRoute: "text",
      }),
      expect.objectContaining({
        id: "text:text-2",
        label: "Text 2: Second group",
        value: "Right",
        selectionTarget: { kind: "text", id: "text-2" },
        openRoute: "text",
      }),
    ]);
  });

  it("pins heavy scenes to the specified group, standalone and setting order", () => {
    const devices = Array.from({ length: 6 }, (_, index) => ({
      id: `d${index + 1}`,
      model: index < 3 ? "iphone-17-pro" : "macbook-pro-16",
      media: { kind: "image" as const, src: `assets/screen-${index + 1}.png` },
    }));
    const objects = ["coffee-cup", "plant", "desk-lamp"].map((objectId, index) => ({
      id: `o${index + 1}`,
      objectId: `ws:${objectId}`,
    }));
    const frame: FrameSpec = {
      cutout: { shape: "rounded-rect" },
      decorations: ["logo", "badge"].map((id, index) => ({
        id,
        src: `assets/${id}.png`,
        position: [0, index * 0.2] as [number, number],
        size: index === 0 ? 0.24 : 0.12,
      })),
    };
    const model = overview(
      docWith({
        text: { headline: "Headline", bullets: "Feature list" },
        devices,
        videoWindow: { media: { src: "assets/screen-2.mov" }, radius: "subtle" },
        objects,
        chart: {
          type: "stackedBar",
          data: {
            categories: ["A"],
            series: Array.from({ length: 4 }, (_, index) => ({
              id: `s${index + 1}`,
              values: [index],
            })),
          },
        },
        layeredScreenshot: {
          layers: Array.from({ length: 5 }, () => ({}) as never),
          pose: { spread: 0.5, azimuthDeg: 0, elevationDeg: 0, zoom: 1, pan: [0, 0] },
        },
        compare: { mask: { type: "linear" } },
      }),
      { frame, durationMs: 6_500 },
    );

    expect(model.groups.map((group) => [group.id, group.rows.length])).toEqual([
      ["text", 2],
      ["devices", 6],
      ["images", 2],
      ["videos", 1],
      ["objects", 3],
    ]);
    expect(model.standalone.map((row) => row.id)).toEqual([
      "chart",
      "screenshotStack",
      "comparison",
    ]);
    expect(model.standalone.map((row) => row.value)).toEqual([
      "Stacked bar · 4 series",
      "5 layers",
      "Linear wipe",
    ]);
    expect(model.settings.map((row) => row.id)).toEqual([
      "overlay",
      "theme",
      "background",
      "camera",
      "lighting",
      "transition",
      "duration",
    ]);
  });

  it("disables only present singleton add options", () => {
    const model = overview(
      docWith({
        text: { headline: "Existing" },
        devices: [{ id: "d1", model: "iphone-17-pro" }],
        objects: [{ id: "o1", objectId: "ws:plant" }],
        videoWindow: { media: { src: "assets/demo.mov" }, radius: "macos" },
        chart: { type: "line", data: { categories: [], series: [] } },
        layeredScreenshot: {
          layers: [],
          pose: { spread: 0, azimuthDeg: 0, elevationDeg: 0, zoom: 1, pan: [0, 0] },
        },
        compare: {},
      }),
      { frame: { cutout: { shape: "rounded-rect" } } },
    );
    const options = Object.fromEntries(model.addOptions.map((option) => [option.id, option]));
    for (const id of ["device", "text", "image", "object"] as const) {
      expect(options[id]).toMatchObject({ singleton: false, disabled: false });
    }
    for (const id of ["video", "chart", "screenshotStack", "comparison"] as const) {
      expect(options[id]).toMatchObject({
        singleton: true,
        disabled: true,
        disabledReason: "Already in scene",
      });
    }
    expect(model.addOptions.map((option) => option.id)).toEqual([
      "device",
      "text",
      "image",
      "video",
      "object",
      "chart",
      "screenshotStack",
      "comparison",
    ]);
  });
});

describe("sceneSections (the EditBar capability gating, verbatim)", () => {
  it("a text+video-device scene gets every section", () => {
    const doc = docWith({
      text: { headline: "Hi" },
      devices: [{ media: { kind: "video", src: "assets/a.mp4" } }] as SceneDoc["devices"],
    });
    const sections = sceneSections({ doc, slotsCount: 3 });
    expect(sections.map((s) => s.id)).toEqual([
      "text",
      "device",
      "objects",
      "frame",
      "camera",
      "motion",
    ]);
    const deviceRows = sections.find((s) => s.id === "device")?.rows.map((r) => r.id);
    expect(deviceRows).toEqual([
      "device.media",
      "device.editVideo",
      "device.change",
      "device.position",
      "style.shadow",
      "device.duplicate",
      "device.add",
      "device.remove",
    ]);
    expect(
      sections.find((s) => s.id === "device")?.rows.find((r) => r.id === "device.position")?.label,
    ).toBe("Arrangement");
  });

  it("no text → the Text section offers a single Add text row; image media → no Edit video", () => {
    const doc = docWith({
      devices: [{ media: { kind: "image", src: "assets/a.png" } }] as SceneDoc["devices"],
    });
    const sections = sceneSections({ doc, slotsCount: 2 });
    expect(sections.map((s) => s.id)).toEqual([
      "text",
      "device",
      "objects",
      "frame",
      "camera",
      "motion",
    ]);
    const textRows = sections.find((s) => s.id === "text")?.rows;
    expect(textRows?.map((r) => r.id)).toEqual(["text.add"]);
    expect(textRows?.[0].chevron).toBe(false);
    expect(textRows?.[0].danger).toBeUndefined();
    expect(sections.find((s) => s.id === "device")?.rows.map((r) => r.id)).not.toContain(
      "device.editVideo",
    );
  });

  it("no device → the device section offers a single Add device row and no Shadow row", () => {
    const doc = docWith({ text: { headline: "Hi" } });
    const sections = sceneSections({ doc, slotsCount: 2 });
    expect(sections.map((s) => s.id)).toEqual([
      "text",
      "device",
      "objects",
      "frame",
      "camera",
      "motion",
    ]);
    const deviceRows = sections.find((s) => s.id === "device")?.rows;
    expect(deviceRows?.map((r) => r.id)).toEqual(["device.add"]);
    expect(deviceRows?.[0].chevron).toBe(false);
    expect(deviceRows?.[0].danger).toBeUndefined();
  });

  it("a device puts the Shadow row in the Device panel", () => {
    const doc = docWith({
      devices: [{ media: { kind: "image", src: "assets/a.png" } }] as SceneDoc["devices"],
    });
    const sections = sceneSections({ doc, slotsCount: 2 });
    expect(sections.find((s) => s.id === "device")?.rows.map((r) => r.id)).toEqual([
      "device.media",
      "device.change",
      "device.position",
      "style.shadow",
      "device.duplicate",
      "device.add",
      "device.remove",
    ]);
  });

  it("doc-less scenes still get Camera + Motion (Duration always; the EditBar contract)", () => {
    const sections = sceneSections({ doc: undefined, slotsCount: 1 });
    expect(sections.map((s) => s.id)).toEqual(["camera", "motion"]);
    expect(sections.find((s) => s.id === "motion")?.rows.map((r) => r.id)).toEqual([
      "motion.duration",
    ]);
  });

  it("Transition needs a second scene (slots > 1)", () => {
    const doc = docWith({});
    const one = sceneSections({ doc, slotsCount: 1 });
    const two = sceneSections({ doc, slotsCount: 2 });
    expect(one.find((s) => s.id === "motion")?.rows.map((r) => r.id)).not.toContain(
      "motion.transition",
    );
    expect(two.find((s) => s.id === "motion")?.rows.map((r) => r.id)).toContain(
      "motion.transition",
    );
  });

  it("a laptop device adds the Lid angle row", () => {
    const doc = docWith({
      devices: [{ id: "d1", model: "macbook-pro-16" }] as SceneDoc["devices"],
    });
    const rows = sceneSections({ doc, slotsCount: 1 })
      .find((s) => s.id === "device")
      ?.rows.map((r) => r.id);
    expect(rows).toEqual([
      "device.media",
      "device.change",
      "device.position",
      "device.lid",
      "style.shadow",
      "device.duplicate",
      "device.add",
      "device.remove",
    ]);
  });

  it("Remove device is the only danger row and carries no chevron", () => {
    const doc = docWith({
      devices: [{ media: { kind: "video", src: "assets/a.mp4" } }] as SceneDoc["devices"],
    });
    const rows = sceneSections({ doc, slotsCount: 2 }).flatMap((s) => s.rows);
    const danger = rows.filter((r) => r.danger);
    expect(danger.map((r) => r.id)).toEqual(["device.remove"]);
    expect(danger[0].chevron).toBe(false);
  });

  it("selectedDeviceId scopes the device rows to that device", () => {
    const doc = docWith({
      devices: [
        { id: "d1", model: "iphone-17-pro", media: { kind: "video", src: "assets/a.mp4" } },
        { id: "d2", model: "macbook-pro-16" },
      ] as SceneDoc["devices"],
    });
    const forD1 = sceneSections({ doc, slotsCount: 1, selectedDeviceId: "d1" })
      .find((s) => s.id === "device")
      ?.rows.map((r) => r.id);
    expect(forD1).toContain("device.editVideo");
    expect(forD1).not.toContain("device.lid");
    const forD2 = sceneSections({ doc, slotsCount: 1, selectedDeviceId: "d2" })
      .find((s) => s.id === "device")
      ?.rows.map((r) => r.id);
    expect(forD2).toContain("device.lid");
    expect(forD2).not.toContain("device.editVideo");
  });

  it("a stale selectedDeviceId falls back to the first device", () => {
    const doc = docWith({
      devices: [
        { id: "d1", model: "iphone-17-pro", media: { kind: "video", src: "assets/a.mp4" } },
      ] as SceneDoc["devices"],
    });
    const rows = sceneSections({ doc, slotsCount: 1, selectedDeviceId: "gone" })
      .find((s) => s.id === "device")
      ?.rows.map((r) => r.id);
    expect(rows).toContain("device.editVideo");
  });

  it("two devices retitle the section Devices; one keeps Device", () => {
    const one = docWith({ devices: [{ id: "d1" }] as SceneDoc["devices"] });
    const two = docWith({ devices: [{ id: "d1" }, { id: "d2" }] as SceneDoc["devices"] });
    expect(sceneSections({ doc: one, slotsCount: 1 }).find((s) => s.id === "device")?.label).toBe(
      "Device",
    );
    expect(sceneSections({ doc: two, slotsCount: 1 }).find((s) => s.id === "device")?.label).toBe(
      "Devices",
    );
  });
});

describe("sceneSections Overlay section", () => {
  const cutoutFrame: FrameSpec = { cutout: { shape: "rounded-rect" } };

  it("no deck frame and no sidecar cutout → the Add overlay row", () => {
    const doc = docWith({ text: { headline: "Hi" } });
    const sections = sceneSections({ doc, slotsCount: 2 });
    const rows = sections.find((s) => s.id === "frame")?.rows;
    expect(rows?.map((r) => r.id)).toEqual(["frame.add"]);
    expect(rows?.[0].chevron).toBe(false);
  });

  it("no doc → no Overlay section at all", () => {
    const sections = sceneSections({ doc: undefined, slotsCount: 2 });
    expect(sections.map((s) => s.id)).not.toContain("frame");
  });

  it("a standalone sidecar cutout shows the full section without a deck frame", () => {
    const doc = docWith({
      text: { headline: "Hi" },
      frame: { cutout: { shape: "rounded-rect", side: "start" } },
    });
    const sections = sceneSections({ doc, slotsCount: 2, frame: cutoutFrame });
    expect(sections.find((s) => s.id === "frame")?.rows.map((r) => r.id)).toEqual([
      "frame.enabled",
      "frame.cutout",
      "frame.panel",
      "frame.icon",
      "frame.chip",
      "frame.decorations",
      "frame.text",
    ]);
  });

  it("a hidden standalone cutout (enabled: false) keeps the toggle, not Add overlay", () => {
    const doc = docWith({
      text: { headline: "Hi" },
      frame: { enabled: false, cutout: { shape: "rounded-rect", side: "start" } },
    });
    const sections = sceneSections({ doc, slotsCount: 2, frame: undefined });
    expect(sections.find((s) => s.id === "frame")?.rows.map((r) => r.id)).toEqual([
      "frame.enabled",
    ]);
  });

  it("a sidecar override without a cutout can't stand alone → the Add overlay row", () => {
    const doc = docWith({ text: { headline: "Hi" }, frame: { enabled: false } });
    const sections = sceneSections({ doc, slotsCount: 2 });
    expect(sections.find((s) => s.id === "frame")?.rows.map((r) => r.id)).toEqual(["frame.add"]);
  });

  it("a deck frame that resolves for this scene shows Overlay after device, with cutout + panel rows", () => {
    const doc = docWith({ text: { headline: "Hi" } });
    const sections = sceneSections({ doc, slotsCount: 2, deckFrame: true, frame: cutoutFrame });
    expect(sections.map((s) => s.id)).toEqual([
      "text",
      "device",
      "objects",
      "frame",
      "camera",
      "motion",
    ]);
    expect(sections.find((s) => s.id === "frame")?.rows.map((r) => r.id)).toEqual([
      "frame.enabled",
      "frame.cutout",
      "frame.panel",
      "frame.icon",
      "frame.chip",
      "frame.decorations",
      "frame.text",
    ]);
  });

  it("a deck frame the scene opted out of shows only the enable toggle", () => {
    const doc = docWith({ text: { headline: "Hi" } });
    const sections = sceneSections({ doc, slotsCount: 2, deckFrame: true, frame: undefined });
    const rows = sections.find((s) => s.id === "frame")?.rows;
    expect(rows?.map((r) => r.id)).toEqual(["frame.enabled"]);
    expect(rows?.[0].chevron).toBe(false);
  });
});

describe("the Chart row's value", () => {
  const chartWith = (parts: Partial<SceneDocChart>): SceneDocChart => ({
    type: "column",
    data: { categories: ["A"], series: [{ id: "s1", values: [1] }] },
    ...parts,
  });

  it("reads dimension then type", () => {
    expect(chartRowValue(chartWith({ dimension: "3d" }))).toBe("3D column");
    expect(chartRowValue(chartWith({ dimension: "2d", type: "line" }))).toBe("2D line");
    expect(chartRowValue(chartWith({ type: "stackedBar" }))).toBe("2D stacked bar");
  });

  it("a panel mount is always flat, whatever the block says", () => {
    expect(chartRowValue(chartWith({ dimension: "3d", mount: "panel" }))).toBe("2D column");
  });

  it("the type grid covers every schema type, in schema order", () => {
    expect(CHART_TYPE_IDS).toEqual([
      "column",
      "stackedColumn",
      "bar",
      "stackedBar",
      "line",
      "area",
      "stackedArea",
      "pie",
    ]);
    expect(CHART_TYPE_IDS.every((id) => CHART_TYPE_LABELS[id].length > 0)).toBe(true);
  });
});

describe("drillStackForScene (what the inspector keeps open across a scene change)", () => {
  const full = {
    hasDoc: true,
    textKeys: ["title", "subtitle"],
    hasDevice: true,
    hasObject: true,
    hasOverlay: true,
  };

  it("keeps a generic section the new scene also has", () => {
    expect(drillStackForScene(["text"], full)).toEqual(["text"]);
    expect(drillStackForScene(["style.background"], full)).toEqual(["style.background"]);
    expect(drillStackForScene(["lighting"], full)).toEqual(["lighting"]);
    expect(drillStackForScene(["style.theme"], full)).toEqual(["style.theme"]);
    expect(drillStackForScene(["device"], full)).toEqual(["device"]);
  });

  it("Animations survives even a doc-less scene", () => {
    expect(drillStackForScene(["camera"], { ...full, hasDoc: false, textKeys: [] })).toEqual([
      "camera",
    ]);
  });

  it("a font screen follows only while the new scene exposes that key", () => {
    expect(drillStackForScene(["text", "text.font:title"], full)).toEqual([
      "text",
      "text.font:title",
    ]);
    expect(
      drillStackForScene(["text", "text.font:title"], { ...full, textKeys: ["headline"] }),
    ).toEqual(["text"]);
  });

  it("keeps a Text icon child only while its item key still exists", () => {
    const route = textIconInspectorRoute("image", "title");
    expect(drillStackForScene(["text", route], full)).toEqual(["text", route]);
    expect(drillStackForScene(["text", route], { ...full, textKeys: ["headline"] })).toEqual([
      "text",
    ]);
  });

  it("a scene the section is missing from drops to the row list", () => {
    expect(drillStackForScene(["text"], { ...full, hasDoc: false, textKeys: [] })).toEqual([]);
    expect(drillStackForScene(["style.background"], { ...full, hasDoc: false })).toEqual([]);
    expect(drillStackForScene(["device"], { ...full, hasDevice: false })).toEqual([]);
    expect(drillStackForScene(["objects"], { ...full, hasObject: false })).toEqual([]);
    expect(drillStackForScene(["frame"], { ...full, hasOverlay: false })).toEqual([]);
  });

  it("scene-specific editors never survive, popping to their section", () => {
    expect(drillStackForScene(["device", "device.position"], full)).toEqual(["device"]);
    expect(drillStackForScene(["frame", "frame.cutout"], full)).toEqual(["frame"]);
    expect(drillStackForScene(["objects", "objects.placement"], full)).toEqual(["objects"]);
    expect(drillStackForScene(["style.background", "style.background.media"], full)).toEqual([
      "style.background",
    ]);
    expect(drillStackForScene(["compare.edit"], full)).toEqual([]);
    expect(drillStackForScene(["motion.transition"], full)).toEqual([]);
    expect(drillStackForScene(["videoWindow.edit"], full)).toEqual([]);
  });
});
