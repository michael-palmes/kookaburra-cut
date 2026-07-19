import { describe, expect, it } from "vitest";
import { lockupLayout } from "./brandLockupLayout";

const base = {
  title: "Swyftx App",
  subtitle: "2.10.1",
  iconWidth: 1.4,
  titleSize: 0.36,
  subtitleSize: 0.82,
  usableWidth: 6.6,
};

describe("lockupLayout", () => {
  it("centres the bare icon block on the group origin", () => {
    const l = lockupLayout({ ...base, title: "", subtitle: "" });
    expect(l.centreOffset).toBeCloseTo((0.3 + base.iconWidth) / 2, 10);
  });

  it("shifts left as the text column grows", () => {
    const short = lockupLayout(base);
    const long = lockupLayout({ ...base, subtitle: "2.10.1-beta" });
    expect(long.centreOffset).toBeLessThan(short.centreOffset);
  });

  it("keeps fit at 1 when the block already fits", () => {
    expect(lockupLayout(base).fit).toBe(1);
  });

  it("shrinks long subtitles to the usable width", () => {
    const l = lockupLayout({ ...base, subtitle: "Version 8.0.1-beta.4", usableWidth: 5 });
    expect(l.fit).toBeLessThan(1);
    expect(l.width * l.fit).toBeCloseTo(5, 10);
  });

  it("measures the longest line of multi-line text", () => {
    const single = lockupLayout(base);
    const multi = lockupLayout({ ...base, subtitle: "2.10.1\nJuly release notes" });
    expect(multi.width).toBeGreaterThan(single.width);
  });

  it("degrades to icon + gap on empty text", () => {
    const l = lockupLayout({ ...base, title: "", subtitle: "" });
    expect(l.width).toBeCloseTo(1.7, 10);
    expect(l.fit).toBe(1);
  });
});
