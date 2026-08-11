import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import {
  armImageRemoveConfirmation,
  duplicateFirstClassImage,
  duplicateImage,
  ImageDrillIn,
  type ImageDrillInProps,
  type ImageMutation,
  type ImageMutationOptions,
  type ImagePatchDoc,
  removeFirstClassImage,
  removeImage,
} from "./ImageDrillIn";

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
  options: Array<{ value: string; label: string; title?: string }>;
  value: string;
  onChange: (value: never) => void;
}

const captures = vi.hoisted(() => ({
  sliders: [] as CapturedSliderProps[],
  numbers: [] as CapturedNumberProps[],
  toggles: [] as CapturedToggleProps[],
  segments: [] as CapturedSegmentProps[],
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

function imageDoc(host: "stage" | "overlay" = "stage"): SceneDoc {
  return {
    version: 1,
    images: [
      {
        id: "img1",
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
      },
      {
        id: "img2",
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
      },
    ],
  };
}

function props(doc: SceneDoc, imageId = "img1"): ImageDrillInProps {
  return {
    doc,
    imageId,
    sourcePreviewUrl: "asset://localhost/preview.png",
    overlayAvailable: true,
    backLabel: "Scene",
    onBack: () => undefined,
    onSelectImage: () => undefined,
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
  imageStore.gizmoMode = "translate";
});

describe("ImageDrillIn", () => {
  it("renders the shared Image shell, source identity and accessible navigation", () => {
    const html = renderToStaticMarkup(
      <ImageDrillIn {...props(imageDoc())} overlayAvailable={false} />,
    );

    expect(html).toContain('aria-label="Back to Scene from Image"');
    expect(html).toContain("long-logo-name.png");
    expect(html).toContain("Image 1 of 2");
    expect(html).toContain('src="asset://localhost/preview.png"');
    expect(html).toContain('aria-label="Previous image"');
    expect(html).toContain('aria-label="Next image"');
    expect(html).toContain("Change source");
    expect(html).toContain('data-image-source-action="true"');
    expect(html).toContain('<legend class="visually-hidden">Image settings</legend>');
    expect(html).toContain('<legend class="visually-hidden">Image host</legend>');
    expect(html).toMatch(/aria-disabled="true" aria-describedby="image-overlay-[^"]+"/);
    expect(html).toContain("Add an Overlay to this scene before moving an image there.");
    expect(html).toContain("Duplicate");
    expect(html).toContain("Remove");
    expect(captures.sliders.map((slider) => slider.label)).toEqual(["X", "Y", "Depth"]);
    expect(captures.segments[0]?.options.map((option) => option.label)).toEqual([
      "Move",
      "Rotate",
      "Scale",
    ]);
    expect(captures.toggles.map((toggle) => toggle.label)).toContain("Cast shadow");
    expect(html).toContain("Motion");
    expect(captures.segments[1]?.options.map((option) => option.label)).toEqual([
      "None",
      "Turn",
      "Float",
      "Tilt",
      "Push",
    ]);
  });

  it("independently disables source, settings and structural actions", () => {
    const patchDoc = vi.fn<ImagePatchDoc>(() => Promise.resolve());
    const html = renderToStaticMarkup(
      <ImageDrillIn
        {...props(imageDoc())}
        sourceDisabled
        settingsDisabled
        duplicateDisabled
        patchDoc={patchDoc}
      />,
    );

    const sourceButton = html.match(/<button[^>]*class="action-row"[^>]*>[\s\S]*?<\/button>/)?.[0];
    const duplicateButton = html.match(
      /<button[^>]*class="btn"[^>]*>[\s\S]*?Duplicate[\s\S]*?<\/button>/,
    )?.[0];
    const removeButton = html.match(/<button[^>]*class="btn danger"[^>]*>[\s\S]*?<\/button>/)?.[0];
    const settingsStart = html.indexOf('<fieldset class="image-settings-fieldset" disabled="">');
    const settingsEnd = html.indexOf("</fieldset>", html.lastIndexOf("Motion"));

    expect(sourceButton).toContain('disabled=""');
    expect(settingsStart).toBeGreaterThan(-1);
    expect(html.indexOf("Motion")).toBeGreaterThan(settingsStart);
    expect(settingsEnd).toBeGreaterThan(html.indexOf("Motion"));
    expect(duplicateButton).toContain('disabled=""');
    expect(removeButton).not.toContain('disabled=""');

    captures.sliders.find((slider) => slider.label === "X")?.onInput?.(1.1);
    captures.sliders.find((slider) => slider.label === "X")?.onCommit(1.1);
    captures.segments[0]?.onChange("rotate" as never);
    expect(patchDoc).not.toHaveBeenCalled();
    expect(imageStore.gizmoMode).toBe("translate");
  });

  it("renders Overlay placement, crop, layer and optional motion without Stage controls", () => {
    const html = renderToStaticMarkup(<ImageDrillIn {...props(imageDoc(), "img2")} />);

    expect(html).toContain("avatar.webp");
    expect(html).toContain("Image 2 of 2");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Overlay/);
    expect(captures.sliders.map((slider) => slider.label)).toEqual(["X", "Y", "Size", "Roll"]);
    expect(captures.toggles.map((toggle) => toggle.label)).toEqual(["Circle crop"]);
    expect(captures.segments[0]?.options.map((option) => option.label)).toEqual(["Above", "Below"]);
    expect(html).toContain("Motion");
    expect(html).toContain("Float");
    expect(captures.segments[1]?.options[1]?.title).toBe("Slow turntable");
    expect(html).not.toContain("Cast shadow");
  });

  it("uses the shared image gizmo mode for the Stage rotation and scale controls", () => {
    const doc = imageDoc();
    imageStore.gizmoMode = "rotate";
    renderToStaticMarkup(<ImageDrillIn {...props(doc)} />);

    expect(captures.numbers.map((field) => field.label)).toEqual(["X °", "Y °", "Z °"]);
    expect(captures.sliders).toHaveLength(0);

    captures.numbers.length = 0;
    captures.segments.length = 0;
    imageStore.gizmoMode = "scale";
    renderToStaticMarkup(<ImageDrillIn {...props(doc)} />);
    expect(captures.sliders.map((slider) => slider.label)).toEqual(["Size"]);
  });

  it("previews slider ticks without history and commits once from the original baseline", () => {
    const doc = imageDoc();
    let working = structuredClone(doc);
    const liveOptions: Array<{ history?: string | false } | undefined> = [];
    const baselines: SceneDoc[] = [];
    const committed: SceneDoc[] = [];
    const patchDoc: ImagePatchDoc = async (patch, options) => {
      const next = structuredClone(working);
      patch(next);
      working = next;
      liveOptions.push(options);
    };
    const commitFromBaseline: ImageDrillInProps["commitFromBaseline"] = async (baseline, patch) => {
      baselines.push(baseline);
      const next = structuredClone(baseline);
      patch(next);
      committed.push(next);
    };

    renderToStaticMarkup(
      <ImageDrillIn {...props(doc)} patchDoc={patchDoc} commitFromBaseline={commitFromBaseline} />,
    );
    const x = captures.sliders.find((slider) => slider.label === "X");
    x?.onInput?.(1.1);
    x?.onInput?.(1.4);
    x?.onCommit(1.4);

    expect(liveOptions).toEqual([{ history: false }, { history: false }]);
    expect(baselines).toEqual([doc]);
    expect(committed).toHaveLength(1);
    expect(committed[0]?.images?.[0].stage.position).toEqual([1.4, -0.2, 0.8]);
    expect(committed[0]?.images?.[0].overlay).toEqual(doc.images?.[0].overlay);
  });

  it("routes every control write through the optional promotion adapter", () => {
    const doc = imageDoc("overlay");
    const writes: Array<{
      image: NonNullable<SceneDoc["images"]>[number];
      opts: ImageMutationOptions;
    }> = [];
    const mutateImage = async (mutate: ImageMutation, opts: ImageMutationOptions) => {
      const image = structuredClone(doc.images?.[0]);
      if (!image) return;
      mutate(image);
      writes.push({ image, opts });
    };

    renderToStaticMarkup(<ImageDrillIn {...props(doc)} mutateImage={mutateImage} />);
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
      false,
      "image size",
      "image crop",
      "image layer",
      "image motion",
    ]);
    expect(writes[1]?.opts.baseline).toEqual(doc);
    expect(writes[1]?.image.overlay.size).toBe(0.34);
    expect(writes[2]?.image.overlay.shape).toBe("circle");
    expect(writes[3]?.image.overlay.layer).toBe("below");
    expect(writes[4]?.image.motion).toEqual({ preset: "push-in" });
  });
});

describe("Image inspector structural actions", () => {
  it("self-disarms remove confirmation after three seconds", () => {
    vi.useFakeTimers();
    const onDisarm = vi.fn();
    const cancel = armImageRemoveConfirmation(onDisarm);

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
    let working = imageDoc();
    const histories: Array<string | false | undefined> = [];
    const selected: string[] = [];
    const patchDoc: ImagePatchDoc = async (patch, options) => {
      const next = structuredClone(working);
      patch(next);
      working = next;
      histories.push(options?.history);
    };

    await duplicateFirstClassImage(patchDoc, "img1", (id) => selected.push(id));

    expect(histories).toEqual(["duplicate image"]);
    expect(selected).toEqual(["img3"]);
    expect(working.images?.map((image) => image.id)).toEqual(["img1", "img2", "img3"]);
    expect(working.images?.[2].stage.position).toEqual([0.65, -0.2, 0.8]);
    expect(working.images?.[2].overlay).toEqual(working.images?.[0].overlay);
  });

  it("leaves a duplicate unnumbered so the renderer places it after inherited ordering", () => {
    const next = imageDoc();
    const source = next.images?.[0];
    if (!source) throw new Error("image fixture missing");
    source.overlay.stackOrder = 100;

    const duplicateId = duplicateImage(next, source.id);

    expect(duplicateId).toBe("img3");
    expect(next.images?.[2]?.overlay.stackOrder).toBeUndefined();
  });

  it("removes once, deletes an empty images block and runs the return callback", async () => {
    const source = imageDoc().images?.[0];
    if (!source) throw new Error("image fixture missing");
    let working: SceneDoc = { version: 1, images: [source] };
    const histories: Array<string | false | undefined> = [];
    const removed = vi.fn();
    const patchDoc: ImagePatchDoc = async (patch, options) => {
      const next = structuredClone(working);
      patch(next);
      working = next;
      histories.push(options?.history);
    };

    await removeFirstClassImage(patchDoc, "img1", removed);

    expect(histories).toEqual(["remove image"]);
    expect(working.images).toBeUndefined();
    expect(removed).toHaveBeenCalledOnce();
  });

  it("chooses the adjacent Image after removal", () => {
    const next = imageDoc();
    next.images = [
      ...(next.images ?? []),
      {
        ...structuredClone(next.images?.[0] as NonNullable<SceneDoc["images"]>[number]),
        id: "img3",
      },
    ];

    expect(removeImage(next, "img2")).toBe("img3");
    expect(next.images?.map((image) => image.id)).toEqual(["img1", "img3"]);
    expect(removeImage(next, "img3")).toBe("img1");
  });
});
