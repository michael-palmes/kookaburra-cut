import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assetRevision,
  inventoryStamp,
  noteAssetWritten,
  noteBundledAssetChanged,
  observeAssetStamp,
  refreshWorkspaceAssets,
  resetAssetRevisionsForTests,
  subscribeAssetChanges,
  subscribeAssetRevision,
  withAssetRevision,
  workspaceAssetMissing,
} from "./assetRevisions";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

type Row = { rel: string; size: number; mtimeNs: string };

function listing(stamp: string, assets: Row[]) {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_project_asset_stamps") return { stamp, assets };
    throw new Error(`unexpected ${command}`);
  });
}

afterEach(() => {
  resetAssetRevisionsForTests();
  vi.mocked(invoke).mockReset();
});

describe("withAssetRevision", () => {
  it("leaves a URL bare without a revision", () => {
    expect(withAssetRevision("asset://localhost/p/assets/a.png")).toBe(
      "asset://localhost/p/assets/a.png",
    );
    expect(withAssetRevision("asset://localhost/p/assets/a.png", "")).toBe(
      "asset://localhost/p/assets/a.png",
    );
  });

  it("appends r= and composes with the poster renderer's query", () => {
    expect(withAssetRevision("asset://localhost/p/assets/a.png", "12-345")).toBe(
      "asset://localhost/p/assets/a.png?r=12-345",
    );
    expect(withAssetRevision("asset://localhost/p/assets/a.png?poster=abc", "12-345")).toBe(
      "asset://localhost/p/assets/a.png?poster=abc&r=12-345",
    );
  });
});

describe("refreshWorkspaceAssets", () => {
  it("reads size and modified time as the revision, and reports nothing on the first listing", async () => {
    listing("s1", [{ rel: "assets/a.png", size: 12, mtimeNs: "1700000000123456789" }]);
    expect(await refreshWorkspaceAssets("ws:demo")).toEqual([]);
    expect(assetRevision("ws:demo", "assets/a.png")).toBe("12-1700000000123456789");
    expect(assetRevision("ws:demo", "./assets/a.png")).toBe("12-1700000000123456789");
    expect(inventoryStamp("ws:demo")).toBe("s1");
    expect(invoke).toHaveBeenCalledWith("list_project_asset_stamps", { slug: "demo" });
  });

  it("reports and notifies only the rels whose revision moved", async () => {
    listing("s1", [
      { rel: "assets/a.png", size: 12, mtimeNs: "1" },
      { rel: "assets/b.png", size: 12, mtimeNs: "1" },
      { rel: "assets/gone.mp4", size: 12, mtimeNs: "1" },
    ]);
    await refreshWorkspaceAssets("ws:demo");
    const a = vi.fn();
    const b = vi.fn();
    subscribeAssetRevision("ws:demo", "assets/a.png", a);
    subscribeAssetRevision("ws:demo", "assets/b.png", b);
    const changes = vi.fn();
    const off = subscribeAssetChanges(changes);
    listing("s2", [
      { rel: "assets/a.png", size: 14, mtimeNs: "2" },
      { rel: "assets/b.png", size: 12, mtimeNs: "1" },
      { rel: "assets/new.png", size: 3, mtimeNs: "3" },
    ]);
    expect(await refreshWorkspaceAssets("ws:demo")).toEqual([
      "assets/a.png",
      "assets/gone.mp4",
      "assets/new.png",
    ]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(changes).toHaveBeenCalledWith("ws:demo", [
      { rel: "assets/a.png", before: "12-1" },
      { rel: "assets/gone.mp4", before: "12-1" },
      { rel: "assets/new.png", before: undefined },
    ]);
    off();
  });

  it("keeps bundled projects bare and never lists them", async () => {
    expect(await refreshWorkspaceAssets("product-tour")).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
    expect(assetRevision("product-tour", "assets/a.png")).toBeUndefined();
  });

  it("fails open when the listing fails: no missing check, no revision", async () => {
    listing("s1", [{ rel: "assets/a.png", size: 1, mtimeNs: "1" }]);
    await refreshWorkspaceAssets("ws:demo");
    vi.mocked(invoke).mockRejectedValue(new Error("gone"));
    await refreshWorkspaceAssets("ws:demo");
    expect(assetRevision("ws:demo", "assets/a.png")).toBeUndefined();
    expect(workspaceAssetMissing("ws:demo", "assets/other.png")).toBe(false);
  });
});

describe("workspaceAssetMissing", () => {
  it("checks images against the listing once it has loaded", async () => {
    expect(workspaceAssetMissing("ws:demo", "assets/a.png")).toBe(false);
    listing("s1", [
      { rel: "assets/a.png", size: 1, mtimeNs: "1" },
      { rel: "assets/clip.mp4", size: 1, mtimeNs: "1" },
    ]);
    await refreshWorkspaceAssets("ws:demo");
    expect(workspaceAssetMissing("ws:demo", "assets/a.png")).toBe(false);
    expect(workspaceAssetMissing("ws:demo", "assets/b.png")).toBe(true);
    expect(workspaceAssetMissing("ws:demo", "assets/clip.mp4")).toBe(true);
  });
});

describe("observeAssetStamp", () => {
  it("settles a change once it reads the same on two ticks", async () => {
    expect(observeAssetStamp("ws:demo", "s1")).toBe(false);
    listing("s1", []);
    await refreshWorkspaceAssets("ws:demo");
    expect(observeAssetStamp("ws:demo", "s1")).toBe(false);
    expect(observeAssetStamp("ws:demo", "s2")).toBe(false);
    expect(observeAssetStamp("ws:demo", "s3")).toBe(false);
    expect(observeAssetStamp("ws:demo", "s3")).toBe(true);
    expect(observeAssetStamp("ws:demo", "s3")).toBe(false);
  });

  it("drops a pending change that settles back to the listing", async () => {
    listing("s1", []);
    await refreshWorkspaceAssets("ws:demo");
    expect(observeAssetStamp("ws:demo", "s2")).toBe(false);
    expect(observeAssetStamp("ws:demo", "s1")).toBe(false);
    expect(observeAssetStamp("ws:demo", "s2")).toBe(false);
  });
});

describe("local revisions", () => {
  it("bumps a bundled asset on each dev HMR change", () => {
    const listener = vi.fn();
    subscribeAssetRevision("preset:demo", "assets/a.png", listener);
    noteBundledAssetChanged("preset:demo", "assets/a.png");
    expect(assetRevision("preset:demo", "assets/a.png")).toBe("v1");
    noteBundledAssetChanged("preset:demo", "assets/a.png");
    expect(assetRevision("preset:demo", "assets/a.png")).toBe("v2");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("re-reads the stamps after an in-place write, and bumps locally without a listing", async () => {
    listing("s1", [{ rel: "assets/app-icon.png", size: 1, mtimeNs: "1" }]);
    await refreshWorkspaceAssets("ws:demo");
    listing("s2", [{ rel: "assets/app-icon.png", size: 2, mtimeNs: "2" }]);
    await noteAssetWritten("ws:demo", "assets/app-icon.png");
    expect(assetRevision("ws:demo", "assets/app-icon.png")).toBe("2-2");

    vi.mocked(invoke).mockRejectedValue(new Error("unreadable"));
    await noteAssetWritten("ws:other", "assets/app-icon.png");
    expect(assetRevision("ws:other", "assets/app-icon.png")).toBe("v1");
  });
});
