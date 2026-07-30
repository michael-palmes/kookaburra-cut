import { describe, expect, it } from "vitest";
import type { SceneDoc } from "../engine/sceneDocSchema";
import type { FrameSpec } from "../toolkit/frame/types";
import { projectRows, sceneSections } from "./inspectorOptions";

describe("projectRows (the Project-tab pin)", () => {
  it("workspace projects get the full set, in order", () => {
    const rows = projectRows({
      isWorkspace: true,
      themeName: "Editorial",
      aspect: "16:9",
      soundtrackName: null,
      playbackLabel: "Full quality",
      renderLabel: "ACES",
      scenesCount: 3,
    });
    expect(rows.map((r) => r.id)).toEqual([
      "scenes",
      "theme",
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
    expect(rows.find((r) => r.id === "aspect")?.value).toBe("16:9");
    expect(rows.find((r) => r.id === "playback")?.value).toBe("Full quality");
  });

  it("a soundtrack name replaces the Music 'None' value", () => {
    const rows = projectRows({
      isWorkspace: true,
      themeName: "Pacific",
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

describe("sceneSections (the EditBar capability gating, verbatim)", () => {
  it("a text+video-device scene gets every section", () => {
    const doc = docWith({
      text: { headline: "Hi" },
      devices: [{ media: { kind: "video", src: "assets/a.mp4" } }] as SceneDoc["devices"],
    });
    const sections = sceneSections({ doc, slotsCount: 3 });
    expect(sections.map((s) => s.id)).toEqual(["text", "device", "frame", "camera", "motion"]);
    const deviceRows = sections.find((s) => s.id === "device")?.rows.map((r) => r.id);
    expect(deviceRows).toEqual([
      "device.media",
      "device.editVideo",
      "device.change",
      "device.rotation",
      "style.shadow",
      "device.duplicate",
      "device.add",
      "device.remove",
    ]);
  });

  it("no text → the Text section offers a single Add text row; image media → no Edit video", () => {
    const doc = docWith({
      devices: [{ media: { kind: "image", src: "assets/a.png" } }] as SceneDoc["devices"],
    });
    const sections = sceneSections({ doc, slotsCount: 2 });
    expect(sections.map((s) => s.id)).toEqual(["text", "device", "frame", "camera", "motion"]);
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
    expect(sections.map((s) => s.id)).toEqual(["text", "device", "frame", "camera", "motion"]);
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
      "device.rotation",
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
      "device.rotation",
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
    expect(sections.map((s) => s.id)).toEqual(["text", "device", "frame", "camera", "motion"]);
    expect(sections.find((s) => s.id === "frame")?.rows.map((r) => r.id)).toEqual([
      "frame.enabled",
      "frame.cutout",
      "frame.panel",
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
