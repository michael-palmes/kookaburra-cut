import { describe, expect, it, vi } from "vitest";
import { bindHistory, pushHistory, takeRedo, takeUndo } from "../../engine/history";
import type { VirtualManagedTextRegistration } from "../../engine/managedText";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import type { FrameSpec } from "../../toolkit/frame/types";
import {
  applyManagedTextStructuralAction,
  describeManagedTextMotion,
  managedTextAlignment,
  managedTextStyleValue,
  managedTextVirtualOptionsForFrame,
  nextManagedTextKey,
  performManagedTextStructuralAction,
  rebaseTextMotionSpec,
  setLegacyManagedTextIcon,
  setManagedTextAlignment,
  setManagedTextCopy,
  setManagedTextIcon,
  setManagedTextPointCopy,
  setManagedTextStyle,
  setTextMotionSpec,
  textMotionSpec,
} from "./managedTextEditorModel";

const registrations: VirtualManagedTextRegistration[] = [
  {
    key: "title",
    text: "Code title",
    type: "title",
    style: { size: 1.15, offsetX: 0.2 },
    motion: { in: "fade-up", out: "none", staggerMs: 80 },
  },
  {
    key: "points",
    text: "First\nSecond",
    type: "bullets",
    points: [
      { key: "points-point-1", text: "First" },
      { key: "points-point-2", text: "Second" },
    ],
  },
];

describe("managed text editor model", () => {
  it("projects only frame icons that claim scene text", () => {
    const frame = { icon: "🚀" } as FrameSpec;
    expect(managedTextVirtualOptionsForFrame(frame)).toEqual({ icon: "🚀", iconKey: "icon" });
    expect(managedTextVirtualOptionsForFrame({ ...frame, claimsSceneText: false })).toEqual({});
    expect(managedTextVirtualOptionsForFrame({ ...frame, enabled: false })).toEqual({});
  });

  it("writes alignment to the frame only while that frame claims scene text", () => {
    const doc: SceneDoc = { version: 1, textLayout: { align: "left" } };
    const frame: FrameSpec = {
      cutout: { shape: "rounded-rect", side: "end", size: 0.34 },
      textAlign: "right",
    };

    expect(managedTextAlignment(doc)).toBe("left");
    expect(setManagedTextAlignment(doc, "center")).toMatchObject({
      textLayout: { align: "center" },
    });
    expect(managedTextAlignment(doc, frame)).toBe("right");
    expect(setManagedTextAlignment(doc, "left", frame)).toMatchObject({
      textLayout: { align: "left" },
      frame: { textAlign: "left" },
    });

    const unclaimed = { ...frame, claimsSceneText: false };
    expect(managedTextAlignment(doc, unclaimed)).toBe("left");
    expect(setManagedTextAlignment(doc, "right", unclaimed)).toMatchObject({
      textLayout: { align: "right" },
    });
  });

  it("routes legacy icon writes to the icon source projected by the managed editor", () => {
    const doc: SceneDoc = {
      version: 1,
      headerIcon: "🚀",
      frame: { icon: "assets/scene-frame.png" },
    };
    const frame: FrameSpec = {
      cutout: { shape: "rounded-rect", side: "end", size: 0.34 },
      icon: "assets/resolved-frame.png",
    };

    const frameWrite = setLegacyManagedTextIcon(doc, "icon", "✨", frame);
    expect(frameWrite?.frame?.icon).toBe("✨");
    expect(frameWrite?.headerIcon).toBe("🚀");

    const headerWrite = setLegacyManagedTextIcon(doc, "icon", "✨", {
      ...frame,
      claimsSceneText: false,
    });
    expect(headerWrite?.headerIcon).toBe("✨");
    expect(headerWrite?.frame?.icon).toBe("assets/scene-frame.png");
  });

  it("mints stable readable keys without collisions", () => {
    expect(nextManagedTextKey("title", [])).toBe("title");
    expect(nextManagedTextKey("title", ["title", "title-2", "title-4"])).toBe("title-3");
  });

  it("cancels code-owned structural edits without writing", async () => {
    const commit = vi.fn();
    const confirmTakeover = vi.fn(async () => false);

    const status = await performManagedTextStructuralAction({
      doc: { version: 1 },
      registrations,
      action: { type: "add-item", itemType: "subtitle", afterKey: "title" },
      confirmTakeover,
      commit,
    });

    expect(status).toBe("cancelled");
    expect(confirmTakeover).toHaveBeenCalledWith({
      action: { type: "add-item", itemType: "subtitle", afterKey: "title" },
      itemCount: 2,
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("materialises the virtual sheet and triggering action in one accepted write", async () => {
    const original: SceneDoc = { version: 1, text: { subtitle: "Sidecar subtitle" } };
    const commit = vi.fn();

    const status = await performManagedTextStructuralAction({
      doc: original,
      registrations,
      action: { type: "add-item", itemType: "subtitle", afterKey: "title" },
      confirmTakeover: async () => true,
      commit,
    });

    expect(status).toBe("committed");
    expect(commit).toHaveBeenCalledTimes(1);
    const [result, history] = commit.mock.calls[0] ?? [];
    expect(history).toBe("add text line");
    expect(result.selectedItemKey).toBe("subtitle-2");
    expect(result.doc.managedText?.items.map((item: { key: string }) => item.key)).toEqual([
      "title",
      "subtitle-2",
      "points",
      "subtitle",
    ]);
    expect(result.doc.textStyle).toMatchObject({ titleSize: 1.15, titleOffsetX: 0.2 });
    expect(result.doc.textAnimationOverrides?.title?.in).toBe("fade-up");
    expect(original.managedText).toBeUndefined();
  });

  it("records one takeover edge whose Undo restores code ownership and Redo restores the overlay projection", async () => {
    const original: SceneDoc = {
      version: 1,
      text: { title: "Code title" },
      textLayout: { align: "right" },
    };
    const frame = {
      cutout: { shape: "rounded-rect", side: "end", size: 0.34 },
      icon: "assets/frame-mark.png",
    } as FrameSpec;
    bindHistory(null);
    bindHistory("ws:managed-text-takeover");
    try {
      const status = await performManagedTextStructuralAction({
        doc: original,
        registrations: registrations.slice(0, 1),
        virtualOptions: managedTextVirtualOptionsForFrame(frame),
        action: { type: "take-over", itemKey: "icon" },
        confirmTakeover: async () => true,
        commit: (result, history) => {
          pushHistory({
            label: history,
            changes: [
              {
                kind: "sceneDoc",
                slug: "managed-text-takeover",
                file: "scenes/01-lockup.tsx",
                sceneIndex: 0,
                before: original,
                after: result.doc,
              },
            ],
          });
        },
      });

      expect(status).toBe("committed");
      const undo = takeUndo();
      expect(undo?.label).toBe("take over scene text");
      const undoChange = undo?.changes[0];
      expect(undoChange?.kind).toBe("sceneDoc");
      if (undoChange?.kind !== "sceneDoc") throw new Error("missing Undo edge");
      expect(undoChange.before).toEqual(original);
      expect(undoChange.before?.managedText).toBeUndefined();

      const redo = takeRedo();
      const redoChange = redo?.changes[0];
      expect(redoChange?.kind).toBe("sceneDoc");
      if (redoChange?.kind !== "sceneDoc") throw new Error("missing Redo edge");
      expect(redoChange.after?.managedText?.items).toEqual([
        { key: "icon", type: "icon", icon: "assets/frame-mark.png" },
        { key: "title", type: "title", text: "Code title" },
      ]);
    } finally {
      bindHistory(null);
    }
  });

  it("materialises a code-owned icon before exposing controls with no legacy write path", async () => {
    const iconRegistration: VirtualManagedTextRegistration[] = [
      {
        key: "brand-icon",
        text: "",
        type: "icon",
        icon: "assets/app-icon.png",
        style: { size: 1, offsetX: 0, offsetY: 0, rotationDeg: 0 },
      },
    ];
    const commit = vi.fn();

    const status = await performManagedTextStructuralAction({
      doc: { version: 1 },
      registrations: iconRegistration,
      action: { type: "take-over", itemKey: "brand-icon" },
      confirmTakeover: async () => true,
      commit,
    });

    expect(status).toBe("committed");
    expect(commit).toHaveBeenCalledWith(
      {
        doc: expect.objectContaining({
          managedText: {
            items: [
              {
                key: "brand-icon",
                type: "icon",
                text: "",
                icon: "assets/app-icon.png",
              },
            ],
          },
        }),
        selectedItemKey: "brand-icon",
      },
      "take over scene text",
    );
  });

  it("does not prompt after ownership has transferred", async () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: { items: [{ key: "title", type: "title", text: "Hello" }] },
    };
    const confirmTakeover = vi.fn(async () => false);
    const commit = vi.fn();

    expect(
      await performManagedTextStructuralAction({
        doc,
        action: { type: "change-type", itemKey: "title", itemType: "subtitle" },
        confirmTakeover,
        commit,
      }),
    ).toBe("committed");
    expect(confirmTakeover).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("duplicates all dormant item data and remints stable nested point keys", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          {
            key: "bullets",
            type: "bullets",
            text: "Dormant copy",
            icon: "✨",
            marker: "tick",
            pointGap: 0.18,
            indent: 0.24,
            points: [
              { key: "bullets-point-1", text: "One" },
              { key: "bullets-point-2", text: "Two" },
            ],
          },
        ],
      },
      textStyle: { bulletsSize: 1.2, bulletsOffsetY: -0.3 },
      textAnimationOverrides: {
        bullets: { in: "fade", out: "none", staggerMs: 0 },
      },
    };

    const result = applyManagedTextStructuralAction(doc, {
      type: "duplicate-item",
      itemKey: "bullets",
    });

    expect(result?.selectedItemKey).toBe("bullets-2");
    expect(result?.doc.managedText?.items[1]).toEqual({
      ...doc.managedText?.items[0],
      key: "bullets-2",
      points: [
        { key: "bullets-2-point-1", text: "One" },
        { key: "bullets-2-point-2", text: "Two" },
      ],
    });
    expect(result?.doc.textStyle).toMatchObject({
      "bullets-2Size": 1.2,
      "bullets-2OffsetY": -0.3,
    });
    expect(result?.doc.textAnimationOverrides?.["bullets-2"]).toEqual(
      doc.textAnimationOverrides?.bullets,
    );
    expect(result?.doc.textAnimationOverrides?.["bullets-2"]).not.toBe(
      doc.textAnimationOverrides?.bullets,
    );
  });

  it("retains dormant fields across type changes", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          {
            key: "line",
            type: "bullets",
            text: "Fallback",
            icon: "assets/icon.png",
            points: [{ key: "line-point-1", text: "Point" }],
            marker: "dash",
          },
        ],
      },
    };

    const result = applyManagedTextStructuralAction(doc, {
      type: "change-type",
      itemKey: "line",
      itemType: "icon",
    });

    expect(result?.doc.managedText?.items[0]).toEqual({
      ...doc.managedText?.items[0],
      type: "icon",
    });
  });

  it("adds, reorders and removes bullet points without changing their keys", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          {
            key: "points",
            type: "bullets",
            points: [
              { key: "points-point-1", text: "One" },
              { key: "points-point-2", text: "Two" },
            ],
          },
        ],
      },
    };

    const added = applyManagedTextStructuralAction(doc, {
      type: "add-point",
      itemKey: "points",
      afterPointKey: "points-point-1",
      afterPointText: "One edited before Return",
      text: "Middle",
    });
    expect(added?.doc.managedText?.items[0]?.points).toEqual([
      { key: "points-point-1", text: "One edited before Return" },
      { key: "points-point-3", text: "Middle" },
      { key: "points-point-2", text: "Two" },
    ]);

    const moved = applyManagedTextStructuralAction(added?.doc ?? doc, {
      type: "move-point",
      itemKey: "points",
      pointKey: "points-point-2",
      toIndex: 0,
    });
    expect(moved?.doc.managedText?.items[0]?.points?.map((point) => point.key)).toEqual([
      "points-point-2",
      "points-point-1",
      "points-point-3",
    ]);

    const removed = applyManagedTextStructuralAction(moved?.doc ?? doc, {
      type: "remove-point",
      itemKey: "points",
      pointKey: "points-point-1",
    });
    expect(removed?.doc.managedText?.items[0]?.points?.map((point) => point.key)).toEqual([
      "points-point-2",
      "points-point-3",
    ]);
  });

  it("keeps copy and style edits on the authored path before takeover", () => {
    const doc: SceneDoc = { version: 1, headerIcon: "🚀" };

    const copy = setManagedTextCopy(doc, "title", "Edited", registrations);
    const point = setManagedTextPointCopy(
      copy ?? doc,
      "points",
      "points-point-2",
      "Changed",
      registrations,
    );
    const icon = setManagedTextIcon(point ?? doc, "icon", "✨", [], { icon: "🚀" });
    const styled = setManagedTextStyle(icon ?? doc, "title", "size", 1.25);

    expect(styled).toMatchObject({
      text: { title: "Edited", points: "First\nChanged" },
      headerIcon: "✨",
      textStyle: { titleSize: 1.25 },
    });
    expect(styled?.managedText).toBeUndefined();
    expect(managedTextStyleValue(styled ?? doc, "title", "size")).toBe(1.25);
    expect(managedTextStyleValue(styled ?? doc, "title", "rotation")).toBe(0);
  });

  it("writes all-lines motion independently from stable-key item exceptions", () => {
    const doc: SceneDoc = { version: 1 };
    const base = { in: "fade-up", out: "none", staggerMs: 90, durationMs: 500 };
    const exception = { in: "static", out: "static", staggerMs: 0 };

    const withBase = setTextMotionSpec(doc, { kind: "all" }, base);
    const withException = setTextMotionSpec(
      withBase,
      { kind: "item", itemKey: "title" },
      exception,
    );

    expect(textMotionSpec(withException, { kind: "all" })).toEqual(base);
    expect(textMotionSpec(withException, { kind: "item", itemKey: "title" })).toEqual(exception);
    expect(describeManagedTextMotion(exception)).toBe("None");
    expect(describeManagedTextMotion(undefined)).toBe("Theme");
    expect(describeManagedTextMotion(base)).toBe("Fade Up");

    const followsBase = setTextMotionSpec(
      withException,
      { kind: "item", itemKey: "title" },
      undefined,
    );
    expect(followsBase.textAnimationOverrides).toBeUndefined();
    expect(followsBase.textAnimation).toEqual(base);
  });

  it("rebases one motion-field change without dropping a queued sibling change", () => {
    const baseline = {
      in: "fade-up",
      out: "none",
      staggerMs: 90,
      durationMs: 500,
      ease: "outQuad",
    };
    const durationEdit = { ...baseline, durationMs: 900 };
    const queuedCurrent = { ...baseline, ease: "outExpo" };

    expect(rebaseTextMotionSpec(queuedCurrent, baseline, durationEdit)).toEqual({
      ...baseline,
      durationMs: 900,
      ease: "outExpo",
    });
  });
});
