import { describe, expect, it } from "vitest";
import { ICON_TILE_INSET, iconTileGeometry } from "./IconTile";

describe("iconTileGeometry", () => {
  it("fills its size and depth exactly, centred", () => {
    const geometry = iconTileGeometry(2, 0.6, 0.225, 0.035);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    expect(box?.min.x).toBeCloseTo(-1, 6);
    expect(box?.max.x).toBeCloseTo(1, 6);
    expect(box?.min.y).toBeCloseTo(-1, 6);
    expect(box?.max.y).toBeCloseTo(1, 6);
    expect(box?.min.z).toBeCloseTo(-0.3, 6);
    expect(box?.max.z).toBeCloseTo(0.3, 6);
  });

  it("maps every vertex straight through onto the image, inside its border", () => {
    const size = 2;
    const geometry = iconTileGeometry(size, 0.6, 0.225, 0.035);
    const positions = geometry.getAttribute("position");
    const uvs = geometry.getAttribute("uv");
    const edge = (1 - ICON_TILE_INSET) / 2;
    for (let i = 0; i < positions.count; i++) {
      expect(uvs.getX(i)).toBeCloseTo(0.5 + (positions.getX(i) / size) * ICON_TILE_INSET, 6);
      expect(uvs.getY(i)).toBeCloseTo(0.5 + (positions.getY(i) / size) * ICON_TILE_INSET, 6);
      expect(uvs.getX(i)).toBeGreaterThanOrEqual(edge - 1e-6);
      expect(uvs.getX(i)).toBeLessThanOrEqual(1 - edge + 1e-6);
    }
  });
});
