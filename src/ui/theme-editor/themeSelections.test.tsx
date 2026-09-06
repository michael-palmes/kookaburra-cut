import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultTheme } from "../../theme/registry";
import { TextMotionPanel } from "../TextAnimationPicker";
import { TextLookPanel } from "../TextLookPicker";

vi.mock("../OptionCard", () => ({
  OptionCard: ({ label, selected }: { label: string; selected: boolean }) => (
    <button type="button" aria-pressed={selected}>
      {label}
    </button>
  ),
}));

describe("theme authoring selections", () => {
  it("shows the plain fallback without writing omitted theme settings", () => {
    const onLive = vi.fn();
    const props = {
      mode: "theme" as const,
      theme: defaultTheme,
      current: undefined,
      force: false,
      onForce: vi.fn(),
      onLive,
    };
    for (const html of [
      renderToStaticMarkup(<TextLookPanel {...props} codedLook={false} />),
      renderToStaticMarkup(<TextMotionPanel {...props} codedMotion={false} />),
    ]) {
      expect(html).not.toContain("Theme default");
      expect(html).toContain('aria-pressed="true">None</button>');
    }
    expect(onLive).not.toHaveBeenCalled();
  });

  it("selects authored style and motion presets", () => {
    const props = {
      mode: "theme" as const,
      theme: defaultTheme,
      force: false,
      onForce: vi.fn(),
      onLive: vi.fn(),
    };
    const look = renderToStaticMarkup(
      <TextLookPanel {...props} current={{ preset: "neon" }} codedLook={false} />,
    );
    const motion = renderToStaticMarkup(
      <TextMotionPanel
        {...props}
        current={{ in: "fade", out: "none", staggerMs: 0 }}
        codedMotion={false}
      />,
    );
    expect(look).toContain('aria-pressed="true">Neon</button>');
    expect(motion).toContain('aria-pressed="true">Fade</button>');
    expect(props.onLive).not.toHaveBeenCalled();
  });

  it("keeps scene inheritance selected for omitted overrides", () => {
    const props = {
      theme: defaultTheme,
      current: undefined,
      force: false,
      onForce: vi.fn(),
      onLive: vi.fn(),
    };
    for (const html of [
      renderToStaticMarkup(<TextLookPanel {...props} codedLook={false} />),
      renderToStaticMarkup(<TextMotionPanel {...props} codedMotion={false} />),
    ])
      expect(html).toContain('aria-pressed="true">Theme default</button>');
  });
});
