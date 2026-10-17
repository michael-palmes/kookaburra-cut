import { describe, expect, it } from "vitest";
import {
  editRenderMatchesPending,
  emptyMediaChangeBatch,
  isAgentMediaChange,
  mediaChangedSlug,
  noteMediaChange,
} from "./mediaChangedEvent";

const pending = { slug: "demo", editName: "clip" };
const agent = { slug: "demo", paths: ["assets/clip-edited.mp4"], edit: "clip", origin: "agent" };

describe("media-changed broadcasts", () => {
  it("reads the slug of any payload shape and spots agent renders", () => {
    expect(mediaChangedSlug(null)).toBeNull();
    expect(mediaChangedSlug({ slug: "demo", name: "clip" })).toBe("demo");
    expect(mediaChangedSlug(agent)).toBe("demo");
    expect(mediaChangedSlug({ slug: "" })).toBeNull();
    expect(isAgentMediaChange(agent)).toBe(true);
    expect(isAgentMediaChange({ slug: "demo", name: "clip" })).toBe(false);
    expect(isAgentMediaChange(null)).toBe(false);
  });

  it("matches a pending re-point only to its own editor render", () => {
    expect(editRenderMatchesPending({ slug: "demo", name: "clip" }, pending)).toBe(true);
    expect(editRenderMatchesPending({ slug: "demo", name: "other" }, pending)).toBe(false);
    expect(editRenderMatchesPending({ slug: "elsewhere", name: "clip" }, pending)).toBe(false);
    expect(editRenderMatchesPending({ slug: "demo", name: "clip" }, null)).toBe(false);
    expect(editRenderMatchesPending(null, pending)).toBe(false);
  });

  it("never lets an agent render consume a pending re-point", () => {
    expect(editRenderMatchesPending(agent, pending)).toBe(false);
    expect(editRenderMatchesPending({ ...agent, name: "clip" }, pending)).toBe(false);
  });
});

describe("noteMediaChange", () => {
  it("refreshes for an agent render without syncing durations or re-pointing", () => {
    const batch = emptyMediaChangeBatch();
    noteMediaChange(batch, agent);
    expect([...batch.slugs]).toEqual(["demo"]);
    expect(batch.rendered).toBeNull();
    expect(batch.syncDurations).toBe(false);
  });

  it("keeps the latest editor render and syncs durations for app broadcasts", () => {
    const batch = emptyMediaChangeBatch();
    noteMediaChange(batch, { slug: "demo", name: "first" });
    noteMediaChange(batch, agent);
    noteMediaChange(batch, null);
    expect(batch.rendered).toEqual({ slug: "demo", name: "first" });
    noteMediaChange(batch, { slug: "demo", name: "second" });
    expect(batch.rendered).toEqual({ slug: "demo", name: "second" });
    expect(batch.syncDurations).toBe(true);
    expect([...batch.slugs]).toEqual(["demo"]);
  });

  it("syncs durations for an import, which names no project", () => {
    const batch = emptyMediaChangeBatch();
    noteMediaChange(batch, null);
    expect(batch).toEqual({ slugs: new Set(), rendered: null, syncDurations: true });
  });
});
