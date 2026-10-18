import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { TRANSITION_CATALOG } from "../engine/transitionCatalog";
import { buildTimelineVectors, serialiseTimelineVectors } from "./timelineVectors";

const VECTORS_PATH = fileURLToPath(
  new URL(
    "../../.agents/skills/kookaburra-scene-authoring/scripts/tests/fixtures/timeline-vectors.json",
    import.meta.url,
  ),
);

vi.spyOn(console, "warn").mockImplementation(() => {});
const vectors = buildTimelineVectors();

describe("timeline conformance vectors", () => {
  it("match the committed timeline-vectors.json (run pnpm agent:vectors when this fails)", () => {
    if (process.env.KB_WRITE_VECTORS) {
      writeFileSync(VECTORS_PATH, serialiseTimelineVectors(vectors));
      return;
    }
    let committed: unknown = null;
    try {
      committed = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
    } catch {
      committed = null;
    }
    const fresh = JSON.stringify(committed) === JSON.stringify(vectors);
    expect(fresh, "timeline-vectors.json is stale: run pnpm agent:vectors").toBe(true);
  });

  it("are deterministic, unique and cover every transition type", () => {
    expect(serialiseTimelineVectors(buildTimelineVectors())).toBe(
      serialiseTimelineVectors(vectors),
    );
    const ids = vectors.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const types = new Set(
      vectors.cases.flatMap((c) =>
        c.slots.flatMap((s) => (s.transitionIn ? [s.transitionIn.type] : [])),
      ),
    );
    for (const entry of TRANSITION_CATALOG) expect(types.has(entry.type), entry.type).toBe(true);
    expect(vectors.cases.some((c) => c.at.some((a) => a.transition !== null))).toBe(true);
  });
});
