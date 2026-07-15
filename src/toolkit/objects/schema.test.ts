import { beforeEach, describe, expect, it, vi } from "vitest";
import { OBJECT_MANIFEST_VERSION, parseObjectManifest } from "./schema";

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
