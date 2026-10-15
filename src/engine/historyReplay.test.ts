import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  bindHistory,
  discardHistoryWhere,
  type HistoryChange,
  type HistoryEntry,
  peekRedo,
  peekUndo,
  pushHistory,
  takeRedo,
  takeUndo,
} from "./history";
import { historyEntryTouches, replayHistoryEntry } from "./historyReplay";
import { contentHash } from "./sceneDocBase";

const docChange = (file: string, hash: string): HistoryChange => ({
  kind: "sceneDoc",
  slug: "demo",
  file,
  sceneIndex: 0,
  before: { version: 1, name: "before" },
  after: { version: 1, name: "after" },
  hash,
});

/** Disk hashes by file; a write records its base and leaves `next:<n>`. */
function fakeDisk(hashes: Record<string, string>) {
  const calls: Array<{ file: string; base: string | undefined }> = [];
  let n = 0;
  const hashesOf = vi.fn(async (_slug: string, files: string[]) =>
    files.map((file) => hashes[file] ?? "absent"),
  );
  const write = vi.fn(async (change: HistoryChange, _dir: "undo" | "redo", base?: string) => {
    const file = change.kind === "sceneDoc" ? change.file.replace(".tsx", ".json") : "project.json";
    calls.push({ file, base });
    n += 1;
    hashes[file] = `next:${n}`;
    return hashes[file];
  });
  return { calls, hashesOf, write };
}

describe("replayHistoryEntry", () => {
  it("refuses an entry whose file changed outside the app, before writing anything", async () => {
    const entry: HistoryEntry = {
      label: "scene edit",
      changes: [docChange("scenes/01-a.tsx", "h-app"), docChange("scenes/02-b.tsx", "h-b")],
    };
    const disk = fakeDisk({ "scenes/01-a.json": "h-claude", "scenes/02-b.json": "h-b" });
    const outcome = await replayHistoryEntry(entry, "undo", disk.write, disk.hashesOf);
    expect(outcome).toEqual({ status: "conflict", files: ["scenes/01-a.json"] });
    expect(disk.write).not.toHaveBeenCalled();
  });

  it("replays over the hash each change left, and keeps the new hash for the way back", async () => {
    const change = docChange("scenes/01-a.tsx", "h1");
    const entry: HistoryEntry = { label: "scene edit", changes: [change] };
    const disk = fakeDisk({ "scenes/01-a.json": "h1" });

    expect(await replayHistoryEntry(entry, "undo", disk.write, disk.hashesOf)).toEqual({
      status: "done",
    });
    expect(disk.calls).toEqual([{ file: "scenes/01-a.json", base: "h1" }]);
    expect(change.hash).toBe("next:1");

    expect(await replayHistoryEntry(entry, "redo", disk.write, disk.hashesOf)).toEqual({
      status: "done",
    });
    expect(disk.calls[1]).toEqual({ file: "scenes/01-a.json", base: "next:1" });
  });

  it("checks a manifest change never replayed against the hash of its recorded after", async () => {
    const after = '{\n  "scenes": []\n}\n';
    const entry: HistoryEntry = {
      label: "render settings",
      changes: [{ kind: "manifest", slug: "demo", before: "{}", after, reload: false }],
    };
    const matching = fakeDisk({ "project.json": await contentHash(after) });
    expect(
      (await replayHistoryEntry(entry, "undo", matching.write, matching.hashesOf)).status,
    ).toBe("done");

    const fresh: HistoryEntry = {
      label: "render settings",
      changes: [{ kind: "manifest", slug: "demo", before: "{}", after, reload: false }],
    };
    const edited = fakeDisk({ "project.json": "claude" });
    expect(await replayHistoryEntry(fresh, "undo", edited.write, edited.hashesOf)).toEqual({
      status: "conflict",
      files: ["project.json"],
    });
  });

  it("bases a file's second change in one entry on what the replay just wrote", async () => {
    const entry: HistoryEntry = {
      label: "scene edit",
      changes: [
        docChange("scenes/01-a.tsx", "h-first"),
        { kind: "manifest", slug: "demo", before: "{}", after: "{}", reload: false, hash: "m1" },
        docChange("scenes/01-a.tsx", "h-clamp"),
      ],
    };
    const disk = fakeDisk({ "scenes/01-a.json": "h-clamp", "project.json": "m1" });
    expect((await replayHistoryEntry(entry, "undo", disk.write, disk.hashesOf)).status).toBe(
      "done",
    );
    expect(disk.calls).toEqual([
      { file: "scenes/01-a.json", base: "h-clamp" },
      { file: "project.json", base: "m1" },
      { file: "scenes/01-a.json", base: "next:1" },
    ]);
  });

  it("turns a refusal mid-replay into a conflict", async () => {
    const entry: HistoryEntry = { label: "x", changes: [docChange("scenes/01-a.tsx", "h1")] };
    const disk = fakeDisk({ "scenes/01-a.json": "h1" });
    disk.write.mockRejectedValueOnce("conflict: scenes/01-a.json changed outside the app");
    expect(await replayHistoryEntry(entry, "undo", disk.write, disk.hashesOf)).toEqual({
      status: "conflict",
      files: ["scenes/01-a.json"],
    });
  });
});

describe("discarding refused entries", () => {
  const entry = (label: string, file: string): HistoryEntry => ({
    label,
    changes: [docChange(file, "h")],
  });

  beforeEach(() => {
    bindHistory(null);
    bindHistory("ws:demo", "demo");
  });

  it("drops a refused undo and every older entry on that file, keeping the rest in order", () => {
    pushHistory(entry("a1", "scenes/01-a.tsx"));
    pushHistory(entry("b1", "scenes/02-b.tsx"));
    pushHistory(entry("a2", "scenes/01-a.tsx"));
    const refused = takeUndo();
    expect(refused?.label).toBe("a2");
    discardHistoryWhere(
      (e) => e === refused || historyEntryTouches(e, "demo", ["scenes/01-a.json"]),
    );
    expect(peekUndo()?.label).toBe("b1");
    expect(peekRedo()).toBeNull();
    expect(takeUndo()?.label).toBe("b1");
    expect(takeUndo()).toBeNull();
  });

  it("drops a refused redo without losing the undo stack below it", () => {
    pushHistory(entry("b1", "scenes/02-b.tsx"));
    pushHistory(entry("a1", "scenes/01-a.tsx"));
    takeUndo();
    const refused = takeRedo();
    expect(refused?.label).toBe("a1");
    discardHistoryWhere((e) => e === refused);
    expect(peekUndo()?.label).toBe("b1");
    expect(peekRedo()).toBeNull();
  });
});
