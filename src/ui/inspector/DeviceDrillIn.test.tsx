import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../toolkit/device/modelUrl", () => ({
  androidModelUrl: "/android.glb",
  phoneModelUrl: "/placeholder-phone.glb",
  iphone17ProModelUrl: "/placeholder-phone.glb",
  macbookPro16ModelUrl: "/placeholder-phone.glb",
  iphone15ProModelAvailable: false,
  iphone17ProModelAvailable: false,
  macbookPro16ModelAvailable: false,
}));

import { DeviceDrillIn } from "./DeviceDrillIn";

describe("DeviceDrillIn in a clean clone", () => {
  it("shows only Android and seeds its default colour for an unavailable model", () => {
    const html = renderToStaticMarkup(
      <DeviceDrillIn
        model="iphone-17-pro"
        colour="silver"
        motion="none"
        onBack={() => undefined}
        onSave={() => undefined}
      />,
    );

    expect(html).toContain('alt="Android"');
    expect(html).toContain("Graphite");
    expect(html).not.toContain("iPhone 17 Pro");
    expect(html).not.toContain("MacBook Pro");
  });
});
