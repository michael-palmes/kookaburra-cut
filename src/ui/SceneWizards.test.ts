import { describe, expect, it } from "vitest";
import { useClockStore } from "../engine/clock";
import type { SceneDoc } from "../engine/sceneDocSchema";
import {
  sceneIndexAtPlayhead,
  sceneWizardCanEditTitle,
  sceneWizardTitleValue,
  setSceneWizardTitle,
  type WizardSceneInfo,
} from "./SceneWizards";

describe("scene insertion at the playhead", () => {
  it("uses the later overlapping scene and keeps the last scene at the end", () => {
    const scenes: WizardSceneInfo[] = [0, 1, 2].map((index) => ({
      index,
      id: `scene-${index}`,
      file: `scenes/0${index + 1}.tsx`,
      stem: `0${index + 1}`,
      name: null,
      startMs: index * 3000,
      durationMs: 4000,
    }));
    const previous = useClockStore.getState().currentMs;
    try {
      useClockStore.getState().setCurrentMs(0);
      expect(sceneIndexAtPlayhead(scenes) + 1).toBe(1);
      useClockStore.getState().setCurrentMs(3500);
      expect(sceneIndexAtPlayhead(scenes) + 1).toBe(2);
      useClockStore.getState().setCurrentMs(10000);
      expect(sceneIndexAtPlayhead(scenes) + 1).toBe(3);
    } finally {
      useClockStore.getState().setCurrentMs(previous);
    }
  });
});

describe("scene wizard title compatibility", () => {
  it("reads and updates the matching managed title while mirroring legacy copy", () => {
    const doc: SceneDoc = {
      version: 1,
      text: { title: "Legacy title", subtitle: "Legacy subtitle" },
      managedText: {
        layout: "template",
        items: [
          { key: "title", type: "title", text: "Managed title" },
          { key: "subtitle", type: "subtitle", text: "Managed subtitle" },
        ],
      },
    };

    expect(sceneWizardCanEditTitle(doc)).toBe(true);
    expect(sceneWizardTitleValue(doc)).toBe("Managed title");
    const next = setSceneWizardTitle(doc, "Edited title");

    expect(next.managedText).toEqual({
      layout: "template",
      items: [
        { key: "title", type: "title", text: "Edited title" },
        { key: "subtitle", type: "subtitle", text: "Managed subtitle" },
      ],
    });
    expect(next.text).toEqual({ title: "Edited title", subtitle: "Legacy subtitle" });
    expect(doc.managedText?.items[0]?.text).toBe("Managed title");
  });

  it("keeps the legacy headline key when that is the scene's authored slot", () => {
    const doc: SceneDoc = {
      version: 1,
      text: { headline: "Legacy headline" },
      managedText: {
        items: [{ key: "headline", type: "title", text: "Managed headline" }],
      },
    };

    expect(sceneWizardCanEditTitle(doc)).toBe(true);
    expect(sceneWizardTitleValue(doc)).toBe("Managed headline");
    expect(setSceneWizardTitle(doc, "Edited headline")).toMatchObject({
      text: { headline: "Edited headline" },
      managedText: {
        items: [{ key: "headline", type: "title", text: "Edited headline" }],
      },
    });
    expect(setSceneWizardTitle(doc, "").text).toEqual({});
    const cleared = setSceneWizardTitle(doc, "");
    expect(sceneWizardCanEditTitle(cleared)).toBe(true);
    expect(sceneWizardTitleValue(cleared)).toBe("");
  });

  it("retains the legacy path for a code-owned scene", () => {
    const doc: SceneDoc = { version: 1, text: { title: "Original" } };

    expect(sceneWizardCanEditTitle(doc)).toBe(true);
    expect(sceneWizardTitleValue(doc)).toBe("Original");
    expect(setSceneWizardTitle(doc, "Edited")).toEqual({
      version: 1,
      text: { title: "Edited" },
    });
  });

  it("hides and does not write a title when the managed block has no matching key", () => {
    const doc: SceneDoc = {
      version: 1,
      text: { title: "Legacy title", subtitle: "Legacy subtitle" },
      managedText: {
        layout: "template",
        items: [{ key: "subtitle", type: "subtitle", text: "Managed subtitle" }],
      },
    };

    expect(sceneWizardCanEditTitle(doc)).toBe(false);
    expect(sceneWizardTitleValue(doc)).toBe("");
    expect(setSceneWizardTitle(doc, "Edited title")).toEqual(doc);
    expect(doc.managedText?.items).toEqual([
      { key: "subtitle", type: "subtitle", text: "Managed subtitle" },
    ]);
  });

  it.each(["icon", "bullets"] as const)(
    "hides dormant title copy after its item becomes %s",
    (type) => {
      const doc: SceneDoc = {
        version: 1,
        text: { title: "Legacy title" },
        managedText: {
          items: [
            type === "icon"
              ? { key: "title", type, icon: "🚀", text: "Dormant title" }
              : {
                  key: "title",
                  type,
                  text: "Dormant title",
                  points: [{ key: "point-1", text: "Visible point" }],
                },
          ],
        },
      };

      expect(sceneWizardCanEditTitle(doc)).toBe(false);
      expect(sceneWizardTitleValue(doc)).toBe("");
      expect(setSceneWizardTitle(doc, "Edited")).toEqual(doc);
    },
  );

  it("keeps App Version's subtitle-typed title slot editable", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        items: [{ key: "title", type: "subtitle", text: "Your App" }],
      },
    };

    expect(sceneWizardCanEditTitle(doc)).toBe(true);
    expect(sceneWizardTitleValue(doc)).toBe("Your App");
    expect(setSceneWizardTitle(doc, "New App").managedText?.items[0]?.text).toBe("New App");
  });
});
