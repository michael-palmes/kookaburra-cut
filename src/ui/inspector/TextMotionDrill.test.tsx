import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import type { TextAnimationSpec } from "../../theme/tokens";
import type { ManagedTextWrite } from "./ManagedTextDrill";
import {
  motionDeliveryChoices,
  motionSpecForDelivery,
  motionSpecForPreset,
  selectedDelivery,
  TextMotionDrill,
  type TextMotionDrillProps,
} from "./TextMotionDrill";

interface CapturedSliderProps {
  icon: unknown;
  label: string;
  value: number;
  onInput?: (value: number) => void;
  onCommit: (value: number) => void;
}

interface CapturedSegmentProps {
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: never) => void;
}

interface CapturedToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

const captures = vi.hoisted(() => ({
  sliders: [] as CapturedSliderProps[],
  segments: [] as CapturedSegmentProps[],
  toggles: [] as CapturedToggleProps[],
}));

vi.mock("./rows", async () => {
  const actual = await vi.importActual<typeof import("./rows")>("./rows");
  return {
    ...actual,
    InspectorSliderRow: (props: CapturedSliderProps) => {
      captures.sliders.push(props);
      return <div data-slider={props.label}>{props.label}</div>;
    },
    SegmentedRow: (props: CapturedSegmentProps) => {
      captures.segments.push(props);
      return (
        <div data-segmented={props.options.map((option) => option.label).join(",")}>
          {props.options.map((option) => option.label).join(" ")}
        </div>
      );
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

function props(doc: SceneDoc): TextMotionDrillProps {
  return {
    doc,
    itemKey: "title",
    itemType: "title",
    itemLabel: "Title",
    onBack: () => undefined,
    writeDoc: () => undefined,
  };
}

beforeEach(() => {
  captures.sliders.length = 0;
  captures.segments.length = 0;
  captures.toggles.length = 0;
});

describe("text motion editor model", () => {
  it("maps inspector None to the distinct static preset", () => {
    const current: TextAnimationSpec = {
      in: "fade-scale",
      out: "none",
      staggerMs: 90,
      stagger: "word",
      startScale: 0.72,
      shine: true,
    };

    expect(motionSpecForPreset(current, "static")).toEqual({
      in: "static",
      out: "static",
      staggerMs: 0,
      startScale: 0.72,
      shine: true,
    });
    expect(motionSpecForPreset(current, "static").in).not.toBe("none");
  });

  it("normalises scatter to deterministic character delivery", () => {
    expect(motionSpecForPreset({ in: "fade", out: "none", staggerMs: 0 }, "scatter-scale")).toEqual(
      {
        in: "scatter-scale",
        out: "none",
        staggerMs: 35,
        stagger: "char",
      },
    );
  });

  it("writes each delivery spelling and its tuned default delay", () => {
    const spec: TextAnimationSpec = { in: "fade-up", out: "none", staggerMs: 0 };

    expect(motionSpecForDelivery(spec, "all-at-once")).toEqual({
      ...spec,
      delivery: "all-at-once",
    });
    expect(motionSpecForDelivery(spec, "word")).toEqual({
      ...spec,
      stagger: "word",
      staggerMs: 90,
    });
    expect(motionSpecForDelivery(spec, "by-paragraph-group")).toEqual({
      ...spec,
      delivery: "by-paragraph-group",
      staggerMs: 260,
    });
    expect(selectedDelivery(motionSpecForDelivery(spec, "by-paragraph"))).toBe("by-paragraph");
  });

  it("hides invalid granular delivery for icons and per-character scatter", () => {
    expect(motionDeliveryChoices("icon", "fade").map((choice) => choice.id)).toEqual([
      "default",
      "all-at-once",
    ]);
    expect(motionDeliveryChoices("title", "scatter-scale").map((choice) => choice.id)).toEqual([
      "default",
      "char",
    ]);
  });
});

describe("TextMotionDrill", () => {
  it("renders scope, static None, the full motion grid and named coded-motion warning", () => {
    const doc: SceneDoc = {
      version: 1,
      textAnimation: {
        in: "fade-scale",
        out: "none",
        staggerMs: 90,
        stagger: "word",
        startScale: 0.75,
        shine: true,
      },
    };
    const html = renderToStaticMarkup(
      <TextMotionDrill {...props(doc)} codedMotionNames={["Brand lockup", "Title"]} />,
    );

    expect(html).toContain('aria-label="Back to Text from Text motion"');
    expect(captures.segments[0]?.options.map((option) => option.label)).toEqual([
      "All lines",
      "This line",
    ]);
    expect(html).toContain('aria-label="All lines motion preset"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Reset to theme motion");
    expect(html).toContain(">None<");
    for (const preset of [
      "Fade",
      "Fade up",
      "Blur in",
      "Slide",
      "Mask reveal",
      "Fade scale",
      "Twist scale",
      "Scatter scale",
    ]) {
      expect(html).toContain(`>${preset}<`);
    }
    expect(html).not.toContain("The plain linear reveal");
    expect(html).toContain("Brand lockup and Title set their own coded motion");
    expect(html).toContain("Leave it");
    expect(html).toContain("Override");
    expect(html).toContain("By word");
    expect(html).toContain("By letter");
    expect(html).toContain("By line");
    expect(html).not.toContain("By group");
    expect(html).toContain('aria-label="Text motion easing"');
    expect(captures.sliders.map((slider) => slider.label)).toEqual([
      "Stagger",
      "Duration",
      "Distance",
      "Start size",
    ]);
    expect(captures.sliders.every((slider) => slider.icon !== undefined)).toBe(true);
    expect(captures.toggles).toEqual([expect.objectContaining({ label: "Shine", checked: true })]);
  });

  it("does not render invalid delivery choices for an Icon", () => {
    const html = renderToStaticMarkup(
      <TextMotionDrill
        {...props({
          version: 1,
          textAnimation: { in: "fade", out: "none", staggerMs: 0 },
        })}
        itemType="icon"
      />,
    );

    expect(html).toContain("Default");
    expect(html).toContain("All at once");
    expect(html).not.toContain("By word");
    expect(html).not.toContain("By letter");
    expect(html).not.toContain("By line");
    expect(html).not.toContain("By group");
  });

  it("previews slider ticks without history and commits from the original baseline", () => {
    const doc: SceneDoc = {
      version: 1,
      textAnimation: { in: "fade", out: "none", staggerMs: 0, durationMs: 500 },
    };
    const writes: Parameters<ManagedTextWrite>[0][] = [];
    const writeDoc: ManagedTextWrite = (request) => {
      writes.push(request);
    };
    renderToStaticMarkup(<TextMotionDrill {...props(doc)} writeDoc={writeDoc} />);

    const duration = captures.sliders.find((slider) => slider.label === "Duration");
    duration?.onInput?.(750);
    duration?.onInput?.(900);
    duration?.onCommit(900);

    expect(writes.map((write) => write.history)).toEqual([false, false, "text motion duration"]);
    expect(writes.map((write) => write.preview.textAnimation?.durationMs)).toEqual([750, 900, 900]);
    expect(writes[2]?.baseline).toBe(doc);
  });

  it("writes This line controls as a stable-key exception without changing All lines", () => {
    const doc: SceneDoc = {
      version: 1,
      textAnimation: { in: "fade", out: "none", staggerMs: 0 },
      textAnimationOverrides: {
        title: { in: "twist-scale", out: "none", staggerMs: 0, direction: "from-left" },
      },
    };
    const writeDoc = vi.fn<ManagedTextWrite>();
    const html = renderToStaticMarkup(
      <TextMotionDrill {...props(doc)} initialScope="item" writeDoc={writeDoc} />,
    );

    expect(html).toContain("Match the other lines");

    const direction = captures.segments.find((segment) =>
      segment.options.some((option) => option.value === "from-right"),
    );
    direction?.onChange("from-right" as never);

    expect(writeDoc).toHaveBeenCalledTimes(1);
    const [request] = writeDoc.mock.calls[0] ?? [];
    expect(request.preview.textAnimation).toEqual(doc.textAnimation);
    expect(request.preview.textAnimationOverrides?.title).toEqual({
      in: "twist-scale",
      out: "none",
      staggerMs: 0,
      direction: "from-right",
    });
    expect(request.history).toBe("change text motion direction");
  });

  it("shows the complete Twist scale controls together", () => {
    const html = renderToStaticMarkup(
      <TextMotionDrill
        {...props({
          version: 1,
          textAnimation: {
            in: "twist-scale",
            out: "none",
            staggerMs: 0,
            direction: "from-right",
            shine: true,
          },
        })}
      />,
    );

    expect(captures.sliders.map((slider) => slider.label)).toEqual([
      "Distance",
      "Start size",
      "Duration",
    ]);
    expect(captures.segments.at(-1)?.options.map((option) => option.label)).toEqual([
      "Left",
      "Right",
    ]);
    expect(captures.toggles).toEqual([expect.objectContaining({ label: "Shine", checked: true })]);
    expect(html).toContain("Left Right");
  });
});
