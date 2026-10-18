import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EditClip, EditSource } from "../engine/edit";
import { relayout } from "../engine/editMath";
import { Timeline } from "./Timeline";

const source: EditSource = {
  id: "s1",
  rel: "assets/a.mp4",
  width: 1920,
  height: 1080,
  fps: 60,
  durationMs: 8000,
};
const noop = () => {};

describe("Timeline zoom keys", () => {
  it("draws a diamond per key inside the clip's span, softened when it glides smoothly", () => {
    const clips: EditClip[] = relayout([
      {
        id: "c1",
        sourceId: "s1",
        inMs: 0,
        outMs: 2000,
        speed: 1,
        startMs: 0,
        zoom: {
          keys: [
            { tMs: -500, rect: [0, 0, 1, 1] },
            { tMs: 0, rect: [0, 0, 1, 1], ease: "smooth" },
            { tMs: 1000, rect: [0.25, 0.25, 0.5, 0.5] },
            { tMs: 2500, rect: [0.25, 0.25, 0.5, 0.5] },
          ],
        },
      },
      { id: "c2", sourceId: "s1", inMs: 2000, outMs: 3000, speed: 1, startMs: 0 },
    ]);
    const html = renderToStaticMarkup(
      <Timeline
        clips={clips}
        sources={[source]}
        metas={{}}
        selectedId={null}
        playheadMs={0}
        onSelect={noop}
        onPlayhead={noop}
        onEditOp={noop}
      />,
    );
    expect(html.match(/class="timeline-zoom-key[^"]*"/g)).toEqual([
      'class="timeline-zoom-key smooth"',
      'class="timeline-zoom-key"',
    ]);
  });
});
