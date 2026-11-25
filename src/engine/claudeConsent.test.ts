import { describe, expect, it } from "vitest";
import { CLAUDE_OFF, claudeConsentFrom } from "./claudeConsent";

describe("claudeConsentFrom", () => {
  it("maps the stored tri-state, and an unanswered question is not on", () => {
    expect(claudeConsentFrom(true)).toBe("on");
    expect(claudeConsentFrom(false)).toBe("off");
    expect(claudeConsentFrom(null)).toBe("undecided");
    expect(claudeConsentFrom(undefined)).toBe("undecided");
  });

  it("reads as off before the first read lands and when it fails", () => {
    expect(CLAUDE_OFF.allowed).toBe(false);
    expect(CLAUDE_OFF.consent).toBeNull();
  });
});
