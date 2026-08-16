import { describe, expect, it } from "vitest";
import { deviceGizmoProxySyncKey } from "./DeviceGizmo";
import type { DevicePose } from "./gizmoCommit";

describe("DeviceGizmo proxy reset", () => {
  it("forces the held proxy back to the committed pose after a failed write", () => {
    const committed: DevicePose = { position: [1, 2, 3], rotationDeg: [4, 5, 6], scale: 1 };

    expect(deviceGizmoProxySyncKey(committed, 0)).not.toBe(deviceGizmoProxySyncKey(committed, 1));
  });
});
