import { describe, expect, it } from "vitest";
import { deviceAcknowledgementMatches, useDeviceEditStore } from "./deviceEditStore";

describe("device gizmo write acknowledgement", () => {
  it("targets a failed write to only the matching local device preview", () => {
    const store = useDeviceEditStore.getState();
    const commitId = store.requestCommit({
      sceneIndex: 3,
      deviceId: "d2",
      kind: "placement",
      placement: { position: [1, 0, 0] },
    });
    const commit = useDeviceEditStore.getState().pendingCommit;
    expect(commit?.commitId).toBe(commitId);
    if (!commit) throw new Error("Expected a pending device commit");

    store.clearCommit();
    store.acknowledgeCommit(commit, false);
    const acknowledgement = useDeviceEditStore.getState().acknowledgements[commitId];

    expect(acknowledgement?.succeeded).toBe(false);
    expect(acknowledgement && deviceAcknowledgementMatches(acknowledgement, 3, "d2")).toBe(true);
    expect(acknowledgement && deviceAcknowledgementMatches(acknowledgement, 3, "d1")).toBe(false);
    expect(acknowledgement && deviceAcknowledgementMatches(acknowledgement, 2, "d2")).toBe(false);

    store.clearAcknowledgement(commitId);
    expect(useDeviceEditStore.getState().acknowledgements[commitId]).toBeUndefined();
  });
});
