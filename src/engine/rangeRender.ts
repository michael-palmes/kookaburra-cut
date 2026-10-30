/** The window half of a ranged render (docs/agent-kit.md, "Ranged checks"): the stage worker renders each frame (`rangeRun.ts`), the bytes cross once per frame and are handed on (to the flash detector, a preview clip or a strip) from here. */

import type { ExportOptions } from "./exporter";
import { withExporting } from "./exportState";
import { computeFormat } from "./format";
import type { SceneTextBox } from "./rangeRun";
import { stage, stageExportOptions } from "./stageHandle";

export type { SceneTextBox } from "./rangeRun";

/** One rendered frame: the readback (GL bottom-up rows), valid until `onFrame` returns, and, when asked, the text it shows. */
export interface RangeFrame {
  index: number;
  tMs: number;
  rgba: Uint8Array;
  width: number;
  height: number;
  texts?: SceneTextBox[];
}

/** The safe area as `useFormat().safe` lays it out, normalised (top-left origin). */
export function safeAreaBox(format: ExportOptions["format"]): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const { frame, safe } = computeFormat(format);
  return {
    x: safe.left / frame.width,
    y: safe.top / frame.height,
    w: (frame.width - safe.left - safe.right) / frame.width,
    h: (frame.height - safe.top - safe.bottom) / frame.height,
  };
}

/** Renders `times` (project ms) through the export path, handing each frame to `onFrame` before the next renders. */
export async function renderRange(
  opts: ExportOptions,
  times: readonly number[],
  onFrame: (frame: RangeFrame) => Promise<void>,
  options: { texts?: boolean } = {},
): Promise<void> {
  if (times.length === 0) return;
  const s = stage();
  const { width, height } = opts.format;
  await withExporting(async () => {
    try {
      await s.rangeBegin(stageExportOptions(opts), [Math.min(...times), Math.max(...times)]);
      let buffer: ArrayBuffer | null = null;
      for (const [index, tMs] of times.entries()) {
        const out = await s.rangeFrame(index, tMs, buffer, options.texts === true);
        await onFrame({ index, tMs, rgba: out.rgba, width, height, texts: out.texts });
        buffer = out.rgba.buffer as ArrayBuffer;
      }
    } finally {
      await s.rangeEnd().catch(() => {});
    }
  });
}
