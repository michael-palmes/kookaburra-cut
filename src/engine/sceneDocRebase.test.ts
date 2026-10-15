import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake workspace: sidecar texts by file, a content "hash" per text, and conflict refusals like Rust's.
const disk = new Map<string, string>();
const hashOf = (text: string) => `hash:${text}`;
const writes: Array<{ file: string; text: string; baseHash: string | null }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    const file = args.file as string;
    if (cmd === "read_scene_doc_entry") {
      const text = disk.get(file);
      return text == null ? null : { text, hash: hashOf(text) };
    }
    if (cmd === "write_scene_doc") {
      const current = disk.get(file);
      const base = args.baseHash as string | null;
      if (base !== null && base !== (current == null ? "absent" : hashOf(current))) {
        throw `conflict: ${file} changed outside the app`;
      }
      const text = args.text as string;
      writes.push({ file, text, baseHash: base });
      disk.set(file, text);
      return { file, hash: hashOf(text), before: current == null ? null : "1:1", stamp: "2:2" };
    }
    throw new Error(`unexpected command ${cmd}`);
  }),
}));

import { loadSceneDoc } from "./sceneDoc";
import { noteAppHash, type OutsideChange, onOutsideChange, sceneDocBase } from "./sceneDocBase";
import { writeSceneDocRebased } from "./sceneDocRebase";
import type { SceneDoc } from "./sceneDocSchema";

const FILE = "scenes/01-hero.json";
const TSX = "scenes/01-hero.tsx";
const reports: OutsideChange[] = [];
onOutsideChange((change) => reports.push(change));

const json = (doc: object) => JSON.stringify(doc, null, 2);
const load = async () => loadSceneDoc("ws:demo", TSX, {});
const rename = (name: string) => (from: SceneDoc | undefined) =>
  from ? { ...structuredClone(from), name } : null;

beforeEach(() => {
  disk.clear();
  writes.length = 0;
  reports.length = 0;
});

describe("writeSceneDocRebased", () => {
  it("writes over the hash the document was read at, and the written document carries the new one", async () => {
    disk.set(FILE, json({ version: 1, name: "Hero" }));
    const doc = await load();
    expect(sceneDocBase(doc)).toBe(hashOf(json({ version: 1, name: "Hero" })));

    const written = await writeSceneDocRebased("demo", TSX, doc, rename("Hero 2"));
    expect(written).toMatchObject({ rebased: false, outside: false, from: doc });
    expect(writes).toEqual([
      expect.objectContaining({ baseHash: hashOf(json({ version: 1, name: "Hero" })) }),
    ]);
    expect(sceneDocBase(written?.doc)).toBe(hashOf(disk.get(FILE) ?? ""));
    expect(reports).toEqual([]);
  });

  it("rebuilds the edit on the file Claude changed instead of writing the stale document", async () => {
    disk.set(FILE, json({ version: 1, name: "Hero", text: { title: "Old" } }));
    const stale = await load();
    disk.set(FILE, json({ version: 1, name: "Hero", text: { title: "Claude's title" } }));

    const written = await writeSceneDocRebased("demo", TSX, stale, rename("Renamed"));

    expect(written?.rebased).toBe(true);
    expect(written?.outside).toBe(true);
    expect(written?.from?.text?.title).toBe("Claude's title");
    expect(JSON.parse(disk.get(FILE) ?? "{}")).toEqual({
      version: 1,
      name: "Renamed",
      text: { title: "Claude's title" },
    });
    expect(reports).toEqual([{ slug: "demo", files: [FILE], action: "rebased" }]);
  });

  it("treats a scene without a sidecar as one that must not exist yet", async () => {
    const written = await writeSceneDocRebased("demo", TSX, undefined, () => ({
      version: 1,
      name: "First",
    }));
    expect(written?.rebased).toBe(false);
    expect(writes[0]?.baseHash).toBe("absent");

    disk.delete(FILE);
    const doclessThenClaude = json({ version: 1, name: "Claude made one" });
    disk.set(FILE, doclessThenClaude);
    const rebased = await writeSceneDocRebased("demo", TSX, undefined, (from) => ({
      ...(from ?? { version: 1 }),
      background: { type: "color", color: "#000000" },
    }));
    expect(rebased?.rebased).toBe(true);
    expect(JSON.parse(disk.get(FILE) ?? "{}").name).toBe("Claude made one");
  });

  it("rebases quietly over the app's own newer write", async () => {
    disk.set(FILE, json({ version: 1, name: "A" }));
    const older = await load();
    const own = json({ version: 1, name: "B" });
    disk.set(FILE, own);
    noteAppHash(hashOf(own));

    const written = await writeSceneDocRebased("demo", TSX, older, rename("C"));
    expect(written).toMatchObject({ rebased: true, outside: false });
    expect(reports).toEqual([]);
  });

  it("drops the edit and reports when the changed file can't be read", async () => {
    disk.set(FILE, json({ version: 1 }));
    const doc = await load();
    disk.set(FILE, "{ not json");
    await expect(writeSceneDocRebased("demo", TSX, doc, rename("X"))).rejects.toThrow(
      /changed outside the app/,
    );
    expect(disk.get(FILE)).toBe("{ not json");
    expect(reports).toEqual([{ slug: "demo", files: [FILE], action: "dropped" }]);
  });

  it("writes nothing when the edit no longer applies to the changed file", async () => {
    disk.set(FILE, json({ version: 1 }));
    const doc = await load();
    disk.set(FILE, json({ version: 1, name: "Claude" }));
    const written = await writeSceneDocRebased("demo", TSX, doc, (from) =>
      from?.name ? null : { ...(from ?? { version: 1 }), name: "added" },
    );
    expect(written).toBeNull();
    expect(writes).toEqual([]);
    expect(reports).toEqual([{ slug: "demo", files: [FILE], action: "reloaded" }]);
  });
});
