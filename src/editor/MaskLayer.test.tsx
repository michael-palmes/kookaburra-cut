import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EditMask, EditSource } from "../engine/edit";
import { MaskLayer, type MaskLayerProps } from "./MaskLayer";
import { MaskSettingsBar } from "./MaskSettingsBar";

vi.mock("../ui/colour/ColourPicker", () => ({
  ColourPicker: ({ value, label }: { value: string; label: string }) => (
    <button type="button" aria-label={label} data-value={value} />
  ),
}));

const source: EditSource = {
  id: "s1",
  rel: "assets/a.mp4",
  width: 590,
  height: 1280,
  fps: 60,
  durationMs: 8000,
};
const mask = (over: Partial<EditMask> = {}): EditMask => ({
  id: "m1",
  sourceId: "s1",
  style: "solid",
  startMs: 1000,
  endMs: 3000,
  keys: [{ sourceMs: 1000, rect: [0.1, 0.2, 0.3, 0.1] }],
  ...over,
});
const noop = () => {};
const layer = (over: Partial<MaskLayerProps>) =>
  renderToStaticMarkup(
    <MaskLayer
      source={source}
      masks={[mask()]}
      sourceMs={1000}
      keyTolMs={8}
      selectedId={null}
      armed={false}
      editable
      media={null}
      onSelect={noop}
      onGesture={noop}
      onDraw={noop}
      onCommitRect={noop}
      onCommitPath={noop}
      onContextMenu={noop}
      {...over}
    />,
  );
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("MaskLayer", () => {
  it("draws a solid mask at its keyed box in % of the source frame", () => {
    const html = layer({});
    expect(html).toContain('class="mask-effect"');
    expect(html).toContain("left:10%;top:20%;width:30%;height:10%;background:#000000");
    expect(html).toContain('class="mask-frame"');
    expect(count(html, "mask-handle")).toBe(0);
  });

  it("gives the selected mask eight handles and a filled key cue on its key", () => {
    const html = layer({ selectedId: "m1" });
    expect(count(html, "mask-handle ")).toBe(8);
    expect(html).toContain("mask-key-badge on");
    expect(layer({ selectedId: "m1", sourceMs: 2000 })).toContain('class="mask-key-badge"');
  });

  it("shows a selected mask outside its span as a dashed outline only", () => {
    const html = layer({ selectedId: "m1", sourceMs: 5000 });
    expect(html).toContain("mask-frame inactive");
    expect(html).not.toContain("mask-effect");
    expect(layer({ sourceMs: 5000 })).not.toContain("mask-frame");
  });

  it("keeps the effect but drops the edit chrome while playing", () => {
    const html = layer({ selectedId: "m1", editable: false });
    expect(html).toContain("mask-effect");
    expect(html).not.toContain("mask-frame");
  });

  it("reads blur and pixelate through a canvas", () => {
    expect(layer({ masks: [mask({ style: "blur" })] })).toContain('class="mask-canvas"');
    expect(layer({ masks: [mask({ style: "pixelate" })] })).toContain("mask-canvas pixelated");
  });

  it("arms a draw surface and hides everything with no frame on screen", () => {
    expect(layer({ armed: true })).toContain("mask-draw-layer");
    expect(layer({ sourceMs: null })).not.toContain("mask-effect");
  });
});

describe("MaskSettingsBar", () => {
  const bar = (m: EditMask | null, keyState = { onKey: true, editable: true }, image = false) =>
    renderToStaticMarkup(
      <MaskSettingsBar
        mask={m}
        image={image}
        keyState={keyState}
        onStyle={noop}
        onStrength={noop}
        onStrengthCommit={noop}
        onColor={noop}
        onAddKey={noop}
        onRemoveKey={noop}
        onDelete={noop}
      />,
    );

  it("hints how to draw when nothing is selected", () => {
    expect(bar(null)).toContain("Drag over the preview to hide an area");
  });

  it("offers a colour for solid and a strength for blur and pixelate", () => {
    expect(bar(mask())).toContain('aria-label="Mask colour" data-value="#000000"');
    expect(bar(mask({ style: "blur" }))).toContain('type="range"');
    expect(bar(mask({ style: "pixelate" }))).not.toContain("Mask colour");
  });

  it("enables only the key actions the playhead allows", () => {
    const on = bar(mask({ keys: [...mask().keys, { sourceMs: 2000, rect: [0, 0, 0.2, 0.2] }] }));
    expect(on).toMatch(/disabled=""[^>]*title="A key already sits at this frame"/);
    expect(on).toContain('title="Delete the key at this frame"');
    expect(bar(mask())).toContain('title="A mask keeps at least one key"');
    expect(bar(mask(), { onKey: false, editable: false })).toContain(
      "Move the playhead into this mask&#x27;s span first",
    );
    expect(bar(mask(), { onKey: true, editable: false }, true)).toContain(
      "A mask on a still is one static box",
    );
  });
});
