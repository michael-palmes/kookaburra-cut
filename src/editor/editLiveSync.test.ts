import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { EditDoc, EditEntry, EditStamps, EditTap, EditWrite } from "../engine/edit";
import { relayout } from "../engine/editMath";
import {
  adoptOwnWrite,
  createEditStampState,
  describeDropped,
  type EditSyncIO,
  mergeEditDocs,
  observeEditStamp,
  pollEdit,
  sameValue,
  saveWithRebase,
} from "./editLiveSync";

const T1: EditTap = { id: "t1", sourceId: "s1", sourceMs: 1000, pos: [0.5, 0.5] };
const T2: EditTap = { id: "t2", sourceId: "s1", sourceMs: 2000, pos: [0, 0] };

const BASE: EditDoc = {
  version: 1,
  name: "hero",
  sources: [
    {
      id: "s1",
      rel: "assets/a.mp4",
      kind: "video",
      width: 1170,
      height: 2532,
      fps: 60,
      durationMs: 12000,
    },
  ],
  settings: { width: 1170, height: 2532, fps: 60 },
  clips: relayout([
    { id: "c1", sourceId: "s1", inMs: 0, outMs: 4000, speed: 1, startMs: 0 },
    { id: "c2", sourceId: "s1", inMs: 6000, outMs: 9000, speed: 2, startMs: 0 },
  ]),
  taps: [T1],
  masks: [
    {
      id: "m1",
      sourceId: "s1",
      style: "solid",
      startMs: 500,
      endMs: 1500,
      keys: [{ sourceMs: 500, rect: [0.1, 0.1, 0.2, 0.2] }],
    },
  ],
};

const edit = (patch: Partial<EditDoc>, from = BASE): EditDoc => ({ ...from, ...patch });
const withSpeed = (doc: EditDoc, id: string, speed: number) =>
  edit({ clips: relayout(doc.clips.map((c) => (c.id === id ? { ...c, speed } : c))) }, doc);

describe("observeEditStamp", () => {
  it("acts on a change once it reads the same twice; the first read sets the baseline", () => {
    const state = createEditStampState();
    expect(observeEditStamp(state, "1:10")).toBe("same");
    expect(observeEditStamp(state, "1:10")).toBe("same");
    expect(observeEditStamp(state, "2:11")).toBe("settling");
    expect(observeEditStamp(state, "3:12")).toBe("settling");
    expect(observeEditStamp(state, "3:12")).toBe("changed");
    expect(observeEditStamp(state, "3:12")).toBe("same");
  });

  it("reports a removal once it settles, and a return as a change", () => {
    const state = createEditStampState("1:10");
    expect(observeEditStamp(state, null)).toBe("settling");
    expect(observeEditStamp(state, null)).toBe("removed");
    expect(observeEditStamp(state, null)).toBe("same");
    expect(observeEditStamp(state, "4:20")).toBe("settling");
    expect(observeEditStamp(state, "4:20")).toBe("changed");
  });

  it("a flicker back to the baseline cancels the pending change", () => {
    const state = createEditStampState("1:10");
    expect(observeEditStamp(state, "2:11")).toBe("settling");
    expect(observeEditStamp(state, "1:10")).toBe("same");
    expect(observeEditStamp(state, "2:11")).toBe("settling");
  });
});

describe("adoptOwnWrite", () => {
  const write = (before: string | null, stamp: string): EditWrite => ({ hash: "h", before, stamp });

  it("adopts the editor's own write, so it never reloads it", () => {
    const state = createEditStampState("1:10");
    expect(adoptOwnWrite(state, write("1:10", "2:11"))).toBe(true);
    expect(observeEditStamp(state, "2:11")).toBe("same");
  });

  it("clears a poll that already saw the write land", () => {
    const state = createEditStampState("1:10");
    expect(observeEditStamp(state, "2:11")).toBe("settling");
    adoptOwnWrite(state, write("1:10", "2:11"));
    expect(observeEditStamp(state, "2:11")).toBe("same");
  });

  it("refuses when an outside write moved the baseline first, so that change still loads", () => {
    const state = createEditStampState("1:10");
    observeEditStamp(state, "5:50");
    observeEditStamp(state, "5:50");
    expect(adoptOwnWrite(state, write("1:10", "6:60"))).toBe(false);
    expect(observeEditStamp(state, "6:60")).toBe("settling");
    expect(observeEditStamp(state, "6:60")).toBe("changed");
  });

  it("adopts a first write to a missing file and ignores an unobserved baseline", () => {
    const removed = createEditStampState(null);
    expect(adoptOwnWrite(removed, write(null, "1:10"))).toBe(true);
    expect(adoptOwnWrite(createEditStampState(), write(null, "1:10"))).toBe(false);
  });
});

describe("mergeEditDocs", () => {
  it("takes the outside doc whole when there are no local changes", () => {
    const remote = withSpeed(edit({ tapStyle: "glow" }), "c1", 4);
    const merged = mergeEditDocs(BASE, BASE, remote);
    expect(merged).toEqual({ doc: remote, dropped: [], keptLocal: false });
  });

  it("keeps local changes the outside doc never touched", () => {
    const local = edit({ tapSize: 2 });
    const remote = withSpeed(BASE, "c2", 4);
    const merged = mergeEditDocs(BASE, local, remote);
    expect(merged.doc.tapSize).toBe(2);
    expect(merged.doc.clips[1].speed).toBe(4);
    expect(merged.keptLocal).toBe(true);
    expect(merged.dropped).toEqual([]);
  });

  it("gives a same-key clash to the outside doc and lists it", () => {
    const local = withSpeed(edit({ tapColor: "red" }), "c1", 2);
    const remote = withSpeed(edit({ tapColor: "dark" }), "c2", 0.5);
    const merged = mergeEditDocs(BASE, local, remote);
    expect(merged.doc.clips.map((c) => c.speed)).toEqual([1, 0.5]);
    expect(merged.doc.tapColor).toBe("dark");
    expect(merged.dropped).toEqual(["clips", "tapColor"]);
    expect(merged.keptLocal).toBe(false);
  });

  it("treats the same change on both sides as agreement", () => {
    const both = edit({ settings: { width: 1080, height: 1920, fps: 30 } });
    expect(mergeEditDocs(BASE, both, both)).toMatchObject({ dropped: [], keptLocal: false });
  });

  it("drops an optional key the outside doc cleared", () => {
    const base = edit({ tapStyle: "glow", reference: { rel: "assets/b.mp4", offsetMs: 0 } });
    const remote = { ...base };
    delete remote.tapStyle;
    delete remote.reference;
    const merged = mergeEditDocs(base, base, remote);
    expect("tapStyle" in merged.doc).toBe(false);
    expect("reference" in merged.doc).toBe(false);
  });

  it("merges taps per id: adds from both sides, local and outside edits of different taps", () => {
    const base = edit({ taps: [T1, T2] });
    const t3: EditTap = { id: "t3", sourceId: "s1", sourceMs: 3000, pos: [0.1, 0.1] };
    const t4: EditTap = { id: "t4", sourceId: "s1", sourceMs: 3500, pos: [0.2, 0.2] };
    const local = edit({ taps: [{ ...T1, pos: [0.9, 0.9] }, T2, t3] }, base);
    const remote = edit({ taps: [T1, t4] }, base);
    const merged = mergeEditDocs(base, local, remote);
    expect(merged.doc.taps?.map((t) => t.id)).toEqual(["t1", "t4", "t3"]);
    expect(merged.doc.taps?.[0].pos).toEqual([0.9, 0.9]);
    expect(merged.dropped).toEqual([]);
    expect(merged.keptLocal).toBe(true);
  });

  it("an edit against a deletion goes to the outside doc either way", () => {
    const movedLocally = edit({ taps: [{ ...T1, pos: [0, 0] }] });
    const deleted = edit({ taps: [] });
    expect(mergeEditDocs(BASE, movedLocally, deleted)).toMatchObject({
      doc: { taps: [] },
      dropped: ["taps.t1"],
    });
    const movedOutside = edit({ taps: [{ ...T1, pos: [1, 1] }] });
    expect(mergeEditDocs(BASE, deleted, movedOutside)).toMatchObject({
      doc: { taps: [{ id: "t1", pos: [1, 1] }] },
      dropped: ["taps.t1"],
    });
    expect(mergeEditDocs(BASE, deleted, BASE)).toMatchObject({
      doc: { taps: [] },
      keptLocal: true,
    });
  });

  it("keeps both when each side minted the same new id, the local one renamed", () => {
    const local = edit({ taps: [T1, { ...T2, sourceMs: 100 }] });
    const remote = edit({ taps: [T1, { ...T2, sourceMs: 900, pos: [1, 1] }] });
    const merged = mergeEditDocs(BASE, local, remote);
    expect(merged.doc.taps?.map((t) => [t.id, t.sourceMs])).toEqual([
      ["t1", 1000],
      ["t2", 900],
      ["t3", 100],
    ]);
    expect(merged).toMatchObject({ dropped: [], keptLocal: true });
  });

  it("merges masks per id and prunes the ones the merged clips no longer show", () => {
    const localMask = {
      id: "m2",
      sourceId: "s1",
      style: "blur" as const,
      startMs: 7000,
      endMs: 8000,
      keys: [{ sourceMs: 7000, rect: [0, 0, 0.5, 0.5] as [number, number, number, number] }],
    };
    const local = edit({ masks: [...(BASE.masks ?? []), localMask] });
    const remote = edit({ clips: relayout(BASE.clips.slice(0, 1)) });
    const merged = mergeEditDocs(BASE, local, remote);
    expect(merged.doc.masks?.map((m) => m.id)).toEqual(["m1"]);
    expect(merged.doc.clips.map((c) => c.id)).toEqual(["c1"]);
  });

  it("unions sources, never dropping one a kept clip uses", () => {
    const s2 = { ...BASE.sources[0], id: "s2", rel: "assets/b.mp4" };
    const local = edit({
      sources: [...BASE.sources, s2],
      clips: relayout([
        ...BASE.clips,
        { id: "c3", sourceId: "s2", inMs: 0, outMs: 500, speed: 1, startMs: 0 },
      ]),
    });
    const remote = edit({ tapStyle: "ring" });
    const merged = mergeEditDocs(BASE, local, remote);
    expect(merged.doc.sources.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(merged.doc.clips.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(merged.doc.tapStyle).toBe("ring");
    const base2 = edit({ sources: [...BASE.sources, s2] });
    expect(mergeEditDocs(base2, base2, BASE).doc.sources.map((s) => s.id)).toEqual(["s1"]);
    const uses = edit(
      { masks: [], taps: [{ id: "t1", sourceId: "s2", sourceMs: 10, pos: [0, 0] }] },
      base2,
    );
    expect(mergeEditDocs(base2, uses, edit({ masks: [] })).doc.sources.map((s) => s.id)).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("relays out and ignores layout-only and undefined-key differences", () => {
    const unlaid = edit({ clips: BASE.clips.map((c) => ({ ...c, startMs: 0 })) });
    const local = { ...BASE, tapStyle: undefined };
    const merged = mergeEditDocs(unlaid, local, unlaid);
    expect(merged.doc.clips).toEqual(BASE.clips);
    expect(merged).toMatchObject({ dropped: [], keptLocal: false });
  });
});

describe("sameValue", () => {
  it("compares deeply, key order free, undefined keys absent", () => {
    expect(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1, d: undefined })).toBe(
      true,
    );
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue({ a: [] }, { a: {} })).toBe(false);
  });
});

describe("describeDropped", () => {
  it("names what Claude's edit replaced", () => {
    expect(describeDropped([])).toBeNull();
    expect(describeDropped(["clips"])).toBe(
      "Claude edited this too: your changes to the clips were replaced.",
    );
    expect(describeDropped(["tapSize", "taps.t3", "masks.m2"])).toBe(
      "Claude edited this too: your changes to the tap size, tap t3 and mask m2 were replaced.",
    );
  });
});

function fakeIO(initial: { doc: EditDoc | null; render?: string | null }) {
  let doc = initial.doc;
  let n = 1;
  let stamp: string | null = doc ? "1:1" : null;
  let hash = "h1";
  const conflicts: string[] = [];
  const io: EditSyncIO & { writeOutside: (d: EditDoc | null) => void; corrupt: boolean } = {
    corrupt: false,
    stamps: vi.fn(
      async (): Promise<EditStamps> => ({ doc: stamp, render: initial.render ?? null }),
    ),
    load: vi.fn(async (): Promise<EditEntry> => {
      if (!doc) throw new Error("reading edit: missing");
      if (io.corrupt) throw new Error("edit is corrupt: expected value");
      return { doc, hash, stamp: stamp ?? "", render: null };
    }),
    save: vi.fn(async (_slug, _name, next: EditDoc, base: string | null): Promise<EditWrite> => {
      if (base !== null && base !== hash) {
        conflicts.push(base);
        throw "conflict: edits/hero.json changed outside the editor";
      }
      const before = stamp;
      doc = next;
      n += 1;
      hash = `h${n}`;
      stamp = `${n}:${n}`;
      return { hash, stamp, before };
    }),
    writeOutside: (next) => {
      doc = next;
      n += 1;
      hash = `h${n}`;
      stamp = next ? `${n}:${n}` : null;
    },
  };
  return { io, conflicts, disk: () => ({ doc, hash, stamp }) };
}

const TARGET = { slug: "demo", name: "hero" };

describe("pollEdit", () => {
  it("reads the doc once an outside change settles", async () => {
    const { io } = fakeIO({ doc: BASE });
    const watch = { doc: createEditStampState("1:1"), render: createEditStampState() };
    expect(await pollEdit(io, TARGET, watch)).toEqual({ kind: "idle" });
    const remote = withSpeed(BASE, "c1", 2);
    io.writeOutside(remote);
    expect(await pollEdit(io, TARGET, watch)).toEqual({ kind: "idle" });
    const outcome = await pollEdit(io, TARGET, watch);
    expect(outcome).toMatchObject({ kind: "changed", entry: { doc: remote, hash: "h2" } });
    expect(await pollEdit(io, TARGET, watch)).toEqual({ kind: "idle" });
  });

  it("reports a removed doc and an unreadable one", async () => {
    const { io } = fakeIO({ doc: BASE });
    const watch = { doc: createEditStampState("1:1"), render: createEditStampState() };
    io.writeOutside(null);
    await pollEdit(io, TARGET, watch);
    expect(await pollEdit(io, TARGET, watch)).toEqual({ kind: "removed" });
    io.writeOutside(BASE);
    io.corrupt = true;
    await pollEdit(io, TARGET, watch);
    expect(await pollEdit(io, TARGET, watch)).toMatchObject({
      kind: "unreadable",
      error: expect.stringContaining("corrupt"),
    });
    io.corrupt = false;
    io.writeOutside(BASE);
    await pollEdit(io, TARGET, watch);
    expect(await pollEdit(io, TARGET, watch)).toMatchObject({ kind: "changed" });
  });

  it("re-reads the render record when only it moved, and reads at once when forced", async () => {
    const { io } = fakeIO({ doc: BASE, render: "9:9" });
    const watch = { doc: createEditStampState("1:1"), render: createEditStampState("8:8") };
    await pollEdit(io, TARGET, watch);
    expect(await pollEdit(io, TARGET, watch)).toEqual({ kind: "render", render: null, hash: "h1" });
    expect(await pollEdit(io, TARGET, watch, true)).toMatchObject({ kind: "changed" });
  });
});

describe("saveWithRebase", () => {
  const never = () => {
    throw new Error("resolver should not run");
  };

  it("saves against the base hash", async () => {
    const { io, disk } = fakeIO({ doc: BASE });
    const next = withSpeed(BASE, "c1", 2);
    const outcome = await saveWithRebase(io, TARGET, next, "h1", never);
    expect(outcome).toMatchObject({
      kind: "saved",
      doc: next,
      write: { hash: "h2", before: "1:1" },
    });
    expect(disk().doc).toBe(next);
  });

  it("on a conflict re-reads, merges and saves once against the fresh hash", async () => {
    const { io, conflicts, disk } = fakeIO({ doc: BASE });
    const remote = withSpeed(BASE, "c2", 4);
    io.writeOutside(remote);
    const local = edit({ tapSize: 3 });
    const outcome = await saveWithRebase(io, TARGET, local, "h1", (entry) => {
      expect(entry).toMatchObject({ doc: remote, hash: "h2" });
      return mergeEditDocs(BASE, local, entry.doc).doc;
    });
    expect(conflicts).toEqual(["h1"]);
    expect(outcome.kind).toBe("saved");
    expect(disk().doc).toMatchObject({ tapSize: 3, clips: [{ speed: 1 }, { speed: 4 }] });
    expect(vi.mocked(io.save).mock.calls.at(-1)?.[3]).toBe("h2");
  });

  it("adopts the outside doc when nothing of ours is left to save, and defers when asked", async () => {
    const { io } = fakeIO({ doc: BASE });
    io.writeOutside(withSpeed(BASE, "c2", 4));
    expect(await saveWithRebase(io, TARGET, BASE, "h1", () => null)).toMatchObject({
      kind: "adopted",
      entry: { hash: "h2" },
    });
    expect(await saveWithRebase(io, TARGET, BASE, "h1", () => "defer")).toEqual({
      kind: "deferred",
      doc: BASE,
    });
  });

  it("throws a second conflict, other failures and a conflict without a base", async () => {
    const { io } = fakeIO({ doc: BASE });
    io.writeOutside(withSpeed(BASE, "c2", 4));
    await expect(
      saveWithRebase(io, TARGET, BASE, "h1", (entry) => {
        io.writeOutside(entry.doc);
        return BASE;
      }),
    ).rejects.toMatch(/^conflict:/);
    vi.mocked(io.save).mockRejectedValueOnce(new Error("disk full"));
    await expect(saveWithRebase(io, TARGET, BASE, "h9", never)).rejects.toThrow("disk full");
    vi.mocked(io.save).mockRejectedValueOnce(
      "conflict: edits/hero.json changed outside the editor",
    );
    await expect(saveWithRebase(io, TARGET, BASE, null, never)).rejects.toMatch(/^conflict:/);
  });
});
