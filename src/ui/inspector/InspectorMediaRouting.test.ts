import { describe, expect, it } from "vitest";

const testProcess = (
  globalThis as unknown as {
    process: {
      getBuiltinModule: (name: "fs") => {
        readFileSync: (path: URL, encoding: "utf8") => string;
        readdirSync: (path: URL) => string[];
      };
    };
  }
).process;

const testFs = testProcess.getBuiltinModule("fs");

const readSource = (path: string) => testFs.readFileSync(new URL(path, import.meta.url), "utf8");

const sceneTabSource = readSource("./SceneTab.tsx");
const layeredScreenshotSource = readSource("../LayeredScreenshotBuilder.tsx");
const objectPickerSource = readSource("../ObjectPicker.tsx");

/** Every file that mounts a MediaBrowser inside the inspector: the panel's own screens plus the Screenshot Stack builder. */
function mediaBrowserSources(): string[] {
  const inspectorSources = testFs
    .readdirSync(new URL(".", import.meta.url))
    .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
    .map((file) => readSource(`./${file}`))
    .filter((source) => source.includes("<MediaBrowser"));
  return [...inspectorSources, layeredScreenshotSource];
}

function sourceSection(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Source section not found: ${start} to ${end}`);
  }
  return source.slice(startIndex, endIndex);
}

describe("inspector media routing", () => {
  it("routes every shared scene picker through the media inspector", () => {
    const picker = sourceSection(
      sceneTabSource,
      '  if (drillIn === "media.picker") {',
      "\n\n  // ── Drill-in views",
    );

    expect(sceneTabSource).not.toContain('setModal("media")');
    expect(sceneTabSource).not.toContain("mediaModal");
    expect(sceneTabSource.match(/openMediaPicker\(\{/g)).toHaveLength(8);
    expect(picker).toContain('className="inspector-drill"');
    expect(picker).toContain('className="inspector-media-host"');
    expect(picker).toContain('mediaTarget.kind === "device"');
    expect(picker).toContain('? "Screen media"');
    expect(picker).toContain('mediaPickerKind === "video"');
    expect(picker).toContain('? "Choose video"');
    expect(picker).toContain(': "Choose image"');
    expect(picker).toContain("onPick={pickSceneMedia}");
    expect(picker).not.toContain("modal-overlay");
  });

  it("adds a newly picked media entry with the automatic host and opens its inspector", () => {
    const addition = sourceSection(
      sceneTabSource,
      "  const addPickedMedia = (src: string, kind: SceneMediaKind, meta: MediaMeta | null) => {",
      "\n\n  const pickSceneMedia = (rel: string, meta: MediaMeta | null) => {",
    );
    const selection = sourceSection(
      sceneTabSource,
      "  const pickSceneMedia = (rel: string, meta: MediaMeta | null) => {",
      '\n  if (drillIn === "media.picker") {',
    );

    expect(addition).toContain("defaultSceneMediaHost(kind, sceneFrame !== undefined)");
    expect(addition).toContain("createSceneMedia(id, src, kind, host)");
    expect(addition).toContain("detectWindowRecording(meta)");
    expect(addition).toContain("jumpDrill([MEDIA_DRILL_ROUTE])");
    expect(selection).toMatch(/else \{\s*addPickedMedia\(rel, kind, meta\);\s*\}/);
    expect(selection).toContain("detectWindowRecording(meta)");
    expect(sceneTabSource).not.toContain('"image.host"');
    expect(sceneTabSource).not.toContain("ImageHostPicker");
  });

  it("opens both Screenshot Stack media pickers as inspector child screens", () => {
    const addPicker = sourceSection(
      layeredScreenshotSource,
      "  if (adding) {",
      "\n\n  if (changingMedia",
    );

    expect(addPicker).toContain('title="Add to the stack"');
    expect(addPicker).toContain('className="inspector-media-host"');
    expect(addPicker).toContain("onPick={addScreen}");
    expect(addPicker).toContain("Add text instead");
    expect(layeredScreenshotSource).not.toContain("modal-overlay");
    expect(layeredScreenshotSource).not.toContain("wizard-media-host");
  });

  it("keeps every inspector media browser inside the inspector media host", () => {
    for (const source of mediaBrowserSources()) {
      const browsers = source.match(/<MediaBrowser\b/g) ?? [];
      const inspectorHosts = source.match(/className="inspector-media-host"/g) ?? [];
      expect(browsers.length).toBeGreaterThan(0);
      expect(inspectorHosts).toHaveLength(browsers.length);
      expect(source).not.toContain("wizard-media-host");
      expect(source).not.toContain("media-modal-wide");
    }
  });

  it("opts every inspector media browser into the panel-scoped preview", () => {
    for (const source of mediaBrowserSources()) {
      const browsers = source.match(/<MediaBrowser\b/g) ?? [];
      const scoped = source.match(/\binspectorPreview\b/g) ?? [];
      expect(scoped).toHaveLength(browsers.length);
    }
  });

  it("keeps the follow-up object choice in the inspector navigation stack", () => {
    const objectPicker = sourceSection(
      sceneTabSource,
      '  if (drillIn === "objects.picker") {',
      "\n\n  // ── The section list",
    );

    expect(sceneTabSource).not.toContain('className="modal-overlay"');
    expect(sceneTabSource).not.toContain("imageHostModal");
    expect(sceneTabSource).not.toContain("objectPickerOpen");
    expect(objectPicker).toContain("<ObjectPicker embedded");
    expect(objectPickerSource).toContain("if (embedded)");
    expect(objectPickerSource).toContain(
      'className="inspector-drill-body inspector-object-picker-body"',
    );
  });

  it("embeds modal-capable gradient and transition choices when used by SceneTab", () => {
    const gradientPickers = sceneTabSource.match(/<GradientPickerModal\s+embedded\b/g) ?? [];
    const transitionPickers = sceneTabSource.match(/<TransitionModal\s+embedded\b/g) ?? [];

    expect(gradientPickers).toHaveLength(3);
    expect(transitionPickers).toHaveLength(1);
  });
});
