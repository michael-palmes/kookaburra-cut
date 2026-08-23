import { describe, expect, it } from "vitest";
import { resolveAssetPath, resolveAssetUrl } from "./project";

// Bundled templates ship no assets/ folder; their scene media resolves by name from the shared
// projects/_samples/ pool, exactly as create_project seeds it. Presets ship their own copies.
describe("bundled library asset resolution", () => {
  it("falls back to the samples pool for a template's pool-named media", () => {
    const path = resolveAssetPath(
      "template:whats-new-social-cut",
      "assets/kooka-feed-loop-sample.mp4",
    );
    expect(path).toMatch(/\/projects\/_samples\/kooka-feed-loop-sample\.mp4$/);
  });

  it("prefers a preset's own shipped copy over the pool", () => {
    const path = resolveAssetPath("preset:feature-compare", "assets/home-old-sample.jpg");
    expect(path).toMatch(/\/presets\/feature-compare\/assets\/home-old-sample\.jpg$/);
  });

  it("leaves a genuinely missing template asset on its project-local path", () => {
    const path = resolveAssetPath("template:whats-new-social-cut", "assets/not-a-real-file.png");
    expect(path).toMatch(/\/projects\/whats-new-social-cut\/assets\/not-a-real-file\.png$/);
  });

  it("never falls back for bare bundled ids", () => {
    const path = resolveAssetPath("showcase-tour", "assets/kooka-feed-loop-sample.mp4");
    expect(path).toMatch(/\/projects\/showcase-tour\/assets\/kooka-feed-loop-sample\.mp4$/);
  });

  it("serves pool images as loadable URLs for template scenes", () => {
    const url = resolveAssetUrl("template:redesign-reveal", "assets/home-old-sample.jpg");
    expect(url).toContain("_samples");
  });
});
