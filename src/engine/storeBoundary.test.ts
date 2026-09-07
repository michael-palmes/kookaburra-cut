import { describe, expect, it } from "vitest";

// CLAUDE.md promises the export path never reads the editor store. The promise is crossed in exactly the places listed here, each tolerable for a stated reason; a new engine module reaching into `src/store` is a deliberate act that has to add itself to this list and say why the exporter is unaffected.
const engineSources = import.meta.glob<string>("./**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
});

const STORE_READERS: Record<string, string> = {
  "format.ts":
    "useFormat falls back to the store's format; export and Verify commit each leg's aspect there first (commitFormat)",
  "project.ts":
    "assetVersionSuffix is empty on a fresh load; loadProject only reads it to bust caches for re-imported media",
  "clips.ts": "the playback preview tier; exports pin the exact-PNG lane through isExporting()",
  "autorun.ts":
    "the terminal-driven runner commits the format per leg, the same store write the app's own export does",
  "projectTrust.ts":
    "the trust gate mirrors the native grant into a UI store; the export path never consults it",
  "gizmoSections.ts":
    "section-scoped gizmo outlines read the inspector route; exports disable the helper layer",
  "FrameDecoration.tsx": "preview-only chrome for overlay decorations, gated on the editing state",
  "SceneHost.tsx": "hosts read the editing state to mount gizmos, which the export preamble clears",
  "SceneTerminalPanel.tsx":
    "live terminal content is preview-only; exports render the baked snapshot",
  "SceneWebsitePanel.tsx": "live website views are preview-only; exports render the captured PNG",
  "overlayPanelTexture.ts":
    "asset version suffix for re-imported panel images, empty on a fresh load",
  "sceneTerminalBake.ts": "asset version key for the baked terminal PNG, empty on a fresh load",
};

const storeImport = /from\s+["'](?:\.\.\/)+store\//;

describe("the engine's store boundary", () => {
  const readers = Object.entries(engineSources)
    .filter(([path]) => !path.includes(".test."))
    .filter(([, source]) => storeImport.test(source))
    .map(([path]) => path.replace(/^\.\//, ""))
    .sort();

  it("is exactly the listed set of readers", () => {
    expect(readers).toEqual(Object.keys(STORE_READERS).sort());
  });

  it("names a reason for every reader", () => {
    for (const reason of Object.values(STORE_READERS)) expect(reason.length).toBeGreaterThan(20);
  });
});
