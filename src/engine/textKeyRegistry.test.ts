import { beforeEach, describe, expect, it } from "vitest";
import { brandLockupManagedMotion } from "../toolkit/text/brandLockupLayout";
import { deriveManagedTextModel, materialiseManagedText } from "./managedText";
import {
  codedTextMotionNames,
  nonSceneTextKeys,
  sceneOwnsAnyTextKey,
  sceneTextKeysConsumedBy,
  textKeyColorDefaults,
  textKeyStyleCapable,
  textKeysConsumedBy,
  useTextKeyRegistry,
  virtualManagedTextRegistrations,
} from "./textKeyRegistry";

beforeEach(() => useTextKeyRegistry.setState({ keys: {} }));

describe("mounted text takeover registration", () => {
  it("merges resolved hook copy with the primitive's style and coded motion", () => {
    const registry = useTextKeyRegistry.getState();
    registry.register(3, "hero-title", "copy-mount", { resolvedText: "Fallback from code" });
    registry.register(3, "hero-title", "primitive-mount", {
      resolvedText: "Fallback from code",
      colorDefault: "accent",
      styleCapable: true,
      style: {
        color: "accent",
        font: "Avenir Next@600",
        size: 1,
        offsetX: 0,
        offsetY: 0,
        lineHeight: 1.1,
        rotationDeg: 0,
      },
      codedMotion: {
        in: "twist-scale",
        out: "fade",
        staggerMs: 90,
        stagger: "word",
        direction: "from-right",
        durationMs: 650,
        ease: "outExpo",
      },
    });

    expect(textKeysConsumedBy(3)).toEqual(["hero-title"]);
    expect(textKeyColorDefaults(3)).toEqual({ "hero-title": "accent" });
    expect(textKeyStyleCapable(3)).toEqual(new Set(["hero-title"]));
    expect(codedTextMotionNames(3)).toEqual(["Hero Title"]);
    expect(virtualManagedTextRegistrations(3)).toEqual([
      {
        key: "hero-title",
        text: "Fallback from code",
        style: {
          color: "accent",
          font: "Avenir Next@600",
          size: 1,
          offsetX: 0,
          offsetY: 0,
          lineHeight: 1.1,
          rotationDeg: 0,
        },
        motion: {
          in: "twist-scale",
          out: "fade",
          staggerMs: 90,
          stagger: "word",
          direction: "from-right",
          durationMs: 650,
          ease: "outExpo",
        },
      },
    ]);
  });

  it("feeds an exact mounted fallback snapshot into one managed takeover", () => {
    useTextKeyRegistry.getState().register(1, "title", "mounted-title", {
      resolvedText: "Mounted fallback, not in the sidecar",
      style: { color: "muted", font: "Inter@600", size: 1.2 },
      codedMotion: { in: "fade-up", out: "none", staggerMs: 0 },
    });

    const doc = { version: 1 };
    const model = deriveManagedTextModel(doc, virtualManagedTextRegistrations(1));
    const takenOver = materialiseManagedText(doc, model);

    expect(takenOver.managedText?.items).toEqual([
      { key: "title", type: "title", text: "Mounted fallback, not in the sidecar" },
    ]);
    expect(takenOver.textStyle).toEqual({
      titleColor: "muted",
      titleFont: "Inter@600",
      titleSize: 1.2,
    });
    expect(takenOver.textAnimationOverrides?.title).toEqual({
      in: "fade-up",
      out: "none",
      staggerMs: 0,
    });
  });

  it("includes a mounted code-owned project image icon in takeover", () => {
    useTextKeyRegistry.getState().register(1, "icon", "mounted-icon", {
      resolvedText: "",
      managedType: "icon",
      icon: "assets/code-mark.png",
      styleCapable: true,
      style: { size: 1, offsetX: 0, offsetY: 0, rotationDeg: 0 },
    });

    const model = deriveManagedTextModel({ version: 1 }, virtualManagedTextRegistrations(1));

    expect(model.items).toEqual([
      { key: "icon", type: "icon", text: "", icon: "assets/code-mark.png" },
    ]);
    expect(model.textStyle).toEqual({
      iconSize: 1,
      iconOffsetX: 0,
      iconOffsetY: 0,
      iconRotationDeg: 0,
    });
  });

  it("retains a BrandLockup parent reveal on its title and subtitle after takeover", () => {
    const motion = brandLockupManagedMotion(200, 1100);
    const registry = useTextKeyRegistry.getState();
    registry.register(1, "title", "brand-title", {
      resolvedText: "Kookaburra Cut",
      codedMotion: motion,
    });
    registry.register(1, "subtitle", "brand-subtitle", {
      resolvedText: "1.0",
      codedMotion: motion,
    });

    const takenOver = materialiseManagedText(
      { version: 1 },
      deriveManagedTextModel({ version: 1 }, virtualManagedTextRegistrations(1)),
    );

    expect(takenOver.managedText?.items.map(({ key }) => key)).toEqual(["title", "subtitle"]);
    expect(takenOver.textAnimationOverrides).toEqual({ title: motion, subtitle: motion });
  });

  it("excludes embedded and managed render mounts from virtual takeover", () => {
    const registry = useTextKeyRegistry.getState();
    registry.register(4, "beforeLabel", "compare-chip", {
      resolvedText: "Before",
      codedMotion: { in: "fade", out: "none", staggerMs: 0 },
      managedTextRole: "embedded",
    });
    registry.register(4, "ls-caption", "screenshot-copy", {
      resolvedText: "Embedded caption",
      managedTextRole: "embedded",
    });
    registry.register(4, "ls-caption", "screenshot-primitive", {
      resolvedText: "Embedded caption",
      style: { color: "text", font: "Inter@500" },
      managedTextRole: "embedded",
    });
    registry.register(4, "managed-title", "managed-renderer", {
      resolvedText: "Managed",
      codedMotion: { in: "fade-up", out: "none", staggerMs: 0 },
      managedTextRole: "managed",
    });
    registry.register(4, "title", "scene-copy", {
      resolvedText: "Scene title",
      managedTextRole: "scene",
    });

    expect(textKeysConsumedBy(4)).toEqual(["beforeLabel", "ls-caption", "managed-title", "title"]);
    expect(sceneTextKeysConsumedBy(4)).toEqual(["title"]);
    expect(nonSceneTextKeys(4)).toEqual(["beforeLabel", "ls-caption", "managed-title"]);
    expect(virtualManagedTextRegistrations(4)).toEqual([{ key: "title", text: "Scene title" }]);
    expect(codedTextMotionNames(4)).toEqual([]);
    expect(sceneOwnsAnyTextKey(useTextKeyRegistry.getState().keys[4], ["managed-title"])).toBe(
      false,
    );
    expect(sceneOwnsAnyTextKey(useTextKeyRegistry.getState().keys[4], ["title"])).toBe(true);
  });

  it("removes one mount's metadata without dropping a surviving copy consumer", () => {
    const registry = useTextKeyRegistry.getState();
    registry.register(2, "title", "copy", { resolvedText: "Hello" });
    registry.register(2, "title", "primitive", {
      resolvedText: "Hello",
      styleCapable: true,
      style: { color: "text", font: "Inter" },
      codedMotion: { in: "fade", out: "none", staggerMs: 0 },
    });

    registry.unregister(2, "title", "primitive");

    expect(textKeysConsumedBy(2)).toEqual(["title"]);
    expect(virtualManagedTextRegistrations(2)).toEqual([{ key: "title", text: "Hello" }]);
    expect(codedTextMotionNames(2)).toEqual([]);
  });
});
