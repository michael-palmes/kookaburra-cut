import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VirtualManagedTextRegistration } from "../../engine/managedText";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import {
  ManagedTextDrill,
  type ManagedTextDrillProps,
  type ManagedTextWrite,
  restoreManagedTextActivatorFocus,
} from "./ManagedTextDrill";

interface CapturedSliderProps {
  icon: unknown;
  label: string;
  value: number;
  onInput?: (value: number) => void;
  onCommit: (value: number) => void;
}

interface CapturedNumberProps {
  label: string;
  value: number;
  onInput?: (value: number) => void;
  onCommit: (value: number) => void;
}

interface CapturedSegmentProps {
  options: Array<{ value: string; label: string; icon?: ReactNode }>;
  value: string;
  onChange: (value: never) => void;
}

const captures = vi.hoisted(() => ({
  sliders: [] as CapturedSliderProps[],
  numbers: [] as CapturedNumberProps[],
  segments: [] as CapturedSegmentProps[],
}));

vi.mock("./rows", async () => {
  const actual = await vi.importActual<typeof import("./rows")>("./rows");
  return {
    ...actual,
    InspectorSliderRow: (props: CapturedSliderProps) => {
      captures.sliders.push(props);
      return <div data-slider={props.label}>{props.label}</div>;
    },
    NumberField: (props: CapturedNumberProps) => {
      captures.numbers.push(props);
      return <div data-number={props.label}>{props.label}</div>;
    },
    SegmentedRow: (props: CapturedSegmentProps) => {
      captures.segments.push(props);
      return (
        <div data-segmented={props.options.map((option) => option.label).join(",")}>
          {props.options.map((option) => (
            <span key={option.value}>
              {option.icon}
              {option.label}
            </span>
          ))}
        </div>
      );
    },
  };
});

function managedDoc(): SceneDoc {
  return {
    version: 1,
    managedText: {
      items: [
        { key: "title", type: "title", text: "Launch faster" },
        {
          key: "points",
          type: "bullets",
          marker: "tick",
          pointGap: 0.2,
          indent: 0.3,
          points: [
            { key: "points-point-1", text: "One workflow" },
            { key: "points-point-2", text: "Every format" },
          ],
        },
        { key: "icon", type: "icon", icon: "assets/app-icon.png" },
      ],
    },
    textStyle: { pointsSize: 1.1, pointsOffsetX: 0.25, pointsRotationDeg: -3 },
    textAnimation: { in: "fade", out: "none", staggerMs: 0 },
    textAnimationOverrides: {
      points: { in: "fade-up", out: "none", staggerMs: 90, stagger: "word" },
    },
  };
}

function props(doc: SceneDoc, selectedItemKey = "points"): ManagedTextDrillProps {
  return {
    doc,
    selectedItemKey,
    onBack: () => undefined,
    onSelectItem: () => undefined,
    onOpenMotion: () => undefined,
    onEditFont: () => undefined,
    onEditColour: () => undefined,
    confirmTakeover: async () => true,
    writeDoc: () => undefined,
  };
}

beforeEach(() => {
  captures.sliders.length = 0;
  captures.numbers.length = 0;
  captures.segments.length = 0;
});

function segmentWith(label: string): CapturedSegmentProps | undefined {
  return captures.segments.find((segment) =>
    segment.options.some((option) => option.label === label),
  );
}

describe("ManagedTextDrill", () => {
  it("restores modal activator focus after the closing frame only while it remains mounted", () => {
    const focus = vi.fn();
    const activator = { isConnected: true, focus } as unknown as HTMLElement;
    const ref = { current: activator };
    let scheduled: (() => void) | undefined;

    restoreManagedTextActivatorFocus(ref, (callback) => {
      scheduled = callback;
    });

    expect(ref.current).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    scheduled?.();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });

    focus.mockClear();
    Object.defineProperty(activator, "isConnected", { value: false });
    restoreManagedTextActivatorFocus({ current: activator }, (callback) => callback());
    expect(focus).not.toHaveBeenCalled();
  });

  it("renders the copy sheet first and exposes accessible stable-key editing controls", () => {
    const html = renderToStaticMarkup(<ManagedTextDrill {...props(managedDoc())} />);

    expect(html).toContain('aria-label="Back to Scene from Text"');
    expect(html.indexOf(">Copy<")).toBeLessThan(html.indexOf(">Selected line<"));
    expect(html).toContain("Line</button>");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Reorder Bullets line"');
    expect(html).toContain('aria-label="Move Bullets line up"');
    expect(html).toContain('aria-label="Move Bullets line down"');
    expect(html).toContain('aria-label="Reorder point 1"');
    expect(html).toContain('aria-label="Remove point 1"');
    expect(html).toContain('aria-label="Point 1"');
    expect(html).toContain('aria-label="Dot marker"');
    expect(html).toContain('aria-label="Dash marker"');
    expect(html).toContain('aria-label="Tick marker"');
    expect(html).toContain('aria-label="Number marker"');
    expect(html).toContain('aria-label="None marker"');
    expect(html).toContain("Duplicate");
    expect(html).toContain("Remove");
    expect(html).toContain("Fade Up · This line");
    expect(segmentWith("Left")?.options.map((option) => option.label)).toEqual([
      "Left",
      "Centre",
      "Right",
    ]);
    expect(segmentWith("Bullets")?.options.map((option) => option.label)).toEqual([
      "Title",
      "Subtitle",
      "Bullets",
      "Icon",
    ]);
    expect(segmentWith("Bullets")?.options.every((option) => option.icon !== undefined)).toBe(true);
    expect(html.match(/data-text-type-icon=/g)).toHaveLength(4);
    expect(html.match(/data-text-type-icon="(?:title|subtitle|bullets|icon)"/g)).toHaveLength(4);
    expect(captures.sliders.map((slider) => slider.label)).toEqual([
      "Point gap",
      "Indent",
      "Spacing",
    ]);
    expect(captures.sliders.every((slider) => slider.icon !== undefined)).toBe(true);
    expect(captures.numbers.map((field) => field.label)).toEqual([
      "Size %",
      "X",
      "Y",
      "Rotation °",
    ]);
    expect(captures.numbers[0]?.value).toBeCloseTo(110, 10);
    expect(captures.numbers.slice(1).map((field) => field.value)).toEqual([0.25, 0, -3]);
    expect(html).toContain(">Font<");
    expect(html).toContain(">Colour<");
  });

  it("writes text alignment as one rebased document edit", () => {
    const doc = { ...managedDoc(), textLayout: { align: "left" as const } };
    const writeDoc = vi.fn<ManagedTextWrite>();
    renderToStaticMarkup(<ManagedTextDrill {...props(doc)} writeDoc={writeDoc} />);

    segmentWith("Centre")?.onChange("right" as never);

    expect(writeDoc).toHaveBeenCalledTimes(1);
    const [request] = writeDoc.mock.calls[0] ?? [];
    expect(request.history).toBe("text alignment");
    expect(request.preview.textLayout).toEqual({ align: "right" });
    expect(
      request.applyToCurrent({ ...doc, background: { type: "color", color: "#123456" } }),
    ).toMatchObject({
      textLayout: { align: "right" },
      background: { type: "color", color: "#123456" },
    });
  });

  it("renders emoji and project-image icon affordances with accessible recents", () => {
    const html = renderToStaticMarkup(
      <ManagedTextDrill
        {...props(managedDoc(), "icon")}
        recentIcons={["✨", "assets/app-icon.png"]}
        resolveIconPreview={(value) =>
          value.startsWith("assets/") ? `asset://localhost/${value}` : undefined
        }
        onOpenEmoji={async () => "✨"}
        onChooseImage={async () => "assets/other.png"}
      />,
    );

    expect(html).toContain('aria-label="Icon preview"');
    expect(html).toContain('src="asset://localhost/assets/app-icon.png"');
    expect(html).toContain("Clear");
    expect(html).toContain("All emoji");
    expect(html).toContain("Image…");
    expect(html).toContain('aria-label="Use recent icon ✨"');
    expect(html).toContain('aria-label="Use recent icon assets/app-icon.png"');
    expect(html).not.toContain(">Font<");
    expect(html).not.toContain(">Colour<");
    expect(captures.sliders).toHaveLength(0);
  });

  it("requires takeover before exposing controls for a code-owned icon", () => {
    const html = renderToStaticMarkup(
      <ManagedTextDrill
        {...props({ version: 1 }, "brand-icon")}
        registrations={[
          {
            key: "brand-icon",
            type: "icon",
            text: "",
            icon: "assets/app-icon.png",
            style: { size: 1, offsetX: 0, offsetY: 0, rotationDeg: 0 },
          },
        ]}
        onOpenEmoji={async () => "✨"}
        onChooseImage={async () => "assets/other.png"}
      />,
    );

    expect(html).toContain("This icon is controlled by scene code");
    expect(html).toContain("Take over to edit");
    expect(html).not.toContain("All emoji");
    expect(html).not.toContain("Image…");
    expect(html).not.toContain(">Placement<");
    expect(html).not.toContain(">Motion<");
    expect(captures.numbers).toHaveLength(0);
    expect(captures.sliders).toHaveLength(0);
  });

  it("keeps honest header-icon controls available before takeover", () => {
    const html = renderToStaticMarkup(
      <ManagedTextDrill
        {...props({ version: 1, headerIcon: "🚀" }, "icon")}
        onOpenEmoji={async () => "✨"}
        onChooseImage={async () => "assets/other.png"}
      />,
    );

    expect(html).not.toContain("Take over to edit");
    expect(html).toContain("All emoji");
    expect(html).toContain("Image…");
    expect(html).toContain(">Placement<");
    expect(html).toContain(">Motion<");
    expect(captures.numbers.map((field) => field.label)).toEqual([
      "Size %",
      "X",
      "Y",
      "Rotation °",
    ]);
  });

  it("shows mounted code-owned style and motion before takeover", () => {
    const html = renderToStaticMarkup(
      <ManagedTextDrill
        {...props({ version: 1 }, "title")}
        registrations={[
          {
            key: "title",
            type: "title",
            text: "Mounted title",
            style: {
              color: "accent",
              font: "Avenir Next@600",
              size: 1.25,
              lineHeight: 1.4,
            },
            motion: { in: "twist-scale", out: "none", staggerMs: 0 },
          },
        ]}
      />,
    );

    expect(html).toContain("Avenir Next");
    expect(html).toContain("accent");
    expect(html).toContain("Twist Scale · This line");
    expect(captures.numbers.find((field) => field.label === "Size %")?.value).toBe(125);
    expect(captures.sliders.find((slider) => slider.label === "Spacing")?.value).toBe(1.4);
  });

  it("cancels the first structural edit without writing", async () => {
    const registrations: VirtualManagedTextRegistration[] = [
      { key: "title", type: "title", text: "Code title" },
    ];
    const confirmTakeover = vi.fn(async () => false);
    const writeDoc = vi.fn<ManagedTextWrite>();
    renderToStaticMarkup(
      <ManagedTextDrill
        {...props({ version: 1 }, "title")}
        registrations={registrations}
        confirmTakeover={confirmTakeover}
        writeDoc={writeDoc}
      />,
    );

    segmentWith("Bullets")?.onChange("subtitle" as never);
    await vi.waitFor(() => expect(confirmTakeover).toHaveBeenCalledTimes(1));
    expect(writeDoc).not.toHaveBeenCalled();
  });

  it("accepts takeover and applies the triggering type change in one document write", async () => {
    const registrations: VirtualManagedTextRegistration[] = [
      { key: "title", type: "title", text: "Code title" },
    ];
    const writeDoc = vi.fn<ManagedTextWrite>();
    const onSelectItem = vi.fn();
    renderToStaticMarkup(
      <ManagedTextDrill
        {...props({ version: 1 }, "title")}
        registrations={registrations}
        onSelectItem={onSelectItem}
        confirmTakeover={async () => true}
        writeDoc={writeDoc}
      />,
    );

    segmentWith("Bullets")?.onChange("subtitle" as never);
    await vi.waitFor(() => expect(writeDoc).toHaveBeenCalledTimes(1));
    const [request] = writeDoc.mock.calls[0] ?? [];
    expect(request.preview.managedText?.items).toEqual([
      { key: "title", type: "subtitle", text: "Code title" },
    ]);
    expect(request).toEqual({
      preview: expect.any(Object),
      history: "change text line type",
      baseline: { version: 1 },
      historyFromBaseline: false,
      applyToCurrent: expect.any(Function),
    });
    expect(onSelectItem).toHaveBeenCalledWith("title");
  });

  it("previews bullet sliders without history and commits once from the initial baseline", async () => {
    const doc = managedDoc();
    const writes: Parameters<ManagedTextWrite>[0][] = [];
    const writeDoc: ManagedTextWrite = async (request) => {
      writes.push(request);
    };
    renderToStaticMarkup(<ManagedTextDrill {...props(doc)} writeDoc={writeDoc} />);

    const gap = captures.sliders.find((slider) => slider.label === "Point gap");
    gap?.onInput?.(0.34);
    gap?.onInput?.(0.48);
    gap?.onCommit(0.48);

    await vi.waitFor(() => expect(writes).toHaveLength(3));
    expect(writes.map((write) => write.history)).toEqual([false, false, "change bullet point gap"]);
    expect(writes.map((write) => write.preview.managedText?.items[1]?.pointGap)).toEqual([
      0.34, 0.48, 0.48,
    ]);
    expect(writes[2]?.baseline).toBe(doc);
  });

  it("rebases rapid writes onto the queued current document", () => {
    const doc = managedDoc();
    const writes: Parameters<ManagedTextWrite>[0][] = [];
    const writeDoc: ManagedTextWrite = (request) => {
      writes.push(request);
    };
    renderToStaticMarkup(<ManagedTextDrill {...props(doc)} writeDoc={writeDoc} />);

    captures.numbers.find((field) => field.label === "X")?.onCommit(0.5);
    captures.numbers.find((field) => field.label === "Y")?.onCommit(-0.25);

    expect(writes).toHaveLength(2);
    const currentWithUnrelatedEdit: SceneDoc = {
      ...structuredClone(doc),
      background: { type: "color", color: "#123456" },
    };
    const queued = writes.reduce(
      (current, write) => write.applyToCurrent(current),
      currentWithUnrelatedEdit,
    );
    expect(queued.textStyle).toMatchObject({
      pointsOffsetX: 0.5,
      pointsOffsetY: -0.25,
      pointsRotationDeg: -3,
    });
    expect(queued.background).toEqual({ type: "color", color: "#123456" });
  });
});
