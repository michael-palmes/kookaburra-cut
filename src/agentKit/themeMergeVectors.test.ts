import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildThemeMergeVectors, serialiseThemeMergeVectors } from "./themeMergeVectors";

const VECTORS_PATH = fileURLToPath(
  new URL(
    "../../.agents/skills/kookaburra-scene-authoring/scripts/tests/fixtures/theme-merge-vectors.json",
    import.meta.url,
  ),
);

const vectors = buildThemeMergeVectors();

describe("theme merge conformance vectors", () => {
  it("match the committed theme-merge-vectors.json (run pnpm agent:vectors when this fails)", () => {
    if (process.env.KB_WRITE_VECTORS) {
      writeFileSync(VECTORS_PATH, serialiseThemeMergeVectors(vectors));
      return;
    }
    let committed: unknown = null;
    try {
      committed = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
    } catch {
      committed = null;
    }
    const fresh = JSON.stringify(committed) === JSON.stringify(vectors);
    expect(fresh, "theme-merge-vectors.json is stale: run pnpm agent:vectors").toBe(true);
  });

  it("are deterministic, unique and cover every chain outcome", () => {
    expect(serialiseThemeMergeVectors(buildThemeMergeVectors())).toBe(
      serialiseThemeMergeVectors(vectors),
    );
    const ids = [...vectors.merge, ...vectors.resolve].map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    const problems = new Set(vectors.resolve.map((v) => v.problem));
    for (const problem of [null, "missing", "cycle", "too-long", "version", "invalid"]) {
      expect(problems.has(problem as never), `no vector for ${problem}`).toBe(true);
    }
  });

  it("never carry extends or a null into a resolved document", () => {
    const walk = (value: unknown): boolean =>
      value === null
        ? false
        : Array.isArray(value)
          ? value.every(walk)
          : typeof value === "object"
            ? Object.values(value as object).every(walk)
            : true;
    for (const v of vectors.resolve) {
      if (!v.out || v.id === "no-extends-is-unchanged") continue;
      expect(v.out.extends, v.id).toBeUndefined();
      expect(walk(v.out), v.id).toBe(true);
    }
    for (const v of vectors.merge) expect(walk(v.out), v.id).toBe(true);
  });
});
