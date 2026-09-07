import { describe, expect, it } from "vitest";
import {
  AUTO_CHECK_THROTTLE_MS,
  consentFromSettings,
  formatCheckedAgo,
  formatUpdateStatus,
  shouldAutoCheck,
  shouldOfferVersion,
} from "./updates";

const NOW = 1_800_000_000_000;

describe("consentFromSettings", () => {
  it("maps the tri-state exactly", () => {
    expect(consentFromSettings(true)).toBe("on");
    expect(consentFromSettings(false)).toBe("off");
    expect(consentFromSettings(null)).toBe("undecided");
    expect(consentFromSettings(undefined)).toBe("undecided");
  });
});

describe("shouldAutoCheck", () => {
  it("always checks when never checked", () => {
    expect(shouldAutoCheck(null, NOW)).toBe(true);
  });

  it("throttles inside the 20h window and re-arms at the boundary", () => {
    expect(shouldAutoCheck(NOW - AUTO_CHECK_THROTTLE_MS + 1, NOW)).toBe(false);
    expect(shouldAutoCheck(NOW - AUTO_CHECK_THROTTLE_MS, NOW)).toBe(true);
    expect(shouldAutoCheck(NOW - AUTO_CHECK_THROTTLE_MS - 1, NOW)).toBe(true);
  });
});

describe("shouldOfferVersion", () => {
  it("re-offers only a different version than the declined one", () => {
    expect(shouldOfferVersion(null, "0.2.0")).toBe(true);
    expect(shouldOfferVersion("0.2.0", "0.2.0")).toBe(false);
    expect(shouldOfferVersion("0.2.0", "0.3.0")).toBe(true);
  });
});

describe("formatUpdateStatus", () => {
  const base = {
    phase: "idle" as const,
    devBuild: false,
    error: null,
    availableVersion: null,
    lastCheckedMs: null,
    nowMs: NOW,
  };

  it("orders the states: phase, dev build, error, offer, last checked, never", () => {
    expect(formatUpdateStatus({ ...base, phase: "checking" })).toBe("Checking…");
    expect(formatUpdateStatus({ ...base, phase: "installing" })).toBe("Installing…");
    expect(formatUpdateStatus({ ...base, devBuild: true })).toBe("Not available in a dev build.");
    expect(formatUpdateStatus({ ...base, error: "offline" })).toBe(
      "Couldn't check for updates: offline",
    );
    expect(formatUpdateStatus({ ...base, availableVersion: "0.2.0" })).toBe(
      "Update 0.2.0 is available.",
    );
    expect(formatUpdateStatus({ ...base, lastCheckedMs: NOW - 60_000 })).toMatch(/^Last checked/);
    expect(formatUpdateStatus(base)).toBe("Not checked yet.");
  });

  it("phase wins over a stale error, and an offer wins over the timestamp", () => {
    expect(formatUpdateStatus({ ...base, phase: "checking", error: "offline" })).toBe("Checking…");
    expect(
      formatUpdateStatus({ ...base, availableVersion: "0.2.0", lastCheckedMs: NOW - 60_000 }),
    ).toBe("Update 0.2.0 is available.");
  });
});

describe("formatCheckedAgo", () => {
  it("buckets minutes, hours and days like Welcome's last-opened label", () => {
    expect(formatCheckedAgo(NOW - 20_000, NOW)).toBe("Last checked just now");
    expect(formatCheckedAgo(NOW - 5 * 60_000, NOW)).toMatch(/minute/);
    expect(formatCheckedAgo(NOW - 3 * 3_600_000, NOW)).toMatch(/hour/);
    expect(formatCheckedAgo(NOW - 48 * 3_600_000, NOW)).toMatch(/day|yesterday/);
  });
});
