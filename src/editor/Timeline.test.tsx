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

describe("Timeline keyboard roles", () => {
  const clips: EditClip[] = relayout([
    {
      id: "c1",
      sourceId: "s1",
      inMs: 0,
      outMs: 2000,
      speed: 1,
      startMs: 0,
      zoom: { keys: [{ tMs: 1000, rect: [0, 0, 1, 1] }] },
    },
    { id: "c2", sourceId: "s1", inMs: 2000, outMs: 3000, speed: 1, startMs: 0 },
  ]);
  const html = renderToStaticMarkup(
    <Timeline
      clips={clips}
      sources={[source]}
      metas={{}}
      selectedId="c2"
      playheadMs={0}
      onSelect={noop}
      onPlayhead={noop}
      onEditOp={noop}
      masks={[
        {
          id: "m1",
          sourceId: "s1",
          style: "solid",
          startMs: 500,
          endMs: 2500,
          keys: [{ sourceMs: 500, rect: [0, 0, 0.5, 0.5] }],
        },
      ]}
    />,
  );

  it("reads each lane as a list of named items with positions", () => {
    expect(html).toContain('role="listbox" aria-label="Clips"');
    expect(html).toContain('role="listbox" aria-label="Masks"');
    expect(html).toContain(
      'aria-label="Clip, a.mp4, 0:00.00 to 0:02.00" aria-posinset="1" aria-setsize="3"',
    );
    expect(html).toContain('aria-label="Zoom key, 0:01.00" aria-posinset="2" aria-setsize="3"');
    expect(html).toContain('aria-label="Clip, a.mp4, 0:02.00 to 0:03.00" aria-posinset="3"');
    expect(html).toContain('aria-label="Mask, solid, 0:00.50 to 0:02.50"');
  });

  it("gives each lane one Tab stop, on the selected clip", () => {
    const stops = html.match(/role="option" tabindex="0"[^>]*aria-selected="(true|false)"/g) ?? [];
    expect(stops).toHaveLength(2);
    expect(stops[0]).toContain('aria-selected="true"');
  });

  it("never nests a zoom key inside its clip", () => {
    // Keys draw after every clip, as siblings in the track rather than children of a clip.
    expect(html.indexOf('aria-label="Zoom key')).toBeGreaterThan(
      html.indexOf('aria-label="Clip, a.mp4, 0:02.00'),
    );
  });

  it("draws one mask item even where two clips show the mask", () => {
    expect(html.match(/aria-label="Mask, /g)).toHaveLength(1);
    expect(html.match(/class="timeline-mask-bar solid/g)).toHaveLength(2);
  });
});
