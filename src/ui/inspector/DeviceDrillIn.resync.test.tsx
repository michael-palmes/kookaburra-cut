import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedProject } from "../../engine/project";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import { settleSceneDocPatches, useSceneDocPatch } from "../useSceneDocPatch";
import { DeviceDrillIn } from "./DeviceDrillIn";

interface CapturedSlider {
  label: string;
  onInput?: (value: number) => void;
  onCommit: (value: number) => void;
}

const mocks = vi.hoisted(() => ({
  sliders: [] as CapturedSlider[],
  durations: [] as number[],
  invoke: vi.fn(),
  pushHistory: vi.fn(),
  onTimingChanged: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: mocks.invoke,
}));

vi.mock("../../engine/history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../engine/history")>()),
  pushHistory: mocks.pushHistory,
}));

vi.mock("./rows", async () => {
  const actual = await vi.importActual<typeof import("./rows")>("./rows");
  return {
    ...actual,
    InspectorSliderRow: (props: CapturedSlider) => {
      mocks.sliders.push(props);
      return null;
    },
  };
});

const CLIP_MS = 30_000;

/** Side b's Before already plays 8 s, so the After clip is the longest slot the scene follows. */
function followMediaDoc(side: "a" | "b"): SceneDoc {
  const clip = { src: "assets/rec.mp4", kind: "video" } as const;
  if (side === "a") {
    return {
      version: 1,
      duration: { mode: "follow-media" },
      devices: [{ id: "d1", model: "android", media: clip }],
    };
  }
  return {
    version: 1,
    duration: { mode: "follow-media" },
    devices: [{ id: "d1", model: "android", media: { ...clip, outMs: 8000 } }],
    compare: { b: { media: { d1: { ...clip } } } },
  };
}

function project(doc: SceneDoc, id: string): LoadedProject {
  return {
    id: `ws:${id}`,
    sceneDocs: [doc],
    sceneFiles: ["scenes/01-device.tsx"],
    slots: [{ startMs: 0, durationMs: CLIP_MS }],
  } as unknown as LoadedProject;
}

function Host({ loaded, side }: { loaded: LoadedProject; side: "a" | "b" }) {
  const { patchDoc, patchDocResult, commitFromBaseline } = useSceneDocPatch(
    loaded,
    0,
    () => undefined,
    mocks.onTimingChanged,
  );
  return (
    <DeviceDrillIn
      doc={loaded.sceneDocs[0] as SceneDoc}
      deviceId="d1"
      backLabel="Scene"
      screenMediaDurationMs={CLIP_MS}
      comparison={side === "b" ? { side, onSideChange: () => undefined } : undefined}
      onBack={() => undefined}
      onSelectDevice={() => undefined}
      onChangeDevice={() => undefined}
      onChangeScreenMedia={() => undefined}
      onOpenArrangement={() => undefined}
      patchDoc={patchDoc}
      patchDocResult={patchDocResult}
      commitFromBaseline={commitFromBaseline}
    />
  );
}

const slider = (label: string) => mocks.sliders.find((s) => s.label === label);

beforeEach(() => {
  mocks.sliders.length = 0;
  mocks.durations.length = 0;
  vi.clearAllMocks();
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "media_meta") return { durationMs: CLIP_MS };
    if (command === "update_project_scene") mocks.durations.push(args.durationMs as number);
    if (command === "read_project_manifest_snapshot") return `{"durations":[${mocks.durations}]}`;
    return null;
  });
});

describe("device drill Playback rows on a follow-media scene", () => {
  for (const [side, seconds] of [
    ["a", 8],
    ["b", 12],
  ] as const) {
    it(`a trim commit re-syncs the scene length in the same undo step (side ${side})`, async () => {
      renderToStaticMarkup(
        <Host loaded={project(followMediaDoc(side), `trim-${side}`)} side={side} />,
      );
      slider("Trim end")?.onCommit(seconds);
      await settleSceneDocPatches();

      expect(mocks.durations).toEqual([seconds * 1000]);
      expect(mocks.onTimingChanged).toHaveBeenCalledOnce();
      const entry = mocks.pushHistory.mock.calls[0]?.[0];
      expect(entry?.label).toBe("screen trim end");
      expect(entry?.changes.map((c: { kind: string }) => c.kind)).toEqual(["sceneDoc", "manifest"]);
    });
  }

  it("a dragged trim re-syncs once, on release", async () => {
    renderToStaticMarkup(<Host loaded={project(followMediaDoc("a"), "drag")} side="a" />);
    const trimStart = slider("Trim start");
    trimStart?.onInput?.(1);
    trimStart?.onInput?.(2);
    await settleSceneDocPatches();
    expect(mocks.durations).toEqual([]);

    trimStart?.onCommit(2);
    await settleSceneDocPatches();
    expect(mocks.durations).toEqual([28_000]);
    expect(mocks.pushHistory).toHaveBeenCalledOnce();
    expect(
      mocks.pushHistory.mock.calls[0]?.[0].changes.map((c: { kind: string }) => c.kind),
    ).toEqual(["sceneDoc", "manifest"]);
  });
});
