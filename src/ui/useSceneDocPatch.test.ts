import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeFormat, FORMATS } from "../engine/format";
import type { LoadedProject } from "../engine/project";
import type { SceneDoc } from "../engine/sceneDocSchema";
import { bakeRigBinding } from "../engine/sceneRigConvert";
import { resolveDeviceLayout } from "../toolkit/device/layout";
import { resolveDeviceWorldAnchor } from "../toolkit/device/worldAnchor";
import {
  applySceneDocPatch,
  docPatchMatchesProject,
  resolveDocPatchIndex,
  useSceneDocPatch,
} from "./useSceneDocPatch";

const mocks = vi.hoisted(() => ({
  onDocChanged: vi.fn(),
  onTimingChanged: vi.fn(),
  pushHistory: vi.fn(),
  rebakeRigBindings: vi.fn(),
  setError: vi.fn(),
  writeSceneDoc: vi.fn(async (_slug: string, _file: string, _doc: SceneDoc) => {}),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState<T>(initial: T) {
      return [initial, mocks.setError] as const;
    },
  };
});

vi.mock("../engine/history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/history")>();
  return { ...actual, pushHistory: mocks.pushHistory };
});

vi.mock("../engine/sceneDoc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/sceneDoc")>();
  return { ...actual, writeSceneDoc: mocks.writeSceneDoc };
});

vi.mock("../engine/sceneRigConvert", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/sceneRigConvert")>();
  const rebakeRigBindings: typeof actual.rebakeRigBindings = (rig, doc, format, floorY) => {
    mocks.rebakeRigBindings();
    return actual.rebakeRigBindings(rig, doc, format, floorY);
  };
  return { ...actual, rebakeRigBindings };
});

const files = ["scenes/01-title.tsx", "scenes/02-device.tsx", "scenes/03-outro.tsx"];

function abortableProject(id: string, doc: SceneDoc): LoadedProject {
  return {
    id: `ws:${id}`,
    sceneDocs: [doc],
    sceneFiles: ["scenes/01-abort.tsx"],
    slots: [],
  } as unknown as LoadedProject;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveDocPatchIndex", () => {
  it("keeps the index when the file is still there", () => {
    expect(resolveDocPatchIndex(files, 1, "scenes/02-device.tsx")).toBe(1);
  });

  it("follows the file when an insert shifted the scene down", () => {
    const after = ["scenes/01-title.tsx", "scenes/04-new.tsx", ...files.slice(1)];
    expect(resolveDocPatchIndex(after, 1, "scenes/02-device.tsx")).toBe(2);
  });

  it("follows the file when a reorder moved the scene up", () => {
    const after = ["scenes/02-device.tsx", "scenes/01-title.tsx", "scenes/03-outro.tsx"];
    expect(resolveDocPatchIndex(after, 1, "scenes/02-device.tsx")).toBe(0);
  });

  it("drops the patch when the scene left the project", () => {
    expect(resolveDocPatchIndex(["scenes/01-title.tsx"], 1, "scenes/02-device.tsx")).toBeNull();
  });

  it("never lands a device doc on the title scene that took its index", () => {
    // The phantom device: the write targeted 02-device, an insert shifted it to 2.
    const after = ["scenes/01-title.tsx", "scenes/00-new-title.tsx", ...files.slice(1)];
    expect(resolveDocPatchIndex(after, 1, "scenes/02-device.tsx")).not.toBe(1);
  });

  it("matches regardless of a leading ./ on either side", () => {
    expect(resolveDocPatchIndex(files, 0, "./scenes/01-title.tsx")).toBe(0);
    expect(resolveDocPatchIndex(["./scenes/02-device.tsx"], 0, "scenes/02-device.tsx")).toBe(0);
  });

  it("falls back to the bounds check when no file is given", () => {
    expect(resolveDocPatchIndex(files, 2)).toBe(2);
    expect(resolveDocPatchIndex(files, 3)).toBeNull();
    expect(resolveDocPatchIndex(files, -1)).toBeNull();
  });
});

describe("docPatchMatchesProject", () => {
  it("accepts the intended project and rejects a late write from another project", () => {
    expect(docPatchMatchesProject("ws:current", "ws:current")).toBe(true);
    expect(docPatchMatchesProject("ws:current", "ws:previous")).toBe(false);
  });

  it("keeps legacy callers without project identity compatible", () => {
    expect(docPatchMatchesProject("ws:current")).toBe(true);
  });
});

describe("applySceneDocPatch", () => {
  it("rebakes a device-bound camera aim for baseline commits as well as live patches", () => {
    const baseline: SceneDoc = {
      version: 1,
      devices: [
        {
          id: "phone",
          model: "iphone-17-pro",
          placement: { position: [0, 0, 0] },
        },
      ],
      cameraRig: {
        keys: [
          {
            id: "key-1",
            tMs: 0,
            pose: {
              position: [0, 0, 5],
              aim: { mode: "object", id: "phone", at: [0, 0, 0] },
            },
          },
        ],
        segments: [],
      },
    };

    const after = applySceneDocPatch(baseline, (next) => {
      const device = next.devices?.[0];
      if (device) device.placement = { ...device.placement, position: [1, 2, 3] };
    });

    expect(after.cameraRig?.keys[0].pose.aim).toEqual({
      mode: "object",
      id: "phone",
      at: [1, 2, 3],
    });
    expect(baseline.cameraRig?.keys[0].pose.aim).toEqual({
      mode: "object",
      id: "phone",
      at: [0, 0, 0],
    });
  });

  it("pre-bakes an arranged target before a deletion freezes its camera aim", () => {
    const format = computeFormat(FORMATS["9:16"]);
    const baseline: SceneDoc = {
      version: 1,
      devices: [
        { id: "other", model: "iphone-17-pro" },
        { id: "phone", model: "iphone-17-pro", placement: { ground: true } },
      ],
      deviceLayout: { preset: "row", devices: { phone: { offset: [0.25, 0.1, -0.2] } } },
      cameraRig: {
        keys: [
          {
            id: "key-1",
            tMs: 0,
            pose: {
              position: [0, 0, 5],
              aim: { mode: "object", id: "phone", at: [0, 0, 0] },
            },
          },
        ],
        segments: [],
      },
    };
    const layout = baseline.deviceLayout;
    if (!layout) throw new Error("device layout expected");
    const floorY = -0.75;
    const placement = resolveDeviceLayout(baseline.devices ?? [], layout, format)[1];
    const expected = resolveDeviceWorldAnchor(
      baseline.devices?.[1] ?? { model: "" },
      placement,
      floorY,
    );
    const after = applySceneDocPatch(
      baseline,
      (next) => {
        if (next.cameraRig) next.cameraRig = bakeRigBinding(next.cameraRig, "phone");
        next.devices = next.devices?.filter((device) => device.id !== "phone");
      },
      format,
      floorY,
    );
    expect(after.cameraRig?.keys[0].pose.aim).toEqual({ mode: "point", at: expected });
  });
});

describe("abortable scene-doc mutations", () => {
  const docWithRig: SceneDoc = {
    version: 1,
    name: "Before",
    cameraRig: {
      keys: [],
      segments: [],
    },
  };

  it("aborts patchDocResult before rebake, write, host patch or history", async () => {
    const { patchDocResult } = useSceneDocPatch(
      abortableProject("abort-live", docWithRig),
      0,
      mocks.onDocChanged,
      mocks.onTimingChanged,
    );

    const succeeded = await patchDocResult((next) => {
      next.name = "Discarded";
      return false;
    });

    expect(succeeded).toBe(false);
    expect(docWithRig.name).toBe("Before");
    expect(mocks.rebakeRigBindings).not.toHaveBeenCalled();
    expect(mocks.writeSceneDoc).not.toHaveBeenCalled();
    expect(mocks.onDocChanged).not.toHaveBeenCalled();
    expect(mocks.pushHistory).not.toHaveBeenCalled();
  });

  it("aborts commitFromBaselineResult before rebake, write, host patch or history", async () => {
    const { commitFromBaselineResult } = useSceneDocPatch(
      abortableProject("abort-baseline", docWithRig),
      0,
      mocks.onDocChanged,
      mocks.onTimingChanged,
    );

    const succeeded = await commitFromBaselineResult(docWithRig, (next) => {
      next.name = "Discarded";
      return false;
    });

    expect(succeeded).toBe(false);
    expect(docWithRig.name).toBe("Before");
    expect(mocks.rebakeRigBindings).not.toHaveBeenCalled();
    expect(mocks.writeSceneDoc).not.toHaveBeenCalled();
    expect(mocks.onDocChanged).not.toHaveBeenCalled();
    expect(mocks.pushHistory).not.toHaveBeenCalled();
  });
});

describe("rebased scene-doc baseline commits", () => {
  it("applies the reducer to the queued latest doc and records the supplied baseline once", async () => {
    const baseline: SceneDoc = {
      version: 1,
      name: "Drag start",
      text: { title: "Original title" },
    };
    const project = abortableProject("rebased-latest", baseline);
    const { commitRebasedFromBaselineResult, patchDocResult } = useSceneDocPatch(
      project,
      0,
      mocks.onDocChanged,
      mocks.onTimingChanged,
    );

    expect(
      await patchDocResult(
        (next) => {
          next.name = "Queued latest";
          next.text = { ...next.text, subtitle: "Added during drag" };
        },
        { history: false },
      ),
    ).toBe(true);

    const reducer = vi.fn((next: SceneDoc) => {
      expect(next.name).toBe("Queued latest");
      expect(next.text?.subtitle).toBe("Added during drag");
      next.text = { ...next.text, title: "Final title" };
    });
    expect(await commitRebasedFromBaselineResult(baseline, reducer, "text style")).toBe(true);

    expect(reducer).toHaveBeenCalledOnce();
    expect(mocks.writeSceneDoc).toHaveBeenCalledTimes(2);
    expect(mocks.writeSceneDoc.mock.calls[1]?.[2]).toEqual({
      version: 1,
      name: "Queued latest",
      text: { title: "Final title", subtitle: "Added during drag" },
    });
    expect(mocks.pushHistory).toHaveBeenCalledOnce();
    expect(mocks.pushHistory).toHaveBeenCalledWith({
      label: "text style",
      changes: [
        expect.objectContaining({
          kind: "sceneDoc",
          before: baseline,
          after: {
            version: 1,
            name: "Queued latest",
            text: { title: "Final title", subtitle: "Added during drag" },
          },
        }),
      ],
    });
  });

  it("does not write, patch the host or add history when the rebased reducer aborts", async () => {
    const baseline: SceneDoc = { version: 1, name: "Before" };
    const { commitRebasedFromBaselineResult } = useSceneDocPatch(
      abortableProject("rebased-abort", baseline),
      0,
      mocks.onDocChanged,
      mocks.onTimingChanged,
    );

    const succeeded = await commitRebasedFromBaselineResult(baseline, (next) => {
      next.name = "Discarded";
      return false;
    });

    expect(succeeded).toBe(false);
    expect(baseline.name).toBe("Before");
    expect(mocks.rebakeRigBindings).not.toHaveBeenCalled();
    expect(mocks.writeSceneDoc).not.toHaveBeenCalled();
    expect(mocks.onDocChanged).not.toHaveBeenCalled();
    expect(mocks.pushHistory).not.toHaveBeenCalled();
  });
});
