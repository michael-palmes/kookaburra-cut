import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import type { Theme } from "../../theme/tokens";
import { lookSpecForPreset, TextLookDrill, type TextLookDrillProps } from "./TextLookDrill";

interface CapturedSliderProps {
  icon: unknown;
  label: string;
  value: number;
  onInput?: (value: number) => void;
  onCommit: (value: number) => void;
}

interface CapturedColourProps {
  value: string;
  defaultValue?: string;
  label: string;
  theme?: Theme;
  onCommit: (value: string) => void;
  onReset?: () => void;
}

interface CapturedToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

const captures = vi.hoisted(() => ({
  sliders: [] as CapturedSliderProps[],
  colours: [] as CapturedColourProps[],
  toggles: [] as CapturedToggleProps[],
}));

vi.mock("../colour/ColourPicker", () => ({
  ColourPicker: (props: CapturedColourProps) => {
    captures.colours.push(props);
    return <div data-colour-picker={props.value}>Colour picker</div>;
  },
}));

vi.mock("./rows", async () => {
  const actual = await vi.importActual<typeof import("./rows")>("./rows");
  return {
    ...actual,
    InspectorSliderRow: (props: CapturedSliderProps) => {
      captures.sliders.push(props);
      return <div data-slider={props.label}>{props.label}</div>;
    },
    ToggleRow: (props: CapturedToggleProps) => {
      captures.toggles.push(props);
      return (
        <button type="button" data-toggle={props.label} aria-pressed={props.checked}>
          {props.label}
        </button>
      );
    },
  };
});

function props(doc: SceneDoc): TextLookDrillProps {
  return {
    doc,
    itemKey: "title",
    itemType: "title",
    onBack: () => undefined,
    writeDoc: () => undefined,
  };
}

beforeEach(() => {
  captures.sliders.length = 0;
  captures.colours.length = 0;
  captures.toggles.length = 0;
});

describe("TextLookDrill", () => {
  it("renders the scope, every preset card with its glyph, and the theme reset", () => {
    const html = renderToStaticMarkup(<TextLookDrill {...props({ version: 1 })} />);

    expect(html).toContain('aria-label="Back to Text from Text style"');
    expect(html).toContain(">Reset to theme style<");
    expect(html).toContain(">Gradient<");
    expect(html).toContain(">Chrome (3D)<");
    // The theme card plus ten preset cards, each leading with an svg glyph.
    expect(html.match(/text-motion-preset-card/g)?.length).toBeGreaterThanOrEqual(11);
    expect(html.match(/<svg/g)?.length).toBeGreaterThanOrEqual(11);
    // No spec configured: no param rows.
    expect(captures.sliders).toEqual([]);
    expect(captures.colours).toEqual([]);
  });

  it("shows only the selected look's params", () => {
    const outlineHtml = renderToStaticMarkup(
      <TextLookDrill
        {...props({ version: 1, textLook: { preset: "outline", strokeEm: 0.05, hollow: true } })}
      />,
    );
    expect(captures.sliders.map((slider) => slider.label)).toEqual(["Stroke"]);
    expect(captures.sliders[0]?.value).toBe(0.05);
    expect(captures.sliders.every((slider) => slider.icon !== undefined)).toBe(true);
    expect(captures.toggles.map((toggle) => toggle.label)).toEqual(["Hollow"]);
    expect(captures.colours.map((colour) => colour.label)).toEqual(["Style colour"]);
    expect(outlineHtml).toContain(">Preset controls<");

    captures.sliders.length = 0;
    captures.colours.length = 0;
    captures.toggles.length = 0;
    renderToStaticMarkup(
      <TextLookDrill {...props({ version: 1, textLook: { preset: "gradient" } })} />,
    );
    expect(captures.sliders.map((slider) => slider.label)).toEqual(["Angle"]);
    expect(captures.colours.map((colour) => colour.label)).toEqual([
      "Style colour",
      "Gradient stop B",
    ]);
    expect(captures.toggles).toEqual([]);
  });

  it("defaults the outline Hollow toggle on (the hollow-by-default contract)", () => {
    renderToStaticMarkup(
      <TextLookDrill {...props({ version: 1, textLook: { preset: "outline" } })} />,
    );
    expect(captures.toggles).toEqual([expect.objectContaining({ label: "Hollow", checked: true })]);

    captures.toggles.length = 0;
    renderToStaticMarkup(
      <TextLookDrill {...props({ version: 1, textLook: { preset: "outline", hollow: false } })} />,
    );
    expect(captures.toggles).toEqual([
      expect.objectContaining({ label: "Hollow", checked: false }),
    ]);
  });

  it("offers the glass tint well with a clear-white default and reset", () => {
    renderToStaticMarkup(
      <TextLookDrill {...props({ version: 1, textLook: { preset: "glass-3d" } })} />,
    );
    expect(captures.colours.map((colour) => colour.label)).toEqual(["Style tint"]);
    expect(captures.colours[0]?.value).toBe("#ffffff");
    expect(captures.colours[0]?.defaultValue).toBe("#ffffff");
    // No explicit tint yet: nothing to reset.
    expect(captures.colours[0]?.onReset).toBeUndefined();

    captures.colours.length = 0;
    renderToStaticMarkup(
      <TextLookDrill
        {...props({ version: 1, textLook: { preset: "glass-3d", colorA: "#22ccff" } })}
      />,
    );
    expect(captures.colours[0]?.value).toBe("#22ccff");
    expect(captures.colours[0]?.defaultValue).toBe("#ffffff");
    expect(captures.colours[0]?.onReset).toBeDefined();
  });

  it("mirrors the coded-style warning and the force override state", () => {
    const warned = renderToStaticMarkup(
      <TextLookDrill {...props({ version: 1 })} codedLookNames={["Headline"]} />,
    );
    expect(warned).toContain("Headline sets their own coded style");
    expect(warned).toContain(">Override<");

    const forced = renderToStaticMarkup(
      <TextLookDrill {...props({ version: 1, textLookForce: true })} />,
    );
    expect(forced).toContain('aria-label="Coded style override"');
    expect(forced).toContain(">Use coded style<");
  });

  it("switches presets keeping shared params, and none clears them", () => {
    const current = { preset: "neon", colorA: "#ff0055", intensity: 0.8 };
    expect(lookSpecForPreset(current, "outline")).toEqual({
      preset: "outline",
      colorA: "#ff0055",
      intensity: 0.8,
    });
    expect(lookSpecForPreset(current, "none")).toEqual({ preset: "none" });
    expect(lookSpecForPreset(undefined, "arc")).toEqual({ preset: "arc" });
  });
});
