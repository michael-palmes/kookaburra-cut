import { beforeEach, describe, expect, it, vi } from "vitest";
import { isObjectRel, OBJECT_MANIFEST_VERSION, parseObjectManifest } from "./schema";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("parseObjectManifest", () => {
  it("passes a well-formed manifest through", () => {
    const doc = {
      version: 1,
      id: "desk-lamp",
      name: "Desk lamp",
      glb: "object.glb",
      thumbnail: "thumbnail.png",
      fitHeight: 2,
      licence: { name: "CC0", holder: "Someone", redistributable: true },
      tags: ["prop", "studio"],
    };
    expect(parseObjectManifest(doc, "test")).toEqual(doc);
  });

  it("rejects docs missing required strings or with a bad version", () => {
    expect(parseObjectManifest({ version: 1, id: "x", name: "X" }, "test")).toBeUndefined();
    expect(parseObjectManifest({ id: "x", name: "X", glb: "a.glb" }, "test")).toBeUndefined();
    expect(
      parseObjectManifest(
        { version: OBJECT_MANIFEST_VERSION + 1, id: "x", name: "X", glb: "a.glb" },
        "test",
      ),
    ).toBeUndefined();
    expect(parseObjectManifest("nope", "test")).toBeUndefined();
  });

  it("keeps glb and thumbnail paths beside the manifest", () => {
    for (const ok of ["model.glb", "meshes/model.glb", "art/thumb.webp"]) {
      expect(isObjectRel(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "../model.glb",
      "a/../model.glb",
      "/Users/x/model.glb",
      "~/model.glb",
      "C:/model.glb",
      "a/b/model.glb",
      "a\\model.glb",
      ".hidden/model.glb",
      "model.glb\u0000",
      "./model.glb",
    ]) {
      expect(isObjectRel(bad), JSON.stringify(bad)).toBe(false);
    }
    const base = { version: 1, id: "x", name: "X" };
    expect(parseObjectManifest({ ...base, glb: "../../etc/model.glb" }, "t")).toBeUndefined();
    expect(parseObjectManifest({ ...base, glb: "a.glb", thumbnail: "/tmp/t.png" }, "t")).toEqual({
      ...base,
      glb: "a.glb",
    });
  });

  it("drops malformed optional fields, keeping the manifest", () => {
    const doc = parseObjectManifest(
      {
        version: 1,
        id: "x",
        name: "X",
        glb: "a.glb",
        fitHeight: -3,
        licence: { holder: "no name" },
        tags: ["ok", 4],
      },
      "test",
    );
    expect(doc).toEqual({ version: 1, id: "x", name: "X", glb: "a.glb", tags: ["ok"] });
  });
});
