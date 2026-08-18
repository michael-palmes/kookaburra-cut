import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  MediaBrowser,
  MediaBrowserError,
  MediaCard,
  mediaCardActions,
  mediaPreviewTabTarget,
  runMediaPickSingleFlight,
} from "./MediaBrowser";

const testProcess = (
  globalThis as unknown as {
    process: {
      getBuiltinModule: (name: "fs") => {
        readFileSync: (path: URL, encoding: "utf8") => string;
      };
    };
  }
).process;
const styles = testProcess
  .getBuiltinModule("fs")
  .readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("MediaBrowser accessibility", () => {
  it("names the source and media type controls", () => {
    const html = renderToStaticMarkup(
      <MediaBrowser slug="demo" projectPath="/tmp/demo" globalToggle kindToggle hideAdd />,
    );

    expect(html).toContain('role="radiogroup" aria-label="Media source"');
    expect(html).toContain('role="radiogroup" aria-label="Media type"');
  });

  it("announces operational errors", () => {
    const html = renderToStaticMarkup(<MediaBrowserError message="Import failed" />);

    expect(html).toContain('role="alert"');
    expect(html).toContain("Import failed");
  });

  it("keeps player controls reachable while wrapping focus at dialog boundaries", () => {
    const playerControl = { id: "player" } as HTMLElement;
    const close = { id: "close" } as HTMLElement;
    const outside = { id: "outside" } as HTMLElement;
    const focusables = [playerControl, close];

    expect(mediaPreviewTabTarget(focusables, playerControl, false)).toBeNull();
    expect(mediaPreviewTabTarget(focusables, close, true)).toBeNull();
    expect(mediaPreviewTabTarget(focusables, close, false)).toBe(playerControl);
    expect(mediaPreviewTabTarget(focusables, playerControl, true)).toBe(close);
    expect(mediaPreviewTabTarget(focusables, outside, false)).toBe(playerControl);
    expect(mediaPreviewTabTarget(focusables, outside, true)).toBe(close);
    expect(mediaPreviewTabTarget([], outside, false)).toBeNull();
  });

  it("keeps card activation, preview and actions as separate controls", () => {
    const html = renderToStaticMarkup(
      <MediaCard
        rel="assets/icon.png"
        meta={null}
        metaFailed={false}
        edited={false}
        canDrag={false}
        selected
        disabled
        onPick={() => undefined}
        onPreview={() => undefined}
        onMenu={() => undefined}
      />,
    );

    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('tabindex="0"');
    expect(html).toContain('aria-label="Use icon.png" aria-pressed="true"');
    expect(html).toContain('class="media-card-activate"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-label="Preview icon.png"');
    expect(html).toContain('aria-label="Actions for icon.png"');
    expect(html.match(/<button/g)).toHaveLength(3);
    const activation = html.slice(html.indexOf("<button"), html.indexOf("</button>") + 9);
    expect(activation).not.toContain("<img");
    expect(activation.match(/<button/g)).toHaveLength(1);
  });

  it("keeps the card activation focus ring inside the card", () => {
    expect(styles).toMatch(
      /\.media-card-activate:focus-visible\s*\{[^}]*box-shadow:\s*inset 0 0 0 2px var\(--focus-ring\)/,
    );
  });

  it("runs card, Preview and Actions controls independently", () => {
    const pick = vi.fn();
    const preview = vi.fn();
    const menu = vi.fn();
    const actions = mediaCardActions(pick, preview, menu);

    actions.activate();
    expect(pick).toHaveBeenCalledTimes(1);

    actions.preview();
    expect(pick).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledTimes(1);

    actions.openMenu?.(12, 24);
    expect(pick).toHaveBeenCalledTimes(1);
    expect(menu).toHaveBeenCalledWith(12, 24);
  });

  it("allows only one copy-on-use pick at a time", async () => {
    const busyRef = { current: false };
    let release: (() => void) | undefined;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const first = runMediaPickSingleFlight(busyRef, task);
    const second = runMediaPickSingleFlight(busyRef, task);

    expect(task).toHaveBeenCalledTimes(1);
    expect(busyRef.current).toBe(true);
    await expect(second).resolves.toBe(false);
    release?.();
    await expect(first).resolves.toBe(true);
    expect(busyRef.current).toBe(false);
  });
});
