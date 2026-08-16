import { describe, expect, it } from "vitest";
import type { SceneDoc } from "../engine/sceneDocSchema";
import {
  SCENE_KIND_OPTIONS,
  sceneWizardCanEditTitle,
  sceneWizardTitleValue,
  setSceneWizardTitle,
} from "./SceneWizards";

const testProcess = (
  globalThis as unknown as {
    process: {
      getBuiltinModule: (name: "fs") => {
        readFileSync: (path: URL, encoding: "utf8") => string;
      };
    };
  }
).process;
const rustScaffolderSource = testProcess
  .getBuiltinModule("fs")
  .readFileSync(new URL("../../src-tauri/src/scene_doc.rs", import.meta.url), "utf8");

function rustSceneKinds(): string[] {
  const body = rustScaffolderSource.match(
    /let template = match options\.kind\.as_str\(\) \{([\s\S]*?)\n {4}\};/,
  )?.[1];
  expect(body).toBeDefined();
  return [...new Set([...(body ?? "").matchAll(/"([a-z]+)"/g)].map((match) => match[1]))].sort();
}

describe("scene wizard kind parity", () => {
  it("offers exactly the 15 kinds accepted by the native scaffolder", () => {
    expect(SCENE_KIND_OPTIONS.map(({ id }) => id).sort()).toEqual(rustSceneKinds());
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
