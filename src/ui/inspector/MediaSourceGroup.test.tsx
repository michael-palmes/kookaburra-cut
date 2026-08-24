import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MediaSourceGroup, mediaThumbnailSize } from "./MediaSourceGroup";

describe("MediaSourceGroup", () => {
  it("fits thumbnails to their source aspect ratio", () => {
    expect(mediaThumbnailSize(1170 / 2532)).toEqual({ width: 26.8, height: 58 });
    expect(mediaThumbnailSize(1920 / 1080)).toEqual({ width: 58, height: 32.63 });
    expect(mediaThumbnailSize(1)).toEqual({ width: 58, height: 58 });
    expect(mediaThumbnailSize(0)).toBeUndefined();
    expect(mediaThumbnailSize()).toBeUndefined();
  });

  it("renders one summary and both actions under the group label", () => {
    const html = renderToStaticMarkup(
      <MediaSourceGroup
        label="Video"
        previewUrl="asset://localhost/poster.jpg"
        aspectRatio={1170 / 2532}
        name="demo-recording.mov"
        detail="0:12 · 1170×2532"
        onChange={() => undefined}
        onEdit={() => undefined}
      />,
    );

    expect(html).toContain('<span class="drill-group-label">Video</span>');
    expect(html).toContain(
      '<div class="device-editor-media-thumb" style="width:26.8px;height:58px">',
    );
    expect(html).toContain('src="asset://localhost/poster.jpg"');
    expect(html).toContain('title="demo-recording.mov"');
    expect(html).toContain("0:12 · 1170×2532");
    expect(html).toContain("Change");
    expect(html).toContain("Edit");
    expect(html).not.toContain('disabled=""');
  });

  it("falls back to the placeholder box and disables what cannot run", () => {
    const withoutEdit = renderToStaticMarkup(
      <MediaSourceGroup
        label="Screen"
        name="No screen media"
        detail="Choose an image or video"
        onChange={() => undefined}
      />,
    );
    const disabled = renderToStaticMarkup(
      <MediaSourceGroup
        label="Screen"
        previewUrl="asset://localhost/shot.png"
        name="shot.png"
        detail="Image"
        disabled
        onChange={() => undefined}
        onEdit={() => undefined}
      />,
    );

    expect(withoutEdit).toContain('<div class="device-editor-media-thumb">');
    expect(withoutEdit.match(/disabled=""/g)).toHaveLength(1);
    expect(disabled.match(/disabled=""/g)).toHaveLength(2);
  });
});
