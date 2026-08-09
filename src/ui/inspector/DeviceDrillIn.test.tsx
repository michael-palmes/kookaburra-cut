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

import { DeviceColourDrillIn, DeviceDrillIn } from "./DeviceDrillIn";

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

  it("keeps the After editor focused on colour inheritance", () => {
    const html = renderToStaticMarkup(
      <DeviceColourDrillIn
        model="android"
        colour="graphite"
        beforeColour="graphite"
        overridden={false}
        onBack={() => undefined}
        onSave={() => undefined}
      />,
    );

    expect(html).toContain("After device colour");
    expect(html).toContain("Match before");
    expect(html).not.toContain("Device model");
    expect(html).not.toContain("Motion");
    expect(html).not.toContain("All devices");
  });
});
