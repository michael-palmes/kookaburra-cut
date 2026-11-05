import { describe, expect, it } from "vitest";
import {
  AUTO_CHECK_POLL_MS,
  AUTO_CHECK_THROTTLE_MS,
  autoCheckDue,
  consentFromSettings,
  formatCheckedAgo,
  formatUpdateStatus,
  shouldAutoCheck,
} from "./updates";

const NOW = 1_800_000_000_000;

describe("consentFromSettings", () => {
  it("maps the tri-state exactly", () => {
    expect(consentFromSettings(true)).toBe("on");
    expect(consentFromSettings(false)).toBe("off");
    expect(consentFromSettings(null)).toBe("undecided");
    expect(consentFromSettings(undefined)).toBe("undecided");
  });

  it("reads off whatever is stored when a profile turns update checks off", () => {
    expect(consentFromSettings(true, true)).toBe("off");
    expect(consentFromSettings(null, true)).toBe("off");
    expect(consentFromSettings(false, true)).toBe("off");
    expect(consentFromSettings(true, false)).toBe("on");
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

describe("autoCheckDue", () => {
  const due = {
    storedConsent: true,
    managedOff: false,
    lastCheckedMs: NOW - AUTO_CHECK_THROTTLE_MS,
    lastAttemptMs: null,
    exporting: false,
    nowMs: NOW,
  };

  it("checks once the throttle lapses with consent on", () => {
    expect(autoCheckDue(due)).toBe(true);
    expect(autoCheckDue({ ...due, lastCheckedMs: null })).toBe(true);
    expect(autoCheckDue({ ...due, lastCheckedMs: undefined })).toBe(true);
    expect(autoCheckDue({ ...due, lastCheckedMs: NOW - 1 })).toBe(false);
  });

  it("waits out the throttle after a failed attempt that stored no timestamp", () => {
    expect(autoCheckDue({ ...due, lastCheckedMs: null, lastAttemptMs: NOW - 1 })).toBe(false);
    expect(
      autoCheckDue({ ...due, lastCheckedMs: null, lastAttemptMs: NOW - AUTO_CHECK_THROTTLE_MS }),
    ).toBe(true);
    expect(autoCheckDue({ ...due, lastAttemptMs: NOW - 1 })).toBe(false);
  });

  it("never checks without consent, under a profile or mid-export", () => {
    expect(autoCheckDue({ ...due, storedConsent: false })).toBe(false);
    expect(autoCheckDue({ ...due, storedConsent: null })).toBe(false);
    expect(autoCheckDue({ ...due, storedConsent: undefined })).toBe(false);
    expect(autoCheckDue({ ...due, managedOff: true })).toBe(false);
    expect(autoCheckDue({ ...due, exporting: true })).toBe(false);
  });

  it("comes due again on the first tick past the throttle in a window left open", () => {
    const ticks = Math.ceil(AUTO_CHECK_THROTTLE_MS / AUTO_CHECK_POLL_MS);
    const at = (n: number) =>
      autoCheckDue({ ...due, lastCheckedMs: NOW, nowMs: NOW + n * AUTO_CHECK_POLL_MS });
    expect(at(ticks - 1)).toBe(false);
    expect(at(ticks)).toBe(true);
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
