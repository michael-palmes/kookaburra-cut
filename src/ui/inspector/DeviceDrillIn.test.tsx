import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import {
  AVAILABLE_DEVICE_IDS,
  DEFAULT_DEVICE_ID,
  isDeviceAvailable,
  resolveAvailableDeviceSpec,
} from "../../toolkit/device/catalog";
import { effectiveDeviceShadowMode } from "../../toolkit/device/Device";
import {
  changeFirstClassDeviceModel,
  DeviceDrillIn,
  type DeviceDrillInProps,
  DeviceModelDrillIn,
  type DevicePatchDoc,
  type DevicePatchDocResult,
  deviceNavigationFocusTarget,
  duplicateFirstClassDevice,
  removeFirstClassDevice,
} from "./DeviceDrillIn";

interface CapturedSliderProps {
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

interface CapturedOptionProps {
  label: string;
  selected: boolean;
  onSelect: () => void;
}

interface CapturedColourProps {
  value: string;
  label: string;
  pressed?: boolean;
  onCommit: (hex: string) => void;
}

const captures = vi.hoisted(() => ({
  sliders: [] as CapturedSliderProps[],
  segments: [] as CapturedSegmentProps[],
  toggles: [] as CapturedToggleProps[],
  options: [] as CapturedOptionProps[],
  colours: [] as CapturedColourProps[],
}));

const deviceStore = vi.hoisted(() => ({
  gizmoMode: "translate" as "translate" | "rotate" | "scale",
}));

vi.mock("../../engine/deviceEditStore", () => {
  const useDeviceEditStore = (
    select: (state: { gizmoMode: "translate" | "rotate" | "scale" }) => unknown,
  ) => select({ gizmoMode: deviceStore.gizmoMode });
  useDeviceEditStore.getState = () => ({
    setGizmoMode: (gizmoMode: "translate" | "rotate" | "scale") => {
      deviceStore.gizmoMode = gizmoMode;
    },
  });
  return { useDeviceEditStore };
});

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
      return <div data-segmented={props.options.map((option) => option.label).join(",")} />;
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

vi.mock("../OptionCard", () => ({
  OptionCard: (props: CapturedOptionProps) => {
    captures.options.push(props);
    return (
      <button type="button" data-option={props.label} aria-pressed={props.selected}>
        {props.label}
      </button>
    );
  },
}));

vi.mock("../colour/ColourPicker", () => ({
  ColourPicker: (props: CapturedColourProps) => {
    captures.colours.push(props);
    return <button type="button" aria-label={props.label} aria-pressed={props.pressed} />;
  },
}));

function deviceDoc(): SceneDoc {
  return {
    version: 1,
    devices: [
      { id: "d1", model: "android", colour: "white" },
      {
        id: "d2",
        model: "iphone-17-pro",
        colour: "deep-blue",
        media: { src: "assets/demo.mov", kind: "video", startMs: 300 },
        placement: {
          position: [1, -0.3, 0.2],
          rotationDeg: [4, 12, -2],
          scale: 1.1,
          ground: true,
        },
        motion: { preset: "push-in", durationMs: 900 },
        shadow: "soft",
      },
      { id: "d3", model: "macbook-pro-16", colour: "space-grey" },
    ],
    deviceLayout: {
      preset: "row",
      gap: 0.6,
      devices: {
        d2: { offset: [0.1, 0.2, -0.3], rotationDeg: [-6, 14, 0], scale: 1.35 },
      },
    },
  };
}

function props(doc: SceneDoc): DeviceDrillInProps {
  return {
    doc,
    deviceId: "d2",
    backLabel: "Scene",
    screenMediaPreviewUrl: "asset://localhost/demo.jpg",
    screenMediaAspectRatio: 1170 / 2532,
    screenMediaDetail: "0:12 · 1170×2532",
    onBack: () => undefined,
    onSelectDevice: () => undefined,
    onChangeDevice: () => undefined,
    onChangeScreenMedia: () => undefined,
    onEditScreenMedia: () => undefined,
    onOpenArrangement: () => undefined,
    patchDoc: () => Promise.resolve(),
    patchDocResult: () => Promise.resolve(true),
    commitFromBaseline: () => Promise.resolve(),
  };
}

beforeEach(() => {
  captures.sliders.length = 0;
  captures.segments.length = 0;
  captures.toggles.length = 0;
  captures.options.length = 0;
  captures.colours.length = 0;
  deviceStore.gizmoMode = "translate";
});

describe("DeviceDrillIn", () => {
  it("renders the preview-led live editor hierarchy and accessible device navigation", () => {
    const html = renderToStaticMarkup(<DeviceDrillIn {...props(deviceDoc())} />);

    expect(html).toContain('aria-label="Back to Scene from Device"');
    expect(html).toContain(resolveAvailableDeviceSpec("iphone-17-pro").name);
    expect(html).toContain("Device 2 of 3");
    expect(html).toContain('aria-label="Previous device"');
    expect(html).toContain('aria-label="Next device"');
    expect(html).toContain('class="device-editor-preview"');
    expect(html).toContain('<fieldset class="device-editor-finishes" aria-label="Device finish">');
    // Deep Blue is an iPhone finish; the fallback offers its own, so name the resolved one.
    expect(html).toContain(isDeviceAvailable("iphone-17-pro") ? "Deep Blue" : "Graphite");
    expect(html).toContain("Change device");
    expect(html).toContain("demo.mov");
    expect(html).toContain("0:12 · 1170×2532");
    expect(html).toContain('class="device-editor-media-thumb" style="width:26.8px;height:58px"');
    expect(html).toContain("Arranges all 3 devices");
    expect(html).toContain("Reset position");
    expect(html).toContain('<fieldset class="device-editor-motion-list">');
    expect(html.match(/device-editor-motion-choice/g)).toHaveLength(5);
    expect(html).toContain("Push-in settle");
    expect(html).toContain("Slow turntable");
    expect(html).toContain("Tilt reveal");
    expect(html).toContain('aria-label="Duplicate device"');
    expect(html).toContain('aria-label="Remove device"');
    expect(html).not.toContain("device-editor-actions");
    expect(html).not.toContain("Cancel");
    expect(html).not.toContain("Save");
    expect(captures.segments[0]?.options.map((option) => option.label)).toEqual([
      "Move",
      "Rotate",
      "Scale",
    ]);
    expect(captures.sliders.map((slider) => slider.label)).toEqual([
      "Start delay",
      "Left-right",
      "Up-down",
      "Depth",
    ]);
    expect(captures.toggles).toEqual([
      expect.objectContaining({ label: "Rest on floor", checked: true }),
      expect.objectContaining({ label: "Keyframes", checked: false }),
    ]);
    expect(captures.options.map((option) => option.label)).toEqual([
      "Soft contact",
      "Long & smooth",
      "Sun sweep",
      "Twin studio",
      "Overhead",
      "Card drop",
      "Backlight",
      "Feather",
      "Window light",
      "Wet floor",
      "None",
    ]);
    expect(captures.options[0]?.selected).toBe(true);
  });

  it("keeps keyboard focus in device navigation after Previous or Next changes identity", () => {
    expect(deviceNavigationFocusTarget("next", 1, 3)).toBe("next");
    expect(deviceNavigationFocusTarget("next", 2, 3)).toBe("previous");
    expect(deviceNavigationFocusTarget("previous", 1, 3)).toBe("previous");
    expect(deviceNavigationFocusTarget("previous", 0, 3)).toBe("next");
    expect(deviceNavigationFocusTarget("next", 0, 1)).toBeNull();
  });

  it("uses the selected gizmo mode without changing the shared slider component", () => {
    const doc = deviceDoc();
    deviceStore.gizmoMode = "rotate";
    const rotateHtml = renderToStaticMarkup(<DeviceDrillIn {...props(doc)} />);
    expect(captures.sliders.map((slider) => slider.label)).toEqual([
      "Start delay",
      "Tilt",
      "Turn",
      "Roll",
    ]);
    expect(captures.sliders.map(({ value }) => value)).toEqual([0.3, -6, 14, 0]);
    expect(rotateHtml).toContain('class="device-editor-pose-choice selected"');
    expect(rotateHtml).toContain("Front on");
    expect(rotateHtml).toContain("Editorial");
    expect(rotateHtml).toContain("Mirrored");

    captures.sliders.length = 0;
    captures.segments.length = 0;
    deviceStore.gizmoMode = "scale";
    renderToStaticMarkup(<DeviceDrillIn {...props(doc)} />);
    expect(captures.sliders.map((slider) => slider.label)).toEqual(["Start delay", "Size"]);
    expect(captures.sliders[1]?.value).toBe(1.35);
  });

  it("retains the live laptop lid control", () => {
    const doc = deviceDoc();
    const html = renderToStaticMarkup(
      <DeviceDrillIn {...props(doc)} deviceId="d3" screenMediaPreviewUrl={undefined} />,
    );

    const laptop = isDeviceAvailable("macbook-pro-16");
    expect(html).toContain(resolveAvailableDeviceSpec("macbook-pro-16").name);
    expect(html).toContain('<div class="device-editor-media-thumb">');
    expect(captures.sliders.map((slider) => slider.label)).toEqual([
      "Left-right",
      "Up-down",
      "Depth",
      ...(laptop ? ["Lid angle"] : []),
    ]);
    if (laptop) expect(captures.sliders.at(-1)?.value).toBe(90);
  });

  it("previews layout-slider ticks without history and commits once from the original baseline", () => {
    const doc = deviceDoc();
    let working = structuredClone(doc);
    const liveOptions: Array<{ history?: string | false } | undefined> = [];
    const baselines: SceneDoc[] = [];
    const committed: SceneDoc[] = [];
    const patchDoc: DevicePatchDoc = async (patch, options) => {
      const next = structuredClone(working);
      patch(next);
      working = next;
      liveOptions.push(options);
    };
    const commitFromBaseline: DeviceDrillInProps["commitFromBaseline"] = async (
      baseline,
      patch,
    ) => {
      baselines.push(baseline);
      const next = structuredClone(baseline);
      patch(next);
      committed.push(next);
    };

    renderToStaticMarkup(
      <DeviceDrillIn {...props(doc)} patchDoc={patchDoc} commitFromBaseline={commitFromBaseline} />,
    );
    const x = captures.sliders.find((slider) => slider.label === "Left-right");
    x?.onInput?.(0.4);
    x?.onInput?.(0.7);
    x?.onCommit(0.7);

    expect(liveOptions).toEqual([{ history: false }, { history: false }]);
    expect(baselines).toEqual([doc]);
    expect(committed).toHaveLength(1);
    expect(committed[0]?.deviceLayout?.devices?.d2?.offset).toEqual([0.7, 0.2, -0.3]);
    expect(committed[0]?.devices?.[1].placement).toEqual(doc.devices?.[1].placement);
  });

  it("writes settled finish, floor and shadow changes immediately", () => {
    const doc = deviceDoc();
    let working = structuredClone(doc);
    const histories: Array<string | false | undefined> = [];
    const patchDoc: DevicePatchDoc = async (patch, options) => {
      const next = structuredClone(working);
      patch(next);
      working = next;
      histories.push(options?.history);
    };

    renderToStaticMarkup(<DeviceDrillIn {...props(doc)} patchDoc={patchDoc} />);
    captures.colours[0]?.onCommit("#ABCDEF");
    captures.toggles[0]?.onChange(false);
    captures.options.find((option) => option.label === "Sun sweep")?.onSelect();

    expect(histories).toEqual(["device finish", "device floor placement", "device shadow"]);
    expect(working.devices?.[1].colour).toBe("custom:#abcdef");
    expect(working.devices?.[1].placement?.ground).toBeUndefined();
    expect(working.devices?.[1].shadow).toBe("sun");
  });

  it("writes the screen start delay in ms and clears the field at zero", () => {
    const doc = deviceDoc();
    let working = structuredClone(doc);
    const histories: Array<string | false | undefined> = [];
    const patchDoc: DevicePatchDoc = async (patch, options) => {
      const next = structuredClone(working);
      patch(next);
      working = next;
      histories.push(options?.history);
    };

    renderToStaticMarkup(<DeviceDrillIn {...props(doc)} patchDoc={patchDoc} />);
    const delay = captures.sliders.find((slider) => slider.label === "Start delay");
    expect(delay?.value).toBe(0.3);
    delay?.onCommit(1.5);
    expect(working.devices?.[1].media).toEqual({
      src: "assets/demo.mov",
      kind: "video",
      startMs: 1500,
    });
    delay?.onCommit(0);
    expect(working.devices?.[1].media).toEqual({ src: "assets/demo.mov", kind: "video" });
    expect(histories).toEqual(["screen start delay", "screen start delay"]);
  });

  it("offers no start delay without screen video media", () => {
    renderToStaticMarkup(
      <DeviceDrillIn {...props(deviceDoc())} deviceId="d3" screenMediaPreviewUrl={undefined} />,
    );

    expect(captures.sliders.some((slider) => slider.label === "Start delay")).toBe(false);
  });

  it("exposes a custom finish as the selected toggle in its labelled group", () => {
    const doc = deviceDoc();
    const selected = doc.devices?.find((device) => device.id === "d2");
    if (selected) selected.colour = "custom:#abcdef";

    const html = renderToStaticMarkup(<DeviceDrillIn {...props(doc)} />);

    expect(html).toContain('<fieldset class="device-editor-finishes" aria-label="Device finish">');
    expect(html).toContain('aria-label="Custom finish" aria-pressed="true"');
    expect(captures.colours[0]).toEqual(
      expect.objectContaining({ value: "#abcdef", pressed: true }),
    );
  });

  it("keeps the inherited presentation shadow independent from real stage shadows", () => {
    const doc: SceneDoc = {
      version: 1,
      devices: [{ id: "d1", model: "iphone-17-pro" }],
    };

    renderToStaticMarkup(<DeviceDrillIn {...props(doc)} deviceId="d1" />);

    expect(captures.options.find((option) => option.label === "None")?.selected).toBe(false);
    expect(captures.options.find((option) => option.label === "Soft contact")?.selected).toBe(true);
    expect(doc.devices?.[0].shadow).toBeUndefined();
    expect(effectiveDeviceShadowMode(undefined)).toBe("soft");
    expect(effectiveDeviceShadowMode("long")).toBe("long");
    expect(effectiveDeviceShadowMode("none")).toBe("none");
  });

  it("identifies an unknown model with the same available fallback as the renderer", () => {
    const doc: SceneDoc = {
      version: 1,
      devices: [{ id: "d1", model: "future-device" }],
    };

    const html = renderToStaticMarkup(<DeviceDrillIn {...props(doc)} deviceId="d1" />);

    expect(html).toContain("Android");
    expect(html).not.toContain("iPhone 17 Pro");
  });

  it("shows a one-device identity while retaining its Arrangement and transform controls", () => {
    const doc: SceneDoc = {
      version: 1,
      devices: [{ id: "d1", model: "iphone-17-pro", colour: "silver" }],
    };
    const one = { ...props(doc), deviceId: "d1" };
    const html = renderToStaticMarkup(<DeviceDrillIn {...one} />);

    expect(html).toContain("Device 1 of 1");
    expect(html).toContain("Positions this device");
    expect(html).toContain('aria-label="Previous device" title="Previous device" disabled=""');
    expect(html).toContain('aria-label="Next device" title="Next device" disabled=""');
    expect(captures.sliders.map((slider) => slider.label)).toEqual([
      "Left-right",
      "Up-down",
      "Depth",
    ]);
  });

  it("disables independent settings and structural actions", () => {
    const html = renderToStaticMarkup(
      <DeviceDrillIn {...props(deviceDoc())} settingsDisabled duplicateDisabled removeDisabled />,
    );

    expect(html).toContain('<fieldset class="device-editor-settings" disabled="">');
    expect(html).toMatch(
      /class="inspector-drill-header-action" aria-label="Duplicate device"[^>]*disabled=""/,
    );
    expect(html).toMatch(
      /class="inspector-drill-header-action danger" aria-label="Remove device"[^>]*disabled=""/,
    );
  });

  it("keeps model selection in a catalogue-only immediate drill", () => {
    const html = renderToStaticMarkup(
      <DeviceModelDrillIn
        model="iphone-17-pro"
        deviceCount={3}
        deviceLabel="Device 2"
        backLabel="Device"
        onBack={() => undefined}
        onSelectModel={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Back to Device from Change device"');
    expect(html).toContain('aria-label="Device model"');
    expect(html).toContain(
      '<fieldset class="inspector-device-switcher" aria-label="Device model">',
    );
    expect(html).toContain('aria-label="Apply device model to"');
    const available = AVAILABLE_DEVICE_IDS.length;
    expect(html.match(/class="inspector-device-switch-preview"/g)).toHaveLength(available);
    expect(html.match(/class="inspector-device-switch-name"/g)).toHaveLength(available);
    for (const id of AVAILABLE_DEVICE_IDS) {
      expect(html).toContain(
        `class="inspector-device-switch-name">${resolveAvailableDeviceSpec(id).name}</span>`,
      );
    }
    expect(html).toContain('class="inspector-device-switch-name">Android</span>');
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain("All devices");
    expect(html).toContain("Device 2");
    expect(html).toContain("Pick a model to apply it immediately");
    expect(html).not.toContain("inspector-device-picker");
    expect(html).not.toContain("wizard-field");
    expect(html).not.toContain("Save");
    expect(html).not.toContain("Cancel");
  });

  it("disables a one-device current model tile so it cannot create no-op history", () => {
    const html = renderToStaticMarkup(
      <DeviceModelDrillIn
        model={DEFAULT_DEVICE_ID}
        onBack={() => undefined}
        onSelectModel={() => undefined}
      />,
    );

    expect(html).toMatch(/aria-pressed="true"[^>]*disabled=""/);
  });
});

function comparisonDoc(): SceneDoc {
  const next = deviceDoc();
  next.compare = { b: {} };
  return next;
}

describe("DeviceDrillIn comparison sides", () => {
  it("shows no side selector on a scene without a comparison", () => {
    renderToStaticMarkup(<DeviceDrillIn {...props(deviceDoc())} />);

    expect(captures.segments[0]?.options.map((option) => option.label)).toEqual([
      "Move",
      "Rotate",
      "Scale",
    ]);
  });

  it("leads with the side selector and keeps the plain editor on Before", () => {
    const html = renderToStaticMarkup(
      <DeviceDrillIn
        {...props(comparisonDoc())}
        comparison={{ side: "a", onSideChange: () => undefined }}
      />,
    );

    expect(captures.segments[0]?.options.map((option) => option.label)).toEqual([
      "Before",
      "After",
    ]);
    expect(html).toContain("Change device");
    expect(html).toContain("Arranges all 3 devices");
    expect(html).toContain("Push-in settle");
    expect(html).not.toContain("Match the before side");
    expect(captures.sliders.map((slider) => slider.label)).toEqual([
      "Start delay",
      "Left-right",
      "Up-down",
      "Depth",
    ]);
  });

  it("narrows After to finish, screen and shadow", () => {
    const html = renderToStaticMarkup(
      <DeviceDrillIn
        {...props(comparisonDoc())}
        comparison={{ side: "b", onSideChange: () => undefined }}
      />,
    );

    expect(html).toContain('aria-label="After device finish"');
    expect(html).toContain('<legend class="visually-hidden">After device shadow</legend>');
    expect(html).toContain("Same as before");
    expect(html).not.toContain("Change device");
    expect(html).not.toContain("Arranges all 3 devices");
    expect(html).not.toContain("Push-in settle");
    expect(html).not.toContain("Reset position");
    expect(html).not.toContain("Match the before side");
    expect(captures.sliders.map((slider) => slider.label)).toEqual(["Start delay"]);
    expect(captures.options.map((option) => option.label)).toEqual([
      "Soft contact",
      "Long & smooth",
      "Sun sweep",
      "Twin studio",
      "Overhead",
      "Card drop",
      "Backlight",
      "Feather",
      "Window light",
      "Wet floor",
      "None",
    ]);
  });

  it("writes After finish and shadow through compare.b, never through Before", async () => {
    const doc = comparisonDoc();
    let working = structuredClone(doc);
    const histories: Array<string | false | undefined> = [];
    const patchDoc: DevicePatchDoc = async (patch, options) => {
      const next = structuredClone(working);
      patch(next);
      working = next;
      histories.push(options?.history);
    };

    renderToStaticMarkup(
      <DeviceDrillIn
        {...props(doc)}
        patchDoc={patchDoc}
        comparison={{ side: "b", onSideChange: () => undefined }}
      />,
    );
    captures.colours[0]?.onCommit("#ABCDEF");
    captures.options.find((option) => option.label === "Sun sweep")?.onSelect();
    await Promise.resolve();

    expect(histories).toEqual(["after device finish", "after device shadow"]);
    expect(working.compare?.b?.deviceAppearance?.d2).toEqual({
      colour: "custom:#abcdef",
      shadow: "sun",
    });
    expect(working.devices?.[1].colour).toBe(doc.devices?.[1].colour);
    expect(working.devices?.[1].shadow).toBe("soft");
  });

  it("offers Match the before side once After owns an override", () => {
    const doc = comparisonDoc();
    if (doc.compare) doc.compare.b = { deviceAppearance: { d2: { shadow: "none" } } };

    const html = renderToStaticMarkup(
      <DeviceDrillIn {...props(doc)} comparison={{ side: "b", onSideChange: () => undefined }} />,
    );

    expect(html).toContain("Match the before side");
    expect(captures.options.find((option) => option.label === "None")?.selected).toBe(true);
    expect(doc.devices?.[1].shadow).toBe("soft");
  });

  it("names the After screen media and marks an inherited one", () => {
    const doc = comparisonDoc();
    const inherited = renderToStaticMarkup(
      <DeviceDrillIn {...props(doc)} comparison={{ side: "b", onSideChange: () => undefined }} />,
    );
    expect(inherited).toContain("demo.mov");
    expect(inherited).toContain("Same as before");

    if (doc.compare) doc.compare.b = { media: { d2: { src: "assets/after.mp4", kind: "video" } } };
    const overridden = renderToStaticMarkup(
      <DeviceDrillIn
        {...props(doc)}
        screenMediaDetail={undefined}
        comparison={{ side: "b", onSideChange: () => undefined }}
      />,
    );
    expect(overridden).toContain("after.mp4");
    expect(overridden).not.toContain("Same as before");
  });

  it("writes the After start delay through compare.b.media, materialising the inherited spec", () => {
    const doc = comparisonDoc();
    let working = structuredClone(doc);
    const patchDoc: DevicePatchDoc = async (patch) => {
      const next = structuredClone(working);
      patch(next);
      working = next;
    };

    renderToStaticMarkup(
      <DeviceDrillIn
        {...props(doc)}
        patchDoc={patchDoc}
        comparison={{ side: "b", onSideChange: () => undefined }}
      />,
    );
    const delay = captures.sliders.find((slider) => slider.label === "Start delay");
    expect(delay?.value).toBe(0.3);
    delay?.onCommit(2);

    expect(working.compare?.b?.media?.d2).toEqual({
      src: "assets/demo.mov",
      kind: "video",
      startMs: 2000,
    });
    expect(working.devices?.[1].media?.startMs).toBe(300);
  });
});

describe("device editor actions", () => {
  it("applies model compatibility through one live document write", async () => {
    let doc = deviceDoc();
    const writes: Array<{ history?: string | false } | undefined> = [];
    const patchDocResult: DevicePatchDocResult = async (patch, options) => {
      const next = structuredClone(doc);
      patch(next);
      doc = next;
      writes.push(options);
      return true;
    };

    expect(await changeFirstClassDeviceModel(patchDocResult, "d2", "macbook-pro-16")).toBe(true);

    expect(writes).toEqual([{ history: "change device model" }]);
    expect(doc.devices?.[1]).toEqual({
      ...deviceDoc().devices?.[1],
      model: "macbook-pro-16",
      colour: "silver",
    });
    expect(doc.deviceLayout).toEqual(deviceDoc().deviceLayout);
  });

  it("duplicates and removes in one structural history entry each", async () => {
    let doc = deviceDoc();
    const selections: string[] = [];
    const writes: Array<string | false | undefined> = [];
    const patchDocResult: DevicePatchDocResult = async (patch, options) => {
      const next = structuredClone(doc);
      patch(next);
      doc = next;
      writes.push(options?.history);
      return true;
    };

    expect(await duplicateFirstClassDevice(patchDocResult, "d2", (id) => selections.push(id))).toBe(
      true,
    );
    const duplicateId = selections[0];
    expect(duplicateId).toBe("d4");
    expect(doc.devices?.find((device) => device.id === duplicateId)?.media?.src).toBe(
      "assets/demo.mov",
    );

    expect(await removeFirstClassDevice(patchDocResult, duplicateId)).toEqual({
      succeeded: true,
      nextDeviceId: "d3",
    });
    expect(writes).toEqual(["duplicate device", "remove device"]);
    expect(doc.devices?.some((device) => device.id === duplicateId)).toBe(false);
  });

  it("does not select or navigate after a failed structural write", async () => {
    const selections: string[] = [];
    const failed: DevicePatchDocResult = async (patch) => {
      patch(deviceDoc());
      return false;
    };

    expect(await changeFirstClassDeviceModel(failed, "d2", "android")).toBe(false);
    expect(await duplicateFirstClassDevice(failed, "d2", (id) => selections.push(id))).toBe(false);
    expect(await removeFirstClassDevice(failed, "d2")).toEqual({
      succeeded: false,
      nextDeviceId: null,
    });
    expect(selections).toEqual([]);
  });
});
