import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaBrowserProps } from "../MediaBrowser";
import {
  requestTextIconCharacterPalette,
  TextIconEmojiPickerDrill,
  TextIconImagePickerDrill,
  textIconEmojiInitialValue,
  textIconPickerMountKey,
} from "./TextIconPickerDrill";
import { TEXT_ICON_EMOJIS } from "./textIconEmojiCatalogue";

const captures = vi.hoisted(() => ({
  invoke: vi.fn(),
  mediaBrowser: null as MediaBrowserProps | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: captures.invoke }));

vi.mock("../MediaBrowser", () => ({
  MediaBrowser: (props: MediaBrowserProps) => {
    captures.mediaBrowser = props;
    return <div data-media-browser="image" />;
  },
}));

beforeEach(() => {
  captures.invoke.mockReset();
  captures.mediaBrowser = null;
});

describe("TextIconEmojiPickerDrill", () => {
  it("remounts draft state when the scene identity changes", () => {
    expect(textIconPickerMountKey("project", "scene-a.json", "text.icon.emoji:u16:icon")).not.toBe(
      textIconPickerMountKey("project", "scene-b.json", "text.icon.emoji:u16:icon"),
    );
  });

  it("starts clean when replacing a project image with an emoji", () => {
    expect(textIconEmojiInitialValue("assets/icon.png")).toBe("");
    expect(textIconEmojiInitialValue("🚀")).toBe("🚀");
    const html = renderToStaticMarkup(
      <TextIconEmojiPickerDrill
        initialValue="assets/icon.png"
        onBack={() => undefined}
        onPick={() => undefined}
      />,
    );
    expect(html).toContain('value=""');
    expect(html).not.toContain("assets/icon.png");
  });

  it("renders the full emoji palette in an inspector child screen", () => {
    const html = renderToStaticMarkup(
      <TextIconEmojiPickerDrill
        initialValue="✨"
        notice="Character Viewer unavailable"
        backLabel="Text"
        onBack={() => undefined}
        onPick={() => undefined}
      />,
    );

    expect(html).toContain('class="inspector-drill"');
    expect(html).toContain('aria-label="Back to Text from Choose emoji"');
    expect(html).toContain("Emoji or symbol");
    expect(html).toContain("Character Viewer unavailable");
    expect(html).toContain('value="✨"');
    expect(html).toContain('class="chip-icon-tile emoji selected"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain("Emoji catalogue");
    expect(html.match(/class="chip-icon-tile emoji/g)).toHaveLength(TEXT_ICON_EMOJIS.length);
    expect(TEXT_ICON_EMOJIS.length).toBeGreaterThanOrEqual(128);
    for (const emoji of TEXT_ICON_EMOJIS) expect(html).toContain(`aria-label="Use ${emoji}"`);
    expect(html).toContain("More emoji…");
    expect(html).toContain("Use icon");
  });

  it("requests the native character palette and reports failures", async () => {
    captures.invoke.mockResolvedValueOnce(undefined);
    await requestTextIconCharacterPalette();
    expect(captures.invoke).toHaveBeenCalledWith("show_character_palette");

    const onError = vi.fn();
    captures.invoke.mockRejectedValueOnce(new Error("palette unavailable"));
    await requestTextIconCharacterPalette(onError);
    expect(onError).toHaveBeenCalledWith("Error: palette unavailable");
  });
});

describe("TextIconImagePickerDrill", () => {
  it("embeds an image-only project and global media picker", () => {
    const onPick = vi.fn();
    const html = renderToStaticMarkup(
      <TextIconImagePickerDrill
        slug="launch"
        projectPath="/tmp/launch"
        refreshKey={7}
        selectedRel="assets/icon.png"
        backLabel="Text"
        onBack={() => undefined}
        onPick={onPick}
      />,
    );

    expect(html).toContain('class="inspector-drill"');
    expect(html).toContain('aria-label="Back to Text from Choose image"');
    expect(html).toContain('class="inspector-media-host"');
    expect(captures.mediaBrowser).toMatchObject({
      slug: "launch",
      projectPath: "/tmp/launch",
      refreshKey: 7,
      kinds: ["image"],
      globalToggle: true,
      selectedRel: "assets/icon.png",
    });

    captures.mediaBrowser?.onPick?.("assets/new-icon.png", null);
    expect(onPick).toHaveBeenCalledWith("assets/new-icon.png");
  });
});
