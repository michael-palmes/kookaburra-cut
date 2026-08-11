import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import {
  ArrangeDevicesDrill,
  type ArrangeDevicesDrillProps,
  baselineForArrangeScene,
} from "./ArrangeDevicesDrill";

interface CapturedSliderProps {
  label: string;
  value: number;
  onInput?: (value: number) => void;
  onCommit: (value: number) => void;
}

const capturedSliders = vi.hoisted(() => [] as CapturedSliderProps[]);

vi.mock("./rows", async () => {
  const actual = await vi.importActual<typeof import("./rows")>("./rows");
  return {
    ...actual,
    InspectorSliderRow: (props: CapturedSliderProps) => {
      capturedSliders.push(props);
      return <div data-slider-label={props.label}>{props.label}</div>;
    },
  };
});

const multiDeviceDoc = (): SceneDoc => ({
  version: 1,
  devices: [
    { id: "d1", model: "iphone-17-pro", colour: "silver" },
    { id: "d2", model: "iphone-17-pro", colour: "deep-blue" },
    { id: "d3", model: "macbook-pro-16", colour: "space-grey" },
  ],
  deviceLayout: {
    preset: "row",
    gap: 0.72,
    devices: {
      d1: { scale: 0.9 },
      d2: { offset: [0.1, 0.2, -0.3], rotationDeg: [0, 8, 0] },
    },
  },
});

const idleProps = (doc: SceneDoc): ArrangeDevicesDrillProps => ({
  doc,
  sceneIdentity: "ws:test\u0000scenes/one.tsx",
  selectedDeviceId: doc.devices?.[0]?.id ?? null,
  backLabel: "Scene",
  onBack: () => undefined,
  onSelectDevice: () => undefined,
  onOpenDevice: () => undefined,
  patchDoc: () => Promise.resolve(),
  commitFromBaseline: () => Promise.resolve(),
});

beforeEach(() => {
  capturedSliders.length = 0;
});

describe("ArrangeDevicesDrill", () => {
  it("renders the approved shared layout and single-device nudge hierarchy", () => {
    const doc = multiDeviceDoc();
    const html = renderToStaticMarkup(
      <ArrangeDevicesDrill {...idleProps(doc)} selectedDeviceId="d2" />,
    );

    expect(html).toContain('aria-label="Back to Scene from Arrange devices"');
    expect(html).toContain("3 devices in this scene");
    expect(html.match(/arrange-layout-choice/g)).toHaveLength(6);
    expect(html.match(/class="arrange-layout-diagram"/g)).toHaveLength(6);
    expect(html.match(/width="28" height="18"/g)).toHaveLength(6);
    expect(html).toContain(
      '<fieldset class="bg-type-grid arrange-layout-grid" aria-label="Layout"',
    );
    expect(html).toContain(
      '<fieldset class="bg-type-grid arrange-device-picker" aria-label="Nudge device"',
    );
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain("Toe-in");
    expect(html).toContain("Cascade");
    expect(html).toContain("Depth");
    expect(html).toContain('aria-label="Device 2, iPhone 17 Pro"');
    expect(html).toContain("Device 2 · iPhone 17 Pro");
    expect(html).toContain("offset from the layout");
    expect(html).toContain("Open device");
    expect(html).toContain("Reset device");
    expect(html).toContain("Reset all positions");
    expect(capturedSliders.map((slider) => slider.label)).toEqual([
      "Gap",
      "Left-right",
      "Up-down",
      "Depth",
      "Size",
    ]);
  });

  it("hides group layout and Gap for one device while retaining its transform controls", () => {
    const doc: SceneDoc = {
      version: 1,
      devices: [
        {
          id: "d1",
          model: "iphone-17-pro",
          placement: { position: [0.5, -0.3, 0], rotationDeg: [0, 12, 0], scale: 1.1 },
        },
      ],
    };
    const html = renderToStaticMarkup(<ArrangeDevicesDrill {...idleProps(doc)} />);

    expect(html).toContain("1 device in this scene");
    expect(html).not.toContain("arrange-layout-grid");
    expect(html).not.toContain("offset from the layout");
    expect(capturedSliders.map((slider) => slider.label)).toEqual([
      "Left-right",
      "Up-down",
      "Depth",
      "Size",
    ]);
  });

  it("previews slider ticks without history and commits once from the drag baseline", () => {
    const doc = multiDeviceDoc();
    let working = structuredClone(doc);
    const liveOptions: Array<{ history?: string | false } | undefined> = [];
    const committed: SceneDoc[] = [];
    const baselines: SceneDoc[] = [];
    const patchDoc: ArrangeDevicesDrillProps["patchDoc"] = (patch, options) => {
      const next = structuredClone(working);
      patch(next);
      working = next;
      liveOptions.push(options);
      return Promise.resolve();
    };
    const commitFromBaseline: ArrangeDevicesDrillProps["commitFromBaseline"] = (
      baseline,
      patch,
    ) => {
      baselines.push(baseline);
      const next = structuredClone(baseline);
      patch(next);
      committed.push(next);
      return Promise.resolve();
    };

    renderToStaticMarkup(
      <ArrangeDevicesDrill
        {...idleProps(doc)}
        selectedDeviceId="d2"
        patchDoc={patchDoc}
        commitFromBaseline={commitFromBaseline}
      />,
    );
    const slider = capturedSliders.find((candidate) => candidate.label === "Left-right");
    slider?.onInput?.(1.25);
    slider?.onInput?.(1.4);
    slider?.onCommit(1.4);

    expect(liveOptions).toEqual([{ history: false }, { history: false }]);
    expect(baselines).toEqual([doc]);
    expect(committed).toHaveLength(1);
    expect(committed[0].deviceLayout).toEqual({
      preset: "row",
      gap: 0.72,
      devices: {
        d1: { scale: 0.9 },
        d2: { offset: [1.4, 0.2, -0.3], rotationDeg: [0, 8, 0] },
      },
    });
  });

  it("writes a one-device nudge to raw placement without disturbing its rotation", () => {
    const doc: SceneDoc = {
      version: 1,
      devices: [
        {
          id: "d1",
          model: "iphone-17-pro",
          placement: { position: [0.5, -0.3, 0], rotationDeg: [2, 14, -1], scale: 1 },
        },
      ],
    };
    const committed: SceneDoc[] = [];
    const commitFromBaseline: ArrangeDevicesDrillProps["commitFromBaseline"] = (
      baseline,
      patch,
    ) => {
      const next = structuredClone(baseline);
      patch(next);
      committed.push(next);
      return Promise.resolve();
    };

    renderToStaticMarkup(
      <ArrangeDevicesDrill
        {...idleProps(doc)}
        patchDoc={(patch) => {
          const next = structuredClone(doc);
          patch(next);
          return Promise.resolve();
        }}
        commitFromBaseline={commitFromBaseline}
      />,
    );
    const slider = capturedSliders.find((candidate) => candidate.label === "Size");
    slider?.onInput?.(1.2);
    slider?.onCommit(1.2);

    expect(committed[0]?.devices?.[0].placement).toEqual({
      position: [0.5, -0.3, 0],
      rotationDeg: [2, 14, -1],
      scale: 1.2,
    });
  });

  it("uses the renderer's zero placement default when the device has no authored placement", () => {
    const doc: SceneDoc = {
      version: 1,
      devices: [{ id: "d1", model: "iphone-17-pro" }],
    };
    const committed: SceneDoc[] = [];

    renderToStaticMarkup(
      <ArrangeDevicesDrill
        {...idleProps(doc)}
        patchDoc={() => Promise.resolve()}
        commitFromBaseline={(baseline, patch) => {
          const next = structuredClone(baseline);
          patch(next);
          committed.push(next);
          return Promise.resolve();
        }}
      />,
    );
    const slider = capturedSliders.find((candidate) => candidate.label === "Left-right");
    slider?.onInput?.(0.8);
    slider?.onCommit(0.8);

    expect(committed[0]?.devices?.[0].placement?.position).toEqual([0.8, 0, 0]);
  });

  it("rejects a drag baseline after the drill rerenders for another scene", () => {
    const doc = multiDeviceDoc();
    const baseline = {
      sceneIdentity: "ws:test\u0000scenes/one.tsx",
      doc,
    };

    expect(baselineForArrangeScene(baseline, baseline.sceneIdentity)).toBe(baseline);
    expect(baselineForArrangeScene(baseline, "ws:test\u0000scenes/two.tsx")).toBeNull();
  });
});
