import { describe, expect, it } from "vitest";
import {
  ABSENT_BASE,
  asWriteConflict,
  contentHash,
  inheritSceneDocBase,
  outsideChangeLabel,
  outsideChangeMessage,
  rememberSceneDocHash,
  sceneDocBase,
  WriteConflictError,
} from "./sceneDocBase";
import type { SceneDoc } from "./sceneDocSchema";

describe("scene doc bases", () => {
  it("hashes text exactly as Rust hashes the file (plain SHA-256 hex)", async () => {
    expect(await contentHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("ties a hash to the document object, so a stale copy never passes for fresh", () => {
    const doc: SceneDoc = { version: 1, name: "Hero" };
    rememberSceneDocHash(doc, "h1");
    expect(sceneDocBase(doc)).toBe("h1");
    expect(sceneDocBase(structuredClone(doc))).toBeUndefined();
    expect(sceneDocBase(undefined)).toBe(ABSENT_BASE);
  });

  it("lets a preview inherit the base of the document it came from", () => {
    const doc: SceneDoc = { version: 1 };
    rememberSceneDocHash(doc, "h1");
    const preview: SceneDoc = { version: 1, name: "dragging" };
    inheritSceneDocBase(preview, doc);
    expect(sceneDocBase(preview)).toBe("h1");
    const fromNothing: SceneDoc = { version: 1 };
    inheritSceneDocBase(fromNothing, null);
    expect(sceneDocBase(fromNothing)).toBe(ABSENT_BASE);
  });

  it("recognises Rust's conflict refusals and nothing else", () => {
    const conflict = asWriteConflict("conflict: scenes/01-a.json changed outside the app");
    expect(conflict).toBeInstanceOf(WriteConflictError);
    expect(conflict?.message).toBe("scenes/01-a.json changed outside the app");
    expect(asWriteConflict(new Error("disk full"))).toBeNull();
    expect(asWriteConflict(conflict)).toBe(conflict);
  });

  it("names the scene in the toast", () => {
    const project = {
      sceneFiles: ["scenes/01-a.tsx", "./scenes/02-b.tsx"],
      sceneDocs: [{ version: 1, name: "Opening" }, undefined] as (SceneDoc | undefined)[],
    };
    expect(outsideChangeLabel(["scenes/01-a.json"], project)).toBe("“Opening”");
    expect(outsideChangeLabel(["scenes/02-b.json"], project)).toBe("“Scene 2”");
    expect(outsideChangeLabel(["project.json"], project)).toBe("project.json");
    expect(
      outsideChangeMessage(
        { slug: "s", files: ["scenes/01-a.json"], action: "dropped", what: "Undo" },
        "“Opening”",
      ),
    ).toBe("Undo skipped: “Opening” changed outside the app. Reloaded.");
  });
});
