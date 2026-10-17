import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildRepointVectors, serialiseRepointVectors } from "./repointVectors";

const VECTORS_PATH = fileURLToPath(
  new URL(
    "../../.agents/skills/kookaburra-scene-authoring/scripts/tests/fixtures/repoint-vectors.json",
    import.meta.url,
  ),
);

vi.spyOn(console, "warn").mockImplementation(() => {});
const vectors = buildRepointVectors();

describe("repoint conformance vectors", () => {
  it("match the committed repoint-vectors.json (run pnpm agent:vectors when this fails)", () => {
    if (process.env.KB_WRITE_VECTORS) {
      writeFileSync(VECTORS_PATH, serialiseRepointVectors(vectors));
      return;
    }
    let committed: unknown = null;
    try {
      committed = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
    } catch {
      committed = null;
    }
    const fresh = JSON.stringify(committed) === JSON.stringify(vectors);
    expect(fresh, "repoint-vectors.json is stale: run pnpm agent:vectors").toBe(true);
  });

  it("are deterministic, unique and cover every slot", () => {
    expect(serialiseRepointVectors(buildRepointVectors())).toBe(serialiseRepointVectors(vectors));
    const ids = [...vectors.repoint, ...vectors.follow].map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    const slots = new Set(vectors.repoint.filter((v) => v.expect).map((v) => v.slot));
    for (const slot of [
      "background",
      "media",
      "videoWindow",
      "device",
      "deviceCover",
      "compareDevice",
      "compareDeviceCover",
    ]) {
      expect(slots.has(slot as never), `no landing vector for ${slot}`).toBe(true);
    }
    expect(vectors.repoint.some((v) => v.expect === null)).toBe(true);
  });

  it("re-point every landing vector at the render", () => {
    for (const v of vectors.repoint) {
      if (!v.expect) continue;
      expect(JSON.stringify(v.expect), v.id).toContain(v.rel);
    }
  });
});
