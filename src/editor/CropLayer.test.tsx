import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EditSource } from "../engine/edit";
import {
  aspectBox,
  CropLayer,
  CropSettingsBar,
  cropViewStyle,
  movedBox,
  normalisedAspect,
} from "./CropLayer";

const land: EditSource = {
  id: "s1",
  rel: "assets/a.mp4",
  width: 1920,
  height: 1080,
  fps: 60,
  durationMs: 8000,
};
const noop = () => {};

describe("crop gestures", () => {
  it("locks a box to the output's shape in normalised source units", () => {
    expect(normalisedAspect(land, 9 / 16)).toBeCloseTo(0.31640625, 12);
    const k = normalisedAspect(land, 16 / 9);
    expect(k).toBe(1);
    expect(aspectBox([0.2, 0.2], [0.5, 0.3], k)).toEqual([0.2, 0.2, 0.3, 0.3]);
    const up = aspectBox([0.5, 0.5], [0.4, 0.1], k);
    expect(up.map((v) => Number(v.toFixed(10)))).toEqual([0.1, 0.1, 0.4, 0.4]);
  });

  it("stops a box at the frame edge it grows toward", () => {
    const box = aspectBox([0.8, 0.5], [1.4, 0.9], 1);
    expect(box.map((v) => Number(v.toFixed(10)))).toEqual([0.8, 0.5, 0.2, 0.2]);
    expect(movedBox([0.5, 0.5, 0.4, 0.4], 0.3, -0.7)).toEqual([0.6, 0, 0.4, 0.4]);
  });

  it("frames only the crop, scaled to fit and centred in the preview", () => {
    const area = { width: 800, height: 450 };
    const half = cropViewStyle([0.25, 0, 0.5, 1], land, area) as Record<string, unknown>;
    expect(half.transform).toBe("translate(0px, 0px) scale(1)");
    expect(half.clipPath).toBe("inset(0% 25% 0% 25%)");
    const quarter = cropViewStyle([0.25, 0.25, 0.5, 0.5], land, area) as Record<string, unknown>;
    expect(quarter.transform).toBe("translate(-400px, -225px) scale(2)");
    expect(quarter["--crop-k"]).toBe(2);
    expect(cropViewStyle([0, 0, 1, 1], { width: 0, height: 0 }, area)).toBeUndefined();
  });

  it("frames a gliding zoom exactly, off the even-pixel grid", () => {
    const area = { width: 800, height: 450 };
    const between = [0.2501, 0.2501, 0.5, 0.5] as [number, number, number, number];
    const snapped = cropViewStyle(between, land, area) as Record<string, unknown>;
    const exact = cropViewStyle(between, land, area, true) as Record<string, unknown>;
    expect(snapped.clipPath).toBe("inset(25% 25% 25% 25%)");
    expect(exact.clipPath).not.toBe(snapped.clipPath);
    expect(exact["--crop-k"]).toBe(2);
  });
});

describe("CropLayer", () => {
  const layer = (crop: [number, number, number, number] | null, onKey = false) =>
    renderToStaticMarkup(
      <CropLayer
        source={land}
        crop={crop}
        onKey={onKey}
        aspect={9 / 16}
        editable
        onGesture={noop}
        onCommit={noop}
      />,
    );

  it("draws the crop box with four corner handles, or nothing to start from", () => {
    const html = layer([0.25, 0, 0.5, 1]);
    expect(html).toContain('class="crop-box" style="left:25%;top:0%;width:50%;height:100%"');
    expect(html.split("crop-handle").length - 1).toBe(4);
    expect(html).not.toContain("crop-key-badge");
    expect(layer(null)).not.toContain("crop-box");
  });

  it("marks a frame that holds a zoom key", () => {
    const html = layer([0.25, 0, 0.5, 1], true);
    expect(html).toContain('class="crop-box on-key"');
    expect(html).toContain("crop-key-badge");
  });

  it("the strip deletes the zoom key only when the playhead is on one", () => {
    const bar = (onKey: boolean) =>
      renderToStaticMarkup(
        <CropSettingsBar
          clipId="c1"
          hasCrop
          onKey={onKey}
          onFit={noop}
          onDeleteKey={noop}
          onReset={noop}
        />,
      );
    expect(bar(false)).toMatch(/disabled=""[^>]*title="No zoom key at the playhead"/);
    expect(bar(true)).toContain('title="Delete the zoom key at the playhead"');
    expect(bar(true)).toContain("zoom between keys");
  });

  it("the strip fits and resets only what it can", () => {
    const bar = (clipId: string | null, hasCrop: boolean) =>
      renderToStaticMarkup(
        <CropSettingsBar clipId={clipId} hasCrop={hasCrop} onFit={noop} onReset={noop} />,
      );
    expect(bar("c2", false)).toContain("crop c2 to the output&#x27;s shape");
    expect(bar("c2", false)).toMatch(/disabled=""[^>]*title="This clip isn&#x27;t cropped"/);
    expect(bar(null, false)).toContain("Move the playhead onto a clip");
  });
});
