import { describe, expect, it } from "vitest";
import { ASSET_ICON_SCALE, frameIconAssetMaxHeight } from "./FrameIcon";

describe("frameIconAssetMaxHeight", () => {
  it("preserves absent-managed scene and panel icon aspect ratios", () => {
    expect(
      frameIconAssetMaxHeight({
        doc: { version: 1 },
        managedTextRole: "scene",
        textKey: "icon",
        box: 1,
      }),
    ).toBeUndefined();
    expect(
      frameIconAssetMaxHeight({
        doc: { version: 1 },
        managedTextRole: "scene",
        textKey: "frameIcon",
        box: 1,
      }),
    ).toBeUndefined();
  });

  it("contains generic and template-managed icon assets", () => {
    expect(
      frameIconAssetMaxHeight({
        doc: { version: 1, managedText: { items: [] } },
        managedTextRole: "managed",
        textKey: "icon",
        box: 2,
      }),
    ).toBe(2 * ASSET_ICON_SCALE);
    expect(
      frameIconAssetMaxHeight({
        doc: { version: 1, managedText: { layout: "template", items: [] } },
        managedTextRole: "scene",
        textKey: "frameIcon",
        box: 2,
      }),
    ).toBe(2 * ASSET_ICON_SCALE);
  });

  it("leaves embedded frame chrome at its legacy size", () => {
    expect(
      frameIconAssetMaxHeight({
        doc: { version: 1, managedText: { items: [] } },
        managedTextRole: "embedded",
        box: 1,
      }),
    ).toBeUndefined();
  });
});
