import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneDoc, SceneDocMediaSpec } from "../../engine/sceneDocSchema";
import {
  armMediaRemoveConfirmation,
  duplicateFirstClassMedia,
  MediaDrillIn,
  type MediaDrillInProps,
  type MediaMutation,
  type MediaMutationOptions,
  type MediaPatchDoc,
  removeFirstClassMedia,
} from "./MediaDrillIn";
import { duplicateSceneMedia, removeSceneMedia } from "./mediaEditorModel";

interface CapturedSliderProps {
  label: string;
  value: number;
  onInput?: (value: number) => void;
  onCommit: (value: number) => void;
}

interface CapturedNumberProps {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}

interface CapturedToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

interface CapturedSegmentProps {
  options: Array<{
    value: string;
    label: string;
    title?: string;
    icon?: unknown;
    disabled?: boolean;
  }>;
  value: string;
  onChange: (value: never) => void;
}

interface CapturedRangeProps {
  label: string;
  value: number;
  onInput?: (value: number) => void;
  onCommit: (value: number) => void;
}

const captures = vi.hoisted(() => ({
  sliders: [] as CapturedSliderProps[],
  numbers: [] as CapturedNumberProps[],
  toggles: [] as CapturedToggleProps[],
  segments: [] as CapturedSegmentProps[],
  ranges: [] as CapturedRangeProps[],
}));

const imageStore = vi.hoisted(() => ({
  gizmoMode: "translate" as "translate" | "rotate" | "scale",
}));

vi.mock("../../engine/imageEditStore", () => {
  const useImageEditStore = (
    select: (state: { gizmoMode: "translate" | "rotate" | "scale" }) => unknown,
  ) => select({ gizmoMode: imageStore.gizmoMode });
  useImageEditStore.getState = () => ({
    setGizmoMode: (gizmoMode: "translate" | "rotate" | "scale") => {
      imageStore.gizmoMode = gizmoMode;
    },
  });
  return { useImageEditStore };
});

vi.mock("../colour/ColourPicker", () => ({
  ColourPicker: (props: { value: string; label: string }) => (
    <div data-colour={props.label}>{props.value}</div>
  ),
}));

vi.mock("../TextAnimationPicker", () => ({
  DebouncedRange: (props: CapturedRangeProps) => {
    captures.ranges.push(props);
    return <div data-range={props.label}>{props.label}</div>;
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
    ToggleRow: (props: CapturedToggleProps) => {
      captures.toggles.push(props);
      return (
        <button type="button" data-toggle={props.label} aria-pressed={props.checked}>
          {props.label}
        </button>
      );
    },
    SegmentedRow: (props: CapturedSegmentProps) => {
      captures.segments.push(props);
      return (
        <div data-segmented={props.options.map((option) => option.label).join(",")}>
          {props.options.map((option) => option.label).join(" ")}
        </div>
      );
    },
  };
});

function image(host: "stage" | "overlay"): SceneDocMediaSpec {
  return {
    id: "img1",
    kind: "image",
    src: "assets/launch/long-logo-name.png",
    host,
    stage: { position: [0.4, -0.2, 0.8], size: 1.2, rotationDeg: [4, 12, -2] },
    overlay: {
      position: [0.3, -0.45],
      size: 0.28,
      rotationDeg: 7,
      shape: "none",
      layer: "above",
    },
  };
}

function secondImage(): SceneDocMediaSpec {
  return {
    id: "img2",
    kind: "image",
    src: "assets/avatar.webp",
    host: "overlay",
    stage: { position: [-0.3, 0.1, -0.5], size: 0.8, rotationDeg: [0, 180, 0] },
    overlay: {
      position: [-0.5, 0.2],
      size: 0.18,
      rotationDeg: -15,
      shape: "circle",
      layer: "below",
    },
  };
}

function video(): SceneDocMediaSpec {
  return {
    id: "vid1",
    kind: "video",
    src: "assets/demo-recording.mov",
    host: "overlay",
    stage: { position: [0, 0, 0], size: 5.3, rotationDeg: [0, 0, 0] },
    overlay: { position: [0, 0], size: 0.72, rotationDeg: 0, shape: "none", layer: "below" },
    window: { radius: "macos" },
    video: { startMs: 1500 },
  };
}

function mediaDoc(host: "stage" | "overlay" = "stage"): SceneDoc {
  return { version: 1, media: [image(host), secondImage()] };
}

function props(doc: SceneDoc, mediaId = "img1"): MediaDrillInProps {
  return {
    doc,
    mediaId,
    sourcePreviewUrl: "asset://localhost/preview.png",
    overlayAvailable: true,
    backLabel: "Scene",
    onBack: () => undefined,
    onSelectMedia: () => undefined,
    onChangeSource: () => undefined,
    patchDoc: () => Promise.resolve(),
    commitFromBaseline: () => Promise.resolve(),
  };
}

beforeEach(() => {
  captures.sliders.length = 0;
  captures.numbers.length = 0;
  captures.toggles.length = 0;
  captures.segments.length = 0;
  captures.ranges.length = 0;
  imageStore.gizmoMode = "translate";
});

describe("MediaDrillIn", () => {
  it("renders the shared media shell, source identity and accessible navigation", () => {
    const html = renderToStaticMarkup(
      <MediaDrillIn {...props(mediaDoc())} overlayAvailable={false} />,
    );

    expect(html).toContain('aria-label="Back to Scene from Image"');
    expect(html).toContain("long-logo-name.png");
    expect(html).toContain("1 of 2");
    expect(html).toContain('src="asset://localhost/preview.png"');
    expect(html).toContain('aria-label="Previous media"');
    expect(html).toContain('aria-label="Next media"');
    expect(html).toContain("Change");
    expect(html).toContain('data-media-source-action="true"');
    expect(html).toContain('<legend class="visually-hidden">Media settings</legend>');
    expect(html).toContain("Add an Overlay to this scene before moving media there.");
    expect(html).toContain('aria-label="Duplicate media"');
    expect(html).toContain('aria-label="Remove media"');
    expect(captures.sliders.map((slider) => slider.label)).toEqual(["X", "Y", "Depth"]);
    expect(captures.segments[0]?.options.map((option) => option.label)).toEqual([
      "Stage",
      "Overlay",
    ]);
    expect(captures.segments[0]?.options[1]?.disabled).toBe(true);
    expect(captures.segments[1]?.options.map((option) => option.label)).toEqual([
      "Move",
      "Rotate",
      "Scale",
    ]);
    expect(captures.segments[2]?.options.map((option) => option.label)).toEqual([
      "None",
      "Sharp",
      "Subtle",
      "macOS",
      "Rounded",
    ]);
    expect(captures.toggles.map((toggle) => toggle.label)).toEqual(["Cast shadow"]);
    expect(captures.segments[3]?.options.map((option) => option.label)).toEqual([
      "None",
      "Turn",
      "Float",
      "Tilt",
      "Push",
    ]);
  });

  it("hides the Edit row until an entry can be re-pointed", () => {
    const without = renderToStaticMarkup(<MediaDrillIn {...props(mediaDoc())} />);
    const withEdit = renderToStaticMarkup(
      <MediaDrillIn {...props(mediaDoc())} onEditSource={() => undefined} />,
    );

    expect(without).not.toContain(">Edit<");
    expect(withEdit).toContain(">Edit<");
  });

  it("independently disables source, settings and structural actions", () => {
    const patchDoc = vi.fn<MediaPatchDoc>(() => Promise.resolve());
    const html = renderToStaticMarkup(
      <MediaDrillIn
        {...props(mediaDoc())}
        sourceDisabled
        settingsDisabled
        duplicateDisabled
        patchDoc={patchDoc}
      />,
    );

    const sourceButton = html.match(/<button[^>]*class="action-row"[^>]*>[\s\S]*?<\/button>/)?.[0];
    const duplicateButton = html.match(
      /<button[^>]*aria-label="Duplicate media"[^>]*>[\s\S]*?<\/button>/,
    )?.[0];
    const removeButton = html.match(
      /<button[^>]*aria-label="Remove media"[^>]*>[\s\S]*?<\/button>/,
    )?.[0];
    const settingsStart = html.indexOf('<fieldset class="media-settings-fieldset" disabled="">');

    expect(sourceButton).toContain('disabled=""');
    expect(settingsStart).toBeGreaterThan(-1);
    expect(html.indexOf("Motion")).toBeGreaterThan(settingsStart);
    expect(duplicateButton).toContain('disabled=""');
    expect(removeButton).not.toContain('disabled=""');

    captures.sliders.find((slider) => slider.label === "X")?.onInput?.(1.1);
    captures.sliders.find((slider) => slider.label === "X")?.onCommit(1.1);
    captures.segments
      .find((segment) => segment.options.some((option) => option.label === "Move"))
      ?.onChange("rotate" as never);
    captures.segments
      .find((segment) => segment.options.some((option) => option.label === "Stage"))
      ?.onChange("overlay" as never);
    expect(patchDoc).not.toHaveBeenCalled();
    expect(imageStore.gizmoMode).toBe("translate");
  });

  it("renders Overlay placement, crop and layer without Stage controls", () => {
    const html = renderToStaticMarkup(<MediaDrillIn {...props(mediaDoc(), "img2")} />);

    expect(html).toContain("avatar.webp");
    expect(html).toContain("Image · 2 of 2");
    expect(captures.segments[0]?.value).toBe("overlay");
    expect(captures.sliders.map((slider) => slider.label)).toEqual(["X", "Y", "Size", "Roll"]);
    expect(captures.toggles.map((toggle) => toggle.label)).toEqual(["Circle crop"]);
    expect(captures.segments[1]?.options.map((option) => option.label)).toEqual(["Above", "Below"]);
    expect(html).not.toContain("Cast shadow");
  });

  it("uses the shared gizmo mode for the Stage rotation and scale controls", () => {
    const doc = mediaDoc();
    imageStore.gizmoMode = "rotate";
    renderToStaticMarkup(<MediaDrillIn {...props(doc)} />);

    expect(captures.numbers.map((field) => field.label)).toEqual(["X °", "Y °", "Z °"]);
    expect(captures.sliders).toHaveLength(0);

    captures.numbers.length = 0;
    captures.segments.length = 0;
    imageStore.gizmoMode = "scale";
    renderToStaticMarkup(<MediaDrillIn {...props(doc)} />);
    expect(captures.sliders.map((slider) => slider.label)).toEqual(["Size"]);
  });

  it("previews slider ticks without history and commits once from the original baseline", () => {
    const doc = mediaDoc();
    let working = structuredClone(doc);
    const liveOptions: Array<{ history?: string | false } | undefined> = [];
    const baselines: SceneDoc[] = [];
    const committed: SceneDoc[] = [];
    const patchDoc: MediaPatchDoc = async (patch, options) => {
      const next = structuredClone(working);
      patch(next);
      working = next;
      liveOptions.push(options);
    };
    const commitFromBaseline: MediaDrillInProps["commitFromBaseline"] = async (baseline, patch) => {
      baselines.push(baseline);
      const next = structuredClone(baseline);
      patch(next);
      committed.push(next);
    };

    renderToStaticMarkup(
      <MediaDrillIn {...props(doc)} patchDoc={patchDoc} commitFromBaseline={commitFromBaseline} />,
    );
    const x = captures.sliders.find((slider) => slider.label === "X");
    x?.onInput?.(1.1);
    x?.onInput?.(1.4);
    x?.onCommit(1.4);

    expect(liveOptions).toEqual([{ history: false }, { history: false }]);
    expect(baselines).toEqual([doc]);
    expect(committed).toHaveLength(1);
    expect(committed[0]?.media?.[0].stage.position).toEqual([1.4, -0.2, 0.8]);
    expect(committed[0]?.media?.[0].overlay).toEqual(doc.media?.[0].overlay);
  });

  it("routes every control write through the optional promotion adapter", () => {
    const doc = mediaDoc("overlay");
    const writes: Array<{ entry: SceneDocMediaSpec; opts: MediaMutationOptions }> = [];
    const mutateMedia = async (mutate: MediaMutation, opts: MediaMutationOptions) => {
      const entry = structuredClone(doc.media?.[0]);
      if (!entry) return;
      mutate(entry);
      writes.push({ entry, opts });
    };

    renderToStaticMarkup(<MediaDrillIn {...props(doc)} mutateMedia={mutateMedia} />);
    captures.segments
      .find((segment) => segment.options.some((option) => option.label === "Stage"))
      ?.onChange("stage" as never);
    const size = captures.sliders.find((slider) => slider.label === "Size");
    size?.onInput?.(0.31);
    size?.onCommit(0.34);
    captures.toggles.find((toggle) => toggle.label === "Circle crop")?.onChange(true);
    captures.segments
      .find((segment) => segment.options.some((option) => option.label === "Below"))
      ?.onChange("below" as never);
    captures.segments
      .find((segment) => segment.options.some((option) => option.label === "Push"))
      ?.onChange("push-in" as never);

    expect(writes.map((write) => write.opts.history)).toEqual([
      "move media to stage",
      false,
      "media size",
      "media crop",
      "media layer",
      "media motion",
    ]);
    expect(writes[0]?.entry.host).toBe("stage");
    expect(writes[2]?.opts.baseline).toEqual(doc);
    expect(writes[2]?.entry.overlay.size).toBe(0.34);
    expect(writes[3]?.entry.overlay.shape).toBe("circle");
    expect(writes[4]?.entry.overlay.layer).toBe("below");
    expect(writes[5]?.entry.motion).toEqual({ preset: "push-in" });
  });

  it("gives a windowed video its chrome controls, playback fields and its own motion set", () => {
    const doc: SceneDoc = { version: 1, media: [video()] };
    const html = renderToStaticMarkup(<MediaDrillIn {...props(doc, "vid1")} />);

    expect(html).toContain('aria-label="Back to Scene from Video"');
    expect(html).toContain("Video · 1 of 1");
    expect(captures.segments.at(-1)?.options.map((option) => option.label)).toEqual([
      "None",
      "Float",
      "Drift",
      "Tilt",
      "Push",
    ]);
    expect(captures.toggles.map((toggle) => toggle.label)).toEqual([
      "Circle crop",
      "Window recording",
      "Show border",
      "Loop",
    ]);
    expect(captures.ranges.map((range) => range.label)).toEqual([
      "Corner radius",
      "Border width",
      "Border strength",
      "Shadow strength",
      "Shadow softness",
      "Shadow drop",
    ]);
    expect(captures.numbers.map((field) => field.label)).toEqual(["Start time"]);
    expect(captures.numbers[0]?.value).toBe(1.5);
    expect(html).not.toContain("Cast shadow");
  });

  it("clears the window block when the corners drop to none", () => {
    const doc: SceneDoc = { version: 1, media: [video()] };
    const writes: SceneDocMediaSpec[] = [];
    const mutateMedia = async (mutate: MediaMutation) => {
      const entry = structuredClone(doc.media?.[0]);
      if (!entry) return;
      mutate(entry);
      writes.push(entry);
    };

    renderToStaticMarkup(<MediaDrillIn {...props(doc, "vid1")} mutateMedia={mutateMedia} />);
    const corners = captures.segments.find((segment) =>
      segment.options.some((option) => option.label === "macOS"),
    );
    corners?.onChange("none" as never);
    corners?.onChange("rounded" as never);

    expect(writes[0]?.window).toBeUndefined();
    expect(writes[1]?.window).toEqual({ radius: "rounded" });
  });

  it("offers the chrome presets to a still image too", () => {
    const doc: SceneDoc = { version: 1, media: [image("overlay")] };
    const writes: SceneDocMediaSpec[] = [];
    const mutateMedia = async (mutate: MediaMutation) => {
      const entry = structuredClone(doc.media?.[0]);
      if (!entry) return;
      mutate(entry);
      writes.push(entry);
    };

    renderToStaticMarkup(<MediaDrillIn {...props(doc)} mutateMedia={mutateMedia} />);
    captures.segments
      .find((segment) => segment.options.some((option) => option.label === "macOS"))
      ?.onChange("macos" as never);

    expect(writes[0]?.window).toEqual({ radius: "macos" });
  });
});

describe("media inspector structural actions", () => {
  it("self-disarms remove confirmation after three seconds", () => {
    vi.useFakeTimers();
    const onDisarm = vi.fn();
    const cancel = armMediaRemoveConfirmation(onDisarm);

    try {
      vi.advanceTimersByTime(2_999);
      expect(onDisarm).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onDisarm).toHaveBeenCalledOnce();
    } finally {
      cancel();
      vi.useRealTimers();
    }
  });

  it("duplicates once at execution time, retains the dormant placement and selects the copy", async () => {
    let working = mediaDoc();
    const histories: Array<string | false | undefined> = [];
    const selected: string[] = [];
    const patchDoc: MediaPatchDoc = async (patch, options) => {
      const next = structuredClone(working);
      patch(next);
      working = next;
      histories.push(options?.history);
    };

    await duplicateFirstClassMedia(patchDoc, "img1", (id) => selected.push(id));

    expect(histories).toEqual(["duplicate media"]);
    expect(selected).toEqual(["img3"]);
    expect(working.media?.map((entry) => entry.id)).toEqual(["img1", "img2", "img3"]);
    expect(working.media?.[2].stage.position).toEqual([0.65, -0.2, 0.8]);
    expect(working.media?.[2].overlay).toEqual(working.media?.[0].overlay);
  });

  it("mints the duplicate id from the source's own kind", () => {
    const next: SceneDoc = { version: 1, media: [image("stage"), video()] };

    expect(duplicateSceneMedia(next, "vid1")).toBe("vid2");
    expect(next.media?.map((entry) => entry.id)).toEqual(["img1", "vid1", "vid2"]);
  });

  it("leaves a duplicate unnumbered so the renderer places it after inherited ordering", () => {
    const next = mediaDoc();
    const source = next.media?.[0];
    if (!source) throw new Error("media fixture missing");
    source.overlay.stackOrder = 100;

    expect(duplicateSceneMedia(next, source.id)).toBe("img3");
    expect(next.media?.[2]?.overlay.stackOrder).toBeUndefined();
  });

  it("removes once, deletes an empty media block and runs the return callback", async () => {
    let working: SceneDoc = { version: 1, media: [image("stage")] };
    const histories: Array<string | false | undefined> = [];
    const removed = vi.fn();
    const patchDoc: MediaPatchDoc = async (patch, options) => {
      const next = structuredClone(working);
      patch(next);
      working = next;
      histories.push(options?.history);
    };

    await removeFirstClassMedia(patchDoc, "img1", removed);

    expect(histories).toEqual(["remove media"]);
    expect(working.media).toBeUndefined();
    expect(removed).toHaveBeenCalledOnce();
  });

  it("chooses the adjacent entry after removal", () => {
    const next: SceneDoc = {
      version: 1,
      media: [image("stage"), secondImage(), { ...image("stage"), id: "img3" }],
    };

    expect(removeSceneMedia(next, "img2")).toBe("img3");
    expect(next.media?.map((entry) => entry.id)).toEqual(["img1", "img3"]);
    expect(removeSceneMedia(next, "img3")).toBe("img1");
  });
});
