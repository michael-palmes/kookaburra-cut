import { describe, expect, it } from "vitest";
import type { ThemeShadowSpec } from "../../theme/tokens";
import { stageMapShadowsEnabled, stageShadowCatcherMode } from "./shadowRig";

const shadow = (over: Partial<ThemeShadowSpec> = {}): ThemeShadowSpec => ({
  technique: "map",
  softness: 0.5,
  opacity: 0.3,
  mapSize: 2048,
  bias: -0.0005,
  ...over,
});

describe("stageShadowCatcherMode", () => {
  it("keeps the legacy full catcher when the backdrop flag is absent", () => {
    expect(stageShadowCatcherMode("floor", shadow())).toBe("full");
    expect(stageShadowCatcherMode("gradient", shadow())).toBe("full");
  });

  it("keeps only a floor catcher when backdrop catching is disabled", () => {
    expect(stageShadowCatcherMode("floor", shadow({ catchBackdrop: false }))).toBe("floor");
    expect(stageShadowCatcherMode("gradient", shadow({ catchBackdrop: false }))).toBe("none");
    expect(stageShadowCatcherMode("image", undefined)).toBe("none");
  });
});

describe("stageMapShadowsEnabled", () => {
  it("preserves the absent-enabled legacy map path", () => {
    expect(stageMapShadowsEnabled(true, shadow())).toBe(true);
  });

  it("requires a backdrop, map style and an enabled master", () => {
    expect(stageMapShadowsEnabled(false, shadow())).toBe(false);
    expect(stageMapShadowsEnabled(true, shadow({ technique: "none" }))).toBe(false);
    expect(stageMapShadowsEnabled(true, shadow({ enabled: false }))).toBe(false);
  });
});
