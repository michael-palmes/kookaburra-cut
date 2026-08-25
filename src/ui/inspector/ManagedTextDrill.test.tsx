import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VirtualManagedTextRegistration } from "../../engine/managedText";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import type { Theme } from "../../theme/tokens";
import {
  ManagedTextDrill,
  type ManagedTextDrillProps,
  type ManagedTextWrite,
  pointerReorderIndex,
  restoreManagedTextActivatorFocus,
} from "./ManagedTextDrill";
import { applyManagedTextStructuralAction } from "./managedTextEditorModel";

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
  ariaLabel?: string;
  options: Array<{ value: string; label: string; icon?: ReactNode }>;
  value: string;
  onChange: (value: never) => void;
}

interface CapturedColourProps {
  value: string;
  defaultValue?: string;
  label: string;
  disabled?: boolean;
  theme?: Theme;
  onCommit: (value: string) => void;
  onReset?: () => void;
}

const captures = vi.hoisted(() => ({
  sliders: [] as CapturedSliderProps[],
  numbers: [] as CapturedNumberProps[],
  segments: [] as CapturedSegmentProps[],
  colours: [] as CapturedColourProps[],
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
    confirmTakeover: async () => true,
    writeDoc: () => undefined,
  };
}

beforeEach(() => {
  captures.sliders.length = 0;
  captures.numbers.length = 0;
  captures.segments.length = 0;
  captures.colours.length = 0;
});

function segmentWith(label: string): CapturedSegmentProps | undefined {
  return captures.segments.find((segment) =>
    segment.options.some((option) => option.label === label),
  );
}

describe("ManagedTextDrill", () => {
  it("shows legacy text-backed icons and bullet points honestly", () => {
    const iconHtml = renderToStaticMarkup(
      <ManagedTextDrill
        {...props(
          {
            version: 1,
            managedText: { items: [{ key: "icon", type: "icon", text: "🚀" }] },
          },
          "icon",
        )}
      />,
    );
    expect(iconHtml).toContain("Icon preview: 🚀");
    expect(iconHtml).toContain('aria-label="Use emoji 🚀" aria-pressed="true"');

    const bulletHtml = renderToStaticMarkup(
      <ManagedTextDrill
        {...props(
          {
            version: 1,
            managedText: {
              layout: "template",
              items: [{ key: "bullets", type: "bullets", text: "First\nSecond" }],
            },
          },
          "bullets",
        )}
      />,
    );
    expect(bulletHtml).toContain('value="First"');
    expect(bulletHtml).toContain('value="Second"');
  });

  it("resolves pointer reordering against non-uniform row centres", () => {
    const rows = [
      { top: 20, bottom: 50 },
      { top: 54, bottom: 104 },
      { top: 108, bottom: 138 },
    ];

    expect(pointerReorderIndex(-20, rows)).toBe(0);
    expect(pointerReorderIndex(79, rows)).toBe(1);
    expect(pointerReorderIndex(200, rows)).toBe(2);
    expect(pointerReorderIndex(10, [])).toBeNull();
  });

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

  it("renders the text element list before the selected editor with accessible controls", () => {
    const html = renderToStaticMarkup(<ManagedTextDrill {...props(managedDoc())} />);

    expect(html).toContain('aria-label="Back to Scene from Text"');
    expect(html.indexOf(">Text group<")).toBeLessThan(html.indexOf('aria-label="Bullets element"'));
    expect(html).toContain('aria-label="Add text element"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Reorder Bullets 2: One workflow · Every format"');
    expect(html).toContain('aria-label="More actions for Bullets 2: One workflow · Every format"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Reorder point 1"');
    expect(html).toContain('aria-label="Remove point 1"');
    expect(html).toContain('aria-label="Point 1"');
    expect(html).toContain('aria-label="Dot marker"');
    expect(html).toContain('aria-label="Dash marker"');
    expect(html).toContain('aria-label="Tick marker"');
    expect(html).toContain('aria-label="Number marker"');
    expect(html).toContain('aria-label="None marker"');
    expect(html).toContain('aria-label="Duplicate text group"');
    expect(html).toContain('aria-label="Remove text group"');
    expect(html).not.toContain("text-inspector-footer");
    expect(html).toContain("Fade Up · This line");
    expect(segmentWith("Left")?.options.map((option) => option.label)).toEqual([
      "Left",
      "Centre",
      "Right",
    ]);
    expect(segmentWith("Left")?.options.every((option) => option.icon !== undefined)).toBe(true);
    expect(html.match(/data-text-alignment-icon=/g)).toHaveLength(3);
    expect(html.match(/data-text-alignment-icon="(?:left|center|right)"/g)).toHaveLength(3);
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
    expect(segmentWith("Bullets")?.value).toBe("bullets");
    expect(segmentWith("Bullets")?.options.map((option) => option.label)).toEqual([
      "Title",
      "Subtitle",
      "Bullets",
      "Icon",
    ]);
    expect(html).not.toContain("draggable=");
  });

  it("hides the style controls a mounted primitive flags inert", () => {
    const doc: SceneDoc = { version: 1, text: { chip: "On time" } };
    const registrations: VirtualManagedTextRegistration[] = [
      {
        key: "chip",
        text: "On time",
        type: "subtitle",
        inertStyleControls: ["font", "colour", "x", "y", "rotation"],
      },
    ];
    const html = renderToStaticMarkup(
      <ManagedTextDrill {...props(doc, "chip")} registrations={registrations} />,
    );

    expect(html).not.toContain(">Font<");
    expect(html).not.toContain(">Colour<");
    expect(html).not.toContain(">Style<");
    expect(captures.numbers.map((field) => field.label)).toEqual(["Size %"]);
    expect(captures.sliders.map((slider) => slider.label)).toEqual(["Spacing"]);
    expect(html).toContain("Text motion");
  });

  it("keeps every style control for a row with no capability hint", () => {
    const doc: SceneDoc = { version: 1, text: { total: "128" } };
    const registrations: VirtualManagedTextRegistration[] = [
      { key: "total", text: "128", type: "subtitle" },
    ];
    const html = renderToStaticMarkup(
      <ManagedTextDrill {...props(doc, "total")} registrations={registrations} />,
    );

    expect(html).toContain(">Font<");
    expect(html).toContain(">Colour<");
    expect(captures.numbers.map((field) => field.label)).toEqual([
      "Size %",
      "X",
      "Y",
      "Rotation °",
    ]);
    expect(captures.sliders.map((slider) => slider.label)).toEqual(["Spacing"]);
  });

  it("offers the Text style row beside motion when a look opener is wired", () => {
    const doc: SceneDoc = { ...managedDoc(), textLook: { preset: "neon" } };
    const html = renderToStaticMarkup(
      <ManagedTextDrill {...props(doc)} onOpenLook={() => undefined} />,
    );

    expect(html).toContain(">Motion and style<");
    expect(html).toContain(">Text style<");
    expect(html).toContain("Neon · All lines");
  });

  it("shows newly added text immediately in the line list and copy editor", () => {
    const result = applyManagedTextStructuralAction(
      { version: 1, managedText: { items: [] } },
      { type: "add-group" },
    );
    if (!result) throw new Error("expected a managed text item");

    const html = renderToStaticMarkup(
      <ManagedTextDrill {...props(result.doc, result.selectedItemKey ?? undefined)} />,
    );

    expect(html).not.toContain(">Text group<");
    expect(html).toContain(">Alignment<");
    expect(html).toContain('class="text-inspector-icon-button text-inspector-add-line"');
    expect(html).toContain('aria-label="Add text element"');
    expect(html).toContain('aria-label="Duplicate text group"');
    expect(html).toContain('aria-label="Remove text group"');
    expect(html).toContain('class="inspector-drill-header-actions"');
    expect(captures.segments.some((segment) => segment.ariaLabel === "Text alignment")).toBe(true);
    expect(html).toContain('aria-label="Title copy"');
    expect(html).toContain(">Text</textarea>");
  });

  it("uses the compact controls for a single icon and ignores reserved frame chrome", () => {
    const iconHtml = renderToStaticMarkup(
      <ManagedTextDrill
        {...props(
          { version: 1, managedText: { items: [{ key: "icon", type: "icon", icon: "🚀" }] } },
          "icon",
        )}
      />,
    );
    expect(iconHtml).not.toContain(">Text group<");
    expect(iconHtml).toContain('aria-label="Add text element"');
    expect(iconHtml).toContain('aria-label="Duplicate text group"');
    expect(iconHtml).toContain('aria-label="Remove text group"');

    const framedHtml = renderToStaticMarkup(
      <ManagedTextDrill
        {...props(
          {
            version: 1,
            managedText: {
              items: [
                { key: "frameIcon", type: "icon", icon: "✨" },
                { key: "title", type: "title", text: "One line" },
              ],
            },
          },
          "title",
        )}
      />,
    );
    expect(framedHtml).not.toContain(">Text group<");
    expect(framedHtml).toContain('aria-label="Add text element"');
    expect(framedHtml).toContain('aria-label="Duplicate text group"');
    expect(framedHtml).toContain('aria-label="Remove text group"');
  });

  it("filters editing to the selected group and exposes one type switcher", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          { key: "title", type: "title", text: "First group" },
          { key: "subtitle", type: "subtitle", text: "Second group" },
        ],
        groups: [
          { key: "text", itemKeys: ["title"] },
          { key: "text-2", itemKeys: ["subtitle"], align: "right" },
        ],
      },
    };
    const html = renderToStaticMarkup(
      <ManagedTextDrill {...props(doc, "subtitle")} selectedGroupKey="text-2" />,
    );

    expect(html).toContain("Second group");
    expect(html).not.toContain("First group");
    expect(html.match(/data-text-type-icon=/g)).toHaveLength(4);
    expect(html).not.toContain('class="text-inspector-line active"');
    expect(segmentWith("Right")?.value).toBe("right");
    expect(segmentWith("Subtitle")?.value).toBe("subtitle");
  });

  it("follows a canvas-selected item into a different text group", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          { key: "title", type: "title", text: "Grouped title" },
          { key: "subtitle", type: "subtitle", text: "Grouped subtitle" },
          { key: "standalone", type: "title", text: "Standalone text" },
        ],
        groups: [
          { key: "text", itemKeys: ["title", "subtitle"] },
          { key: "text-2", itemKeys: ["standalone"], align: "right" },
        ],
      },
    };
    const html = renderToStaticMarkup(
      <ManagedTextDrill {...props(doc, "standalone")} selectedGroupKey="text" />,
    );

    expect(html).toContain("Standalone text");
    expect(html).not.toContain("Grouped title");
    expect(html).not.toContain("Grouped subtitle");
    expect(segmentWith("Right")?.value).toBe("right");
  });

  it("writes group alignment as one rebased document edit", () => {
    const doc = { ...managedDoc(), textLayout: { align: "left" as const } };
    const writeDoc = vi.fn<ManagedTextWrite>();
    renderToStaticMarkup(<ManagedTextDrill {...props(doc)} writeDoc={writeDoc} />);

    segmentWith("Centre")?.onChange("right" as never);

    expect(writeDoc).toHaveBeenCalledTimes(1);
    const [request] = writeDoc.mock.calls[0] ?? [];
    expect(request.history).toBe("text alignment");
    expect(request.preview.textLayout).toEqual({ align: "left" });
    expect(request.preview.managedText?.groups).toEqual([
      { key: "text", itemKeys: ["title", "points", "icon"], align: "right" },
    ]);
    expect(
      request.applyToCurrent({ ...doc, background: { type: "color", color: "#123456" } }),
    ).toMatchObject({
      textLayout: { align: "left" },
      managedText: {
        groups: [{ key: "text", itemKeys: ["title", "points", "icon"], align: "right" }],
      },
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

    expect(html).toContain('aria-label="Icon preview: assets/app-icon.png"');
    expect(html).toContain('src="asset://localhost/assets/app-icon.png"');
    expect(html).toContain("Clear");
    expect(html).toContain("All emoji");
    expect(html).toContain("Image…");
    expect(html).toContain("Quick emoji");
    expect(html).toContain(
      'class="text-inspector-icon-recent-grid text-inspector-icon-quick-grid"',
    );
    expect(html.match(/aria-label="Use emoji /g)).toHaveLength(16);
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
    expect(captures.colours[0]?.value).toBe("#3ad1c4");
    expect(html).toContain("Twist Scale · This line");
    expect(captures.numbers.find((field) => field.label === "Size %")?.value).toBe(125);
    expect(captures.sliders.find((slider) => slider.label === "Spacing")?.value).toBe(1.4);
  });

  it("shows the type switcher for a code-owned synthetic group without eagerly taking over", () => {
    const registrations: VirtualManagedTextRegistration[] = [
      { key: "title", type: "title", text: "Code title" },
    ];
    const confirmTakeover = vi.fn(async () => false);
    const writeDoc = vi.fn<ManagedTextWrite>();
    const html = renderToStaticMarkup(
      <ManagedTextDrill
        {...props({ version: 1 }, "title")}
        registrations={registrations}
        confirmTakeover={confirmTakeover}
        writeDoc={writeDoc}
      />,
    );

    expect(segmentWith("Title")?.value).toBe("title");
    expect(html).toContain("Code title");
    expect(confirmTakeover).not.toHaveBeenCalled();
    expect(writeDoc).not.toHaveBeenCalled();
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

  it("edits colour inline with the scene theme and rebases commit and reset", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: { items: [{ key: "title", type: "title", text: "Text" }] },
      textStyle: { titleColor: "#112233" },
    };
    const theme = {
      name: "Scene theme",
      mode: "dark",
      colors: {
        background: "#000000",
        text: "#ffffff",
        accent: "#ff5500",
        muted: "#888888",
      },
      typography: {
        headline: { family: "Inter", weight: 600 },
        body: { family: "Inter", weight: 400 },
        scale: 1,
      },
      motion: {},
    } as Theme;
    const writeDoc = vi.fn<ManagedTextWrite>();
    renderToStaticMarkup(
      <ManagedTextDrill
        {...props(doc, "title")}
        theme={theme}
        colourDefaults={{ title: "accent" }}
        writeDoc={writeDoc}
      />,
    );

    expect(captures.colours).toHaveLength(1);
    expect(captures.colours[0]).toMatchObject({
      value: "#112233",
      defaultValue: "#ff5500",
      label: "Title colour",
      theme,
    });
    captures.colours[0]?.onCommit("#abcdef");
    captures.colours[0]?.onReset?.();

    expect(writeDoc).toHaveBeenCalledTimes(2);
    const commit = writeDoc.mock.calls[0]?.[0];
    const reset = writeDoc.mock.calls[1]?.[0];
    expect(commit?.history).toBe("text colour");
    expect(commit?.applyToCurrent({ ...doc, name: "Concurrent" })).toMatchObject({
      name: "Concurrent",
      textStyle: { titleColor: "#abcdef" },
    });
    const resetDoc = reset?.applyToCurrent({ ...doc, name: "Concurrent" });
    expect(resetDoc?.name).toBe("Concurrent");
    expect(resetDoc?.textStyle).toBeUndefined();
  });
});
