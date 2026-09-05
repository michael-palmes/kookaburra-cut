import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reviewImportedTerminals } from "./terminalReview";
import type { ImportOutcome } from "./types";
import { reviewImportedWebsites } from "./websiteReview";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockImplementation(async (command) =>
    JSON.stringify(
      command === "read_project_manifest_snapshot"
        ? { scenes: [{ file: "scenes/01-demo.tsx" }] }
        : { terminal: { startCommand: "pnpm dev" }, website: { url: "https://example.com" } },
    ),
  );
});

describe("imported library content review", () => {
  it.each(["template", "preset"] as const)(
    "reviews %s sidecars in their own tree",
    async (kind) => {
      const outcome: ImportOutcome = {
        notes: [],
        results: [
          { kind, slug: "demo", name: "Demo", outcome: "keptBoth" },
          { kind, slug: "skip", name: "Skipped", outcome: "skipped" },
        ],
      };
      expect(await reviewImportedTerminals(outcome)).toHaveLength(1);
      expect(await reviewImportedWebsites(outcome)).toHaveLength(1);
      expect(invoke).toHaveBeenCalledWith("read_scene_doc", {
        slug: `ws-${kind}:demo`,
        file: "scenes/01-demo.json",
      });
      expect(
        vi
          .mocked(invoke)
          .mock.calls.every(([, args]) => (args as { slug: string }).slug === `ws-${kind}:demo`),
      ).toBe(true);
    },
  );
});
