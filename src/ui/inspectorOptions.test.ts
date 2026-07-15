import { describe, expect, it } from "vitest";
import type { SceneDoc } from "../engine/sceneDocSchema";
import { projectRows, sceneSections } from "./inspectorOptions";

describe("projectRows (the Project-tab pin)", () => {
  it("workspace projects get the full set, in order", () => {
    const rows = projectRows({
      isWorkspace: true,
      themeName: "Editorial",
      aspect: "16:9",
      soundtrackName: null,
    });
    expect(rows.map((r) => r.id)).toEqual(["media", "theme", "aspect", "music"]);
    expect(rows.every((r) => r.chevron)).toBe(true);
    expect(rows.find((r) => r.id === "music")?.value).toBe("None");
    expect(rows.find((r) => r.id === "theme")?.value).toBe("Editorial");
    expect(rows.find((r) => r.id === "aspect")?.value).toBe("16:9");
  });

  it("a soundtrack name replaces the Music 'None' value", () => {
    const rows = projectRows({
      isWorkspace: true,
      themeName: "Pacific",
      aspect: "9:16",
      soundtrackName: "sunrise.mp3",
    });
    expect(rows.find((r) => r.id === "music")?.value).toBe("sunrise.mp3");
  });

  it("bundled projects keep only Aspect ratio + a READ-ONLY Theme (decision 12)", () => {
    const rows = projectRows({
      isWorkspace: false,
      themeName: "Default",
      aspect: "1:1",
      soundtrackName: null,
    });
    expect(rows.map((r) => r.id)).toEqual(["theme", "aspect"]);
    expect(rows.find((r) => r.id === "theme")?.chevron).toBe(false);
    expect(rows.find((r) => r.id === "aspect")?.chevron).toBe(true);
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
    expect(sections.map((s) => s.id)).toEqual(["text", "device", "style", "camera", "motion"]);
    const deviceRows = sections.find((s) => s.id === "device")?.rows.map((r) => r.id);
    expect(deviceRows).toEqual([
      "device.media",
      "device.editVideo",
      "device.change",
      "device.rotation",
      "device.remove",
    ]);
  });

  it("no text → the Text section offers a single Add text row; image media → no Edit video", () => {
    const doc = docWith({
      devices: [{ media: { kind: "image", src: "assets/a.png" } }] as SceneDoc["devices"],
    });
    const sections = sceneSections({ doc, slotsCount: 2 });
    expect(sections.map((s) => s.id)).toEqual(["text", "device", "style", "camera", "motion"]);
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
    expect(sections.map((s) => s.id)).toEqual(["text", "device", "style", "camera", "motion"]);
    const deviceRows = sections.find((s) => s.id === "device")?.rows;
    expect(deviceRows?.map((r) => r.id)).toEqual(["device.add"]);
    expect(deviceRows?.[0].chevron).toBe(false);
    expect(deviceRows?.[0].danger).toBeUndefined();
    expect(sections.find((s) => s.id === "style")?.rows.map((r) => r.id)).toEqual([
      "style.theme",
      "style.background",
    ]);
  });

  it("a device adds the Shadow row to Style (M5 live round — all four drill-ins)", () => {
    const doc = docWith({
      devices: [{ media: { kind: "image", src: "assets/a.png" } }] as SceneDoc["devices"],
    });
    const sections = sceneSections({ doc, slotsCount: 2 });
    expect(sections.find((s) => s.id === "style")?.rows.map((r) => r.id)).toEqual([
      "style.theme",
      "style.background",
      "style.shadow",
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
});
