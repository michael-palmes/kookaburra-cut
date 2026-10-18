import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildMusicVectors, serialiseMusicVectors } from "./musicVectors";

const VECTORS_PATH = fileURLToPath(
  new URL(
    "../../.agents/skills/kookaburra-scene-authoring/scripts/tests/fixtures/music-vectors.json",
    import.meta.url,
  ),
);

const vectors = buildMusicVectors();

describe("music conformance vectors", () => {
  it("match the committed music-vectors.json (run pnpm agent:vectors when this fails)", () => {
    if (process.env.KB_WRITE_VECTORS) {
      writeFileSync(VECTORS_PATH, serialiseMusicVectors(vectors));
      return;
    }
    let committed: unknown = null;
    try {
      committed = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
    } catch {
      committed = null;
    }
    const fresh = JSON.stringify(committed) === JSON.stringify(vectors);
    expect(fresh, "music-vectors.json is stale: run pnpm agent:vectors").toBe(true);
  });

  it("are unique, finite and cover every error code", () => {
    const ids = vectors.resolve.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    const codes = new Set(vectors.resolve.map((v) => (v.expect.ok ? "ok" : v.expect.code)));
    expect([...codes].sort()).toEqual(["nested", "no-grid", "ok", "range", "syntax", "unknown"]);
    for (const v of vectors.resolve) {
      if (v.expect.ok) expect(Number.isFinite(v.expect.sceneLocalMs), v.id).toBe(true);
    }
  });
});
