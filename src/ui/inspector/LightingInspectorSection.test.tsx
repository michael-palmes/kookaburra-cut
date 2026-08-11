import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { useLightingEditStore } from "../../engine/lightingEditStore";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import type { Theme } from "../../theme/tokens";
import {
  effectiveLightingPoseForScope,
  LIGHTING_EASING_OPTIONS,
  type LightingInspectorScreen,
  LightingInspectorSection,
  type LightingInspectorSectionProps,
} from "./LightingInspectorSection";
import { LightEditor } from "./LightingSection";

const theme: Theme = {
  id: "test",
  name: "Test",
  colors: {
    background: "#101114",
    text: "#f6f7f9",
    accent: "#70a7ff",
    muted: "#89919f",
  },
  typography: {
    headline: { family: "Inter", weight: 600 },
    body: { family: "Inter", weight: 400 },
    scale: 1.2,
  },
  motion: {
    durations: { fast: 160, base: 400, slow: 800 },
    easings: { standard: "outQuad", emphasized: "outExpo" },
  },
  lighting: {
    environment: { source: "kookaburra:softbox", intensity: 1, rotationDeg: 0 },
    sun: { azimuthDeg: 35, elevationDeg: 40, intensity: 1.8, kelvin: 5600 },
    ambient: 0.4,
    shadow: {
      technique: "map",
      softness: 0.5,
      opacity: 0.3,
      mapSize: 2048,
      bias: -0.0005,
    },
  },
};

function doc(): SceneDoc {
  return {
    version: 1,
    lighting: {
      preset: "soft-studio",
      environment: { source: "kookaburra:ferndale-studio", intensity: 1, rotationDeg: 0 },
      sun: { azimuthDeg: 35, elevationDeg: 40, intensity: 2.2, kelvin: 5600 },
      ambient: 0.4,
      lights: [
        {
          id: "key",
          name: "Hero key",
          type: "spot",
          intensity: 45,
          kelvin: 5000,
          angleDeg: 35,
          penumbra: 0.4,
          placement: { mode: "orbit", azimuthDeg: 45, elevationDeg: 30, distance: 8 },
        },
      ],
      fixtures: [
        {
          id: "tube",
          name: "Backdrop tube",
          form: "tube",
          size: [3.2, 0.06],
          kelvin: 4200,
          emissive: 3.5,
          lightIntensity: 14,
          placement: { mode: "point", position: [0, 2.4, 0] },
        },
      ],
      keys: [
        {
          id: "k1",
          tMs: 0,
          pose: {
            ambient: 0.4,
            lights: { key: { intensity: 45 } },
            fixtures: { tube: { emissive: 3.5 } },
          },
        },
        {
          id: "k2",
          tMs: 500,
          pose: {
            ambient: 0.2,
            lights: { key: { intensity: 20 } },
            fixtures: { tube: { emissive: 6 } },
          },
        },
      ],
      segments: [{ from: "k1", to: "k2", ease: "inOutQuad" }],
    },
  };
}

function props(screen: LightingInspectorScreen, sceneDoc = doc()): LightingInspectorSectionProps {
  return {
    doc: sceneDoc,
    theme,
    projectId: "test",
    projectLighting: undefined,
    slot: { startMs: 1000, durationMs: 2000 },
    backLabel: screen === "overview" ? "Scene" : "Lighting",
    screen,
    onBack: () => undefined,
    onScreenChange: () => undefined,
    patchDoc: async () => undefined,
    patchDocResult: async () => true,
    commitFromBaseline: async () => undefined,
  };
}

beforeEach(() => useLightingEditStore.getState().reset());

describe("LightingInspectorSection", () => {
  it("uses the concise lighting easing language", () => {
    expect(LIGHTING_EASING_OPTIONS.map((option) => option.label)).toEqual([
      "Linear",
      "Smooth",
      "Snappy",
    ]);
  });

  it("captures complete effective values for one light and fixture", () => {
    const lighting = doc().lighting;
    expect(effectiveLightingPoseForScope({}, lighting, { kind: "light", id: "key" })).toEqual({
      lights: {
        key: {
          intensity: 45,
          kelvin: 5000,
          placement: { mode: "orbit", azimuthDeg: 45, elevationDeg: 30, distance: 8 },
        },
      },
    });
    expect(effectiveLightingPoseForScope({}, lighting, { kind: "fixture", id: "tube" })).toEqual({
      fixtures: {
        tube: {
          emissive: 3.5,
          lightIntensity: 14,
          placement: { mode: "point", position: [0, 2.4, 0] },
        },
      },
    });
  });

  it("renders the six tuned looks, retains the selected look and derives its changes", () => {
    const html = renderToStaticMarkup(<LightingInspectorSection {...props("overview")} />);
    for (const label of [
      "Soft studio",
      "Hard keynote",
      "Neon corridor",
      "Golden hour",
      "Dark rim",
      "Clinical white",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain("Overcast");
    expect(html).toContain("changes");
    expect(html).toContain("lighting-thumbs/soft-studio.jpg");
    expect(html).toContain('data-lighting-screen="overview"');
  });

  it("keeps every tuned look actionable when the scene has no resolved lighting", () => {
    const unlitTheme = structuredClone(theme);
    delete unlitTheme.lighting;
    const html = renderToStaticMarkup(
      <LightingInspectorSection {...props("overview", { version: 1 })} theme={unlitTheme} />,
    );
    for (const label of [
      "Soft studio",
      "Hard keynote",
      "Neon corridor",
      "Golden hour",
      "Dark rim",
      "Clinical white",
    ]) {
      expect(html).toContain(label);
    }
    expect(html.match(/role="button"/g)).toHaveLength(6);
    expect(html).toContain("Choose a tuned look to light it");
    expect(html).toContain('aria-label="Sun off"');
  });

  it("keeps the shipping range markup and adds semantic slider icons", () => {
    const sceneDoc = doc();
    if (sceneDoc.lighting?.sun) sceneDoc.lighting.sun.enabled = false;
    const html = renderToStaticMarkup(
      <LightingInspectorSection {...props("overview", sceneDoc)} />,
    );
    expect(html).toContain("Sun off");
    expect(html).toContain("inspector-slider-row-icon");
    expect(html).toContain('type="range"');
    expect(html).toContain("disabled");
  });

  it("exposes every detail screen through the route-controlled integration API", () => {
    const screens: Array<[LightingInspectorScreen, string]> = [
      ["environment", "Environment"],
      ["sun", "Sun &amp; ambient"],
      ["fixtures", "Lights &amp; fixtures"],
      ["shadows", "Shadows"],
      ["animation", "Animation"],
    ];
    for (const [screen, title] of screens) {
      const html = renderToStaticMarkup(<LightingInspectorSection {...props(screen)} />);
      expect(html).toContain(`data-lighting-screen="${screen}"`);
      expect(html).toContain(title);
      expect(html).toContain("Lighting");
    }
  });

  it("keeps both entity lists and the complete add chooser visible together", () => {
    const html = renderToStaticMarkup(<LightingInspectorSection {...props("fixtures")} />);
    expect(html).toContain("Hero key");
    expect(html).toContain("Backdrop tube");
    for (const label of ["Directional", "Point", "Spot", "Area"]) expect(html).toContain(label);
    for (const label of ["Panel", "Ring", "Bulb", "Neon sign", "Ring light", "LED strip"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-label="Add a light"');
    expect(html).toContain('aria-label="Add a fixture"');
    expect(html).toContain('aria-label="Hide Hero key"');
    expect(html).toContain('aria-label="Hide Backdrop tube"');
    expect(html).toContain("45° · 30° · 45");
  });

  it("embeds the full entity editor with icon-wrapped shipping sliders", () => {
    const light = doc().lighting?.lights?.[0];
    if (!light) throw new Error("light missing");
    const html = renderToStaticMarkup(
      <LightEditor
        embedded
        light={light}
        colors={theme.colors}
        onBack={() => undefined}
        onLive={() => undefined}
        onCommit={() => undefined}
        onDuplicate={() => undefined}
        onDelete={() => undefined}
        onAnimate={() => undefined}
      />,
    );
    expect(html).toContain("lighting-inline-editor");
    expect(html).not.toContain("inspector-drill-back");
    expect(html).toContain("Animate this light");
    expect(html).toContain("inspector-slider-row-icon");
    expect(html).toContain('type="range"');
  });

  it("keeps the shadow master distinct from None and leaves Advanced closed", () => {
    const html = renderToStaticMarkup(<LightingInspectorSection {...props("shadows")} />);
    expect(html).toContain("Disables real cast shadows and stage catchers");
    expect(html).toContain("None");
    expect(html).toContain("Strength");
    expect(html).toContain("Softness");
    expect(html).toContain("Colour");
    expect(html).toContain("Catch on background");
    expect(html).toContain("Advanced");
    expect(html).toContain("Reset shadows to theme");
    expect(html).not.toContain("Spread");
    expect(html).not.toContain("<details open");
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>2048<\/button>/);
  });

  it("shows scoped key controls without introducing another timeline", () => {
    const initialState = useLightingEditStore.getInitialState();
    initialState.selectedKeyId = "k2";
    initialState.selectedSegment = 0;
    const sceneDoc = doc();
    if (sceneDoc.lighting?.segments?.[0]) sceneDoc.lighting.segments[0].ease = "linear";
    const html = renderToStaticMarkup(
      <LightingInspectorSection {...props("animation", sceneDoc)} />,
    );
    initialState.selectedKeyId = null;
    initialState.selectedSegment = null;
    expect(html).toContain("One shared lighting lane");
    expect(html).toContain("Key at playhead");
    expect(html).toContain('aria-label="Previous lighting key"');
    expect(html).toContain('aria-label="Next lighting key"');
    expect(html).toContain("0.00s");
    expect(html).toContain("0.50s");
    expect(html).not.toContain("lighting-timeline");
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Whole rig<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Linear<\/button>/);
  });
});
